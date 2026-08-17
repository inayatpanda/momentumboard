import { describe, expect, it } from 'vitest'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { acquireLease, blobAppStore, memoryStore, releaseLease } from './store'
import { d1AppStore, d1CacheStore, ensureD1Schema, envelopeExpiry, type D1Database } from './d1Store'
import samples from './__fixtures__/blobSamples.json'

// A local D1 per test — real SQLite (node:sqlite), the same engine D1 runs.
async function fresh(): Promise<D1Database & { close(): void }> {
  const db = openSqliteD1(':memory:')
  await ensureD1Schema(db)
  return db
}

const RAW = samples as Record<string, string>

describe('d1AppStore — the AppStore contract', () => {
  it('reads back what it wrote, in the same shape', async () => {
    const db = await fresh()
    const store = d1AppStore(db)
    expect(await store.read('nothing-here')).toBeNull()

    await store.write('engine-weights', { momentum: 0.4, quality: 0.6, notes: ['a', 'b'] })
    expect(await store.read('engine-weights')).toEqual({ momentum: 0.4, quality: 0.6, notes: ['a', 'b'] })

    await store.write('engine-weights', { momentum: 0.5 })
    expect(await store.read('engine-weights')).toEqual({ momentum: 0.5 })
    db.close()
  })

  // The whole reason readStrong exists on the Blobs store is that a plain read
  // could miss a just-minted licence key. D1 is single-primary: the read that
  // follows the write sees it, so the two methods are the same method.
  it('readStrong sees a write immediately — single-primary retires the workaround', async () => {
    const db = await fresh()
    const store = d1AppStore(db)
    await store.write('licences', [{ key: 'mb_fresh', label: 'just-minted' }])
    expect(await store.readStrong('licences')).toEqual([{ key: 'mb_fresh', label: 'just-minted' }])
    expect(await store.readStrong('licences')).toEqual(await store.read('licences'))
    db.close()
  })

  it('keeps the stores apart — the same key in app and cache is two rows', async () => {
    const db = await fresh()
    const app = d1AppStore(db)
    const cache = d1CacheStore(db)
    await app.write('pick-stats', { from: 'app' })
    await cache.writeWithTtl('pick-stats', { from: 'cache' }, 600)
    expect(await app.read('pick-stats')).toEqual({ from: 'app' })
    expect(await cache.read<{ value: unknown }>('pick-stats')).toEqual({ value: { from: 'cache' }, expires: expect.any(Number) })
    db.close()
  })

  // M1 shipped 'null' here and the M1 review booked the reversal for M2. The
  // app store's callers READ-MODIFY-WRITE: `licences` is read, appended to and
  // written back. A corrupt row read as null would become `[] → push → write`
  // and overwrite every licence key with a one-element list, silently. The
  // corrupt bytes must survive for recovery, so the read throws instead.
  it('a corrupt row THROWS on the app store, leaving the bytes intact', async () => {
    const db = await fresh()
    const store = d1AppStore(db)
    await store.writeRaw('half-written', '{"a":')
    await expect(store.read('half-written')).rejects.toThrow(/corrupt JSON at key 'half-written'/)
    expect(await store.readRaw('half-written')).toBe('{"a":')
    db.close()
  })

  it("…and reads as a miss on the cache store, where every caller's null means 'go and fetch it'", async () => {
    const db = await fresh()
    const cache = d1CacheStore(db)
    await cache.writeRaw('quote:AAPL', '{"value":')
    expect(await cache.read('quote:AAPL')).toBeNull()
    expect(await cache.readRaw('quote:AAPL')).toBe('{"value":')
    db.close()
  })

  it("onCorrupt: 'null' is available on the app store for callers that want it", async () => {
    const db = await fresh()
    const store = d1AppStore(db, { onCorrupt: 'null' })
    await store.writeRaw('half-written', '{"a":')
    expect(await store.read('half-written')).toBeNull()
    db.close()
  })

  // M1 review, booked for M2. Lazy eviction was SELECT-then-DELETE: two round
  // trips to a remote D1 on a path every cache miss takes. One conditional
  // DELETE does the same job, and its predicate is the exact complement of the
  // read's, so it can only remove a row the read just refused to serve.
  it('evicts a stale row in ONE statement, and only ever a stale one', async () => {
    const db = await fresh()
    const queries: string[] = []
    const counted: D1Database = { prepare: (q: string) => (queries.push(q.trim().split(/\s+/).slice(0, 2).join(' ')), db.prepare(q)) }
    const now = 1_760_000_000_000
    const cache = d1CacheStore(counted, { now: () => now })
    await cache.writeRaw('quote:RMS.PA', RAW['site__cache/quote:RMS.PA'], now - 1)
    await cache.writeRaw('quote:AAPL', JSON.stringify({ value: 231, expires: now + 60_000 }), now + 60_000)

    queries.length = 0
    expect(await cache.read('quote:RMS.PA')).toBeNull()
    expect(queries).toEqual(['SELECT value', 'DELETE FROM'])
    expect(await cache.readRaw('quote:RMS.PA')).toBeNull() // really gone

    queries.length = 0
    expect(await cache.read('quote:AAPL')).toMatchObject({ value: 231 }) // a hit costs one query and evicts nothing
    expect(queries).toEqual(['SELECT value'])

    queries.length = 0
    expect(await cache.read('never-existed')).toBeNull() // a plain miss still tries once, harmlessly
    expect(queries).toEqual(['SELECT value', 'DELETE FROM'])
    expect(await cache.read('quote:AAPL')).toMatchObject({ value: 231 }) // the live row survived every sweep above
    db.close()
  })

  // …BUT THE APP STORE HAS NOTHING TO EVICT. Its rows are immortal (`expires_at`
  // is always NULL), so the speculative DELETE could never match — it was pure
  // cost, one extra subrequest per optional key, and a handler reads a dozen of
  // them inside a fifty-subrequest budget.
  it('a missing APP key costs one statement, not two', async () => {
    const db = await fresh()
    const queries: string[] = []
    const counted: D1Database = { prepare: (q: string) => (queries.push(q.trim().split(/\s+/).slice(0, 2).join(' ')), db.prepare(q)) }
    const app = d1AppStore(counted)
    await app.write('here', { yes: true })

    queries.length = 0
    expect(await app.read('not-here')).toBeNull()
    expect(queries, 'the app store issued an eviction that can never match anything').toEqual(['SELECT value'])

    queries.length = 0
    expect(await app.read('here')).toEqual({ yes: true })
    expect(queries).toEqual(['SELECT value'])
    db.close()
  })

  it('serves the existing lease handshake unchanged', async () => {
    const db = await fresh()
    const store = d1AppStore(db)
    const first = await acquireLease(store, 'lease:predict-background', 100, 60)
    expect(first).toBeTruthy()
    expect(await acquireLease(store, 'lease:predict-background', 120, 60)).toBeNull()
    await releaseLease(store, 'lease:predict-background', first!)
    expect(await acquireLease(store, 'lease:predict-background', 130, 60)).toBeTruthy()
    db.close()
  })

  /* ─────────────────────────────── I-4 ───────────────────────────────
   * The handshake is read → check → write → read. On D1 over HTTP from an
   * Actions runner that is four ~200ms hops with a ~780ms window between the
   * check and the write — long enough for two runners started by the same
   * 15-minute cron to both decide `lease:queue-worker` is free and drain the
   * queue twice. On D1 the whole decision is one statement instead.
   */
  describe('the lease is a compare-and-set on D1, not a handshake', () => {
    it('exposes the capability, so acquireLease takes the atomic path', () => {
      expect(typeof d1AppStore(openSqliteD1(':memory:')).tryAcquireLeaseAtomic).toBe('function')
    })

    it('admits exactly one of two racing acquirers', async () => {
      const db = await fresh()
      const store = d1AppStore(db)
      const [a, b] = await Promise.all([acquireLease(store, 'lease:queue-worker', 100, 60), acquireLease(store, 'lease:queue-worker', 100, 60)])
      expect([a, b].filter(Boolean)).toHaveLength(1)
      // …and eight more, all at once, on a lease that is already held
      const rest = await Promise.all(Array.from({ length: 8 }, () => acquireLease(store, 'lease:queue-worker', 100, 60)))
      expect(rest.filter(Boolean)).toEqual([])
      db.close()
    })

    it('costs ONE statement — the whole point', async () => {
      const db = await fresh()
      const seen: string[] = []
      const counted = { prepare: (sql: string) => (seen.push(sql.trim().split(/\s+/)[0]), db.prepare(sql)) }
      expect(await acquireLease(d1AppStore(counted), 'lease:predict-background', 100, 60)).toBeTruthy()
      expect(seen).toEqual(['INSERT'])
      db.close()
    })

    it('hands an expired lease to the next acquirer, and never a live one', async () => {
      const db = await fresh()
      const store = d1AppStore(db)
      expect(await acquireLease(store, 'lease:predict-background', 100, 60)).toBeTruthy()
      expect(await acquireLease(store, 'lease:predict-background', 159, 60)).toBeNull() // one second to run
      const second = await acquireLease(store, 'lease:predict-background', 160, 60) // expired to the second
      expect(second).toBeTruthy()
      expect(await acquireLease(store, 'lease:predict-background', 161, 60)).toBeNull() // …and the new one holds
      await releaseLease(store, 'lease:predict-background', second!)
      expect(await acquireLease(store, 'lease:predict-background', 162, 60)).toBeTruthy() // release frees it immediately
      db.close()
    })

    // A key holding something that is not a lease record must not wedge the job
    // forever: json_extract raises on malformed JSON, so the predicate checks
    // json_valid first and treats anything unrecognisable as free.
    it('takes a lease over a row that is not a lease record', async () => {
      const db = await fresh()
      const store = d1AppStore(db)
      for (const junk of ['not json at all', '{"unrelated":1}', 'null']) {
        await db.prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1,?2,?3,?4,NULL)').bind('app', 'lease:x', junk, 1).run()
        expect(await acquireLease(store, 'lease:x', 100, 60), junk).toBeTruthy()
      }
      db.close()
    })

    it('leaves the token readable by releaseLease, as the handshake did', async () => {
      const db = await fresh()
      const store = d1AppStore(db)
      const token = await acquireLease(store, 'lease:predict-background', 100, 60)
      expect(await store.read<{ token: string; expiresAt: number }>('lease:predict-background')).toEqual({ token, expiresAt: 160 })
      await releaseLease(store, 'lease:predict-background', 'somebody-else')
      expect(await acquireLease(store, 'lease:predict-background', 101, 60)).toBeNull() // a stranger cannot release it
      db.close()
    })

    // The capability is optional; the stores that lack it must be untouched.
    it('leaves the Blobs and in-memory paths on the original handshake', async () => {
      const mem = memoryStore()
      expect(mem.tryAcquireLeaseAtomic).toBeUndefined()
      expect(blobAppStore.tryAcquireLeaseAtomic).toBeUndefined()
      const first = await acquireLease(mem, 'lease:test', 100, 60)
      expect(first).toBeTruthy()
      expect(await acquireLease(mem, 'lease:test', 120, 60)).toBeNull()
      expect(await acquireLease(mem, 'lease:test', 161, 60)).toBeTruthy()
    })
  })

  it('lists keys, filtered by prefix, and forgets what it removes', async () => {
    const db = await fresh()
    const store = d1AppStore(db)
    for (const k of ['report:2026-08-11', 'report:2026-08-12', 'runlog']) await store.write(k, k)
    expect(await store.keys()).toEqual(['report:2026-08-11', 'report:2026-08-12', 'runlog'])
    expect(await store.keys('report:')).toEqual(['report:2026-08-11', 'report:2026-08-12'])
    // '_' is a SQL LIKE wildcard; a key containing one must not widen the match.
    await store.write('a_b', 1)
    await store.write('axb', 2)
    expect(await store.keys('a_')).toEqual(['a_b'])
    await store.remove('runlog')
    expect(await store.read('runlog')).toBeNull()
    db.close()
  })
})

