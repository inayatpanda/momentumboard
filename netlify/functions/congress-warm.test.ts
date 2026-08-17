// THE SCORECARD THAT STOPPED BEING GRADED.
//
// congress-warm has two jobs: sweep the disclosure feeds, and grade the
// disclosed buys against SPY. The sweep is expensive and correctly skipped when
// organic traffic has already refilled `congress:v1` in the last two hours — but
// the early return that skipped it returned from the WHOLE handler, and the
// grading block sits below it. On a site with readers, the lazy on-request
// refresh keeps that cache warm around the clock, so every scheduled invocation
// took the early exit and the scorecard was never regraded (production: 73h
// stale). Buys age into eligibility and exits move every day, so grading has to
// run on a warm invocation as well as a cold one.
//
// Driven against a real sqlite-backed D1 and the real handler, with every wire
// off: the price series the scorer reads are seeded warm in the cache store, so
// a run that tries to reach the network fails the test rather than passing on it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSqliteD1 } from '../../scripts/lib/sqliteD1'
import { ensureD1Schema } from './lib/d1Store'
import { useBlobStore, useD1Store } from './lib/storeProvider'
import { clearRuntimeEnv } from './lib/runtimeEnv'
import type { CongressScorecard, CongressTrade } from './lib/congress'

const NOW_MS = Date.parse('2026-08-17T06:10:00Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)
const day = (n: number) => new Date(NOW_MS - n * 86_400_000).toISOString().slice(0, 10)

/** An ascending [isoDate, close] series covering the last 40 days. */
const series = (from: number, to: number): [string, number][] =>
  Array.from({ length: 40 }, (_, i) => [day(39 - i), from + ((to - from) * i) / 39] as [string, number])

describe('congress-warm grades on every invocation, warm or cold', () => {
  let sqlite: ReturnType<typeof openSqliteD1>
  const realFetch = globalThis.fetch

  const seed = (store: string, key: string, value: unknown, expiresAt: number | null = null) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(store, key, JSON.stringify(value), NOW_MS, expiresAt)
      .run()

  /** The cache store's own envelope — the shape lib/cache.ts reads. */
  const seedCache = (key: string, value: unknown, ttlSec = 3600) => seed('cache', key, { value, expires: NOW_MS + ttlSec * 1000 }, NOW_MS + ttlSec * 1000)

  const trade = (o: Partial<CongressTrade> = {}): CongressTrade => ({
    politician: 'A. Member',
    chamber: 'house',
    symbol: 'NVDA',
    side: 'buy',
    amountRange: '$15,001–$50,000',
    traded: day(30),
    filed: day(20),
    ...o,
  })

  const scorecard = async () => {
    const row = await sqlite.prepare(`SELECT value FROM blobs WHERE store = 'app' AND key = 'congress-scorecard'`).first<{ value: string }>()
    return row ? (JSON.parse(row.value) as CongressScorecard) : null
  }

  const tick = async () => {
    const { default: warm } = await import('./congress-warm.mts')
    return warm(new Request('https://streetsignal.pages.dev/api/fn/congress-warm', { method: 'POST', body: JSON.stringify({ next_run: new Date(NOW_MS + 60_000).toISOString() }) }), {} as never)
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    clearRuntimeEnv()
    sqlite = openSqliteD1(':memory:')
    await ensureD1Schema(sqlite)
    useD1Store(sqlite)
    delete process.env.APP_TOKEN
    delete process.env.QUIVER_API_KEY
    delete process.env.FMP_API_KEY
    delete process.env.FINNHUB_API_KEY

    // TWO politicians, four graded buys — enough for a scorecard row (the scorer
    // wants ≥2 graded buys a politician), all older than the 5-day eligibility.
    const history: CongressTrade[] = [
      trade({ politician: 'A. Member', symbol: 'NVDA', traded: day(30) }),
      trade({ politician: 'A. Member', symbol: 'AMD', traded: day(25) }),
      trade({ politician: 'B. Senator', chamber: 'senate', symbol: 'NVDA', traded: day(20) }),
      trade({ politician: 'B. Senator', chamber: 'senate', symbol: 'AMD', traded: day(15) }),
    ]
    await seed('app', 'congress-history', history)
    // every price series the scorer needs, warm — no wire is touched
    seedCache('congress:chart:SPY', series(500, 520), 21_600)
    seedCache('congress:chart:NVDA', series(100, 140), 21_600)
    seedCache('congress:chart:AMD', series(200, 190), 21_600)

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      throw new Error(`network disabled in this test: ${url}`)
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    sqlite.close()
    useBlobStore()
    clearRuntimeEnv()
    vi.useRealTimers()
  })

  it('grades on a WARM invocation — the sweep is skipped, the scorecard is not', async () => {
    // organic traffic refilled the trades cache twenty minutes ago
    seedCache('congress:v1', { trades: [trade()], source: 'quiverquant', asOf: NOW_SEC - 20 * 60 }, 86_400)
    expect(await scorecard(), 'precondition: nothing graded yet').toBeNull()

    const res = await tick()
    expect(res.status).toBe(200)

    const written = await scorecard()
    expect(written, 'a warm invocation never reached the grading block').not.toBeNull()
    expect(written!.gradedBuys).toBe(4)
    expect(written!.rows.length).toBeGreaterThan(0)
    expect(written!.asOf).toBe(NOW_SEC)
    // …and the sweep really was skipped: the trades cache is untouched, and any
    // upstream call would have thrown out of this test's fetch stub.
    const cached = await sqlite.prepare(`SELECT value FROM blobs WHERE store = 'cache' AND key = 'congress:v1'`).first<{ value: string }>()
    expect(JSON.parse(cached!.value).value.asOf).toBe(NOW_SEC - 20 * 60)
  })

  it('regrades a scorecard that is already there — buys age in and exits move daily', async () => {
    seedCache('congress:v1', { trades: [trade()], source: 'quiverquant', asOf: NOW_SEC - 60 }, 86_400)
    await seed('app', 'congress-scorecard', { rows: [], gradedBuys: 0, skipped: 0, asOf: NOW_SEC - 73 * 3600 })

    await tick()
    const written = await scorecard()
    expect(written!.asOf, 'the stale scorecard was left where it was').toBe(NOW_SEC)
    expect(written!.gradedBuys).toBe(4)
  })

  it('a broken grade never fails the invocation', async () => {
    seedCache('congress:v1', { trades: [trade()], source: 'quiverquant', asOf: NOW_SEC - 60 }, 86_400)
    await seed('app', 'congress-history', 'not-an-array')
    const res = await tick()
    expect(res.status).toBe(200)
  })

  it('still throttles a second invocation inside its slot window', async () => {
    seedCache('congress:v1', { trades: [trade()], source: 'quiverquant', asOf: NOW_SEC - 60 }, 86_400)
    expect((await tick()).status).toBe(200)
    expect((await tick()).status).toBe(429)
  })
})
