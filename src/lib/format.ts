import { CAP_COHORT_LABEL, capCohortOf } from '../../shared/engine/capClass'
import type { EmptySideReason } from '../../shared/engine/types'

export function fmtPrice(price: number, currency: string): string {
  if (currency === 'GBp') return `${price.toFixed(1)}p`
  const sym = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : `${currency} `
  const num = price >= 1000 ? price.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : price.toFixed(2)
  return `${sym}${num}`
}

export function fmtPct(p: number): string {
  const sign = p >= 0 ? '+' : '−'
  return `${sign}${Math.abs(p).toFixed(2)}%`
}

/** Risk percentages are HALVED for demoted rows, so the ladder's 1.25% becomes
 * 0.625% — a number no UI should print raw. Two places, trailing zeros dropped. */
export function fmtRiskPct(p: number): string {
  return String(Math.round(p * 100) / 100)
}

/** Market-cap band from $M — identification chip for engine calls. */
export function capBand(capUsdM: number | null | undefined): string | null {
  if (capUsdM == null) return null
  if (capUsdM < 300) return 'micro cap'
  if (capUsdM < 2000) return 'small cap'
  if (capUsdM < 10_000) return 'mid cap'
  return 'large cap'
}

/** Large- vs small-cap cohort label from $M — delegates to the shared cohort rule
 * (shared/engine/capClass) so the display sleeves and the engine's learning
 * cohorts use the SAME $2B boundary and can't drift apart. */
export function capCohort(capUsdM: number | null | undefined): 'Large-cap' | 'Small-cap' | 'Unknown' {
  return CAP_COHORT_LABEL[capCohortOf(capUsdM)]
}

/** Why a side of the board carries nothing tradeable, in the reader's words.
 * The engine records the reason (buildBoard's assembly) because "nothing cleared
 * the gates" is simply false when the truth is "something did, and an ISA cannot
 * place it" — or "something did, and our own dip read outranked it" — and a card
 * that says the wrong one teaches the reader to distrust the right one. */
export function emptySideLine(side: 'long' | 'short', reason: EmptySideReason): string {
  if (reason === 'no-route') return `Nothing tradeable on the ${side} side today — the candidates have no ISA route.`
  if (reason === 'dip-lane') return `Nothing tradeable on the ${side} side today — the dip read outranked the shorts we had.`
  return `Nothing cleared the gates on the ${side} side today.`
}

/** Raw fetch/parse exceptions must never reach the screen — "SyntaxError:
 * Unexpected token '<'" is developer console text, not product copy. */
export function humanError(raw: unknown): string {
  const s = String((raw as Error)?.message ?? raw ?? '')
  if (/unexpected token|not valid json|<!doctype|json\.parse/i.test(s)) return 'live data unavailable right now'
  if (/failed to fetch|networkerror|load failed|network request/i.test(s)) return 'no connection — will retry'
  if (/http-401|http-403|unauthori[sz]ed/i.test(s)) return 'licence check failed — re-enter your key in Settings'
  if (/http-429/.test(s)) return 'rate-limited upstream — back shortly'
  if (/http-5\d\d|502|503/.test(s)) return 'server hiccup — retrying shortly'
  return s.length > 90 ? `${s.slice(0, 90)}…` : s || 'something went wrong'
}