// The store column is TEXT. Everything the app keeps — bulletins, reports,
// French company names — has to survive the trip out to a string and back.
describe('JSON round-trip fidelity, against real rescued blobs', () => {
  const cases: [string, string][] = [
    ['site__app/intraday-flags', 'an app object carrying an em dash and a curly apostrophe'],
    ['site__cache/quote:RMS.PA', 'a cache envelope holding "Hermès International Société"'],
    ['site__app/sched-slot:alert-check', 'a bare number, not an object'],
  ]

  it.each(cases)('%s — %s', async name => {
    const raw = RAW[name]
    expect(raw).toBeTruthy()
    const db = await fresh()
    const store = d1AppStore(db, { store: 'roundtrip' })

    // 1. imported bytes come back byte-identical
    await store.writeRaw(name, raw)
    expect(await store.readRaw(name)).toBe(raw)

    // 2. and parse to the same value the Blobs json read would have produced
    const expected = JSON.parse(raw)
    expect(await store.read(name)).toEqual(expected)

    // 3. and survive a write through the normal seam (re-serialised, not re-encoded)
    await store.write(`${name}#rewritten`, expected)
    expect(await store.read(`${name}#rewritten`)).toEqual(expected)
    db.close()
  })

  it('keeps non-ASCII as characters, never as mojibake', async () => {
    const db = await fresh()
    const store = d1AppStore(db)
    await store.write('unicode', { name: 'Hermès International Société', dash: '—', emoji: '📈', cjk: '日経平均' })
    expect(await store.read('unicode')).toEqual({ name: 'Hermès International Société', dash: '—', emoji: '📈', cjk: '日経平均' })
    db.close()
  })
})

