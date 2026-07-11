import type { RegimeColor } from '../types'
import type { Stage } from '../technicals'
import { MODERATE_GATES, type CatalystTag, type Gates } from './catalyst'
import { SMALL_CAP_MAX_USD_M } from './capClass'
import { clamp, round1, round2, type CallEvidence, type EngineCall, type FactorName, type FactorScore, type SetupFamily } from './types'

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

// Two-layer composite. CORE factors are repeatable, point-in-time market data —
// they alone decide the direction and whether a call exists. CONTEXT factors
// (social, pundits, news, 13F, catalysts) are additive colour: capped at
// CONTEXT_MAX_PTS so a loud headline can nudge conviction but never create a
// call, flip its side, or — because a missing context factor no longer
// renormalises the core — change what "the model" is from ticker to ticker.
// Context factors keep their weights and IC stats: their influence stays
// evidence-tested by the learning loop, it just stops being structural.
export const FACTOR_FAMILY: Record<FactorName, 'core' | 'context'> = {
  technical: 'core',
  momentum: 'core',
  sector: 'core', // derived entirely from market prices — belongs in the core
  seasonality: 'core', // price-derived (own candle history)
  social: 'context',
  channels: 'context',
  insiders: 'context',
  news: 'context',
  smartMoney: 'context',
  catalyst: 'context',
}

/** Max composite points the whole context layer can add or subtract. Kept
 * BELOW every dead zone (20/25) so context alone can never cross the gate,
 * and — since a gated core is ≥ the dead zone — can never flip the side. */
export const CONTEXT_MAX_PTS = 12

/** The setup shape of a call, from its side and technical stage. Longs riding
 * strength are continuation; longs buying a dip/turn are reversal; shorting
 * a stretched chart is a fade, shorting confirmed weakness is continuation
 * (down). Contrarian leftovers (long into exhaustion, short into strength —
 * mostly blocked by the entry gates anyway) count as fades. */
export function setupFamilyOf(side: 'long' | 'short', stage: Stage | null): SetupFamily | null {
  if (!stage) return null
  if (side === 'long') {
    if (stage === 'trending' || stage === 'basing') return 'continuation'
    if (stage === 'pullback' || stage === 'early-reversal') return 'reversal'
    return 'fade'
  }
  if (stage === 'weak' || stage === 'falling-knife') return 'continuation'
  return 'fade'
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
  // Evidence-contract inputs (default false — an unknown never passes a gate):
  // was the technical read's volume confirmation present, and did the run know
  // market breadth? Both feed the "at least one of sector/breadth/volume" leg.
  volumeConfirmed?: boolean
  breadthKnown?: boolean
}

/** Weighted composite over the CORE factors that have data, plus a capped
 * context nudge → a concrete call, or null. Most tickers most days are a "no":
 * dead zone, capacity gate, and side-aware entry gates all have to clear
 * before a number reaches the paper. Direction and eligibility come from the
 * core alone; context can only tilt conviction by ≤ CONTEXT_MAX_PTS. */
export function composeCall(input: ComposeInput): EngineCall | null {
  let coreNum = 0
  let coreDen = 0
  let ctxNum = 0
  let coreWeightTotal = 0
  for (const name of Object.keys(input.factors) as FactorName[]) {
    const f = input.factors[name]
    const w = input.weights[name] ?? 0
    if (FACTOR_FAMILY[name] === 'core') coreWeightTotal += w
    if (f.score == null) continue
    if (FACTOR_FAMILY[name] === 'core') {
      coreNum += w * f.score
      coreDen += w
    } else {
      ctxNum += w * f.score
    }
  }
  if (!coreDen) return null // no market-derived signal at all — context alone is never a call
  const raw = coreNum / coreDen
  const side: 'long' | 'short' = raw >= 0 ? 'long' : 'short'
  // regime mult first, then the overnight world-tape nudge (both scale conviction;
  // worldMult is > 0 so the side never flips). The regime STRING stays untouched —
  // world tape can move a call across the dead zone but never into another bucket.
  const coreAdj = raw * (side === 'long' ? LONG_REGIME_MULT[input.regime] : SHORT_REGIME_MULT[input.regime]) * (input.worldMult ?? 1)
  const gates = input.gates ?? MODERATE_GATES
  if (Math.abs(coreAdj) < gates.deadZone) return null // context can't rescue a core below the gate
  // context measured in core-composite points (its vote mass over the core's),
  // hard-capped. Like the world-tape nudge it may push a marginal call back
  // under the dead zone (→ null, correctly suppressed) — an eligibility veto,
  // never a direction: the cap is below the dead zone, so the sign holds.
  const ctxPts = clamp(ctxNum / coreDen, -CONTEXT_MAX_PTS, CONTEXT_MAX_PTS)
  const adj = coreAdj + ctxPts
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
  const smallCap = input.capUsdM != null && input.capUsdM < SMALL_CAP_MAX_USD_M
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

  // The minimum core-data contract. A call that fails it still publishes —
  // graded, learning — but as watch-only "low evidence coverage": technical
  // AND momentum present, the regime known, at least one confirming leg
  // (sector / breadth / volume), and ≥2 core families agreeing with the side.
  // Two agreeing families means technical-plus-nothing never acts alone.
  const coreFamilies = (Object.keys(FACTOR_FAMILY) as FactorName[]).filter(n => FACTOR_FAMILY[n] === 'core')
  const famAgree = coreFamilies.filter(n => {
    const s = input.factors[n]?.score
    return s != null && s !== 0 && Math.sign(s) === dir
  }).length
  const confirmingLeg = input.factors.sector?.score != null || !!input.breadthKnown || !!input.volumeConfirmed
  const contract =
    input.factors.technical?.score != null &&
    input.factors.momentum?.score != null &&
    input.regime !== 'unknown' &&
    confirmingLeg &&
    famAgree >= 2
  const coverage = coreWeightTotal ? Math.round((coreDen / coreWeightTotal) * 100) / 100 : 0
  const evidence: CallEvidence = {
    coverage,
    famAgree,
    contract,
    contextPts: round1(ctxPts),
    detail: `core coverage ${Math.round(coverage * 100)}% · ${famAgree} core famil${famAgree === 1 ? 'y' : 'ies'} agree · context ${ctxPts >= 0 ? '+' : ''}${round1(ctxPts)}pt`,
  }

  return {
    sym: input.sym,
    side,
    composite: round1(adj),
    setup: setupFamilyOf(side, input.stage),
    evidence,
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
