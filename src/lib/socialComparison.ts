import type { EnginePrediction } from './api'
import type { BoardSlice } from './apiViews'
import type { StrategyObservation } from '../../shared/engine/strategyLab'

export type ComparisonStatus = 'aligned' | 'conflict' | 'unconfirmed' | 'mixed' | 'no-youtube'

export interface IndependentEngineRead {
  source: 'board' | 'short-horizon' | 'quality-dip' | 'none'
  label: string
  side: 'long' | 'short' | 'neutral'
  state: 'setup' | 'watch' | 'avoid' | 'collecting'
  summary: string
  reasons: string[]
  risks: string[]
  entry: number | null
  stop: number | null
  target: number | null
}

const baseSym = (sym: string) => sym.toUpperCase().split('.')[0].split('-')[0]
const signed = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}`

function boardRead(row: EnginePrediction): IndependentEngineRead {
  const state: IndependentEngineRead['state'] = row.nearMiss || row.belowBase || row.watchOnly || row.observation ? 'watch' : 'setup'
  const usableDirection = state === 'setup' ? row.side : 'neutral'
  const probability = Number.isFinite(row.probability) ? `${Math.round(row.probability * 100)}% measured hit rate` : 'probability unavailable'
  return {
    source: 'board', label: 'Composite engine', side: usableDirection, state,
    summary: `${state === 'setup' ? row.side.toUpperCase() : 'NO CONFIRMED EDGE'} · composite ${signed(row.composite)} · ${probability}${row.provisional ? ' · provisional' : ''}`,
    reasons: [row.thesis || row.note].filter(Boolean),
    risks: [row.falsifier, row.earningsRisk ? 'earnings risk is active' : null, row.overlay?.reason].filter((v): v is string => Boolean(v)),
    entry: row.entry, stop: row.stop, target: row.target,
  }
}

function labRead(row: StrategyObservation): IndependentEngineRead {
  const activeSide = row.state === 'setup' ? row.side : 'neutral'
  const short = row.sleeve === 'short-horizon'
  const odds = short && row.forecast.probabilityUp != null
    ? `${Math.round(row.forecast.probabilityUp * 100)}% up / ${Math.round((row.forecast.probabilityDown ?? 0) * 100)}% down`
    : `score ${row.score}/100 · probability collecting`
  return {
    source: short ? 'short-horizon' : 'quality-dip',
    label: short ? '3-session engine' : 'Quality-dip engine',
    side: activeSide, state: row.state,
    summary: `${row.state === 'setup' ? row.side.toUpperCase() : row.state.toUpperCase()} · ${odds}${row.forecast.provisional ? ' · provisional' : ''}`,
    reasons: row.reasons,
    risks: [...row.risks, ...row.dataGaps.map(gap => `missing: ${gap}`)],
    entry: row.entry ?? null, stop: row.stop ?? null, target: row.target ?? null,
  }
}

/** Excludes Social Ignition: social claims cannot independently confirm a model
 * whose inputs already include those same claims. */
export function independentEngineRead(sym: string, data: BoardSlice | null | undefined): IndependentEngineRead {
  if (!data) return { source: 'none', label: 'Independent engine', side: 'neutral', state: 'collecting', summary: 'Engine read unavailable', reasons: [], risks: [], entry: null, stop: null, target: null }
  const normalized = baseSym(sym)
  const board = data.board?.board.find(row => baseSym(row.sym) === normalized)
  if (board) return boardRead(board)
  const eligible = (data.engineLab?.observations ?? []).filter(row => baseSym(row.sym) === normalized && row.sleeve !== 'social-ignition')
  const short = eligible.find(row => row.sleeve === 'short-horizon')
  if (short) return labRead(short)
  const quality = eligible.find(row => row.sleeve === 'quality-dip')
  if (quality) return labRead(quality)
  return {
    source: 'none', label: 'Independent engine', side: 'neutral', state: 'collecting',
    summary: 'No independent price/quality setup is active for this stock', reasons: [],
    risks: ['social attention is not independently confirmed by the engine'], entry: null, stop: null, target: null,
  }
}

export function comparisonStatus(channelNet: number | null, read: IndependentEngineRead): ComparisonStatus {
  if (channelNet == null) return 'no-youtube'
  if (channelNet === 0) return 'mixed'
  if (read.source === 'none' || read.side === 'neutral') return 'unconfirmed'
  return (channelNet > 0 && read.side === 'long') || (channelNet < 0 && read.side === 'short') ? 'aligned' : 'conflict'
}
