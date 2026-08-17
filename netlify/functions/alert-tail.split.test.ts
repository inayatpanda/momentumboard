// THE SPLIT, PROVEN FROM BOTH SIDES.
//
// alert-check delivered its alerts and then ran seven more legs in the SAME
// invocation, against the free plan's fifty subrequests — 33 of 50 production
// runs ended on 'Too many subrequests', the trending snapshot was never reached,
// and two Telegram sends were lost inside eight hours. The long tail now runs in
// alert-tail.mts on the quarter-hour trigger, with its own budget.
//
// A split is only real if the work actually MOVED: the five-minute handler must
// no longer touch any of it, and the quarter-hour one must do all of it. Both
// halves are asserted here against the same seeded store, with the tail modules
// spy-wrapped (the originals still run) and the tail's own blobs checked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSqliteD1 } from '../../scripts/lib/sqliteD1'
import { ensureD1Schema } from './lib/d1Store'
import { useBlobStore, useD1Store } from './lib/storeProvider'
import { clearRuntimeEnv } from './lib/runtimeEnv'
import { emptyAlertState, type AlertState } from '../../shared/alerts'
import type { Candle } from '../../shared/types'

const NOW_MS = Date.parse('2026-08-13T15:00:00Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)

/** Spy counters, hoisted so the mock factories below may reach them. */
const spies = vi.hoisted(() => ({ macro: 0, econ: 0, pundit: 0, reset: () => {} }))
spies.reset = () => {
  spies.macro = 0
  spies.econ = 0
  spies.pundit = 0
}

vi.mock('./lib/macroEvents', async importOriginal => {
  const mod = await importOriginal<typeof import('./lib/macroEvents')>()
  return {
    ...mod,
    detectShock: (...args: Parameters<typeof mod.detectShock>) => {
      spies.macro++
      return mod.detectShock(...args)
    },
  }
})

vi.mock('./lib/econCalendar', async importOriginal => {
  const mod = await importOriginal<typeof import('./lib/econCalendar')>()
  return {
    ...mod,
    dueMacroWarnings: (...args: Parameters<typeof mod.dueMacroWarnings>) => {
      spies.econ++
      return mod.dueMacroWarnings(...args)
    },
  }
})

vi.mock('./lib/punditCalls', async importOriginal => {
  const mod = await importOriginal<typeof import('./lib/punditCalls')>()
  return {
    ...mod,
    fetchRedditPunditPosts: (...args: Parameters<typeof mod.fetchRedditPunditPosts>) => {
      spies.pundit++
      return mod.fetchRedditPunditPosts(...args)
    },
  }
})

/** Enough daily bars for rvol/rsi/setups and the macro detectors. */
const candles = (base: number): Candle[] =>
  Array.from({ length: 60 }, (_, i) => ({ t: Math.floor((NOW_MS - (59 - i) * 86_400_000) / 1000), o: base, h: base * 1.01, l: base * 0.99, c: base + (i % 5) * 0.1, v: 1_000_000 }))

describe('the long tail moved out of the five-minute loop', () => {
  let sqlite: ReturnType<typeof openSqliteD1>
  const realFetch = globalThis.fetch
  let hits: string[]

  const seed = (store: string, key: string, value: unknown, expiresAt: number | null = null) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(store, key, JSON.stringify(value), NOW_MS, expiresAt)
      .run()

  const seedCache = (key: string, value: unknown) => seed('cache', key, { value, expires: NOW_MS + 3_600_000 }, NOW_MS + 3_600_000)

  const readApp = async <T,>(key: string): Promise<T | null> => {
    const row = await sqlite.prepare(`SELECT value FROM blobs WHERE store = 'app' AND key = '${key}'`).first<{ value: string }>()
    return row ? (JSON.parse(row.value) as T) : null
  }

  const tickAlerts = async () => {
    const { default: alertCheck } = await import('./alert-check.mts')
    return alertCheck(new Request('https://x/api/fn/alert-check', { method: 'POST', body: JSON.stringify({ next_run: 'x' }) }))
  }

  const tickTail = async () => {
    const { default: alertTail } = await import('./alert-tail.mts')
    return alertTail(new Request('https://x/api/fn/alert-tail', { method: 'POST', body: JSON.stringify({ next_run: 'x' }) }))
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    clearRuntimeEnv()
    spies.reset()
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
    // warm market data, so neither handler needs a wire for its snapshots
    seedCache('quote:AAPL', { price: 150, changePct: 2.4, todayVolume: 1_000_000 })
    seedCache('candles:AAPL:1y', { candles: candles(150) })
    for (const sym of ['CL=F', 'GC=F', '^VIX', 'DX-Y.NYB', 'NG=F']) seedCache(`candles:${sym}:1y`, { candles: candles(70) })
    // one video already discovered by the alert loop and waiting for the queue
    await seed('app', 'video-inbox', [{ url: 'https://youtube.com/watch?v=abc', title: 'NVDA to the moon', channel: 'Stocks with Josh', at: NOW_SEC - 60 }])

    hits = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      hits.push(url)
      if (url.includes('faireconomy.media')) return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
      if (url.includes('finance/trending')) return new Response(JSON.stringify({ finance: { result: [{ quotes: [] }] } }), { headers: { 'content-type': 'application/json' } })
      // every other wire (news, youtube, reddit feeds) is off; each leg is failure-isolated
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

  it('the */5 handler does not touch the tail at all any more', async () => {
    const res = await tickAlerts()
    expect(res.status).toBe(200)

    expect(spies.macro, 'the macro sentinel still ran inside the alert loop').toBe(0)
    expect(spies.econ, 'the econ calendar still ran inside the alert loop').toBe(0)
    expect(spies.pundit, 'the pundit bridge still ran inside the alert loop').toBe(0)
    expect(hits.some(u => u.includes('finance/trending')), 'the trending snapshot still ran inside the alert loop').toBe(false)
    expect(await readApp('trending')).toBeNull()
    expect(await readApp('work-queue'), 'the video queue still ran inside the alert loop').toBeNull()

    // …and it still does its OWN job: the delivered-state write is there
    expect(await readApp<AlertState>('alert-state')).not.toBeNull()
  })

  it('the */15 handler does all of it', async () => {
    const res = await tickTail()
    expect(res.status).toBe(200)

    expect(spies.macro, 'the macro sentinel never ran in the tail').toBeGreaterThan(0)
    expect(spies.econ, 'the econ calendar never ran in the tail').toBe(1)
    expect(spies.pundit, 'the pundit bridge never ran in the tail').toBe(1)
    expect(hits.some(u => u.includes('finance/trending'))).toBe(true)
    expect(await readApp<{ at: number }>('trending')).toMatchObject({ at: NOW_SEC })

    // the video the alert loop recorded is queued exactly once per tier
    const queue = (await readApp<{ kind: string; body: { url: string; mode: string } }[]>('work-queue')) ?? []
    expect(queue.map(q => q.body.mode).sort()).toEqual(['extract', 'watch'])
    expect(queue.every(q => q.kind === 'video')).toBe(true)
  })

  it('never queues the same video twice, however many times it runs', async () => {
    await tickTail()
    vi.setSystemTime(NOW_MS + 15 * 60_000) // past the tail's own slot window
    await tickTail()
    const queue = (await readApp<unknown[]>('work-queue')) ?? []
    expect(queue).toHaveLength(2) // one watch + one extract, from the first run only
  })

  it('leaves alert-state to the alert loop and keeps its own fired keys', async () => {
    const before = await readApp<AlertState>('alert-state')
    await tickTail()
    expect(await readApp<AlertState>('alert-state'), 'the tail wrote the blob the alert loop owns').toEqual(before)
    // its own list exists once it has inherited/recorded anything
    const fired = await readApp<string[]>('alert-tail-fired')
    expect(Array.isArray(fired) || fired === null).toBe(true)
  })

  // The hand-over: keys the alert loop had already fired must not fire again
  // from the new home the first time it runs.
  it('inherits the keys the alert loop had already fired', async () => {
    const key = `macro:CPI m/m:${new Date(NOW_MS).toISOString().slice(0, 10)}:am`
    await seed('app', 'alert-state', { ...emptyAlertState(), lastBatchAt: NOW_SEC - 30, seenItems: [key, 'https://example.com/a-headline'] } satisfies AlertState)
    await tickTail()
    const fired = (await readApp<string[]>('alert-tail-fired')) ?? []
    expect(fired, 'an already-fired macro warning was forgotten and will ping twice').toContain(key)
    expect(fired, 'a headline url is not this handler’s key to keep').not.toContain('https://example.com/a-headline')
  })
})
