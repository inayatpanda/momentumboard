import type { Candle } from './types'
import { sma, rsi, atr, emaLast } from './indicators'
import { detectSetups, EQUITY_SETUP_WINDOWS, type SetupWindows } from './setups'

// Where is a stock IN its move? The reversal-first read: reward names that are
// basing / turning up / pulling back into support; penalise names that have
// already climbed and are extended, overbought and near their highs — those are
// chases, not entries, whatever their momentum. Volume tells us if a move is real.

export type Stage =
  | 'early-reversal' // basing after decline, now turning up on volume — the prize
  | 'basing' // coiling after a decline, no trigger yet — watch
  | 'pullback' // healthy dip in an uptrend, near support — a buy zone
  | 'trending' // advancing, not extended — fine but not an ideal fresh entry
  | 'extended' // stretched above the 20-day, overbought — chasing here is poor R:R
  | 'exhausted' // very extended AND pinned at range highs — reversal/fade risk
  | 'falling-knife' // still dropping, oversold, no turn yet — wait
  | 'weak' // below the 50-day, drifting — avoid

export type EntryQuality = 'early' | 'neutral' | 'chase' | 'wait'

/** Do the timeframes AGREE? Price above the 20-day SMA is one horizon's opinion;
 * price > 8 > 21 > 50 is every horizon pointing the same way, which is a
 * different and stronger statement. `aligned` is deliberately strict — a tie is
 * not an alignment — and deliberately null-not-mixed when a leg is unknown,
 * because a missing 50-EMA is an absence of evidence, not evidence of disorder. */
export interface EmaStack {
  e8: number | null
  e21: number | null
  e50: number | null
  aligned: 'bull' | 'bear' | 'mixed' | null
}

export interface TechnicalRead {
  sym: string
  price: number | null
  rsi: number | null
  pctFrom20d: number | null // +ve = above the 20-day (extension)
  pctFrom50d: number | null
  atrMultFrom20d: number | null // how many ATRs above/below the 20-day
  rangePos: number | null // 0 = at 60-day low, 1 = at 60-day high
  rvol: number | null // last session volume vs 20-day average
  volumeConfirmed: boolean // move backed by above-average volume
  emaStack: EmaStack // 8/21/50 EMAs and whether the timeframes agree
  volThrust: number | null // mean volume of the last 5 sessions vs the 20 before them
  setups: string[]
  stage: Stage
  entryQuality: EntryQuality
  note: string // one-line plain-English read for the paper
}

const lastOf = <T,>(a: T[]): T | undefined => a[a.length - 1]

const round2 = (x: number) => Math.round(x * 100) / 100

/** THE BAR WINDOWS the technical read is measured over (Stage 1c Phase B, Task
 * B2) — the same argument as `SetupWindows` one layer down, and the same
 * promise: the DEFAULT is the equity profile, every existing call site omits
 * the argument, and an equity read is byte-for-byte what it always was.
 *
 * A 24/7 tape prints seven bars a week where an exchange prints five, so
 * reading these numbers unchanged on a coin silently shortens every span by
 * 30%. The crypto profile is built in `shared/engine/cryptoLane.ts` from B1's
 * `CRYPTO_LOOKBACKS` table, which adjudicated each of these one at a time — the
 * RSI period, notably, does NOT scale.
 *
 * `setups` rides inside because `technicalStage` is what calls `detectSetups`,
 * and the stage cascade reads BOTH: a technical read on the crypto clock whose
 * setups were still on the equity clock would be one function reasoning about
 * two calendars. */
export interface TechWindows {
  readonly sma20: number
  readonly sma50: number
  readonly atr: number
  /** FIXED at 14 in both profiles — see CRYPTO_LOOKBACKS.rsi14. */
  readonly rsi: number
  /** "Where in its range" — the range. */
  readonly range: number
  /** The volume baseline today's volume is read against (today excluded). */
  readonly rvolBaseline: number
  readonly ema8: number
  readonly ema21: number
  readonly ema50: number
  readonly thrustRecent: number
  readonly thrustBase: number
  /** Below this many bars there is no read at all. */
  readonly minHistory: number
  readonly setups: SetupWindows
}

