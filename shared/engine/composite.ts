import type { RegimeColor } from '../types'
import type { Stage } from '../technicals'
import { MODERATE_GATES, type CatalystTag, type Gates } from './catalyst'
import { round1, round2, type EngineCall, type FactorName, type FactorScore } from './types'

export const DEFAULT_WEIGHTS: Record<FactorName, number> = {
  technical: 1.0,
  momentum: 0.8,
  sector: 0.6,
  social: 0.5,
  channels: 0.6,
  insiders: 0.4,
  news: 0.4,
  seasonality: 0.3,
  smartMoney: 0.3, // small on purpose: 13F is stale, so we EXPECT the IC loop to decay it
  catalyst: 0.5, // a live news/event vote — seeded moderate, left to the IC loop to keep or decay
}

// Regime scales conviction, by side: longs shrink as the tape reddens,
// shorts grow — but never symmetrically (shorting a green tape stays penal).
export const LONG_REGIME_MULT: Record<RegimeColor | 'unknown', number> = { green: 1.0, amber: 0.8, red: 0.55, unknown: 0.8 }
export const SHORT_REGIME_MULT: Record<RegimeColor | 'unknown', number> = { green: 0.7, amber: 0.9, red: 1.1, unknown: 0.9 }

export interface ComposeInput {
  sym: string
  factors: Record<FactorName, FactorScore>
  weights: Record<FactorName, number>
  regime: RegimeColor | 'unknown'
  capacityPct: number | null
  atr: number | null
  lastClose: number | null
  entryQuality: 'early' | 'neutral' | 'chase' | 'wait' | null
  stage: Stage | null
  earningsWithinHorizon: boolean
  capUsdM: number | null
  // Overnight world-tape nudge (worldTape.ts), bounded to {0.85, 1, 1.1}. Scales
  // conviction only — the `regime` string above (the calibration bucket key) is
  // never derived from it. Default 1 = no nudge.
  worldMult?: number
  // Risk-appetite gates (catalyst.ts). Default MODERATE. Aggressive lowers the
  // dead zone and capacity floors so more ideas reach scoring — grading is untouched.
  gates?: Gates
  // A live market-moving catalyst on this name (catalyst.ts). When present the
  // relaxed catalystCapacityFloor is used instead of the ordinary capacity floor,
  // because swing-capacity is trailing and lags the day the news actually breaks.
  catalyst?: CatalystTag | null
}

/** Weighted composite over the factors that HAVE data → a concrete call, or
 * null. Most tickers most days are a "no": dead zone, capacity gate, and
 * side-aware entry gates all have to clear before a number reaches the paper. */
export function composeCall(input: ComposeInput): EngineCall | null {
  let num = 0
  let den = 0
  for (const name of Object.keys(input.factors) as FactorName[]) {
    const f = input.factors[name]
    if (f.score == null) continue
    const w = input.weights[name] ?? 0
    num += w * f.score
    den += w
  }
  if (!den) return null
  const raw = num / den
  const side: 'long' | 'short' = raw >= 0 ? 'long' : 'short'
  // regime mult first, then the overnight world-tape nudge (both scale conviction;
  // worldMult is > 0 so the side never flips). The regime STRING stays untouched —
  // world tape can move a call across the dead zone but never into another bucket.
  const adj = raw * (side === 'long' ? LONG_REGIME_MULT[input.regime] : SHORT_REGIME_MULT[input.regime]) * (input.worldMult ?? 1)
  const gates = input.gates ?? MODERATE_GATES
  if (Math.abs(adj) < gates.deadZone) return null
  // a live catalyst earns the lower floor — the name is in play TODAY even if its
  // trailing swing-capacity hasn't caught up to the news yet.
  const capacityFloor = input.catalyst ? gates.catalystCapacityFloor : gates.capacityFloor
  if (input.capacityPct == null || input.capacityPct < capacityFloor) return null
  if (input.atr == null || input.lastClose == null) return null
  // side-aware entry gates: never chase a long, never short fresh strength, knives wait
  if (input.entryQuality === 'wait') return null
  if (side === 'long' && input.entryQuality === 'chase') return null
  if (side === 'short' && (input.stage === 'early-reversal' || input.stage === 'pullback')) return null

  const expectedMovePct = round1(Math.min(Math.abs(adj) / 100, 0.8) * input.capacityPct)
  const smallCap = input.capUsdM != null && input.capUsdM < 2000
  const stopMult = smallCap ? 2 : 1.5 // small caps gap — give the stop room or it's noise
  const entry = input.lastClose
  const dir = side === 'long' ? 1 : -1
  const stop = round2(entry - dir * stopMult * input.atr)
  const target = round2(entry + dir * Math.max(2 * input.atr, (entry * expectedMovePct) / 100))

  const contributors = (Object.entries(input.factors) as [FactorName, FactorScore][])
    .filter(([, f]) => f.score != null && f.score !== 0)
    .sort((a, b) => Math.abs((input.weights[b[0]] ?? 0) * b[1].score!) - Math.abs((input.weights[a[0]] ?? 0) * a[1].score!))
    .slice(0, 2)
  const note = contributors.map(([name, f]) => `${name}: ${f.detail}`).join(' · ') || 'composite only'

  const withWeights = Object.fromEntries(
    (Object.entries(input.factors) as [FactorName, FactorScore][]).map(([name, f]) => [name, { ...f, weight: input.weights[name] ?? 0 }]),
  ) as Record<FactorName, FactorScore & { weight: number }>

  return {
    sym: input.sym,
    side,
    composite: round1(adj),
    factors: withWeights,
    expectedMovePct,
    entry: round2(entry),
    stop,
    target,
    capacityPct: input.capacityPct,
    smallCap,
    earningsRisk: input.earningsWithinHorizon,
    stage: input.stage,
    note,
  }
}
