// IS IT OPEN? (dynamism wave.)
//
// One answer, asked by three callers that must never disagree: the session line
// under the page heading, the live-quote poller's "may I fetch" gate, and the
// call card's choice between "now 18.02" and "Fri close 18.02".
//
// It lives in `lib` rather than beside the session line because a hook may not
// import a screen — and because "is this exchange trading" is a fact about the
// world, not about a component.

import { isMarketOpen } from '../../shared/rvol'
import type { Exchange } from '../../shared/symbols'
import { isUsMarketHoliday } from '../../shared/usMarketHolidays'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The UTC calendar day of an instant, as YYYY-MM-DD — the form the NYSE
 * holiday calendar answers questions in. */
export const utcIsoDate = (d: Date): string => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`

/** Is this exchange trading right now? `isMarketOpen` knows the session hours
 * and weekends; the NYSE calendar knows the rest, and 15:00 UTC on Thanksgiving
 * is mid-session by the hour alone. Crypto is always true and the LSE keeps its
 * own holidays — out of scope until something prices off them, and a live quote
 * labelled "now" on an LSE bank holiday is the mildest wrong this can be. */
export function exchangeOpenNow(exchange: Exchange, nowMs: number): boolean {
  if (exchange === 'US' && isUsMarketHoliday(utcIsoDate(new Date(nowMs)))) return false
  return isMarketOpen(exchange, Math.floor(nowMs / 1000))
}
