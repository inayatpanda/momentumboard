import type { Candle } from '../types'
import { DEFAULT_WEIGHTS } from './composite'
import { clamp, round1, type FactorName, type PredOutcome, type Prediction } from './types'

// The learning loop, all deterministic: outcomes fill calibration buckets
// (score → realized win rate becomes tomorrow's probability) and factor IC
// stats (factors that kept being right earn weight — slowly, within bounds).

export type Band = '25-40' | '40-55' | '55-70' | '70+'

export interface BucketStat { n: number; hits: number }

export interface CalibrationState {
  buckets: Record<string, BucketStat> // `${side}:${regime}:${band}`
  brier: { date: string; mean: number; n: number }[]
  seeded?: boolean
}

export function bandFor(absComposite: number): Band {
  if (absComposite >= 70) return '70+'
  if (absComposite >= 55) return '55-70'
  if (absComposite >= 40) return '40-55'
  return '25-40'
}

const MIN_BUCKET_N = 15
const laplace = (b: BucketStat) => (b.hits + 2) / (b.n + 4)

export function probabilityFor(
  state: CalibrationState,
  side: 'long' | 'short',
  regime: string,
  absComposite: number,
): { p: number; n: number; provisional: boolean } {
  const band = bandFor(absComposite)
  const own = state.buckets[`${side}:${regime}:${band}`]
  if (own && own.n >= MIN_BUCKET_N) return { p: laplace(own), n: own.n, provisional: false }
  // pool the band across regimes — regime-specific truth needs evidence first
  const pooled: BucketStat = { n: 0, hits: 0 }
  for (const [key, b] of Object.entries(state.buckets)) {
    if (key.startsWith(`${side}:`) && key.endsWith(`:${band}`)) {
      pooled.n += b.n
      pooled.hits += b.hits
    }
  }
  return { p: laplace(pooled), n: pooled.n, provisional: pooled.n < MIN_BUCKET_N }
}

export function gradeFor(p: number, provisional: boolean, capacityPct: number): 'A' | 'B' | 'C' | null {
  if (p >= 0.62 && !provisional && capacityPct >= 8) return 'A'
  if (p >= 0.55) return 'B'
  if (p >= 0.5) return 'C'
  return null // the engine has no edge in this bucket — suppress, don't dress up
}

/** Outcome vs what price actually did: excess return over SPY, side-adjusted;
 * a stop CLOSE-through is a miss forever — recoveries after don't count. */
export function gradePrediction(
  pred: { date: string; side: 'long' | 'short'; priceAtPrediction: number; stop: number },
  candles: Candle[],
  spyCandles: Candle[],
  horizon: 5 | 10,
): PredOutcome | null {
  const dayEpoch = Date.parse(pred.date) / 1000
  const entryIdx = candles.findIndex(c => c.t >= dayEpoch)
  if (entryIdx === -1 || entryIdx + horizon >= candles.length) return null
  const spyIdx = spyCandles.findIndex(c => c.t >= dayEpoch)
  if (spyIdx === -1 || spyIdx + horizon >= spyCandles.length) return null

  const price = pred.priceAtPrediction
  const rawPct = ((candles[entryIdx + horizon].c - price) / price) * 100
  const spyBase = spyCandles[Math.max(spyIdx - 1, 0)].c
  const spyPct = ((spyCandles[spyIdx + horizon].c - spyBase) / spyBase) * 100

  // GRADING is close-based: a wick through the stop is survivable noise (1.5×ATR
  // sits inside normal weekly range on these names — replay evidence 2026-07-02:
  // intraday-pierce grading scored directional judgment as coin-flip misses).
  // EXECUTION advice on prediction cards is unchanged: the stop remains a hard
  // intraday level for anyone actually in the trade.
  let stopped = false
  for (let i = entryIdx; i <= entryIdx + horizon; i++) {
    if (pred.side === 'long' ? candles[i].c <= pred.stop : candles[i].c >= pred.stop) {
      stopped = true
      break
    }
  }
  const sign = pred.side === 'short' ? -1 : 1
  const excessPct = round1(sign * (rawPct - spyPct))
  return { excessPct, rawPct: round1(rawPct), spyPct: round1(spyPct), stopped, hit: !stopped && excessPct > 0 }
}

