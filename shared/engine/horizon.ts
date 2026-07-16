import type { SetupFamily } from './types'

// WHICH clock does a published row run on? The reader asked for two honest
// buckets instead of one undifferentiated list (2026-07-15): a "this week"
// prediction — the calibrated call the engine will actually be graded on (at 10
// sessions) — versus a "developing" build that only pays off over the next 2-4
// weeks and so is a watch, not a trade. The distinction is about SHAPE, not grade:
// a name coiling in a base or pulling back into support is a multi-week story
// even when it clears every gate, while a plain grade-C continuation watch is a
// short-horizon observation on this week's tape.

export type Horizon = 'week' | 'developing'

export interface HorizonInput {
  watchOnly?: boolean
  belowBase?: boolean
  stage?: string | null
  setup?: SetupFamily | null
  evidence?: { contract: boolean }
}

/** Pure classifier — no I/O, no dates. Actionable A/B trades are always the
 * short-horizon calibrated calls ('week'). Among WATCH rows, a longer build is
 * 'developing': a basing/pullback shape (coils and dips resolve over weeks),
 * a below-base setup (the engine is tracking it precisely because it hasn't
 * earned this-week size yet), or a thin-evidence reversal (a turn still trying
 * to confirm). Everything else on the watch list — chiefly plain grade-C
 * continuation reads — stays 'week': an observation about THIS week's tape. */
export function horizonOf(row: HorizonInput): Horizon {
  // a trade is the calibrated call the engine gets graded on (at 10 sessions)
  if (!row.watchOnly) return 'week'
  // watch rows: is the SHAPE a longer build?
  if (row.belowBase) return 'developing'
  if (row.stage === 'basing' || row.stage === 'pullback') return 'developing'
  // a reversal that hasn't cleared the evidence bar is a turn still forming —
  // weeks of base-building, not a this-week call
  if (row.setup === 'reversal' && row.evidence?.contract === false) return 'developing'
  // plain grade-C continuation watch and the rest → short-horizon observation
  return 'week'
}
