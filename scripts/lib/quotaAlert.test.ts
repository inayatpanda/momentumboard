// The DeepSeek-balance gap, and the marker that never expired.
//
// Both defects are in the "quiet after the first quota alert" machinery, and
// both were invisible because the logic lived inside scripts/bg/daily-run.mts,
// a module that calls `run()` at import time and therefore cannot be imported
// by a test at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteD1 } from './sqliteD1'
import { ensureD1Schema } from '../../netlify/functions/lib/d1Store'
import { useBlobStore, useD1Store } from '../../netlify/functions/lib/storeProvider'
import { getCached, setCached } from '../../netlify/functions/lib/cache'
import { QUOTA_ALERT_TTL_SEC, isQuotaShaped, quotaAlertKey, quotaAlertVerdict } from './quotaAlert'

describe('what counts as "the provider has run out"', () => {
  // The one that was missing. DeepSeek carries the entire compose chain since
  // the M3 cutover, and a dry account answers HTTP 402 "Insufficient Balance"
  // — no 429, no "rate limit", no "quota", no "credit". Three loud emails a
  // day, for the one provider whose exhaustion is most likely.
  it('recognises DeepSeek saying the account is empty', () => {
    for (const body of [
      'compose failed: all 1 LLM providers failed — openai HTTP 402: {"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
      'openai HTTP 402: Payment Required',
      'Insufficient balance',
      'insufficient_balance',
    ]) {
      expect(isQuotaShaped(body), body).toBe(true)
    }
  })

  it('still recognises the shapes it always did', () => {
    for (const body of [
      'groq HTTP 429: rate_limit_exceeded, tokens per day',
      'gemini HTTP 429: Quota exceeded for quota metric',
      'prepay balance depleted',
      'You have run out of credits',
      'openrouter HTTP 429: rate limit',
    ]) {
      expect(isQuotaShaped(body), body).toBe(true)
    }
  })

  // A real failure must stay loud on every shot — that is the whole point of
  // only suppressing the quota shape.
  it('does not swallow an ordinary failure', () => {
    for (const body of [
      'gemini HTTP 400: API key not valid',
      'D1_ERROR: no such table: blobs',
      'compose failed: no-llm-provider-configured',
      'putHtml 503',
      'fetch failed',
    ]) {
      expect(isQuotaShaped(body), body).toBe(false)
    }
  })
})

describe('the once-a-day rule', () => {
  const memory = () => {
    const m = new Map<string, { value: unknown; ttlSec: number }>()
    return {
      m,
      io: {
        getCached: async <T,>(key: string) => (m.get(key)?.value as T) ?? null,
        setCached: async (key: string, value: unknown, ttlSec: number) => void m.set(key, { value, ttlSec }),
      },
    }
  }
  const DRY = 'openai HTTP 402: Insufficient Balance'

  it('is loud the first time and quiet after that, on the same date', async () => {
    const { io } = memory()
    expect(await quotaAlertVerdict(DRY, '2026-08-13', 100, io)).toBe('loud')
    expect(await quotaAlertVerdict(DRY, '2026-08-13', 200, io)).toBe('quiet')
    expect(await quotaAlertVerdict(DRY, '2026-08-13', 300, io)).toBe('quiet')
    // Tomorrow is a new condition and deserves its own alert.
    expect(await quotaAlertVerdict(DRY, '2026-08-14', 400, io)).toBe('loud')
  })

  it('never marks — or quietens — a failure that is not about quota', async () => {
    const { m, io } = memory()
    expect(await quotaAlertVerdict('D1_ERROR: no such table', '2026-08-13', 100, io)).toBe('not-quota')
    expect(await quotaAlertVerdict('D1_ERROR: no such table', '2026-08-13', 200, io)).toBe('not-quota')
    expect(m.size).toBe(0)
  })

  it('records the marker with a TTL rather than forever', async () => {
    const { m, io } = memory()
    await quotaAlertVerdict(DRY, '2026-08-13', 100, io)
    expect([...m.keys()]).toEqual(['report-quota-alerted:2026-08-13'])
    expect(m.get(quotaAlertKey('2026-08-13'))!.ttlSec).toBe(QUOTA_ALERT_TTL_SEC)
    expect(QUOTA_ALERT_TTL_SEC).toBe(3 * 24 * 3600)
  })
})

// The marker used to be an app row with a NULL expiry — one immortal row per
// bad morning, forever, in the store that holds the licences and the ledger.
// Through the cache store it lands in the sweeper's path instead.
describe('the marker lands in the cache store, where the sweeper can reach it', () => {
  let db: ReturnType<typeof openSqliteD1>
  beforeEach(async () => {
    db = openSqliteD1(':memory:')
    await ensureD1Schema(db)
    useD1Store(db)
  })
  afterEach(() => {
    useBlobStore()
    db.close()
  })

  it('writes it to store=cache with a real expires_at three days out', async () => {
    const before = Date.now()
    expect(await quotaAlertVerdict('openai HTTP 402: Insufficient Balance', '2026-08-13', 100)).toBe('loud')

    const row = await db.prepare('SELECT store, expires_at FROM blobs WHERE key = ?1').bind(quotaAlertKey('2026-08-13')).first<{ store: string; expires_at: number | null }>()
    expect(row?.store).toBe('cache')
    expect(row?.expires_at).toBeGreaterThanOrEqual(before + QUOTA_ALERT_TTL_SEC * 1000)
    // and nothing landed in the app store
    expect(await db.prepare(`SELECT count(*) AS n FROM blobs WHERE store = 'app'`).first()).toEqual({ n: 0 })

    // the second shot of the same morning reads it back and goes quiet
    expect(await quotaAlertVerdict('openai HTTP 402: Insufficient Balance', '2026-08-13', 200)).toBe('quiet')
  })

  it('the sweeper reclaims it once it is stale — which is the point of a TTL', async () => {
    await setCached(quotaAlertKey('2026-08-01'), { at: 1 }, -1) // last week's bad morning, already expired
    const { currentCacheStore } = await import('../../netlify/functions/lib/storeProvider')
    // The cron Worker's quarter-hour tick calls exactly this. An app row with a
    // NULL expiry — what the marker used to be — is invisible to it forever.
    expect(await currentCacheStore()!.sweepExpired(100)).toBe(1)
    expect(await getCached(quotaAlertKey('2026-08-01'))).toBeNull()
    expect(await db.prepare('SELECT count(*) AS n FROM blobs').first()).toEqual({ n: 0 })
  })
})

// The extraction only helps if the script actually uses it.
describe('daily-run routes through it', () => {
  const src = readFileSync(join(__dirname, '..', 'bg', 'daily-run.mts'), 'utf8')

  it('calls the shared verdict instead of carrying its own regex', () => {
    expect(src).toContain('quotaAlertVerdict(body, today, nowSec)')
    expect(src, 'the quota regex has moved to scripts/lib/quotaAlert.ts').not.toMatch(/rate\[_ \]\?limit/)
  })

  it('no longer writes the marker into the app store', () => {
    expect(src).not.toContain('report-quota-alerted')
    expect(src).not.toMatch(/blobAppStore\.write\(alertKey/)
  })
})
