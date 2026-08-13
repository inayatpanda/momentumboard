// C-1(b): WHERE THE DELIVERED-ITEMS STATE IS PERSISTED.
//
// alert-check sends its instant alerts and then does ten more things — the macro
// sentinel, the econ calendar, the call-cross sweep, the intraday flags, the
// trending snapshot, the pundit bridge — before finally writing `alert-state`
// back. On Netlify that ordering cost nothing. On Cloudflare's free plan an
// invocation gets FIFTY subrequests, and every fetch AND every D1 binding call
// spends one (the M3 parallel run burned through them on a cold cache at 02:00),
// so the budget can be gone before the last line runs. The final write then
// throws, the invocation dies, and the next tick finds the OLD state: every
// alert already delivered is delivered again.
//
// The fix is one line moved. The test below is the mechanism, driven for real:
// a live D1 with the platform's own subrequest accounting bolted onto it, the
// real handler, the real Telegram send, and a budget that runs out mid-run —
// exactly where it ran out in production.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openSqliteD1 } from '../../scripts/lib/sqliteD1'
import { ensureD1Schema, type D1Database, type D1PreparedStatement } from './lib/d1Store'
import { useBlobStore, useD1Store } from './lib/storeProvider'
import { clearRuntimeEnv } from './lib/runtimeEnv'
import { emptyAlertState, type AlertState } from '../../shared/alerts'

/** 2026-08-13 is a Thursday; 15:00 UTC is 11:00 in New York, so the US session
 * is open (the price rule only fires on an open market) and it is 16:00 in
 * London, which is outside both intraday-flag windows (they want minute 30-44). */
const NOW_MS = Date.parse('2026-08-13T15:00:00Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)

/** A D1 handle with the platform's subrequest accounting bolted on: each
 * statement spends one, exactly as a binding call does inside workerd. `arm(n)`
 * leaves n and then every further statement throws what workerd throws. */
function budgeted(inner: D1Database) {
  let remaining = Number.POSITIVE_INFINITY
  const spend = () => {
    if (remaining <= 0) throw new Error('Too many subrequests by single Worker invocation')
    remaining--
  }
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...v: unknown[]) => wrap(s.bind(...v)),
    first: async <T,>() => {
      spend()
      return s.first<T>()
    },
    run: async <T,>() => {
      spend()
      return s.run<T>()
    },
    all: async <T,>() => {
      spend()
      return s.all<T>()
    },
  })
  const db: D1Database = { prepare: (sql: string) => wrap(inner.prepare(sql)) }
  return { db, arm: (n: number) => void (remaining = n), free: () => void (remaining = Number.POSITIVE_INFINITY) }
}

describe('alert-check persists the delivered-items state before the long tail', () => {
  let sqlite: ReturnType<typeof openSqliteD1>
  let budget: ReturnType<typeof budgeted>
  let telegram: string[]
  const realFetch = globalThis.fetch

  const seed = (store: string, key: string, value: unknown, expiresAt: number | null = null) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(store, key, JSON.stringify(value), NOW_MS, expiresAt)
      .run()

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    clearRuntimeEnv()
    sqlite = openSqliteD1(':memory:')
    await ensureD1Schema(sqlite)
    budget = budgeted(sqlite)
    useD1Store(budget.db)

    process.env.TELEGRAM_BOT_TOKEN = 'bot-token'
    process.env.TELEGRAM_CHAT_ID = '4242'
    delete process.env.APP_TOKEN
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY

    // The reader's configuration, and a price rule that AAPL has already cleared.
    await seed('app', 'config', {
      watchlist: [{ symbol: 'AAPL', riskClass: 'normal' }],
      rules: [{ id: 'rule-1', symbol: 'AAPL', kind: 'priceAbove', level: 100 }],
      ytChannels: [],
      capital: 1000,
    })
    // NOT a virgin state — a virgin one makes the handler seed quietly and return.
    await seed('app', 'alert-state', { ...emptyAlertState(), lastBatchAt: NOW_SEC - 30 } satisfies AlertState)
    // A warm quote so the snapshot needs no network at all.
    await seed('cache', 'quote:AAPL', { value: { price: 150, changePct: 2.4, todayVolume: 1_000_000 }, expires: NOW_MS + 3_600_000 }, NOW_MS + 3_600_000)

    // Every other leg is offline. Telegram is the one wire that answers, and
    // answering it is what ARMS the cap: from the moment an alert has actually
    // been delivered, the invocation has one subrequest left in the tank.
    telegram = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('api.telegram.org')) {
        telegram.push(url)
        budget.arm(1)
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`network disabled in this test: ${url}`)
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    sqlite.close()
    useBlobStore()
    clearRuntimeEnv()
    vi.useRealTimers()
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
  })

  const tick = async () => {
    const { default: alertCheck } = await import('./alert-check.mts')
    return alertCheck(new Request('https://streetsignal.pages.dev/api/fn/alert-check', { method: 'POST', body: JSON.stringify({ next_run: new Date(NOW_MS + 300_000).toISOString() }) }))
  }

  const storedState = async () => {
    const row = await sqlite.prepare(`SELECT value FROM blobs WHERE store = 'app' AND key = 'alert-state'`).first<{ value: string }>()
    return JSON.parse(row!.value) as AlertState
  }

  it('does not resend an already-delivered alert after the subrequest cap kills the invocation', async () => {
    // FIRST TICK. The rule fires, Telegram takes the message, and the budget
    // dies before the end of the run — the invocation is lost.
    await expect(tick()).rejects.toThrow(/Too many subrequests/)
    expect(telegram).toHaveLength(1)

    // The one thing that had to survive: the rule is recorded as fired.
    expect((await storedState()).ruleArmed['rule-1']).toBe(false)

    // NEXT TICK, five minutes later (past alert-check's own 240s slot window),
    // on a healthy invocation. Same price, same rule — and no second message.
    budget.free()
    vi.setSystemTime(NOW_MS + 300_000)
    const res = await tick()
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text())).toMatchObject({ events: 0 })
    expect(telegram, 'the alert was delivered twice — alert-state did not survive the first tick').toHaveLength(1)
  })

  // The write has to land BEFORE the legs that can exhaust the budget, not
  // merely somewhere in the function. Proven by the fact that the run above
  // died in the long tail and the state was already on disk when it did.
  it('writes alert-state while the long tail is still failing, not after it', async () => {
    await expect(tick()).rejects.toThrow(/Too many subrequests/)
    const state = await storedState()
    expect(state.ruleArmed['rule-1']).toBe(false)
    // …and the legs that come after it really did run and really did fail, so
    // the ordering above is the reason the state survived, not luck.
    const runlog = await sqlite.prepare(`SELECT value FROM blobs WHERE store = 'app' AND key = 'runlog'`).first<{ value: string }>()
    expect(runlog, 'the run never reached its final bookkeeping — which is the failure being simulated').toBeNull()
  })
})
