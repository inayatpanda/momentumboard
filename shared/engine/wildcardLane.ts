import type { BucketStat } from './calibration'
import { capCohortOf, type CapCohort, type CapCohortOrUnknown } from './capClass'
import { LANE_CATALYST_KINDS, type CatalystTag } from './catalyst'
import { PUBLISHED_GATES, type FunnelNearMiss, type FunnelTraceRow } from './funnelTrace'
import type { GateAttribution } from './missLedger'
import { isRouteEtp, type LevMap } from './riskLadder'
import { round1, type GateCode } from './types'

// THE EXPERIMENT SLOT — one blocked trade, taken on purpose.
//
// Every gate in this engine accumulates CORRELATIONAL regret and nothing else.
// Stage 3a recorded which gate refused which name; Stage 3b priced those
// refusals ten sessions later — but a refusal has no stop, was never a position,
// and the excess it "cost" is therefore an upper bound on a trade nobody took
// (missLedger.ts's header, rule 2). The one thing that evidence can never become
// is CAUSAL: what would actually have happened to a reader who took the row the
// gate turned down, at a real size, with a real stop, and got stopped out of it
// half the time.
//
// This module buys exactly one of those a week. It picks ONE blocked candidate a
// day the engine already looked at and said no to, and hands it to the engine to
// publish at quarter size with a mandatory stop. Everything else about the slot —
// the size cap, the ladder exclusions, the post-mortem, the causal write-back —
// is Task 2's; this file only CHOOSES, and it chooses the same row twice from the
// same day's inputs or the walk cannot prove anything about it.
//
// THE LADDER (ratified 2026-08-14, superseding spec §4.1's priority 2):
//
//   1. A candidate blocked by EXACTLY ONE gate, preferring the gate with the
//      THINNEST miss-ledger evidence, then the highest conviction.
//   2. A candidate whose (cohort, side, regime) rung carries NO SIZED evidence —
//      the genuinely unmeasured slice. (The spec's "any 70+ composite" rung is
//      dead: the gen-2 seed put 1,398 rows in that band and the walk found it
//      UNDER-performing, so spending the slot there would systematically buy the
//      engine's worst-calibrated band instead of its least-measured one.)
//   3. A catalyst nominee whose core read JUST missed the dead zone — the join of
//      two things that already exist, and the cheapest rung to run.
//
// WHY THINNESS LEADS CONVICTION AT RUNG 1, since the plan's sentence can be read
// both ways ("the highest-|composite| candidate blocked by exactly one gate,
// preferring the gate with the thinnest ledger evidence"): read the other way
// round, the preference would only ever break an exact composite tie and would
// therefore almost never fire, which cannot be what a clause with its own
// rationale — "an unmeasured gate is exactly what the experiment is for" — was
// written to mean. The slot exists to buy causal evidence where there is least of
// it; conviction then decides WHICH row buys it. The plan's own worked hypothesis
// ("dead-zone-core has 7 priced outcomes; this tests it at composite 23") is a
// low-composite row against a thin gate, which is this ordering and not the other.
//
// PURE, and deliberately so: no store, no clock, no environment. Everything the
// choice stands on is an argument, so a test can hand it a day and a replay can
// hand it a thousand.

/** The quarter-size cap, owned here the way `VELOCITY_DOOR_CAP` is owned by
 * velocityLane.ts. It travels through `publishCall`'s EXISTING `sizeCap`
 * parameter (engine.ts) where `sizedFraction = Math.min(tierFraction, sizeCap)` —
 * a CAP, never a multiplier (the ratified v1 D4 rule).
 *
 * It is also the leverage exclusion, structurally: `mapInstrument` is only
 * reached when `sizedFraction === 1` (engine.ts), and 0.25 < 1 can never be that.
 * A wildcard therefore cannot be routed to a leveraged ETP without someone
 * changing this number, which is why the test pins the inequality and not just
 * the value. */
export const WILDCARD_SIZE_CAP = 0.25

