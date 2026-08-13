import type { Gates } from './catalyst'
import type { EmptySideReason, FactorName, FactorScore, GateCode } from './types'

// THE FUNNEL LEAVES A TRACE.
//
// Everything the engine refuses used to be a `continue`. A name that never
// became a candidate, a name whose candles never arrived, a name the dead zone
// turned down, a name that cleared every gate and then lost the third slot on
// its side — all of them left the run identically: silently. The board could
// only ever say what it DID publish, so "why didn't the engine call X?" had no
// answer anywhere in the system, and the learning loop had no population of
// refusals to charge a cost against.
//
// This module is the shape of the answer: one row per symbol per day, naming the
// gate that ended its run, written once as `funnel-trace:${date}` beside a
// bounded index. It is a RECORD, never a decision — nothing in the engine reads
// it back, and a trace that fails to write costs the day's evidence and nothing
// else (see the fail-soft write in engine.ts).

export const FUNNEL_TRACE_INDEX_KEY = 'funnel-trace-index'
/** Mirrors `predictions-index` (engine.ts) exactly — same bound, same shape, so
 * miss detection ten sessions later walks one list the way it walks the other. */
export const FUNNEL_TRACE_INDEX_MAX = 250
/** `detail` is prose for a human reading a trace back, and prose has no natural
 * bound. ~180 rows a day × 250 days of index is the blob's real size question,
 * so every detail is cut here, at the one choke point that cannot be bypassed:
 * the recorder. The GATE CODE carries the accounting; detail is colour. */
export const TRACE_DETAIL_MAX = 120

export const funnelTraceKey = (date: string): string => `funnel-trace:${date}`

export interface FunnelTraceRow {
  gate: GateCode
  /** The direction the name was being argued for when it died. Absent when there
   * was never a side (trimmed, no candles). */
  side?: 'long' | 'short'
  /** The discovery door the name came in through (`sources` in engine.ts) — a
   * screener, the sleeve, a catalyst, the roster. Absent when the name never
   * entered the sources map under a door of its own. */
  source?: string
  detail?: string
}

/** The near-miss record as buildBoard already builds it — carried into the trace
 * VERBATIM rather than re-shaped into gate rows. Those rows already carry stage
 * and factors, and deciding what more a miss ledger wants from them is Stage 3b's
 * job, not this one's. `stage` widens to `string` on purpose: this module must not
 * import the technicals' Stage union to store a label it never interprets. */
export interface FunnelNearMiss {
  sym: string
  core: number
  capUsdM: number | null
  lastClose: number
  atrNow: number
  capacityPct: number | null
  stage: string | null
  factors: Record<FactorName, FactorScore>
}

export interface FunnelTrace {
  date: string
  /** The thresholds THIS run was judged against, stored beside its verdicts —
   * gate feedback (spec §4.3) moves these, and a trace read back next quarter
   * must know which dead zone said no. */
  gates: Gates
  rows: Record<string, FunnelTraceRow>
  /** `not-candidate` is a COUNT and never a list: the universe of names that were
   * never candidates is unbounded, so only the ones the run actually touched and
   * refused admission to can be counted honestly. */
  counts: { notCandidate: number }
  nearMisses: FunnelNearMiss[]
  emptySides: { long?: EmptySideReason; short?: EmptySideReason }
}

/** The codes `publishCall` emits — the name reached the board array. They are
 * TERMINAL against ordinary recording: once a chart has published, a later lane
 * refusing its own attempt on the same chart is not what happened to that name,
 * and must not overwrite the publication. Only `revise` (the fate of a row that
 * genuinely changed after it published — a lane demotion, a diversity cut, a
 * promoted observation) may write over one. */
export const PUBLISHED_GATES: ReadonlySet<GateCode> = new Set<GateCode>([
  'called-full',
  'called-half',
  'called-shadow',
  'called-watch',
  'route-blocked',
])

export interface TraceExtra {
  side?: 'long' | 'short' | null
  source?: string | null
  detail?: string | null
}

export interface FunnelTraceRecorder {
  /** "This name died here." Later stages overwrite earlier ones — the trace names
   * where a name FINALLY stopped, and the engine's stages run in the order a name
   * travels — EXCEPT over a publication (see PUBLISHED_GATES). */
  record(sym: string, gate: GateCode, extra?: TraceExtra): void
  /** "This row's fate changed." Always writes, publication or not. */
  revise(sym: string, gate: GateCode, extra?: TraceExtra): void
  /** Names offered to the candidate pool that never entered it. */
  notCandidate(n: number): void
  gateOf(sym: string): GateCode | null
  size(): number
  build(input: { date: string; gates: Gates; nearMisses: FunnelNearMiss[]; emptySides: FunnelTrace['emptySides'] }): FunnelTrace
}

const rowOf = (gate: GateCode, extra?: TraceExtra): FunnelTraceRow => {
  const row: FunnelTraceRow = { gate }
  if (extra?.side) row.side = extra.side
  if (extra?.source) row.source = extra.source
  if (extra?.detail) row.detail = extra.detail.slice(0, TRACE_DETAIL_MAX)
  return row
}

/** One accumulator per run. Symbols are upper-cased on the way in so a roster
 * spelling and a screener spelling can never become two rows for one name. */
export function funnelTraceRecorder(): FunnelTraceRecorder {
  const rows = new Map<string, FunnelTraceRow>()
  let notCandidateCount = 0
  return {
    record(sym, gate, extra) {
      const key = sym.toUpperCase()
      const prev = rows.get(key)
      if (prev && PUBLISHED_GATES.has(prev.gate)) return
      rows.set(key, rowOf(gate, extra))
    },
    revise(sym, gate, extra) {
      rows.set(sym.toUpperCase(), rowOf(gate, extra))
    },
    notCandidate(n) {
      notCandidateCount += Math.max(0, n)
    },
    gateOf(sym) {
      return rows.get(sym.toUpperCase())?.gate ?? null
    },
    size() {
      return rows.size
    },
    build({ date, gates, nearMisses, emptySides }) {
      return {
        date,
        gates: { ...gates },
        rows: Object.fromEntries([...rows.entries()].sort(([a], [b]) => a.localeCompare(b))),
        counts: { notCandidate: notCandidateCount },
        nearMisses,
        emptySides,
      }
    },
  }
}
