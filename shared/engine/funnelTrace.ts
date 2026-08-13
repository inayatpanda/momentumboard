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
// This module is the shape of the answer: one row per NAME PER SIDE per day,
// naming the gate that ended its run, written once as `funnel-trace:${date}`
// beside a bounded index. It is a RECORD, never a decision — nothing in the
// engine reads it back, and a trace that fails to write costs the day's evidence
// and nothing else (see the fail-soft write in engine.ts).

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

/** THE ROW KEY: `SYM:side` once a side exists, the bare `SYM` for the gates that
 * fire before there is one (trimmed, no-candles). RATIFIED after the Task-2
 * review, replacing one row per symbol.
 *
 * One key per name could hold only ONE fact about a chart, and the engine
 * routinely produces two: the dip lane publishes a sized long on the same tape
 * the composite shorted, and the demotion that follows (engine.ts) then wrote
 * `called-shadow/short` over the row the long had just written — so the only
 * sized, reader-facing call on the name disappeared from the record of the run
 * while the row nobody could take survived. A name that dies on one side and
 * pays on the other is two rows, and the exactly-once invariant is per
 * (name, side-or-none) rather than per name. */
export const traceRowKey = (sym: string, side?: 'long' | 'short' | null): string => (side ? `${sym.toUpperCase()}:${side}` : sym.toUpperCase())

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
  /** Keyed by `traceRowKey` — `SYM:side`, or a bare `SYM` for the gates that fire
   * before a side exists. Sorted, so two runs of one day diff cleanly. */
  rows: Record<string, FunnelTraceRow>
  /** `not-candidate` is a COUNT and never a list: the universe of names that were
   * never candidates is unbounded, so only the ones the run actually touched and
   * refused admission to can be counted honestly. */
  counts: { notCandidate: number }
  nearMisses: FunnelNearMiss[]
  emptySides: { long?: EmptySideReason; short?: EmptySideReason }
}

/** The codes that mean THE READER GOT THIS ROW — `publishCall`'s size decision,
 * the promotion that fills an empty side, and the route-blocked shadow. They are
 * TERMINAL against ordinary recording ON THEIR OWN KEY: once a (name, side) has
 * published, a later lane refusing its own attempt on that same side is not what
 * happened to it, and must not overwrite the publication. Precedence is per key,
 * so a publication on the long side has nothing to say about the short side's
 * refusal. Only `revise` (the fate of a row that genuinely changed after it
 * published — a lane demotion, a diversity cut, a shadow the budget dropped) may
 * write over one. */
export const PUBLISHED_GATES: ReadonlySet<GateCode> = new Set<GateCode>([
  'called-full',
  'called-half',
  'called-shadow',
  'called-watch',
  'called-below-base',
  'called-observation',
  'route-blocked',
])

export interface TraceExtra {
  side?: 'long' | 'short' | null
  source?: string | null
  detail?: string | null
}

export interface FunnelTraceRecorder {
  /** "This name died here, on this side." Later stages overwrite earlier ones on
   * the SAME key — the trace names where a name finally stopped, and the engine's
   * stages run in the order a name travels — EXCEPT over a publication (see
   * PUBLISHED_GATES). `extra.side` picks the key. */
  record(sym: string, gate: GateCode, extra?: TraceExtra): void
  /** "This row's fate changed." Always writes, publication or not. */
  revise(sym: string, gate: GateCode, extra?: TraceExtra): void
  /** Names offered to the candidate pool that never entered it. */
  notCandidate(n: number): void
  /** The row standing at (sym, side) — a COPY, so a caller re-labelling a cut row
   * that later reached the board cannot mutate the record in place. */
  rowAt(sym: string, side?: 'long' | 'short' | null): FunnelTraceRow | null
  gateOf(sym: string, side?: 'long' | 'short' | null): GateCode | null
  /** Does this NAME hold a row on any key — either side, or side-free? The
   * not-candidate count asks exactly this and must never ask about one key. */
  hasRow(sym: string): boolean
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
 * spelling and a screener spelling can never become two rows for one name and
 * side. */
export function funnelTraceRecorder(): FunnelTraceRecorder {
  const rows = new Map<string, FunnelTraceRow>()
  let notCandidateCount = 0
  return {
    record(sym, gate, extra) {
      const key = traceRowKey(sym, extra?.side)
      const prev = rows.get(key)
      if (prev && PUBLISHED_GATES.has(prev.gate)) return
      rows.set(key, rowOf(gate, extra))
    },
    revise(sym, gate, extra) {
      rows.set(traceRowKey(sym, extra?.side), rowOf(gate, extra))
    },
    notCandidate(n) {
      notCandidateCount += Math.max(0, n)
    },
    rowAt(sym, side) {
      const row = rows.get(traceRowKey(sym, side))
      return row ? { ...row } : null
    },
    gateOf(sym, side) {
      return rows.get(traceRowKey(sym, side))?.gate ?? null
    },
    hasRow(sym) {
      const bare = sym.toUpperCase()
      return rows.has(bare) || rows.has(`${bare}:long`) || rows.has(`${bare}:short`)
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
