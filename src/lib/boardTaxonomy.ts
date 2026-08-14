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