export const EQUITY_TECH_WINDOWS: TechWindows = {
  sma20: 20,
  sma50: 50,
  atr: 14,
  rsi: 14,
  range: 60,
  rvolBaseline: 20,
  ema8: 8,
  ema21: 21,
  ema50: 50,
  thrustRecent: 5,
  thrustBase: 20,
  minHistory: 30,
  setups: EQUITY_SETUP_WINDOWS,
}

/** The stack is read off the ROUNDED EMAs, not the raw ones, so the verdict and
 * the three numbers printed beside it can never disagree — a reader must never
 * see `e8 100, e21 100, aligned bull`. The PRICE leg is rounded for the same
 * reason and no other: a close a fifth of a cent above the printed 8-EMA is not
 * a fourth timeframe agreeing, it is a rounding artefact, and the card would
 * have shown the two numbers as equal while the verdict claimed a chain. */
function emaStackOf(closes: number[], price: number, w: TechWindows = EQUITY_TECH_WINDOWS): EmaStack {
  const at = (p: number) => {
    const e = emaLast(closes, p)
    return e == null ? null : round2(e)
  }
  const [e8, e21, e50] = [at(w.ema8), at(w.ema21), at(w.ema50)]
  const p = round2(price)
  const aligned =
    e8 == null || e21 == null || e50 == null ? null // an unknown is not a verdict
    : p > e8 && e8 > e21 && e21 > e50 ? 'bull'
    : p < e8 && e8 < e21 && e21 < e50 ? 'bear'
    : 'mixed'
  return { e8, e21, e50, aligned }
}

/** THE MULTI-DAY PARTICIPATION MEASURE, and the thing `rvol` is not. `rvol` asks
 * whether TODAY was loud against a 20-day average; on a swing horizon the useful
 * question is whether the crowd has been arriving for a WEEK. A name can print a
 * 0.6 rvol into a 2× thrust (the loud days were Monday to Thursday) and a 3.0
 * rvol into a flat one (one headline, nobody stayed). Today is inside the recent
 * window on purpose — this measures the week, not a baseline to judge today by. */
function volThrustOf(vols: number[], w: TechWindows = EQUITY_TECH_WINDOWS): number | null {
  const recent = vols.slice(-w.thrustRecent)
  const base = vols.slice(-(w.thrustRecent + w.thrustBase), -w.thrustRecent)
  if (recent.length < w.thrustRecent || base.length < w.thrustBase) return null
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
  const baseMean = mean(base)
  if (baseMean <= 0) return null // a ratio on nothing is not a number
  return round2(mean(recent) / baseMean)
}

