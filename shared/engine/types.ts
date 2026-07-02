import type { RegimeColor } from '../types'

export type FactorName = 'technical' | 'momentum' | 'sector' | 'social' | 'channels' | 'insiders' | 'news' | 'seasonality' | 'smartMoney'

export interface FactorScore {
  score: number | null // signed −100..+100 toward LONG; null = no data (weight renormalises away)
  detail: string
}

export interface EngineCall {
  sym: string
  side: 'long' | 'short'
  composite: number // signed; |x| is conviction
  factors: Record<FactorName, FactorScore & { weight: number }>
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
  riskPct: number // suggested % of capital at risk
  instrument: { ticker: string; leverage: number } | null
  paperOnly: boolean // a short with no executable mapping at the current rung
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
  regime: RegimeColor | 'unknown'
  priceAtPrediction: number
  shadow?: boolean // suppressed by calibration but logged anyway — the learning loop must eat even when the paper doesn't
  worldTape?: { tone: string; mult: number } // overnight world-tape nudge applied to this call's conviction (bounded ±10/−15%)
  overlay?: { flag: 'boost' | 'caution' | 'veto'; reason: string }
  outcome5?: PredOutcome
  outcome10?: PredOutcome
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
export const round1 = (x: number): number => Math.round(x * 10) / 10
export const round2 = (x: number): number => Math.round(x * 100) / 100
