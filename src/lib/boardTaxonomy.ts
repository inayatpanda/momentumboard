// splitBoardRows (Task 14 review, Fix 3): ONE place for the board's row
// taxonomy — sized vs developing vs watch vs observations vs near-misses.
// Extracted verbatim from src/screens2/Board.tsx (predicates only, no
// behaviour change) so Board, Today, and CountsRail can never drift apart on
// what counts as what. Same taxonomy src/components/EngineBoard.tsx:251-255
// used before the v2 rebuild.

import type { EnginePrediction } from './api'

export interface BoardRowSplit {
  sized: EnginePrediction[]
  developing: EnginePrediction[]
  watch: EnginePrediction[]
  observations: EnginePrediction[]
  nearMisses: EnginePrediction[]
}

export function splitBoardRows(rows: EnginePrediction[]): BoardRowSplit {
  return {
    sized: rows.filter(p => !p.watchOnly),
    developing: rows.filter(p => p.watchOnly && !p.nearMiss && !p.observation && p.horizon === 'developing'),
    watch: rows.filter(p => p.watchOnly && !p.nearMiss && !p.observation && p.horizon !== 'developing'),
    observations: rows.filter(p => p.observation && !p.nearMiss),
    nearMisses: rows.filter(p => p.nearMiss),
  }
}

// ---------------------------------------------------------------------------
// THE ROW-KIND LAW (Task 17 review, I7). CallCard.tsx and VerdictHero.tsx each
// held a private copy of "what kind of row is this, and what does it say
// instead of a grade" — and the two copies had already drifted on the wording
// (one said "below the grade bar", the other "below its own historical hit
// rate"; one dropped "no probability" from the near-miss sentence). A law the
// reader meets on two screens cannot live in two places, so it lives here and
// both cards read it. The MORE COMPLETE wording won every drift.
// ---------------------------------------------------------------------------

export type RowKind = 'sized-live' | 'near-miss' | 'observation' | 'watch'

/** What SHAPE of row is this? Checked against each flag directly and never
 * inferred from `watchOnly` alone: nearMiss and observation rows are always
 * watchOnly on the wire, but a card must not depend on that wiring holding. */
export function rowKind(row: Pick<EnginePrediction, 'watchOnly' | 'nearMiss' | 'observation'>): RowKind {
  if (row.nearMiss) return 'near-miss'
  if (row.observation) return 'observation'
  if (row.watchOnly) return 'watch'
  return 'sized-live'
}

/** THE HARD RULE (CX-13): a letter grade and a calibrated probability are a
 * read on evidence only a sized, live row ever cleared. Every other shape gets
 * one of these sentences instead — never a grade, never a softened one.
 * `belowBase` splits the watch case, because a row tracked under its own
 * historical hit rate is a different fact from a row simply not sized yet. */
export function unsizedReason(kind: RowKind, belowBase = false): string {
  switch (kind) {
    case 'near-miss':
      return 'Nearest miss — cleared no gate, so no grade, no probability and no size.'
    case 'observation':
      return 'Cleared every gate, but no ISA route — observation only, no size.'
    case 'watch':
      return belowBase ? 'Tracking — below its own historical hit rate today, no size yet.' : 'Watch — no size yet.'
    case 'sized-live':
      // a sized row carries its grade and its probability; it has no reason line
      return ''
  }
}
