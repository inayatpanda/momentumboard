import type { RegimeColor } from '../types'
import type { Stage } from '../technicals'
import { MODERATE_GATES, type CatalystTag, type Gates } from './catalyst'
import { SMALL_CAP_MAX_USD_M } from './capClass'
import { clamp, round1, round2, type CallEvidence, type EngineCall, type FactorName, type FactorScore, type SetupFamily } from './types'

/** THE OWNER'S ORDER: the charts speak first. Technical and momentum are the
 * two things measured directly off price, every session, for every name — they
 * lead. Catalyst and news come next because a live, dated event is the strongest
 * thing that is NOT price. Channels and social sit where they were: real, small,
 * still on trial. Sector drops to the back because a sector rank is the most
 * derivative read in the table — a name's own chart already contains most of
 * what its sector was going to say — but it STAYS in the core family: demoting
 * it out of `core` would change coreDen, coverage, famAgree and the evidence
 * contract, which is a different edit with a different blast radius.
 *
 * Changing these numbers alone would be cosmetic: `migrateWeights` only fills
 * nulls and the stored blob wins on every load, so production would keep
 * scoring the old vector. `rebaseWeights` (calibration.ts) is what makes a
 * re-order real, and it is wired into loadState. */
export const DEFAULT_WEIGHTS: Record<FactorName, number> = {
  technical: 1.0,
  momentum: 0.9,
  catalyst: 0.6, // a live, dated event — the strongest thing that isn't price
  news: 0.5,
  channels: 0.5,
  social: 0.5,
  insiders: 0.4,
  seasonality: 0.3,
  smartMoney: 0.3, // small on purpose: 13F is stale, so we EXPECT the IC loop to decay it
  sector: 0.3, // last: the most derivative read in the table, still core
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
  // dead zone and the expected-move floor so more ideas reach scoring — grading
  // is untouched.
  gates?: Gates
  // A live market-moving catalyst on this name (catalyst.ts). When present the
  // expected-move floor is relaxed by 0.5pp, because swing capacity is trailing
  // and lags the day the news actually breaks.
  catalyst?: CatalystTag | null
  // Evidence-contract inputs (default false — an unknown never passes a gate):
  // was the technical read's volume confirmation present, and did the run know
  // market breadth? Both feed the "at least one of sector/breadth/volume" leg.
  volumeConfirmed?: boolean
  breadthKnown?: boolean
}

/** ONE walk over the factor table, shared by composeCall and coreCompositeOf so
 * the "what does the core say?" arithmetic can never fork between the call the
 * engine publishes and the near miss it names. Returns raw sums, unrounded — the
 * rounding belongs to whoever produces a displayed number. */
function tallyFactors(
  factors: Record<FactorName, FactorScore>,
  weights: Record<FactorName, number>,
): { coreNum: number; coreDen: number; ctxNum: number; coreWeightTotal: number } {
  let coreNum = 0
  let coreDen = 0
  let ctxNum = 0
  let coreWeightTotal = 0
  for (const name of Object.keys(factors) as FactorName[]) {
    const f = factors[name]
    const w = weights[name] ?? 0
    if (FACTOR_FAMILY[name] === 'core') coreWeightTotal += w
    if (f.score == null) continue
    if (FACTOR_FAMILY[name] === 'core') {
      coreNum += w * f.score
      coreDen += w
    } else {
      ctxNum += w * f.score
    }
  }
  return { coreNum, coreDen, ctxNum, coreWeightTotal }
}

/** The GATE-FREE core read, UNROUNDED: the weighted core composite after regime
 * scaling, and nothing else — no context nudge, no world tape, no dead zone, no
 * expected-move floor, no entry gate. This is literally composeCall's own first half,
 * extracted so the published call and the named near miss can never fork. Null
 * when the name has no core data at all. Callers that DISPLAY the number take
 * coreCompositeOf (rounded); callers that keep computing take this. */
export function coreAdjOf(
  factors: Record<FactorName, FactorScore>,
  weights: Record<FactorName, number>,
  regime: RegimeColor | 'unknown',
): number | null {
  const { coreNum, coreDen } = tallyFactors(factors, weights)
  if (!coreDen) return null
  const raw = coreNum / coreDen
  const side: 'long' | 'short' = raw >= 0 ? 'long' : 'short'
  return raw * (side === 'long' ? LONG_REGIME_MULT[regime] : SHORT_REGIME_MULT[regime])
}

/** coreAdjOf rounded to one place — the displayed core read. Exported so the
 * board can NAME its nearest misses on a day when nothing clears the gates
 * (engine.ts): "these two came closest, and here is by how much". */
