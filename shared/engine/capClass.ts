// The ONE cap-class cohort rule, shared by client display (TRACK RECORD sleeves)
// and engine learning (calibration buckets + risk ladder). Kept in shared/ so the
// two can never drift: if this threshold ever moves, both move together.

/** Large- vs small-cap boundary in $M. A name at exactly $2B is LARGE (the
 * threshold is the small-cap ceiling, exclusive). Matches composite.ts's
 * `smallCap` stop-width flag and Phase 1's display sleeves. */
export const SMALL_CAP_MAX_USD_M = 2000

/** The two cohorts the engine LEARNS per (large/small), plus `unknown` for names
 * whose cap we don't have. `unknown` is deliberately NOT a learnable cohort: a
 * missing cap must never be *guessed* into large or small — doing so would poison
 * a cohort's buckets/rung with names that might belong to the other. Instead an
 * unknown-cap name POOLS to the combined/cohortless path (calibration) and to the
 * combined rung (risk ladder) — honest about what we don't know. */
export type CapCohort = 'large' | 'small'
export type CapCohortOrUnknown = CapCohort | 'unknown'

/** Cohort from market cap in $M. null/undefined → 'unknown' (pools, never guessed). */
export function capCohortOf(capUsdM: number | null | undefined): CapCohortOrUnknown {
  if (capUsdM == null) return 'unknown'
  return capUsdM < SMALL_CAP_MAX_USD_M ? 'small' : 'large'
}

/** Display label for a cohort — the exact strings Phase 1's TRACK RECORD sleeves
 * use, so `src/lib/format.ts` can delegate here without changing its callers. */
export const CAP_COHORT_LABEL: Record<CapCohortOrUnknown, 'Large-cap' | 'Small-cap' | 'Unknown'> = {
  large: 'Large-cap',
  small: 'Small-cap',
  unknown: 'Unknown',
}
