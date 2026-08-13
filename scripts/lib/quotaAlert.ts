// "IS THIS A PROVIDER-QUOTA MORNING, AND HAVE I ALREADY SAID SO TODAY?"
//
// Provider quota fails all three of the morning's cron shots identically, so
// one dry account used to mail the owner three "Run failed" alerts for a single
// condition (2026-08-04). Quota does not come back between shots on its own, so
// only the FIRST quota failure of a day is loud; the later shots still RETRY —
// a mid-morning top-up composes the paper — but exit quietly if quota is still
// gone. Any non-quota failure stays loud on every shot.
//
// Extracted from scripts/bg/daily-run.mts for two reasons, both of them
// defects found in review:
//
//   1. The shape test missed DeepSeek. DeepSeek answers a dry account with
//      HTTP 402 "Insufficient Balance", which contains none of `429`,
//      `rate limit`, `quota`, `depleted` or `credit` — so the account that now
//      carries the whole compose chain was the one provider whose exhaustion
//      went loud three times a day. Adding it to a regex living inside a script
//      that runs `run()` on import is untestable; here it is one export.
//
//   2. The marker was an app row with no expiry. `report-quota-alerted:<date>`
//      is a same-day suppression and nothing ever deleted it, so the store
//      accumulated one immortal row per bad morning forever. It belongs in the
//      cache store, which has a TTL column and a sweeper (the cron Worker's
//      quarter-hour tick) that already reclaims exactly this.

import { getCached, setCached } from '../../netlify/functions/lib/cache'

/** Long enough to outlive the day it suppresses — the marker is keyed by date,
 * so it only ever needs to survive from the first shot to the last — and short
 * enough that the sweeper reclaims it. Three days covers a Friday failure whose
 * later shots run into the weekend. */
export const QUOTA_ALERT_TTL_SEC = 3 * 24 * 3600

/** The shapes a provider uses to say "you have run out".
 *
 *   429 / rate limit  every provider
 *   quota / depleted  Gemini's prepay
 *   credit            Groq, OpenRouter
 *   insufficient balance / payment required   DeepSeek (HTTP 402) — the slot
 *                     that now carries the compose chain (M3 addendum 2)
 */
const QUOTA_SHAPED = /\b429\b|\b402\b|rate[_ ]?limit|quota|depleted|credit|insufficient[ _-]?balance|payment[ _-]?required/i

export function isQuotaShaped(body: string): boolean {
  return QUOTA_SHAPED.test(body)
}

export const quotaAlertKey = (date: string) => `report-quota-alerted:${date}`

export interface QuotaAlertIo {
  getCached<T>(key: string): Promise<T | null>
  setCached(key: string, value: unknown, ttlSec: number): Promise<void>
}

/** `not-quota` — an ordinary failure; be loud, every time.
 *  `loud`      — the first quota failure today; be loud, and remember.
 *  `quiet`     — already said so today; retry happened, say nothing. */
export type QuotaAlertVerdict = 'not-quota' | 'loud' | 'quiet'

export async function quotaAlertVerdict(body: string, date: string, nowSec: number, io: QuotaAlertIo = { getCached, setCached }): Promise<QuotaAlertVerdict> {
  if (!isQuotaShaped(body)) return 'not-quota'
  const key = quotaAlertKey(date)
  if (await io.getCached(key)) return 'quiet'
  await io.setCached(key, { at: nowSec, body: body.slice(0, 500) }, QUOTA_ALERT_TTL_SEC)
  return 'loud'
}