/** How far under the dead zone still counts as "just missed" at rung 3, in
 * composite points. A nominee ten points under the gate did not miss it. */
export const WILDCARD_NEAR_DEAD_ZONE = 5

/** THE ROWS THAT ARE NOT BLOCKED TRADES.
 *
 * `PUBLISHED_GATES` (funnelTrace.ts) is already the engine's own definition of
 * "the reader got this row" — every `called-*` code plus `route-blocked` — so it
 * is reused verbatim rather than re-listed, and a future publication code joins
 * this exclusion for free. `shadow-capped` is added because it is the one code
 * that names a SAMPLING BUDGET rather than a decision: `pickShadow` dropped the
 * row past the per-side budget, so what blocked it is not a gate the experiment
 * could test, and the trace's `priorGate` (not the code) is where its real denial
 * lives.
 *
 * This is a GLOBAL exclusion, not a rung-1 discrimination: a row the reader
 * already has is not a blocked trade at any priority. */
export const WILDCARD_INELIGIBLE_GATES: ReadonlySet<GateCode> = new Set<GateCode>([...PUBLISHED_GATES, 'shadow-capped'])

/** What the engine needs handed back to publish the experiment. The near-miss row
 * travels VERBATIM: Task 2 prices it with `levelsFor(core, capacityPct, atrNow,
 * lastClose, smallCap)` — the same arithmetic composeCall and the near-miss rows
 * already use — so a wildcard can never drift onto levels of its own. */
export interface WildcardCandidate {
  miss: FunnelNearMiss
  /** Upper-cased, the way the trace and every key in this engine spell a name. */
  sym: string
  side: 'long' | 'short'
  cohort: CapCohortOrUnknown
  /** THE GATE UNDER TEST — the code its own `SYM:side` trace row carries. Never
   * null: a candidate with no trace row was not blocked by anything the engine
   * can name, and is refused the slot (see `wildcardPool`). */
  gate: GateCode
  /** `sidedCost + sidedSaved + unchecked` for that gate — the thinness rung 1
   * sorted on, carried so the hypothesis, the panel and the paper all print the
   * SAME evidence gap the choice was made on. */
  gateEvidenceN: number
  /** The nominating tag, on rung 3 only. */
  catalyst?: CatalystTag
}

export interface WildcardSelection {
  candidate: WildcardCandidate
  /** Template-built from NUMBERS and closed-union literals only (house rule — it
   * reaches the paper). No stored prose, and in particular never the catalyst's
   * `reason`, which is model output. */
  hypothesis: string
  priority: 1 | 2 | 3
}

/** The board's own facts about the day, as sets of keys. All three are refusals,
 * and all three are checked at EVERY rung. */
export interface WildcardExclusions {
  /** Base or full symbols with an earnings print inside the horizon. NEVER the
   * experiment: the engine's refusal to bet a coin flip is not a gate whose cost
   * a causal outcome could measure — it is a decision about variance, and one
   * quarter-size sample cannot argue with it (recon §7.3, ratified). Checked
   * against both the ticker and its base symbol, because `earningsSet` in
   * engine.ts is keyed by base. */
  earningsSyms?: ReadonlySet<string>
  /** `SYM:side` the board already published (engine.ts's `publishedKeys`). */
  publishedKeys?: ReadonlySet<string>
  /** Names the reader can SEE a live row on — one direction per chart, the same
   * rule the observation promotion and the near-miss rows already obey. */
  liveSyms?: ReadonlySet<string>
}

