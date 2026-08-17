// THE SUBREQUEST BILL, COUNTED.
//
// Cloudflare's free plan allows FIFTY subrequests per invocation and every D1
// binding call spends one. alert-check asked for a quote and a candle series per
// watchlist name — two reads a symbol, eighty on a forty-name watchlist — and
// the production runlog shows 33 of 50 runs ending on 'Too many subrequests'.
//
// The fix is one batched read (lib/cache.ts's `getCachedMany` → d1Store's
// `readMany`), so the snapshot assembly costs ONE statement however long the
// watchlist is. This test counts the statements the real handler issues against
// a real sqlite-backed D1, which is the only number that matters.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSqliteD1 } from '../../scripts/lib/sqliteD1'
import { ensureD1Schema, type D1Database } from './lib/d1Store'
import { useBlobStore, useD1Store } from './lib/storeProvider'
import { clearRuntimeEnv } from './lib/runtimeEnv'
import { emptyAlertState, type AlertState } from '../../shared/alerts'
import type { Candle } from '../../shared/types'

const NOW_MS = Date.parse('2026-08-13T15:00:00Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)
/** Cloudflare's free-plan ceiling — the number the production failures hit. */
const SUBREQUEST_CEILING = 50

const candles = (base: number): Candle[] =>
  Array.from({ length: 60 }, (_, i) => ({ t: Math.floor((NOW_MS - (59 - i) * 86_400_000) / 1000), o: base, h: base * 1.01, l: base * 0.99, c: base + (i % 5) * 0.1, v: 1_000_000 }))

describe('alert-check stays inside its subrequest budget', () => {
  let sqlite: ReturnType<typeof openSqliteD1>
  let sql: string[]
  const realFetch = globalThis.fetch

  /** Counts statements the way workerd counts subrequests: one per prepare. */
  const counting = (inner: D1Database): D1Database => ({
    prepare: (q: string) => {
      sql.push(q)
      return inner.prepare(q)
    },
  })

  const seed = (store: string, key: string, value: unknown, expiresAt: number | null = null) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(store, key, JSON.stringify(value), NOW_MS, expiresAt)
      .run()

  const seedCache = (key: string, value: unknown) => seed('cache', key, { value, expires: NOW_MS + 3_600_000 }, NOW_MS + 3_600_000)

  const tick = async () => {
    const { default: alertCheck } = await import('./alert-check.mts')
    return alertCheck(new Request('https://x/api/fn/alert-check', { method: 'POST', body: JSON.stringify({ next_run: 'x' }) }))
  }

  /** A watchlist of `n` names, every one of them warm in the cache. */
  const seedWatchlist = async (n: number) => {
    const syms = Array.from({ length: n }, (_, i) => `SYM${i}`)
    await seed('app', 'config', { watchlist: syms.map(symbol => ({ symbol, riskClass: 'normal' })), rules: [], ytChannels: [], capital: 1000 })
    for (const s of syms) {
      seedCache(`quote:${s}`, { price: 100, changePct: 1.2, todayVolume: 1_000_000 })
      seedCache(`candles:${s}:1y`, { candles: candles(100) })
    }
    seedCache('candles:SPY:1y', { candles: candles(500) })
    seedCache('candles:QQQ:1y', { candles: candles(400) })
    return syms
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    clearRuntimeEnv()
    sql = []
    sqlite = openSqliteD1(':memory:')
    await ensureD1Schema(sqlite)
    useD1Store(counting(sqlite))
    delete process.env.APP_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
    await seed('app', 'alert-state', { ...emptyAlertState(), lastBatchAt: NOW_SEC - 30 } satisfies AlertState)

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

  it('reads forty warm symbols in ONE statement, not eighty', async () => {
    await seedWatchlist(40)
    const seeded = sql.length
    await tick()
    const batched = sql.slice(seeded).filter(q => /key IN \(/.test(q))
    expect(batched, 'the snapshot assembly is not going through the batched read').toHaveLength(1)
    // …and no per-symbol quote/candle read went out beside it
    const perKey = sql.slice(seeded).filter(q => /key = \?2/.test(q))
    expect(perKey.length, 'a warm symbol was still read one key at a time').toBeLessThan(20)
  })

  it('costs the same whether the watchlist is five names or forty', async () => {
    await seedWatchlist(5)
    let seeded = sql.length
    await tick()
    const five = sql.length - seeded

    // a fresh store, the same handler, eight times the names
    sqlite.close()
    sql = []
    sqlite = openSqliteD1(':memory:')
    await ensureD1Schema(sqlite)
    useD1Store(counting(sqlite))
    await seed('app', 'alert-state', { ...emptyAlertState(), lastBatchAt: NOW_SEC - 30 } satisfies AlertState)
    await seedWatchlist(40)
    seeded = sql.length
    vi.setSystemTime(NOW_MS + 300_000) // past alert-check's own slot window
    await tick()
    const forty = sql.length - seeded

    expect(forty, 'the snapshot cost still scales with the watchlist').toBe(five)
    expect(forty, `a run must stay well inside the ${SUBREQUEST_CEILING}-subrequest ceiling`).toBeLessThan(SUBREQUEST_CEILING / 2)
  })
})
