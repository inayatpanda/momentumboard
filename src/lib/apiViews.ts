import type { StockContext } from '../../shared/engine/stockContext'
import type { StrategyChoicesSnapshot } from '../../shared/engine/strategyChoices'
import type { HistoricalStudy } from '../../shared/engine/historyEvidence'
// THE TYPED VIEW CLIENT (plan Task 9): one getter per /api/engine?view= slice.
// Token handling stays in api.ts's apiGet — one place. Shapes mirror the
// server's Phase-1 projections 1:1; engine types import straight from
// shared/engine where the precedent already exists (api.ts:4-5).

import { apiGet, type EnginePrediction, type EventRadarEntry, type IntradayFlagsBlob, type LedgerPrediction, type OpenTraceEntry, type PaperBookData } from './api'
import type { GateCode } from '../../shared/engine/types'
import type { GateStructuredEntry, GateStateSummary } from '../../shared/engine/gateState'
import type { MissExample, MissLedgerSummary } from '../../shared/engine/missLedger'
import type { EngineLabSnapshot, StrategyObservation } from '../../shared/engine/strategyLab'

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
  riskState: {
    rung?: number
    directions?: {
      long: { rung: number; gradedAtRung: number; history?: unknown[] }
      short: { rung: number; gradedAtRung: number; history?: unknown[] }
    }
    [k: string]: unknown
  } | null
  referenceBase: number | null
  yesterday: {
    /** WHICH day is being reported. Rarely the calendar day before the board:
     * a grade lands 5 or 10 sessions after the call, so the server walks back to
     * the newest day that has actually been graded and carries its real date —
     * the strip names it rather than printing one day's score as another's. */
    date: string
    /** WHICH clock those verdicts were struck on: 10 = the calibrated horizon the
     * hit definition is written against, 5 = the earlier read, served only when no
     * ten-session grade has landed on that day. Optional because a slice cached by
     * a bundle that predates the field has none — such a slice prints the score
     * with no horizon claim rather than inventing one. */
    horizon?: 5 | 10
    /** the whole day's census, both partitions — kept for one release so a slice
     * cached by the previous bundle still paints something true */
    wins: number
    losses: number
    /** …and the SPLIT, which is what YesterdayStrip reads: an equity verdict is
     * an excess over SPY across ten sessions, a cohort verdict an absolute move
     * across fourteen crypto bars, and one line summing both means neither.
     * Optional because a cached slice may predate them; `crypto` is null on a
     * day no cohort row graded. */
    equity?: { wins: number; losses: number }
    crypto?: { wins: number; losses: number } | null
    topRegret: { sym: string; excessPct: number; gate: string } | null
  } | null
  /** THE OPEN BOOK (owner iteration 2). Yesterday's still-live calls, re-walked
   * against closes each morning — the same blob the journey slice already served
   * one entry of. Today renders them as "open calls, still walking", because a
   * home screen that shows only what was published THIS morning tells the reader
   * nothing about the money already on the table. Optional: a slice cached by a
   * bundle that predates the server field has none.
   *
   * ONE ROW A CALL, AND CLOSED ROWS APART (2026-08-17). The server collapses an
   * unchanged call re-issued on consecutive mornings into its ORIGINAL issue —
   * the reader was seeing the same position two and three times, each row with a
   * different day count — and hands the finished walks over in `closed` instead
   * of leaving them under a heading that says "still walking". `closed` is
   * optional: a slice cached before the split carries its crossed rows inside
   * `entries`, and the strip still renders those honestly. */
  openTrace?: { date: string | null; generatedAt: number | null; entries: OpenTraceEntry[]; closed?: OpenTraceEntry[] } | null
  /** THE CHANNELS' PICKS (owner request). What the tracked YouTube channels have
   * been recommending this week — the deterministic cross-channel consensus
   * (netlify/functions/lib/videoTrends.ts, `TickerConsensus`), which Today pairs
   * name-by-name with the engine's OWN stance. Optional AND nullable for two
   * different reasons: a slice cached by a bundle that predates the server field
   * has none at all, and a week in which no video was read carries null. */
  channelPicks?: ChannelPick[] | null
  /** Shadow research sleeves: visible and accountable, never silently promoted
   * into the sized board. */
  engineLab?: EngineLabSnapshot | null
  /** Small provenance projection for Today's decision cockpit. The client
   * derives freshness from the live clock/run status, while the server supplies
   * the prior takeable board and the measured evidence that cannot be inferred
   * from today's cards. */
  decision?: {
    priorDate: string | null
    priorRows: { sym: string; side: 'long' | 'short' }[]
    liveGraded: number
    liveHits: number
    latestBrier: number | null
  } | null
}