export interface WildcardInputs {
  /** The day's funnel trace, keyed `SYM:side` (funnelTrace.ts's `traceRowKey`). */
  traceRows: Readonly<Record<string, FunnelTraceRow>>
  /** The blocked-trade pool: every name that produced a real core read and
   * published nothing (engine.ts). Earnings names are already absent by
   * construction — the exclusion above is belt AND braces. */
  nearMisses: readonly FunnelNearMiss[]
  /** The day's catalyst nominations, keyed by upper-cased symbol. */
  catalystBySym: ReadonlyMap<string, CatalystTag>
  /** The HYGIENIC per-gate read (missLedger.ts's `gateAttribution`): sided rows
   * only, bare mirror rows excluded. */
  gateStats: readonly GateAttribution[]
  calibration: { buckets: Readonly<Record<string, BucketStat>> }
  regime: string
  /** The dead zone THIS run was judged against (post-feedback, gateState.ts). */
  deadZone: number
  levMap: LevMap
  /** Is a previous wildcard still open? One slot, always. */
  outstanding: boolean
  exclusions?: WildcardExclusions
}

/** engine.ts's `baseSym` (`sym.split('.')[0].split('-')[0]`), mirrored because
 * `earningsSet` is built with it and this module must ask the same question of
 * the same set. */
const baseSymOf = (sym: string): string => sym.split('.')[0].split('-')[0]

/** engine.ts's `routableShort` — an ISA can only place a short through an inverse
 * ETP, so a name with neither mapping is unroutable. */
const routableShort = (sym: string, levMap: LevMap): boolean => {
  const m = levMap[sym.toUpperCase()]
  return !!(m?.short2x || m?.short3x)
}

/** THE THINNESS OF ONE GATE: `sidedCost + sidedSaved + unchecked`.
 *
 * All three columns, because all three are what "has anyone measured this gate?"
 * means: the two that argue, and the one that says how much of the argument is
 * missing. A gate the ledger has never heard of reads 0 — the thinnest reading
 * there is, and the right one: an unmeasured gate is exactly what the slot is
 * for. Clamped per column so a corrupt blob can only ever read as LESS evidence. */
export function gateEvidenceN(stats: readonly GateAttribution[], gate: GateCode | null | undefined): number {
  if (!gate) return 0
  const g = stats.find(s => s?.gate === gate)
  if (!g) return 0
  return Math.max(0, g.cost ?? 0) + Math.max(0, g.saved ?? 0) + Math.max(0, g.unchecked ?? 0)
}

/** SIZED outcomes graded into one (cohort, side, regime) rung, across every band.
 *
 * COHORT-TAGGED KEYS ONLY (`${cohort}:${side}:${regime}:${band}`, four parts).
 * The legacy cohortless keys — the committed seed and everything graded before
 * Phase 2 — are deliberately not counted: they are precisely the evidence that
 * does NOT tell this rung apart from its neighbour, and the emptiness this rung
 * tests is the emptiness of the tagged slice (the plan's "cohort-tagged keys are
 * still empty in gen-4").
 *
 * The SIZED slice, mirroring calibration.ts's `sizedSlice` — `n − shadowN`,
 * clamped at zero. A rung whose every row was a shadow is a rung no reader was
 * ever offered, which is an empty rung by the only definition that matters here.
 * The key parse mirrors `poolBuckets` exactly (parts.length === 4), for the same
 * reason it is written there: provenance lives in the VALUE, never the key. */
export function rungSizedN(buckets: Readonly<Record<string, BucketStat>>, cohort: CapCohort, side: 'long' | 'short', regime: string): number {
  let n = 0
  for (const [key, b] of Object.entries(buckets ?? {})) {
    const parts = key.split(':')
    if (parts.length !== 4) continue
    if (parts[0] !== cohort || parts[1] !== side || parts[2] !== regime) continue
    n += Math.max(0, (b?.n ?? 0) - (b?.shadowN ?? 0))
  }
  return n
}

/** Every gate code standing against a NAME today, across both sides and the
 * side-free keys. Rung 1's discrimination asks this and not "what did its own row
 * say": a name the dead zone refused long and the expected-move floor refused
 * short was blocked by two different things, and an experiment that took the long
 * would be testing a gate the other side already contradicts. */