export function updateCalibration(
  state: CalibrationState,
  pred: { side: string; regime: string; composite: number },
  outcome: PredOutcome,
): CalibrationState {
  const key = `${pred.side}:${pred.regime}:${bandFor(Math.abs(pred.composite))}`
  const b = state.buckets[key] ?? { n: 0, hits: 0 }
  state.buckets[key] = { n: b.n + 1, hits: b.hits + (outcome.hit ? 1 : 0) }
  return state
}

// ---- factor weight learning ----

export interface IcStat { nAgree: number; sumAgree: number; nDisagree: number; sumDisagree: number }

export interface WeightsState {
  base: Record<FactorName, number>
  current: Record<FactorName, number>
  ic: Record<FactorName, IcStat>
  gradedSinceNudge: number
  history: { date: string; changes: Record<string, { from: number; to: number; ic: number }>; evidence: string }[]
}

const FACTOR_NAMES = Object.keys(DEFAULT_WEIGHTS) as FactorName[]

export function initWeights(base: Record<FactorName, number> = DEFAULT_WEIGHTS): WeightsState {
  return {
    base: { ...base },
    current: { ...base },
    ic: Object.fromEntries(FACTOR_NAMES.map(f => [f, { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }])) as Record<FactorName, IcStat>,
    gradedSinceNudge: 0,
    history: [],
  }
}

export function updateIcStats(state: WeightsState, pred: Prediction, outcome: PredOutcome): WeightsState {
  for (const name of FACTOR_NAMES) {
    const f = pred.factors[name]
    if (!f || f.score == null || f.score === 0) continue
    const agree = f.score > 0 === (pred.side === 'long')
    const st = state.ic[name] ?? { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }
    if (agree) {
      st.nAgree++
      st.sumAgree += outcome.excessPct
    } else {
      st.nDisagree++
      st.sumDisagree += outcome.excessPct
    }
    state.ic[name] = st
  }
  state.gradedSinceNudge++
  return state
}

const NUDGE_EVERY = 15 // graded predictions between weight adjustments
const MIN_IC_N = 20
const NUDGE_STEP = 0.15

/** Bounded, slow, evidenced: weights drift toward factors that kept being
 * right, never beyond [0.4×, 2×] of their base — no whipsawing, no runaway. */
export function maybeNudgeWeights(state: WeightsState, dateISO: string): WeightsState {
  if (state.gradedSinceNudge < NUDGE_EVERY) return state
  const changes: Record<string, { from: number; to: number; ic: number }> = {}
  for (const name of FACTOR_NAMES) {
    const st = state.ic[name]
    if (!st || st.nAgree + st.nDisagree < MIN_IC_N) continue
    const meanAgree = st.nAgree ? st.sumAgree / st.nAgree : 0
    const meanDisagree = st.nDisagree ? st.sumDisagree / st.nDisagree : 0
    const ic = clamp((meanAgree - meanDisagree) / 10, -1, 1)
    const cur = state.current[name]
    const next = clamp(cur * (1 + NUDGE_STEP * ic), 0.4 * state.base[name], 2 * state.base[name])
    if (Math.abs(next - cur) > 1e-9) {
      changes[name] = { from: Math.round(cur * 1000) / 1000, to: Math.round(next * 1000) / 1000, ic: Math.round(ic * 100) / 100 }
      state.current[name] = next
    }
  }
  state.history.push({ date: dateISO, changes, evidence: `${state.gradedSinceNudge} predictions graded since last nudge` })
  if (state.history.length > 100) state.history = state.history.slice(-100)
  state.gradedSinceNudge = 0
  return state
}

export function brierPoint(preds: { probability: number; outcome5?: PredOutcome }[]): number | null {
  const graded = preds.filter(p => p.outcome5)
  if (!graded.length) return null
  const sum = graded.reduce((s, p) => s + (p.probability - (p.outcome5!.hit ? 1 : 0)) ** 2, 0)
  return sum / graded.length
}