/** Mirrors `TickerConsensus` in netlify/functions/lib/videoTrends.ts 1:1 — the
 * shape is computed server-side and served verbatim, capped at eight. */
export interface ChannelPick {
  sym: string
  mentions7d: number
  mentionsPrior7d: number
  channels: number
  /** WHO said it — distinct channel names, first-seen order, capped at six by
   * the server. `channels` stays the full count, so a row reads "Josh, Gareth
   * + 2 more". Optional: a slice cached by a bundle that predates the field
   * carries the count and no names. */
  channelNames?: string[]
  bulls: number
  bears: number
  net: number
  /** heavy one-sided coverage — a contrarian warning, never a buy signal */
  crowded: boolean
  /** the stance balance flipped against the prior week */
  shifted: boolean
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
  stockContext?: StockContext | null
  sym: string
  boardRow: EnginePrediction | null
  openTrace: OpenTraceEntry | null
  funnel: { date: string; rows: JourneyFunnelRow[]; nearMiss: JourneyNearMiss | null }[]
  calls: JourneyCall[]
  /** Per-symbol shadow research forecasts. Never a published board call. */
  lab?: StrategyObservation[]
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

// --- paper book -------------------------------------------------------------
export interface PaperBookSlice {
  book: PaperBookData | null
  months: { month: string; startGBP: number; endGBP: number; returnPct: number; trades: number; wins: number }[]
}

export const getPaperBook = () => apiGet<PaperBookSlice>('/api/engine?view=paper-book')

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
  /** THE CRYPTO PARTITION'S OWN RECORD. `scorecard` and `calibration` above are
   * the EQUITY partition's — the grading pass keeps every cohort row out of both
   * — so without this the cohort's graded count, its independently earned rung
   * and its whole calibration are invisible to the app. null when the partition
   * has never moved; optional because a slice cached before it existed has none.
   * No `hitRate`: `baseHitRate` returns a flat 0.5 under fifty outcomes, which
   * is a designed cold-start floor and not a measurement — the pane computes its
   * hit rate from the cohort's actual receipts instead. */
  crypto?: {
    gradedN: number
    coldStartN: number
    rung: number | null
    gradedAtRung: number | null
    sinceDate: string | null
    calibration: { buckets: Record<string, unknown>; brier: unknown[]; seeded: boolean; modelVersion: string | null; referenceBase: number | null; evidence: unknown; basis: 'absolute' } | null
  } | null
}

export const getLearning = () => apiGet<LearningSlice>('/api/engine?view=learning')

// --- verdict ----------------------------------------------------------------
export interface VerdictRead {
  sym: string
  onDemand: true
  at: string
  unavailable?: true
  /** The pair belongs to the crypto lane, so the on-demand desk — which runs the
   * EQUITY factors — refused to read it (netlify/functions/lib/onDemandVerdict.ts).
   * A different state from `unavailable`: the lane prices this pair every
   * morning. Every numeric field is empty on such a verdict. */
  contained?: true
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

export const getStockContexts = (symbols: string[]) => apiGet<{ generatedAt: number | null; items: Record<string, StockContext | null> }>(`/api/engine?view=stock-contexts&symbols=${encodeURIComponent(symbols.join(','))}`)

export interface StrategyChoicesSlice {
  snapshot: StrategyChoicesSnapshot | null
  historicalStudy: HistoricalStudy | null
}
export const getStrategyChoices = () => apiGet<StrategyChoicesSlice>('/api/engine?view=strategies')