function gatesByName(rows: Readonly<Record<string, FunnelTraceRow>>): Map<string, Set<GateCode>> {
  const out = new Map<string, Set<GateCode>>()
  for (const [key, row] of Object.entries(rows ?? {})) {
    if (!row?.gate) continue
    const sym = key.split(':')[0]
    const seen = out.get(sym) ?? new Set<GateCode>()
    seen.add(row.gate)
    out.set(sym, seen)
  }
  return out
}

/** THE POOL — near misses that are genuinely blocked, tradeable, and unspoken
 * for. Every filter here applies at EVERY rung; the ladder below only orders what
 * survives.
 *
 * ROUTABILITY, and the one asymmetry in it: an unroutable candidate is SKIPPED,
 * not shadowed (superseding the spec's "or it runs as a shadow") — a shadow
 * wildcard produces no causal evidence at all, which is the only thing the slot
 * exists to buy, and the slot is scarce. In this engine "unroutable" means one
 * thing: a SHORT with no inverse ETP an ISA can place. A long is bought as the
 * underlying and needs no mapping, so `levMap` silence about a long says nothing.
 * Route ETPs themselves are refused outright (`isRouteEtp`) — a 3x product is a
 * route, never an underlying. */
function wildcardPool(inputs: WildcardInputs): WildcardCandidate[] {
  const ex = inputs.exclusions ?? {}
  const levMap = inputs.levMap ?? {}
  // One candidate per (name, side). A duplicated near miss keeps its strongest
  // read, so the pool is a function of the SET of rows and not of their order.
  const byKey = new Map<string, WildcardCandidate>()
  for (const m of inputs.nearMisses ?? []) {
    if (!m || typeof m.core !== 'number' || !Number.isFinite(m.core)) continue
    const sym = String(m.sym ?? '').toUpperCase()
    if (!sym) continue
    // the same rule the near-miss rows publish under (engine.ts): the sign of the
    // core read IS the side it was arguing for
    const side: 'long' | 'short' = m.core >= 0 ? 'long' : 'short'
    const key = `${sym}:${side}`
    if (ex.earningsSyms?.has(sym) || ex.earningsSyms?.has(baseSymOf(sym))) continue
    if (ex.publishedKeys?.has(key)) continue
    if (ex.liveSyms?.has(sym)) continue
    if (isRouteEtp(sym, levMap)) continue
    if (side === 'short' && !routableShort(sym, levMap)) continue
    // No trace row ⇒ nothing blocked it that the engine can name ⇒ there is no
    // gate to test and nothing to charge the outcome back to.
    const row = inputs.traceRows?.[key]
    if (!row?.gate) continue
    if (WILDCARD_INELIGIBLE_GATES.has(row.gate)) continue
    const cand: WildcardCandidate = {
      miss: m,
      sym,
      side,
      cohort: capCohortOf(m.capUsdM),
      gate: row.gate,
      gateEvidenceN: gateEvidenceN(inputs.gateStats ?? [], row.gate),
    }
    const prev = byKey.get(key)
    if (!prev || Math.abs(cand.miss.core) > Math.abs(prev.miss.core)) byKey.set(key, cand)
  }
  return [...byKey.values()]
}

/** The candidateSyms tiebreak convention (engine.ts): `localeCompare` on the
 * name. Total, so a shuffled input list cannot change the answer. */
const byName = (a: WildcardCandidate, b: WildcardCandidate): number => a.sym.localeCompare(b.sym) || a.side.localeCompare(b.side)
const byConviction = (a: WildcardCandidate, b: WildcardCandidate): number => Math.abs(b.miss.core) - Math.abs(a.miss.core) || byName(a, b)
const byThinnestGate = (a: WildcardCandidate, b: WildcardCandidate): number => a.gateEvidenceN - b.gateEvidenceN || byConviction(a, b)

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** Rung 1's sentence: the gate under test, what the ledger has and has not
 * measured about it, and the row being spent to find out. */
