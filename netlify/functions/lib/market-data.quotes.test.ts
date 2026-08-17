import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUOTE_CONCURRENCY, QUOTE_LKG_TTL_SEC, quoteLkgKey, routeRequest } from '../market-data.mts'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { ensureD1Schema, type D1Database } from './d1Store'
import { useBlobStore, useD1Store } from './storeProvider'
import type { Quote } from '../../../shared/types'

// DEFECT 2, live: a 15-symbol batch came back with most rows null. Every
// upstream failure was swallowed by `catch { return null }`, the empty result
// rode the 60s cache and the client's 120s slice, and the app's most-opened
// screen showed "—" on rows whose price we had had minutes earlier.

const q = (symbol: string, over: Partial<Quote> = {}): Quote => ({
  symbol, price: 100, prevClose: 99, changePct: 1, currency: 'USD', todayVolume: null, asOf: 1_700_000_000, source: 'finnhub', ...over,
})

const env = { APP_TOKEN: 'secret', FINNHUB_API_KEY: 'fk' }

/** Instrumented upstream: counts attempts per symbol and watches how many calls
 * are in flight at once. `fail` decides which attempt (if any) throws. */
function mkDeps(fail: (sym: string, attempt: number) => boolean = () => false) {
  const attempts = new Map<string, number>()
  const state = { inFlight: 0, peak: 0 }
  const finnhub = vi.fn(async (sym: string) => {
    const n = (attempts.get(sym) ?? 0) + 1
    attempts.set(sym, n)
    state.inFlight++
    state.peak = Math.max(state.peak, state.inFlight)
    try {
      await new Promise(r => setTimeout(r, 4))
      if (fail(sym, n)) throw new Error('upstream-boom')
      return q(sym)
    } finally {
      state.inFlight--
    }
  })
  const yahoo = vi.fn(async (sym: string) => ({ candles: [], quote: q(sym, { source: 'yahoo' }) }))
  return { deps: { finnhub, yahoo }, attempts, state }
}

const quotes = (symbols: string[], deps: unknown) =>
  routeRequest(new URL(`http://x/api/market?type=quote&symbols=${symbols.join(',')}`), new Headers({ 'x-app-token': 'secret' }), env, deps as never)

const served = async (symbols: string[], deps: unknown): Promise<(Quote | null)[]> => (await (await quotes(symbols, deps)).json()).data.quotes

