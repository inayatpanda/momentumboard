// Risk-taking earns its way up and steps down fast: the rung is computed from
// the rolling scorecard, never from a feeling. Every change carries evidence.
//
// Phase 2: the ladder is now per cap-class cohort (large/small). Each cohort earns
// its own rung from its own graded calls, but a young cohort POOLS to the combined
// stream so it is never starved. The stored blob keeps the legacy top-level fields
// (the COMBINED rung, computed exactly as before) so every existing app screen that
// reads riskState.rung keeps working, and ADDS a `cohorts` map.

import { type CapCohortOrUnknown } from './capClass'

/** One rung ladder — shape unchanged from Phase 1's RiskState, now reused per
 * cohort AND as the top-level combined rung. */
export interface CohortRung {
  rung: 0 | 1 | 2 | 3
  sinceDate: string
  gradedAtRung: number
  history: { date: string; from: number; to: number; evidence: string }[]
}

/** The stored `risk-state` blob. Top-level = the combined rung (back-compat);
 * `cohorts` = the per-sleeve rungs (absent on legacy blobs → migrateRisk seeds them). */
export interface RiskState extends CohortRung {
  cohorts?: { large: CohortRung; small: CohortRung }
}

export const RUNG_RISK_PCT = [1.0, 1.25, 1.5, 2.0] as const

export interface OutcomeLite {
  hit: boolean
  stopped: boolean
  leveraged: boolean
}

const initRung = (today: string): CohortRung => ({ rung: 0, sinceDate: today, gradedAtRung: 0, history: [] })

export function initRisk(today: string): RiskState {
  return { ...initRung(today), cohorts: { large: initRung(today), small: initRung(today) } }
}

const cloneRung = (r: CohortRung): CohortRung => ({ rung: r.rung, sinceDate: r.sinceDate, gradedAtRung: r.gradedAtRung, history: [...r.history] })

/** Bring a stored risk-state up to Phase 2. A blob that predates cohorts (no
 * `cohorts`) has BOTH cohorts seeded from the live top-level combined rung — so the
 * production rung-0 blob, and its history/sinceDate, carries forward into each
 * cohort intact (nothing lost) and both cohorts start where the book already is.
 * Idempotent: a blob that already has cohorts is returned untouched. */
export function migrateRisk(state: RiskState): RiskState {
  if (state.cohorts) return state
  const base = cloneRung(state)
  return { ...state, cohorts: { large: cloneRung(base), small: cloneRung(base) } }
}

const PROMOTE_MIN_GRADED = 25
const PROMOTE_HIT_RATE = 0.55
const DEMOTE_HIT_RATE = 0.45
const DEMOTE_WINDOW = 20

/** A cohort earns its OWN rung only once it has a full evaluation window
 * (DEMOTE_WINDOW) of its own graded calls in the recent stream. Below that it
 * MIRRORS the combined rung — the risk-ladder analogue of calibration's
 * pool-when-thin: a young cohort is never starved (it gets exactly what the whole
 * book earned) and still tracks the book's demotions. Chosen to match the ladder's
 * own decision window rather than MIN_BUCKET_N (15): a rung decision needs a full
 * cold-streak window of the cohort's OWN calls before it may diverge from the book. */
export const COHORT_STANDALONE_N = DEMOTE_WINDOW

const hitRate = (xs: OutcomeLite[]) => (xs.length ? xs.filter(o => o.hit).length / xs.length : 0)

/** Apply a target rung to a ladder, booking evidence on change and accumulating
 * the graded-at-rung counter when it holds. (Was `computeRung`'s inner closure.) */
const stepRung = (state: CohortRung, to: number, newCount: number, today: string, evidence: string): CohortRung => {
  const rung = Math.max(0, Math.min(3, to)) as CohortRung['rung']
  if (rung === state.rung) return { ...state, gradedAtRung: state.gradedAtRung + newCount }
  const history = [...state.history, { date: today, from: state.rung, to: rung, evidence }].slice(-50)
  return { rung, sinceDate: today, gradedAtRung: 0, history }
}

/** recentOutcomes: chronological graded history (last ≤60, incl. this run's);
 * newCount: how many of those were graded in this run. Operates on one ladder —
 * used for the combined stream and, once mature, for a standalone cohort. */
