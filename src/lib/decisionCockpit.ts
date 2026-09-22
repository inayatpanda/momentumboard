import type { BoardSlice } from './apiViews'

export type FreshnessState = 'fresh' | 'aging' | 'stale' | 'running' | 'failed'

export interface DecisionCockpitRead {
  sized: number
  longs: number
  shorts: number
  newSymbols: string[]
  removedSymbols: string[]
  flips: { sym: string; from: 'long' | 'short'; to: 'long' | 'short' }[]
  priorDate: string | null
  freshness: FreshnessState
  ageMinutes: number
  liveN: number
  liveHitRate: number | null
  latestBrier: number | null
}

/** One deterministic read over the narrow board projection. Only genuinely
 * takeable rows count: shadow lab observations, watch rows and route-blocked
 * observations can be visible without pretending the instruction changed. */
export function decisionCockpitRead(data: BoardSlice, nowSec = Math.floor(Date.now() / 1000)): DecisionCockpitRead | null {
  const board = data.board
  if (!board) return null
  const current = board.board.filter(row => !row.watchOnly && !row.observation)
  const priorRows = data.decision?.priorRows ?? []
  const priorBySym = new Map(priorRows.map(row => [row.sym, row]))
  const currentBySym = new Map(current.map(row => [row.sym, row]))
  const ageMinutes = Math.max(0, Math.round((nowSec - board.generatedAt) / 60))
  const status = data.runStatus
  const failedAfterBoard = status?.failedAt != null && status.failedAt >= board.generatedAt
  const runningAfterBoard = status != null && status.completedAt == null && status.failedAt == null && status.updatedAt >= board.generatedAt
  const freshness: FreshnessState = failedAfterBoard ? 'failed' : runningAfterBoard ? 'running' : ageMinutes <= 18 * 60 ? 'fresh' : ageMinutes <= 36 * 60 ? 'aging' : 'stale'
  const liveN = data.decision?.liveGraded ?? 0
  const liveHits = data.decision?.liveHits ?? 0

  return {
    sized: current.length,
    longs: current.filter(row => row.side === 'long').length,
    shorts: current.filter(row => row.side === 'short').length,
    newSymbols: data.decision?.priorDate ? current.filter(row => !priorBySym.has(row.sym)).map(row => row.sym) : [],
    removedSymbols: data.decision?.priorDate ? priorRows.filter(row => !currentBySym.has(row.sym)).map(row => row.sym) : [],
    flips: data.decision?.priorDate
      ? current.flatMap(row => {
          const before = priorBySym.get(row.sym)
          return before && before.side !== row.side ? [{ sym: row.sym, from: before.side, to: row.side }] : []
        })
      : [],
    priorDate: data.decision?.priorDate ?? null,
    freshness,
    ageMinutes,
    liveN,
    liveHitRate: liveN ? liveHits / liveN : null,
    latestBrier: data.decision?.latestBrier ?? null,
  }
}

export function boardChangeLine(read: DecisionCockpitRead): string {
  if (!read.priorDate) return 'Prior-session comparison starts after the next completed run.'
  const pieces: string[] = []
  if (read.newSymbols.length) pieces.push(`new ${read.newSymbols.join(', ')}`)
  if (read.flips.length) pieces.push(`flipped ${read.flips.map(f => `${f.sym} ${f.from}→${f.to}`).join(', ')}`)
  if (read.removedSymbols.length) pieces.push(`left ${read.removedSymbols.join(', ')}`)
  return pieces.length ? pieces.join(' · ') : 'No takeable-board changes since the prior session.'
}
