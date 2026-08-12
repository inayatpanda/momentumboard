import type { RegimeColor } from '../types'
import type { Horizon } from './horizon'

export type FactorName = 'technical' | 'momentum' | 'sector' | 'social' | 'channels' | 'insiders' | 'news' | 'seasonality' | 'smartMoney' | 'catalyst'

export interface FactorScore {
  score: number | null // signed −100..+100 toward LONG; null = no data (weight renormalises away)
  detail: string
}

/** The specialist shapes a call can take. Direction alone is not a setup: a
 * trend-follow long and a knife-catch long fail in different ways, so their
 * outcomes must never learn from the same bucket. 'velocity' is the momentum
 * lane's own family (velocityLane.ts) — a name bought IN FLIGHT fails
 * differently again from an ordinary continuation, which is entered on a
 * composite rather than on a break, and it is calibrated separately for it. */
export type SetupFamily = 'continuation' | 'reversal' | 'fade' | 'velocity'

/** Why one side of the board carries nothing tradeable today — recorded by the
 * engine's assembly and rendered by `emptySideLine`. Genuinely different
 * sentences, and saying the wrong one teaches the reader to distrust the right
 * one: 'gates' = nothing cleared them; 'no-route' = something did and an ISA
 * cannot place it; 'dip-lane' / 'velocity-lane' = the side HAD a live short and the
 * engine's own lane read on the same chart outranked it. The lane is named because
 * "our dip read outranked it" is false about a breakout — one rule, two sentences. */
export type EmptySideReason = 'gates' | 'no-route' | 'dip-lane' | 'velocity-lane'

/** What the composite actually stood on. coverage/famAgree describe the CORE
 * (price-derived) factors only — context factors are capped colour, and their
 * presence or absence must never change how much we trust the direction. */
export interface CallEvidence {
  coverage: number // Σ present core weight / Σ all core weight, 0..1
  famAgree: number // core families (non-null, non-zero) whose sign matches the side
  contract: boolean // the minimum core-data contract (see composite.ts)
  contextPts: number // capped context contribution actually applied to the composite
  detail: string
}

export interface EngineCall {
  sym: string
  side: 'long' | 'short'
  composite: number // signed; |x| is conviction
  factors: Record<FactorName, FactorScore & { weight: number }>
  setup: SetupFamily | null // null only when the stage read is missing
  evidence: CallEvidence
  expectedMovePct: number
  entry: number
  stop: number
  target: number
  capacityPct: number
  smallCap: boolean
  earningsRisk: boolean
  stage: string | null
  note: string
}

export interface GradedCall extends EngineCall {
  probability: number // 0..1 calibrated
  provisional: boolean
  grade: 'A' | 'B' | 'C'
  riskRung: number
  // suggested % of capital at risk: 0 when watch-only, otherwise the rung's risk
  // times the row's own fraction of it — 1 full, 0.5 for a half-size trade or a
  // velocity confirmation door, 0.25 for a velocity early door. Never a product of
  // two haircuts: the row carries the SMALLER of its tier and its lane cap.
  riskPct: number
  instrument: { ticker: string; leverage: number } | null
  paperOnly: boolean // a short with no executable mapping at the current rung
  // Published and graded but NOT a trade: grade C on thin evidence, a below-base
  // setup, or an actionable row the diversity gates did not pick. The board shows
  // it as an observation — no size, no instrument, no paper-book entry, no stop
  // alerts. A/B on the full contract trade at full size; C WITH the contract and
  // A/B WITHOUT it trade at half (engine.ts) — those are not watch rows.
  watchOnly?: boolean
  // A watch row that is fully-evidenced but priced BELOW the engine's base rate
  // (e.g. a strong long in a mixed tape the seed rates poorly). Shown so the
  // reader sees the setup; the honest reason it carries no size.
  belowBase?: boolean
}

export interface PredOutcome {
  excessPct: number // side-adjusted, vs SPY over the same window
  rawPct: number
  spyPct: number
  stopped: boolean
  hit: boolean
}

export interface Prediction extends GradedCall {
  id: string // `${date}:${sym}:${side}`
  date: string
  name?: string // company display name stamped at publication — presentation only, every surface reads it instead of re-looking it up
  modelVersion?: number // scoring/calibration epoch used to create this prediction
  regime: RegimeColor | 'unknown'
  priceAtPrediction: number
  themes?: string[] // theme tags (themes.ts) — identification, never a score
  // which clock the row runs on: 'week' = the calibrated call (graded at 10 sessions);
  // 'developing' = a watch whose SHAPE is a 2-4 week build (horizon.ts). Presentation-only taxonomy.
  horizon?: Horizon
  capUsdM?: number | null // market cap in $M when known — lets the UI band micro/small/mid/large
  shadow?: boolean // suppressed by calibration but logged anyway — the learning loop must eat even when the paper doesn't
  // The board's last resort: a name that cleared NO gate, published purely so a
  // day when nothing qualified still says what came closest. Always watch-only,
  // riskPct 0, probability = the engine's own base rate (it earned no bucket
  // read). Board-only by design — a near miss is not a prediction, so it never
  // enters the ledger and never teaches calibration, IC or the Brier trail.
  nearMiss?: true
  // The near miss's opposite number: a row that cleared EVERY gate — graded, on a
  // passing evidence contract, no print in the way — and that an ISA simply cannot
  // place. It is promoted out of the shadow set (engine.ts) only when its side
  // would otherwise be nameless, and only ever as a watch-only, zero-size,
  // route-less row. Unlike a near miss it IS a real call, so it stays in the
  // ledger and goes on teaching the buckets — but it is not takeable, and this
  // stamp is what lets every surface say so without re-deriving "no ISA route"
  // from prose: no entry/second-chance alert, no re-qualification of an open
  // trade, no "use engine levels", no agreement/conflict read, never counted as
  // one of the day's live calls.
  observation?: true
  worldTape?: { tone: string; mult: number } // overnight world-tape nudge applied to this call's conviction (bounded ±10/−15%)
  overlay?: { flag: 'boost' | 'caution' | 'veto'; reason: string }
  catalyst?: { kind: string; reason: string } // a market-moving news/event that put this name in play (catalyst.ts)
  outcome5?: PredOutcome
  outcome10?: PredOutcome
  outcome21?: PredOutcome // ~a month — the reader's actual holding period upper bound
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
export const round1 = (x: number): number => Math.round(x * 10) / 10
export const round2 = (x: number): number => Math.round(x * 100) / 100

/** Pearson correlation of two ALREADY-PAIRED samples — observation i of xs belongs
 * with observation i of ys, and whoever pairs them owns that decision (select.ts
 * pairs by tail position, hypeCluster.ts pairs by date).
 *
 * null when the samples cannot be compared at all: mismatched lengths, fewer than
 * two points, or a flat series. A zero-variance series has no correlation to
 * report, and reporting one anyway is how a constant tape ends up "moving in
 * lockstep" with everything. */
export const pearson = (xs: number[], ys: number[]): number | null => {
  const n = xs.length
  if (n < 2 || ys.length !== n) return null
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / n
  const mx = mean(xs)
  const my = mean(ys)
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    cov += a * b
    vx += a * a
    vy += b * b
  }
  if (!vx || !vy) return null
  return cov / Math.sqrt(vx * vy)
}