export function coreCompositeOf(
  factors: Record<FactorName, FactorScore>,
  weights: Record<FactorName, number>,
  regime: RegimeColor | 'unknown',
): number | null {
  const adj = coreAdjOf(factors, weights, regime)
  return adj == null ? null : round1(adj)
}

/** THE LEVELS, one place only. Expected move, entry, stop and target derived
 * from a conviction number, the name's swing capacity and its ATR. composeCall
 * publishes them for a real call and engine.ts prints them beside a near miss —
 * two callers, one arithmetic, so a near-miss row can never quietly drift onto
 * a different stop from the call it nearly was. `adj` carries the SIDE in its
 * sign (long ≥ 0), exactly as the composite does. */
export function levelsFor(
  adj: number,
  capacityPct: number,
  atr: number,
  lastClose: number,
  smallCap: boolean,
): { expectedMovePct: number; entry: number; stop: number; target: number } {
  const expectedMovePct = round1(Math.min(Math.abs(adj) / 100, 0.8) * capacityPct)
  const stopMult = smallCap ? 2 : 1.5 // small caps gap — give the stop room or it's noise
  const dir = adj >= 0 ? 1 : -1
  return {
    expectedMovePct,
    entry: round2(lastClose),
    stop: round2(lastClose - dir * stopMult * atr),
    target: round2(lastClose + dir * Math.max(2 * atr, (lastClose * expectedMovePct) / 100)),
  }
}

/** Weighted composite over the CORE factors that have data, plus a capped
 * context nudge → a concrete call, or null. Most tickers most days are a "no":
 * dead zone, the expected-move floor, and side-aware entry gates all have to
 * clear before a number reaches the paper. Direction and eligibility come from
 * the core alone; context can only tilt conviction by ≤ CONTEXT_MAX_PTS. */
export function composeCall(input: ComposeInput): EngineCall | null {
  const { coreNum, coreDen, ctxNum, coreWeightTotal } = tallyFactors(input.factors, input.weights)
  if (!coreDen) return null // no market-derived signal at all — context alone is never a call
  const side: 'long' | 'short' = coreNum / coreDen >= 0 ? 'long' : 'short'
  // regime mult first, then the overnight world-tape nudge (both scale conviction;
  // worldMult is > 0 so the side never flips). The regime STRING stays untouched —
  // world tape can move a call across the dead zone but never into another bucket.
  const coreAdj = coreAdjOf(input.factors, input.weights, input.regime)! * (input.worldMult ?? 1)
  const gates = input.gates ?? MODERATE_GATES
  if (Math.abs(coreAdj) < gates.deadZone) return null // context can't rescue a core below the gate
  // context measured in core-composite points (its vote mass over the core's),
  // hard-capped. Like the world-tape nudge it may push a marginal call back
  // under the dead zone (→ null, correctly suppressed) — an eligibility veto,
  // never a direction: the cap is below the dead zone, so the sign holds.
  const ctxPts = clamp(ctxNum / coreDen, -CONTEXT_MAX_PTS, CONTEXT_MAX_PTS)
  const adj = coreAdj + ctxPts
  if (Math.abs(adj) < gates.deadZone) return null
  if (input.capacityPct == null || input.atr == null || input.lastClose == null) return null

  const smallCap = input.capUsdM != null && input.capUsdM < SMALL_CAP_MAX_USD_M
  // THE LEVELS COME FIRST NOW, because the eligibility test IS one of them.
  // Eligibility used to be a flat capacity floor — "is this name volatile
  // enough?" — which sorted names by volatility CLASS and so excluded every
  // megacap that travels 5%, however much the engine liked it. The floor is the
  // move THIS call expects instead (conviction × the name's own ten-session
  // travel): a 6%-mover with real conviction is a smaller trade, not a
  // forbidden one, and a name that can only ever hand you 0.8% is no trade at
  // any conviction. Same arithmetic as the published target, computed once.
  const { expectedMovePct, entry, stop, target } = levelsFor(adj, input.capacityPct, input.atr, input.lastClose, smallCap)
  // a live catalyst earns 0.5pp of relief — the name is in play TODAY even if
  // its trailing swing capacity hasn't caught up to the news yet.
  if (expectedMovePct < gates.minExpectedMovePct - (input.catalyst ? 0.5 : 0)) return null
  // side-aware entry gates: never chase a long, never short fresh strength, knives wait
  if (input.entryQuality === 'wait') return null
  if (side === 'long' && input.entryQuality === 'chase') return null
  if (side === 'short' && (input.stage === 'early-reversal' || input.stage === 'pullback')) return null

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
  const dir = side === 'long' ? 1 : -1
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
    entry,
    stop,
    target,
    capacityPct: input.capacityPct,
    smallCap,
    earningsRisk: input.earningsWithinHorizon,
    stage: input.stage,
    note,
  }
}
