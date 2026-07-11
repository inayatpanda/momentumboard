import type { RegimeColor } from '../types'

export type FactorName = 'technical' | 'momentum' | 'sector' | 'social' | 'channels' | 'insiders' | 'news' | 'seasonality' | 'smartMoney' | 'catalyst'

export interface FactorScore {
  score: number | null // signed −100..+100 toward LONG; null = no data (weight renormalises away)
  detail: string
}

/** The three specialist shapes a call can take. Direction alone is not a
 * setup: a trend-follow long and a knife-catch long fail in different ways,
 * so their outcomes must never learn from the same bucket. */
export type SetupFamily = 'continuation' | 'reversal' | 'fade'

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
  riskPct: number // suggested % of capital at risk; 0 when watch-only
  instrument: { ticker: string; leverage: number } | null
  paperOnly: boolean // a short with no executable mapping at the current rung
  // Published and graded but NOT a trade: grade C, or the evidence contract
  // failed. The board shows it as an observation — no size, no instrument, no
  // paper-book entry, no stop alerts. Only A/B contract-passing calls act.
  watchOnly?: boolean
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
  modelVersion?: number // scoring/calibration epoch used to create this prediction
  regime: RegimeColor | 'unknown'
  priceAtPrediction: number
  themes?: string[] // theme tags (themes.ts) — identification, never a score
  capUsdM?: number | null // market cap in $M when known — lets the UI band micro/small/mid/large
  shadow?: boolean // suppressed by calibration but logged anyway — the learning loop must eat even when the paper doesn't
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