export function technicalStage(sym: string, candles: Candle[], w: TechWindows = EQUITY_TECH_WINDOWS): TechnicalRead | null {
  if (!candles || candles.length < w.minHistory) return null
  const closes = candles.map(c => c.c)
  const vols = candles.map(c => c.v)
  const price = lastOf(closes)!
  const r = lastOf(rsi(closes, w.rsi)) ?? null
  const m20 = lastOf(sma(closes, w.sma20)) ?? null
  const m50 = lastOf(sma(closes, w.sma50)) ?? null
  const a14 = lastOf(atr(candles, w.atr)) ?? null

  const pctFrom20d = m20 ? Math.round(((price - m20) / m20) * 1000) / 10 : null
  const pctFrom50d = m50 ? Math.round(((price - m50) / m50) * 1000) / 10 : null
  const atrMultFrom20d = m20 && a14 ? Math.round(((price - m20) / a14) * 10) / 10 : null

  const win = closes.slice(-w.range)
  const lo = Math.min(...win)
  const hi = Math.max(...win)
  const rangePos = hi > lo ? Math.round(((price - lo) / (hi - lo)) * 100) / 100 : null

  const avgVol20 = vols.slice(-(w.rvolBaseline + 1), -1).reduce((s, v) => s + v, 0) / w.rvolBaseline
  const rvol = avgVol20 > 0 ? Math.round((lastOf(vols)! / avgVol20) * 10) / 10 : null
  const volumeConfirmed = rvol != null && rvol >= 1.3

  // ADDITIVE ONLY (stage 2, task 1): computed and carried, consumed by nothing.
  // The stage cascade, entryQuality and note below are deliberately untouched —
  // task 2 is what teaches the score to read these.
  const emaStack = emaStackOf(closes, price, w)
  const volThrust = volThrustOf(vols, w)

  const setups = detectSetups(candles, rvol, w.setups)

  // stage: reversal-first classification
  let stage: Stage
  if (setups.includes('fallingKnife')) stage = 'falling-knife'
  else if (setups.includes('reclaim') || (setups.includes('basing') && (setups.includes('divergence') || (rvol != null && rvol >= 1.5 && price > (m20 ?? price))))) stage = 'early-reversal'
  else if (setups.includes('basing') || setups.includes('divergence')) stage = 'basing'
  else if (setups.includes('overextended') || (r != null && r >= 72 && atrMultFrom20d != null && atrMultFrom20d >= 2)) stage = rangePos != null && rangePos >= 0.9 ? 'exhausted' : 'extended'
  else if (setups.includes('pullbackZone')) stage = 'pullback'
  else if (m50 != null && price < m50 && (pctFrom50d ?? 0) < -1) stage = 'weak'
  else if (m20 != null && price > m20 && (pctFrom20d ?? 0) > 0) stage = 'trending'
  else stage = 'weak'

  const entryQuality: EntryQuality =
    stage === 'early-reversal' || stage === 'pullback' ? 'early'
    : stage === 'extended' || stage === 'exhausted' ? 'chase'
    : stage === 'falling-knife' ? 'wait'
    : 'neutral'

  const note = buildNote(stage, { r, pctFrom20d, rangePos, rvol, volumeConfirmed })
  return { sym, price, rsi: r, pctFrom20d, pctFrom50d, atrMultFrom20d, rangePos, rvol, volumeConfirmed, emaStack, volThrust, setups, stage, entryQuality, note }
}

function buildNote(stage: Stage, m: { r: number | null; pctFrom20d: number | null; rangePos: number | null; rvol: number | null; volumeConfirmed: boolean }): string {
  const vol = m.volumeConfirmed ? `volume-confirmed (RVOL ${m.rvol})` : `on light volume (RVOL ${m.rvol ?? '?'})`
  const rangeStr = m.rangePos != null ? `${Math.round(m.rangePos * 100)}% up its 60-day range` : ''
  const rsiStr = m.r != null ? Math.round(m.r) : '?'
  switch (stage) {
    case 'early-reversal':
      return `Turning up out of a base, ${vol} — the reversal-first entry, near support with room to run.`
    case 'basing':
      return `Coiling after a decline, no trigger yet (${rangeStr}). Watch for a volume reclaim of the 20-day.`
    case 'pullback':
      return `Healthy pullback in an uptrend (RSI ${rsiStr}) — buying the dip near support, not chasing.`
    case 'trending':
      return `Advancing but not extended (${m.pctFrom20d ?? '?'}% above the 20-day) — acceptable, not a fresh setup.`
    case 'extended':
      return `Already extended ${m.pctFrom20d ?? '?'}% above the 20-day, RSI ${rsiStr} — chasing here is poor risk/reward; wait for a pullback.`
    case 'exhausted':
      return `Stretched and pinned at the highs (${rangeStr}, RSI ${rsiStr}) — reversal risk; a fade candidate, not a long.`
    case 'falling-knife':
      return `Still falling, oversold, no turn confirmed — wait for a base and a reclaim before touching it.`
    case 'weak':
      return `Below the 50-day and drifting — no edge here.`
  }
}