const hypothesisP1 = (c: WildcardCandidate, inputs: WildcardInputs): string => {
  const g = (inputs.gateStats ?? []).find(s => s?.gate === c.gate)
  const priced = Math.max(0, g?.cost ?? 0) + Math.max(0, g?.saved ?? 0)
  const unpriced = Math.max(0, g?.unchecked ?? 0)
  return `${c.gate} has ${plural(priced, 'priced outcome')} and ${unpriced} unpriced in the miss ledger, none of them causal; this takes the ${c.side} it blocked, core read ${round1(c.miss.core)}, for one real outcome with a stop.`
}

const hypothesisP2 = (c: WildcardCandidate, inputs: WildcardInputs): string =>
  `no sized outcome has ever been graded at ${c.cohort}/${c.side}/${inputs.regime}; this takes a ${c.side} there, core read ${round1(c.miss.core)}, blocked at ${c.gate}, to put the first one in the rung.`

const hypothesisP3 = (c: WildcardCandidate, inputs: WildcardInputs): string =>
  `a ${c.catalyst?.kind} catalyst names this ${c.side} and the core read ${round1(c.miss.core)} missed the ${round1(inputs.deadZone)} dead zone by ${round1(inputs.deadZone - Math.abs(c.miss.core))}; this takes it at ${c.gate} to price the near miss.`

/** THE CHOICE. Null is the ordinary answer: no candidate means no wildcard, and
 * an experiment slot is not a quota. */
export function selectWildcard(inputs: WildcardInputs): WildcardSelection | null {
  // ONE SLOT. A previous wildcard still carrying no `outcome10` blocks the day
  // before anything is even ranked — the whole point of the cadence is that the
  // causal evidence arrives one clean sample at a time.
  if (inputs.outstanding) return null
  const cands = wildcardPool(inputs)
  if (!cands.length) return null

  // ---- 1. exactly one gate, thinnest first ----
  const gateSets = gatesByName(inputs.traceRows ?? {})
  const single = cands.filter(c => (gateSets.get(c.sym)?.size ?? 0) === 1).sort(byThinnestGate)[0]
  if (single) return { candidate: single, hypothesis: hypothesisP1(single, inputs), priority: 1 }

  // ---- 2. a rung with no sized evidence at all ----
  // `unknown` is refused: an unknown-cap name is never written to a cohort-tagged
  // key (capClass.ts — a missing cap is pooled, never guessed), so its rung would
  // read empty forever and this arm would fire every day on the same non-question.
  const empty = cands
    .filter(c => c.cohort !== 'unknown' && rungSizedN(inputs.calibration?.buckets ?? {}, c.cohort as CapCohort, c.side, inputs.regime) === 0)
    .sort(byConviction)[0]
  if (empty) return { candidate: empty, hypothesis: hypothesisP2(empty, inputs), priority: 2 }

  // ---- 3. a catalyst nominee that just missed the dead zone ----
  // The tag must ARGUE THE SIDE (or name none — "in play" casts no vote), and the
  // core must sit inside WILDCARD_NEAR_DEAD_ZONE of the gate it failed. Lane kinds
  // are refused: a dip or velocity composite is CONSTRUCTED by its lane rather
  // than nominated, so it is not the two-source join this rung is.
  //
  // The nominee is NOT ranked by the catalyst's `strength`: that number is model
  // output, and letting it order the slot would let the model choose its own
  // audition. Conviction and the name decide, as everywhere else here.
  const nominee = cands
    .filter(c => {
      const tag = inputs.catalystBySym?.get(c.sym)
      if (!tag || LANE_CATALYST_KINDS.has(tag.kind)) return false
      if (tag.side && tag.side !== c.side) return false
      const core = Math.abs(c.miss.core)
      return core < inputs.deadZone && core >= inputs.deadZone - WILDCARD_NEAR_DEAD_ZONE
    })
    .map(c => ({ ...c, catalyst: inputs.catalystBySym.get(c.sym) }))
    .sort(byConviction)[0]
  if (nominee) return { candidate: nominee, hypothesis: hypothesisP3(nominee, inputs), priority: 3 }

  return null
}