// H2, the TTL gate. Netlify expired cache blobs server-side as a second net.
// D1 will not, so expiry has to be enforced here — and it is enforced in the
// SQL predicate, which means a stale value cannot be served even if the lazy
// eviction below never runs.
describe('cache TTL — a stale entry is a miss', () => {
  const stale = { value: { price: 999 }, expires: 1_000 }
  const live = { value: { price: 111 }, expires: 9_000 }

  it('never serves a value whose expiry has passed', async () => {
    const db = await fresh()
    let clock = 5_000
    const cache = d1CacheStore(db, { now: () => clock })

    await cache.write('quote:STALE', stale)
    await cache.write('quote:LIVE', live)

    expect(await cache.read('quote:STALE')).toBeNull()
    expect(await cache.read('quote:LIVE')).toEqual(live)

    clock = 9_001 // the live one ages out under us
    expect(await cache.read('quote:LIVE')).toBeNull()
    db.close()
  })

  it('evicts the stale row lazily, so a dead key stops costing storage', async () => {
    const db = await fresh()
    const cache = d1CacheStore(db, { now: () => 5_000 })
    await cache.write('quote:STALE', stale)
    expect(await rowCount(db, 'cache')).toBe(1)
    expect(await cache.read('quote:STALE')).toBeNull()
    expect(await rowCount(db, 'cache')).toBe(0)
    db.close()
  })

  it('does not evict when eviction is off — but still refuses to serve', async () => {
    const db = await fresh()
    const cache = d1CacheStore(db, { now: () => 5_000, evictOnRead: false })
    await cache.write('quote:STALE', stale)
    expect(await cache.read('quote:STALE')).toBeNull()
    expect(await rowCount(db, 'cache')).toBe(1)
    db.close()
  })

  it('writeWithTtl mirrors setCached — seconds in, envelope out', async () => {
    const db = await fresh()
    let clock = 1_000_000
    const cache = d1CacheStore(db, { now: () => clock })
    await cache.writeWithTtl('movers', { gainers: [] }, 600)
    expect(await cache.read('movers')).toEqual({ value: { gainers: [] }, expires: 1_000_000 + 600_000 })
    clock += 600_001
    expect(await cache.read('movers')).toBeNull()
    db.close()
  })

  it('a real rescued cache blob, already expired on 2026-08-12, reads as absent', async () => {
    const raw = RAW['site__cache/quote:RMS.PA']
    const parsed = JSON.parse(raw) as { expires: number }
    const db = await fresh()
    const cache = d1CacheStore(db, { now: () => parsed.expires + 1 })
    await cache.writeRaw('quote:RMS.PA', raw, envelopeExpiry(parsed))
    expect(await cache.read('quote:RMS.PA')).toBeNull()
    // and the same bytes, read before they expired, are the real value
    const before = d1CacheStore(db, { now: () => parsed.expires - 1 })
    await before.writeRaw('quote:RMS.PA', raw, envelopeExpiry(parsed))
    expect(await before.read<{ value: { name: string } }>('quote:RMS.PA')).toMatchObject({ value: { name: 'Hermès International Société en commandite par actions' } })
    db.close()
  })

  it('the app store is immortal — an "expires" field in app data is data, not a TTL', async () => {
    const db = await fresh()
    const app = d1AppStore(db, { now: () => 5_000 })
    await app.write('trial-issues', { expires: 1_000, issued: 3 })
    expect(await app.read('trial-issues')).toEqual({ expires: 1_000, issued: 3 })
    db.close()
  })
})

