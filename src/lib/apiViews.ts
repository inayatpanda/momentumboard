// THE TYPED VIEW CLIENT (plan Task 9): one getter per /api/engine?view= slice.
// Token handling stays in api.ts's apiGet — one place. Shapes mirror the
// server's Phase-1 projections 1:1; engine types import straight from
// shared/engine where the precedent already exists (api.ts:4-5).

import { apiGet, type EnginePrediction, type EventRadarEntry, type IntradayFlagsBlob, type LedgerPrediction, type OpenTraceEntry } from './api'
import type { GateCode } from '../../shared/engine/types'
import type { GateStructuredEntry, GateStateSummary } from '../../shared/engine/gateState'
import type { MissExample, MissLedgerSummary } from '../../shared/engine/missLedger'

// --- board ------------------------------------------------------------------
export interface BoardBlob {
  date: string
  generatedAt: number
  regime: string
  board: EnginePrediction[]
  worldTape?: { tone: string; votes: { on: number; off: number }; detail: string }
  newsTone?: { score: number; label: string; hits: number }
  emptySides?: Record<string, string>
  themes?: unknown
}

export interface BoardSlice {
  board: BoardBlob | null
  intradayFlags: IntradayFlagsBlob | null
  eventRadar: { date: string; generatedAt: number; entries: EventRadarEntry[] } | null
  runStatus: { startedAt: number; updatedAt: number; phase: string; completedAt?: number; failedAt?: number; error?: string } | null
  riskState: { rung?: number; [k: string]: unknown } | null
  referenceBase: number | null
  yesterday: { date: string; wins: number; losses: number; topRegret: { sym: string; excessPct: number; gate: string } | null } | null
}

export const getBoardSlice = () => apiGet<BoardSlice>('/api/engine?view=board')

// --- journey ----------------------------------------------------------------
export interface JourneyFunnelRow {
  key: string
  gate: GateCode
  side?: 'long' | 'short'
  source?: string
  detail?: string
  core?: number
  priorGate?: GateCode
}

export interface JourneyNearMiss {
  sym: string
  core: number
  capUsdM: number | null
  lastClose: number
  atrNow: number
  capacityPct: number | null
  stage: string | null
  factors: Record<string, { score: number | null }>
}

export interface PostMortemRead {
  cls: string
  detail: string
  at: number
  sentence?: string
  clsBefore?: string
  via?: string
}

export type JourneyCall = LedgerPrediction & { postMortem: PostMortemRead | null; outcome21: { excessPct: number; rawPct: number; spyPct: number; stopped: boolean; hit: boolean } | null }

export interface JourneySlice {
  sym: string
  boardRow: EnginePrediction | null
  openTrace: OpenTraceEntry | null
  funnel: { date: string; rows: JourneyFunnelRow[]; nearMiss: JourneyNearMiss | null }[]
  calls: JourneyCall[]
}

export const getJourney = (sym: string, days?: number) =>
  apiGet<JourneySlice>(`/api/engine?view=journey&sym=${encodeURIComponent(sym.toUpperCase())}${days ? `&days=${days}` : ''}`)

// --- funnel -----------------------------------------------------------------
export interface FunnelSlice {
  date: string | null
  missing?: boolean
  gates?: Record<string, number>
  counts?: { notCandidate: number }
  emptySides?: Record<string, string>
  disabled?: boolean
  refusals: JourneyFunnelRow[]
  published: JourneyFunnelRow[]
  nearMisses: JourneyNearMiss[]
}

export const getFunnel = (date?: string) => apiGet<FunnelSlice>(`/api/engine?view=funnel${date ? `&date=${date}` : ''}`)

// --- ledger -----------------------------------------------------------------
export interface LedgerDay {
  date: string
  predictions: JourneyCall[]
}

export const getLedgerDays = (days: number) => apiGet<{ days: LedgerDay[] }>(`/api/engine?view=ledger&days=${days}`)

// --- learning ---------------------------------------------------------------
export interface RegretGate {
  gate: GateCode
  cost: number // EVENT COUNT (CX-15) — never print with pp
  avgCostExcessPct: number | null
  saved: number // event count
  avgSavedExcessPct: number | null
  unchecked: number
  doubleBooked?: true
  causal?: { n: number; hits: number }
  examples: MissExample[]
}

export interface LearningSlice {
  gateState: { gates: GateStructuredEntry[] }
  gateLines: GateStateSummary | null
  regrets: (Omit<MissLedgerSummary, 'topGates'> & { topGates: RegretGate[] }) | null
  weights: { base: Record<string, number>; current: Record<string, number>; history: unknown[] } | null
  scorecard: Record<string, unknown> | null
  roster: { entries: unknown[]; changes: unknown[] } | null
  channelCred: Record<string, { graded: number; hits: number; avgExcess: number | null }>
  calibration: { buckets: Record<string, unknown>; brier: unknown[]; seeded: boolean; modelVersion: string | null; referenceBase: number | null; evidence: unknown } | null
}

export const getLearning = () => apiGet<LearningSlice>('/api/engine?view=learning')

// --- verdict ----------------------------------------------------------------
export interface VerdictRead {
  sym: string
  onDemand: true
  at: string
  unavailable?: true
  lean: 'long' | 'short' | 'none'
  core: number | null
  stage: string | null
  computed: { name: string; score: number | null; detail: string }[]
  nulls: string[]
  lastClose: number | null
  atr: number | null
  note: string
}

export const getVerdict = (sym: string) => apiGet<VerdictRead>(`/api/engine?view=verdict&sym=${encodeURIComponent(sym.toUpperCase())}`)