export function computeRung(
  state: CohortRung,
  recentOutcomes: OutcomeLite[],
  newCount: number,
  brierImproving: boolean,
  override: number | null,
  today: string,
): CohortRung {
  if (override != null && override >= 0 && override <= 3) return stepRung(state, override, newCount, today, 'manual override')

  const gradedAtRung = state.gradedAtRung + newCount

  const last20 = recentOutcomes.slice(-DEMOTE_WINDOW)
  if (last20.length >= DEMOTE_WINDOW && hitRate(last20) < DEMOTE_HIT_RATE) {
    return stepRung(state, state.rung - 1, newCount, today, `cold: hit rate ${Math.round(hitRate(last20) * 100)}% over last ${DEMOTE_WINDOW}`)
  }
  const lev = recentOutcomes.filter(o => o.leveraged).slice(-3)
  if (lev.length === 3 && lev.every(o => o.stopped)) {
    return stepRung(state, state.rung - 1, newCount, today, '3 consecutive leveraged calls stopped out')
  }

  const last25 = recentOutcomes.slice(-PROMOTE_MIN_GRADED)
  if (
    state.rung < 3 &&
    gradedAtRung >= PROMOTE_MIN_GRADED &&
    last25.length >= PROMOTE_MIN_GRADED &&
    hitRate(last25) >= PROMOTE_HIT_RATE &&
    brierImproving
  ) {
    return stepRung(state, state.rung + 1, newCount, today, `earned: ${gradedAtRung} graded at R${state.rung}, hit rate ${Math.round(hitRate(last25) * 100)}%, calibration improving`)
  }

  return { ...state, gradedAtRung }
}

/** One cohort's rung: stand on its own stream once mature, else mirror the freshly
 * computed combined rung. `cohortNew` is this cohort's OWN newly-graded count (so
 * the graded-at-rung counter is honest per sleeve, even while pooling). */
export function computeCohortRung(
  prev: CohortRung,
  cohortRecent: OutcomeLite[],
  cohortNew: number,
  combined: CohortRung,
  brierImproving: boolean,
  override: number | null,
  today: string,
): CohortRung {
  // A manual override pins EVERY cohort to the same rung — the pin is a whole-book
  // decision, not a per-sleeve one.
  if (override != null && override >= 0 && override <= 3) return stepRung(prev, override, cohortNew, today, 'manual override')
  if (cohortRecent.length >= COHORT_STANDALONE_N) return computeRung(prev, cohortRecent, cohortNew, brierImproving, null, today)
  return stepRung(prev, combined.rung, cohortNew, today, `pooled: mirrors combined R${combined.rung} while cohort thin (${cohortRecent.length} own graded)`)
}

/** The rung a call of the given cohort trades at. Known cohorts read their own
 * rung; unknown-cap calls pool to the combined (top-level) rung — never guessed
 * into a sleeve. Assumes migrateRisk has run. */
export function cohortRungOf(state: RiskState, cohort: CapCohortOrUnknown): number {
  if (cohort !== 'unknown' && state.cohorts) return state.cohorts[cohort].rung
  return state.rung
}

export type LevMap = Record<string, { long2x?: string; long3x?: string; short2x?: string; short3x?: string }>

/** Route instruments (leveraged/inverse ETPs) are what mapInstrument RETURNS —
 * they must never enter the candidate pool as underlyings. A held 3CON.L
 * (bought as the route of an earlier call) circling back in as a "candidate"
 * hands the calibration a daily-rebalance decay curve that reads like a free
 * permanent short. Covers every ticker on the levMap route side plus the
 * digit-prefixed LSE ETP naming convention (3CON.L, 2TSL.L…) that no ordinary
 * equity ticker shares. */
export function isRouteEtp(sym: string, levMap: LevMap): boolean {
  const s = sym.toUpperCase()
  if (/^\d/.test(s)) return true
  for (const m of Object.values(levMap)) {
    if ([m.long2x, m.long3x, m.short2x, m.short3x].some(t => t?.toUpperCase() === s)) return true
  }
  return false
}

export function leverageAllowed(rung: number, grade: 'A' | 'B' | 'C'): 0 | 2 | 3 {
  if (rung >= 3 && grade === 'A') return 3
  if (rung >= 2 && (grade === 'A' || grade === 'B')) return 2
  if (rung >= 1 && grade === 'A') return 2
  return 0
}

export function mapInstrument(
  side: 'long' | 'short',
  sym: string,
  grade: 'A' | 'B' | 'C',
  rung: number,
  levMap: LevMap,
): { ticker: string; leverage: number } | null {
  const max = leverageAllowed(rung, grade)
  if (!max) return null
  const m = levMap[sym]
  if (!m) return null
  if (max === 3) {
    const t3 = side === 'long' ? m.long3x : m.short3x
    if (t3) return { ticker: t3, leverage: 3 }
  }
  const t2 = side === 'long' ? m.long2x : m.short2x
  return t2 ? { ticker: t2, leverage: 2 } : null
}