describe('sweepExpired — the cron housekeeper', () => {
  it('deletes only what is past its expiry, honours the limit, and counts', async () => {
    const db = await fresh()
    let clock = 5_000
    const cache = d1CacheStore(db, { now: () => clock })
    for (let i = 0; i < 5; i++) await cache.write(`dead:${i}`, { value: i, expires: 1_000 })
    for (let i = 0; i < 3; i++) await cache.write(`alive:${i}`, { value: i, expires: 9_000 })
    const app = d1AppStore(db)
    await app.write('licences', [{ key: 'mb_x' }])

    expect(await cache.sweepExpired(2)).toBe(2)
    expect(await rowCount(db, 'cache')).toBe(6)
    expect(await cache.sweepExpired()).toBe(3)
    expect(await rowCount(db, 'cache')).toBe(3)
    expect(await cache.sweepExpired()).toBe(0)

    // the app store is untouched by the cache's sweep
    expect(await rowCount(db, 'app')).toBe(1)
    clock = 9_001
    expect(await cache.sweepExpired()).toBe(3)
    expect(await rowCount(db, 'app')).toBe(1)
    db.close()
  })
})

// ONE STATEMENT FOR FORTY KEYS (the subrequest ceiling, 2026-08-17).
//
// Every D1 binding call spends one of an invocation's fifty subrequests, and
// alert-check asked for a quote and a candle series PER SYMBOL — eighty reads
// before it had done anything. Production ended 33 of 50 runs on 'Too many
// subrequests'. `readMany` is the same reads as one `key IN (…)` select.
describe('readMany — the batched cache read', () => {
  /** Counts statements the way workerd counts subrequests: one per prepare. */
  const counted = (db: D1Database & { close(): void }) => {
    let statements = 0
    const wrapped: D1Database & { close(): void } = {
      prepare: (sql: string) => {
        statements++
        return db.prepare(sql)
      },
      close: () => db.close(),
    }
    return { db: wrapped, count: () => statements }
  }

  it('returns what is there, keyed by key, and leaves missing keys ABSENT', async () => {
    const db = await fresh()
    const cache = d1CacheStore(db, { now: () => 5_000 })
    await cache.writeWithTtl('quote:AAPL', { price: 150 }, 600)
    await cache.writeWithTtl('quote:NVDA', { price: 120 }, 600)

    const got = await cache.readMany<{ value: { price: number } }>(['quote:AAPL', 'quote:MSFT', 'quote:NVDA'])
    expect(got.get('quote:AAPL')!.value).toEqual({ price: 150 })
    expect(got.get('quote:NVDA')!.value).toEqual({ price: 120 })
    expect(got.has('quote:MSFT'), 'a missing key must be absent, never a null entry').toBe(false)
    expect(got.size).toBe(2)
    db.close()
  })

  it('is order-independent — the answer is a map, not a positional list', async () => {
    const db = await fresh()
    const cache = d1CacheStore(db, { now: () => 5_000 })
    for (const s of ['A', 'B', 'C']) await cache.writeWithTtl(`quote:${s}`, { sym: s }, 600)
    const forward = await cache.readMany<{ value: { sym: string } }>(['quote:A', 'quote:B', 'quote:C'])
    const backward = await cache.readMany<{ value: { sym: string } }>(['quote:C', 'quote:B', 'quote:A'])
    expect([...backward].map(([k, v]) => [k, v.value.sym]).sort()).toEqual([...forward].map(([k, v]) => [k, v.value.sym]).sort())
    // …and a repeated key is asked for once and answered once
    expect((await cache.readMany(['quote:A', 'quote:A'])).size).toBe(1)
    db.close()
  })

  it('honours expiry exactly as read() does', async () => {
    const db = await fresh()
    let clock = 5_000
    const cache = d1CacheStore(db, { now: () => clock })
    await cache.write('quote:STALE', { value: { price: 999 }, expires: 1_000 })
    await cache.write('quote:LIVE', { value: { price: 111 }, expires: 9_000 })

    const got = await cache.readMany<{ value: { price: number } }>(['quote:STALE', 'quote:LIVE'])
    expect(got.has('quote:STALE')).toBe(false)
    expect(got.get('quote:LIVE')!.value).toEqual({ price: 111 })

    clock = 9_001 // the live one ages out under us
    expect((await cache.readMany(['quote:STALE', 'quote:LIVE'])).size).toBe(0)
    db.close()
  })

  it('costs ONE statement for forty keys — the whole point', async () => {
    const raw = await fresh()
    const { db, count } = counted(raw)
    const cache = d1CacheStore(db, { now: () => 5_000 })
    const syms = Array.from({ length: 40 }, (_, i) => `SYM${i}`)
    for (const s of syms) await cache.writeWithTtl(`quote:${s}`, { sym: s }, 600)

    const before = count()
    const got = await cache.readMany(syms.map(s => `quote:${s}`))
    expect(got.size).toBe(40)
    expect(count() - before, 'forty keys must cost one statement, not forty').toBe(1)
    raw.close()
  })

  it('asks for nothing when there is nothing to ask for', async () => {
    const raw = await fresh()
    const { db, count } = counted(raw)
    const cache = d1CacheStore(db, { now: () => 5_000 })
    expect((await cache.readMany([])).size).toBe(0)
    expect(count()).toBe(0)
    raw.close()
  })

  it('keeps the stores apart, exactly as read() does', async () => {
    const db = await fresh()
    const app = d1AppStore(db)
    const cache = d1CacheStore(db, { now: () => 5_000 })
    await app.write('shared-key', { from: 'app' })
    await cache.writeWithTtl('shared-key', { from: 'cache' }, 600)
    expect((await cache.readMany<{ value: unknown }>(['shared-key'])).get('shared-key')!.value).toEqual({ from: 'cache' })
    expect((await app.readMany<{ from: string }>(['shared-key'])).get('shared-key')).toEqual({ from: 'app' })
    db.close()
  })

  // The cache's own rule (onCorrupt: 'null'): a row that will not parse is a
  // MISS, so the caller re-fetches it — and never a batch-wide throw that would
  // lose the thirty-nine good rows beside it.
  it('drops a corrupt row on the cache store rather than failing the batch', async () => {
    const db = await fresh()
    const cache = d1CacheStore(db, { now: () => 5_000 })
    await cache.writeWithTtl('quote:GOOD', { price: 1 }, 600)
    await cache.writeRaw('quote:BROKEN', '{"value":', 9_000)
    const got = await cache.readMany(['quote:GOOD', 'quote:BROKEN'])
    expect(got.has('quote:BROKEN')).toBe(false)
    expect(got.has('quote:GOOD')).toBe(true)
    db.close()
  })

  it('the app store still THROWS on a corrupt row — its callers write back what they read', async () => {
    const db = await fresh()
    const app = d1AppStore(db)
    await app.writeRaw('licences', '{"key":')
    await expect(app.readMany(['licences'])).rejects.toThrow(/corrupt JSON/)
    db.close()
  })

  it('chunks past SQLite’s bound-variable ceiling instead of throwing', async () => {
    const db = await fresh()
    const cache = d1CacheStore(db, { now: () => 5_000 })
    const keys = Array.from({ length: 1200 }, (_, i) => `k:${i}`)
    for (const k of keys.slice(0, 5)) await cache.writeWithTtl(k, { k }, 600)
    const got = await cache.readMany(keys)
    expect(got.size).toBe(5)
    db.close()
  })
})

async function rowCount(db: D1Database, store: string): Promise<number> {
  const r = await db.prepare('SELECT count(*) AS n FROM blobs WHERE store = ?1').bind(store).first<{ n: number }>()
  return r?.n ?? 0
}
