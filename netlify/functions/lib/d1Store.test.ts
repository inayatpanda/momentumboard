import { describe, expect, it } from 'vitest'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { acquireLease, releaseLease } from './store'
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

  it('a corrupt row reads as a miss, not an exception', async () => {
    const db = await fresh()
    const store = d1AppStore(db)
    await store.writeRaw('half-written', '{"a":')
    expect(await store.read('half-written')).toBeNull()
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

async function rowCount(db: D1Database, store: string): Promise<number> {
  const r = await db.prepare('SELECT count(*) AS n FROM blobs WHERE store = ?1').bind(store).first<{ n: number }>()
  return r?.n ?? 0
}
