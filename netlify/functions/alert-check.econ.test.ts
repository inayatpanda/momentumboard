// WHAT A FAILED ECONOMIC CALENDAR IS WORTH, IN SECONDS.
//
// Verified live 2026-08-17: `econ-calendar` held `[]` while the upstream served
// ninety-six events. `fetchEconCalendar` swallowed every failure into an empty
// array, and the caller cached whatever it got for six hours — so a single
// refused request pinned "nothing is happening this week" into the cache and the
// macro sentinel stayed blind until the TTL expired. Real data earns the full
// TTL; a failure and a genuinely quiet week are both re-asked in ten minutes.
//
// Driven against a real sqlite-backed D1 and the real handler, reading the
// `expires_at` COLUMN — the number the platform actually enforces.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSqliteD1 } from '../../scripts/lib/sqliteD1'
import { ensureD1Schema } from './lib/d1Store'
import { useBlobStore, useD1Store } from './lib/storeProvider'
import { clearRuntimeEnv } from './lib/runtimeEnv'
import { emptyAlertState, type AlertState } from '../../shared/alerts'

/** 2026-08-13 is a Thursday; 15:00 UTC is 11:00 New York (session open) and
 * 16:00 London (outside both intraday-flag windows). */
const NOW_MS = Date.parse('2026-08-13T15:00:00Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)

const EVENT = { title: 'CPI m/m', country: 'USD', date: new Date(NOW_MS + 5 * 86_400_000).toISOString(), impact: 'High' }

describe('the econ calendar is never pinned by a failure', () => {
  let sqlite: ReturnType<typeof openSqliteD1>
  const realFetch = globalThis.fetch
  let econReply: () => Response

  const seed = (store: string, key: string, value: unknown, expiresAt: number | null = null) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(store, key, JSON.stringify(value), NOW_MS, expiresAt)
      .run()

  /** The stored envelope AND the column the platform expires on. */
  const cachedEcon = async () => {
    const row = await sqlite.prepare(`SELECT value, expires_at FROM blobs WHERE store = 'cache' AND key = 'econ-calendar'`).first<{ value: string; expires_at: number | null }>()
    if (!row) return null
    return { value: (JSON.parse(row.value) as { value: unknown }).value, ttlSec: Math.round(((row.expires_at ?? 0) - NOW_MS) / 1000) }
  }

  const tick = async () => {
    const { default: alertCheck } = await import('./alert-check.mts')
    return alertCheck(new Request('https://streetsignal.pages.dev/api/fn/alert-check', { method: 'POST', body: JSON.stringify({ next_run: new Date(NOW_MS + 300_000).toISOString() }) }))
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    clearRuntimeEnv()
    sqlite = openSqliteD1(':memory:')
    await ensureD1Schema(sqlite)
    useD1Store(sqlite)
    delete process.env.APP_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY

    await seed('app', 'config', { watchlist: [{ symbol: 'AAPL', riskClass: 'normal' }], rules: [], ytChannels: [], capital: 1000 })
    await seed('app', 'alert-state', { ...emptyAlertState(), lastBatchAt: NOW_SEC - 30 } satisfies AlertState)
    seedWarmQuote()

    econReply = () => new Response(JSON.stringify([EVENT]), { headers: { 'content-type': 'application/json' } })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('faireconomy.media')) return econReply()
      // every other leg is offline; the handler is failure-isolated per leg
      throw new Error(`network disabled in this test: ${url}`)
    }) as typeof fetch
  })

  function seedWarmQuote() {
    seed('cache', 'quote:AAPL', { value: { price: 150, changePct: 2.4, todayVolume: 1_000_000 }, expires: NOW_MS + 3_600_000 }, NOW_MS + 3_600_000)
  }

  afterEach(() => {
    globalThis.fetch = realFetch
    sqlite.close()
    useBlobStore()
    clearRuntimeEnv()
    vi.useRealTimers()
  })

  it('keeps real events for the full six hours', async () => {
    await tick()
    const stored = await cachedEcon()
    expect((stored!.value as unknown[]).length).toBe(1)
    expect(stored!.ttlSec).toBe(21_600)
  })

  it('caches a REFUSED fetch for ten minutes, not six hours', async () => {
    econReply = () => new Response('upstream on fire', { status: 503 })
    await tick()
    const stored = await cachedEcon()
    expect(stored!.value).toEqual([])
    expect(stored!.ttlSec, 'a failure was stored under the TTL only real data earns').toBe(600)
  })

  it('caches a non-feed payload for ten minutes', async () => {
    econReply = () => new Response(JSON.stringify({ error: 'rate limited' }), { headers: { 'content-type': 'application/json' } })
    await tick()
    expect((await cachedEcon())!.ttlSec).toBe(600)
  })

  it('re-asks after a quiet week too — an empty answer is cheap to re-check', async () => {
    econReply = () => new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    await tick()
    const stored = await cachedEcon()
    expect(stored!.value).toEqual([])
    expect(stored!.ttlSec).toBe(600)
  })

  it('a short-TTL empty really does expire, and the next run sees the real week', async () => {
    econReply = () => new Response('upstream on fire', { status: 503 })
    await tick()
    expect((await cachedEcon())!.ttlSec).toBe(600)

    // eleven minutes later the cache row is dead and the feed is back
    vi.setSystemTime(NOW_MS + 11 * 60_000)
    seedWarmQuote()
    econReply = () => new Response(JSON.stringify([EVENT]), { headers: { 'content-type': 'application/json' } })
    await tick()
    const row = await sqlite.prepare(`SELECT value FROM blobs WHERE store = 'cache' AND key = 'econ-calendar'`).first<{ value: string }>()
    expect((JSON.parse(row!.value) as { value: unknown[] }).value).toHaveLength(1)
  })
})