// Every test uses its own symbols: the 60s quote cache and the 72h last-known-
// good rows are module state shared by the whole file.
let n = 0
const syms = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag}${n}X${i}`)
beforeEach(() => {
  n++
})

describe('quote batch — the fan-out is bounded', () => {
  it('never has more than QUOTE_CONCURRENCY upstream calls in flight, and QUOTE_CONCURRENCY is 4', async () => {
    expect(QUOTE_CONCURRENCY).toBe(4)
    const s = syms(15, 'CONC')
    const { deps, state } = mkDeps()
    const out = await served(s, deps)
    expect(out.map(x => x?.symbol)).toEqual(s) // input order, every row filled
    expect(deps.finnhub).toHaveBeenCalledTimes(15)
    expect(state.peak).toBeLessThanOrEqual(QUOTE_CONCURRENCY)
    expect(state.peak).toBeGreaterThan(1) // …and it is still a fan-out, not a queue of one
  })
})

describe('quote batch — one retry, then the last-known-good tier', () => {
  it('retries a failed symbol exactly once, and serves it fresh when the retry lands', async () => {
    const [flaky, steady] = syms(2, 'RETRY')
    const { deps, attempts } = mkDeps((sym, attempt) => sym === flaky && attempt === 1)
    const out = await served([flaky, steady], deps)
    expect(out[0]).not.toBeNull()
    expect(out[0]!.stale).toBeUndefined() // a retry that landed is FRESH, not stale
    expect(attempts.get(flaky)).toBe(2)
    expect(attempts.get(steady)).toBe(1)
  })

  it('gives up after the one retry — a dead symbol is never called a third time', async () => {
    const [dead] = syms(1, 'DEAD')
    const { deps, attempts } = mkDeps(sym => sym === dead)
    const out = await served([dead], deps)
    expect(out[0]).toBeNull() // never seen before, so there is nothing to serve
    expect(attempts.get(dead)).toBe(2)
  })

  it('serves the last-known-good row, marked stale, with its ORIGINAL asOf', async () => {
    const [sym] = syms(1, 'LKG')
    const { setCached, getCached } = await import('./cache')
    await setCached(quoteLkgKey(sym), q(sym, { price: 42.5, asOf: 1_600_000_000 }), QUOTE_LKG_TTL_SEC)
    const { deps } = mkDeps(() => true)
    const out = await served([sym], deps)
    expect(out[0]).toMatchObject({ symbol: sym, price: 42.5, asOf: 1_600_000_000, stale: true })
    // …and the failure wrote NOTHING to the fresh 60s row
    expect(await getCached(`quote:${sym}`)).toBeNull()
  })

  it('writes the last-known-good row on every successful fetch, and it outlives a weekend', async () => {
    const [sym] = syms(1, 'WRITE')
    const { getCached } = await import('./cache')
    const { deps } = mkDeps()
    await served([sym], deps)
    expect(await getCached<Quote>(quoteLkgKey(sym))).toMatchObject({ symbol: sym, price: 100 })
    expect(QUOTE_LKG_TTL_SEC).toBe(259_200) // 72h — Friday's close is still there on Monday

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 2 * 3_600_000) // +2h: the 60s row is long gone…
      expect(await getCached(`quote:${sym}`)).toBeNull()
      expect(await getCached(quoteLkgKey(sym))).not.toBeNull() // …the lkg row is not
      vi.setSystemTime(Date.now() + 71 * 3_600_000) // +73h
      expect(await getCached(quoteLkgKey(sym))).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fresh cached row is served as-is — never re-fetched, never overwritten by a neighbour’s failure', async () => {
    const [cached, dead] = syms(2, 'FRESH')
    const { setCached, getCached } = await import('./cache')
    await setCached(`quote:${cached}`, q(cached, { price: 7.77, asOf: 1_650_000_000 }), 60)
    const { deps } = mkDeps(() => true)
    const out = await served([cached, dead], deps)
    expect(out[0]).toMatchObject({ price: 7.77, asOf: 1_650_000_000 })
    expect(out[0]!.stale).toBeUndefined()
    expect(deps.finnhub).not.toHaveBeenCalledWith(cached, expect.anything())
    expect(await getCached<Quote>(`quote:${cached}`)).toMatchObject({ price: 7.77 })
  })

  it('nulls ONLY the symbols nobody has ever seen', async () => {
    const [ok, known, never] = syms(3, 'MIX')
    const { setCached } = await import('./cache')
    await setCached(quoteLkgKey(known), q(known, { price: 11 }), QUOTE_LKG_TTL_SEC)
    const { deps } = mkDeps(sym => sym !== ok)
    const out = await served([ok, known, never], deps)
    expect(out[0]).toMatchObject({ symbol: ok, price: 100 })
    expect(out[0]!.stale).toBeUndefined()
    expect(out[1]).toMatchObject({ symbol: known, price: 11, stale: true })
    expect(out[2]).toBeNull()
    expect(out.filter(x => x === null)).toHaveLength(1) // one null, for one never-seen name
  })
})

// The lkg reads are a SET read, not fifteen. Under Netlify Blobs there is no
// multi-get to reach for; under D1 there is, and the failed set must cost one
// round trip however many symbols are in it.
describe('quote batch — the last-known-good set is read in ONE statement on D1', () => {
  let db: (D1Database & { close(): void }) | null = null
  const seen: string[] = []

  afterEach(() => {
    useBlobStore()
    db?.close()
    db = null
    seen.length = 0
  })

  it('issues a single `key IN (…)` select for the whole failed set', async () => {
    const real = openSqliteD1(':memory:')
    await ensureD1Schema(real)
    db = {
      prepare: (sql: string) => {
        seen.push(sql)
        return real.prepare(sql)
      },
      close: () => real.close(),
    }
    useD1Store(db)

    const s = syms(6, 'D1')
    const { setCached } = await import('./cache')
    for (const sym of s) await setCached(quoteLkgKey(sym), q(sym, { price: 5 }), QUOTE_LKG_TTL_SEC)
    seen.length = 0

    const { deps } = mkDeps(() => true)
    const out = await served(s, deps)
    expect(out.every(r => r?.stale === true)).toBe(true)
    expect(out.map(r => r?.symbol)).toEqual(s)

    const selects = seen.filter(sql => sql.trim().toUpperCase().startsWith('SELECT'))
    expect(selects.filter(sql => /key IN \(/i.test(sql))).toHaveLength(1)
    // …and the ONLY other reads are the six 60s-cache lookups the batch always
    // did: the last-known-good tier adds one statement, not one per symbol.
    expect(selects).toHaveLength(1 + s.length)
  })
})
