// The deterministic half of a discovery run: everything from "here is the
// universe and the bars we managed to read" to "here are the candidates and the
// one-line reason for every name that isn't one".
//
// No I/O, no clock, no randomness — same inputs, same list, which is principle
// 4 of the spec and the only reason "why wasn't X seen?" has an answer at all.

import type { Candle } from '../../types'
import { computeFeatures } from './features'
import { runLenses } from './lenses'
import { applyHygiene, percentileRanks, selectCandidates } from './rank'
import {
  DISCOVERY_TRACE_MAX,
  LENS_IDS,
  type DiscoveryRejectCode,
  type Exchange,
  type DiscoveryResult,
  type DiscoveryStats,
  type DiscoveryTraceRow,
  type Features,
  type LensHit,
  type LensId,
  type UniverseMember,
} from './types'

export * from './types'
export { computeFeatures, emaSeries } from './features'
export { runLenses, unusualLens, rsLeaderLens, pullbackLens, breakoutLens, dipLens, weakLens, climaxLens } from './lenses'
export { applyHygiene, percentileRanks, priorityFor, quotesInPence, scaleDollarVol, selectCandidates, unusualRatio, PERCENTILE_FIELDS } from './rank'
export { buildUniverse, type UniverseNomination } from './universe'

export interface DiscoverPureInput {
  date: string
  members: Map<string, UniverseMember>
  nominators: Map<string, string[]>
  tapes: Map<string, Candle[]>
  spy: Candle[] | null
  isEtp: (sym: string) => boolean
  /** names the budget never fetched — seen, not read, and the trace says so */
  unread: string[]
}

export type DiscoverPureResult = Omit<DiscoveryResult, 'stats' | 'tapes'> & {
  stats: Pick<DiscoveryStats, 'scanned' | 'selected' | 'perLens' | 'rejects'>
}

/** Closest-to-selected first. The trace is bounded, and the question it exists
 * to answer — "why wasn't X seen?" — is overwhelmingly asked about names that
 * nearly made it, not about the 400th ETP. */
const REJECT_TRACE_ORDER: readonly DiscoveryRejectCode[] = [
  'lens-cut',
  'no-lens',
  'budget-cut',
  'stale-bars',
  'liquidity-floor',
  'price-floor',
  'too-short',
  'no-bars',
  'etp',
]

const bySym = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function discoverPure(input: DiscoverPureInput): DiscoverPureResult {
  const { members, tapes, nominators } = input
  const unread = new Set(input.unread)

  // "THE LAST SESSION" IS PER EXCHANGE, and this is not a nicety.
  //
  // One number over both venues means the busier one always defines today, and
  // the staleness rule (3 sessions, measured as calendar days × 5/7) then reads
  // every UK tape against Wall Street's calendar. Easter is the worked example:
  // the LSE is shut Good Friday AND Easter Monday, Wall Street only Good Friday,
  // so on Easter Tuesday morning the newest UK bar is Thursday's — 5 calendar
  // days, 3.57 sessions by this arithmetic — and ALL 350 UK names in the seed
  // were rejected 'stale-bars' on a day the London market was perfectly healthy.
  // Measured against its OWN venue's newest bar, that same tape is current.
  //
  // The limit itself is unchanged at HYGIENE.maxStaleSessions; what changes is
  // the clock it is measured from. A venue with no tapes at all falls back to
  // the whole-run maximum — there is nothing else to know, and a venue with no
  // bars has no names to judge either.
  const lastByExchange = new Map<Exchange, number>()
  let lastSessionT = 0
  for (const [sym, tape] of tapes) {
    const last = tape[tape.length - 1]
    if (!last) continue
    if (last.t > lastSessionT) lastSessionT = last.t
    const ex = members.get(sym)?.exchange ?? 'US'
    if (last.t > (lastByExchange.get(ex) ?? 0)) lastByExchange.set(ex, last.t)
  }

  const syms = [...members.keys()].sort(bySym)
  const rejects: { sym: string; code: DiscoveryRejectCode; detail?: string }[] = []
  const features = new Map<string, Features>()

  for (const sym of syms) {
    const member = members.get(sym)!
    // THE TAPE FIRST, the budget second. A name the request budget cut can still
    // have been served a cached tape by the bars layer, and such a name was
    // READ — calling it 'budget-cut' while holding its bars threw away a name we
    // had paid nothing for and told the trace a falsehood about why.
    const tape = tapes.get(sym)
    if (!tape || !tape.length) {
      if (unread.has(sym)) rejects.push({ sym, code: 'budget-cut' })
      else if (input.isEtp(sym)) rejects.push({ sym, code: 'etp' })
      else rejects.push({ sym, code: 'no-bars' })
      continue
    }
    const f = computeFeatures(sym, tape, input.spy)
    const code = applyHygiene(member, f, lastByExchange.get(member.exchange) ?? lastSessionT, input.isEtp)
    if (code) {
      rejects.push({ sym, code, detail: code === 'too-short' ? `${tape.length} bars` : undefined })
      continue
    }
    features.set(sym, f!)
  }

  const percentiles = percentileRanks([...features.values()])

  const hits = new Map<string, LensHit[]>()
  for (const sym of syms) {
    const f = features.get(sym)
    if (!f) continue
    const fired = runLenses(f, percentiles.get(sym)!, members.get(sym)!, tapes.get(sym) ?? null)
    if (!fired.length) rejects.push({ sym, code: 'no-lens' })
    else hits.set(sym, fired)
  }

  const { candidates, cut } = selectCandidates(hits, members, features, nominators)
  const selected = new Set(candidates.map(c => c.sym))
  for (const sym of [...cut.keys()].sort(bySym)) {
    if (selected.has(sym)) continue // a third reading was trimmed; the name still made it
    const best = cut.get(sym)![0]
    rejects.push({ sym, code: 'lens-cut', detail: `${best.lens} ${best.score}` })
  }

  const trace: DiscoveryTraceRow[] = candidates.map(c => ({
    sym: c.sym,
    outcome: 'selected' as const,
    lenses: c.lenses.map(l => ({ lens: l.lens, score: l.score })),
    detail: c.lenses[0].reason,
  }))
  const rank = new Map(REJECT_TRACE_ORDER.map((code, i) => [code, i]))
  const orderedRejects = [...rejects].sort(
    (a, b) => (rank.get(a.code) ?? 99) - (rank.get(b.code) ?? 99) || bySym(a.sym, b.sym),
  )
  for (const r of orderedRejects) trace.push({ sym: r.sym, outcome: r.code, detail: r.detail })

  const perLens = Object.fromEntries(LENS_IDS.map(l => [l, 0])) as Record<LensId, number>
  for (const c of candidates) for (const l of c.lenses) perLens[l.lens]++

  // Counted over EVERY reject, not over the bounded trace. `orderedRejects` is
  // the full list; `trace` is the top DISCOVERY_TRACE_MAX of it, which is why a
  // hygiene code that rejected 139 names could be invisible in both the trace
  // and the log until now.
  const rejectCounts: Partial<Record<DiscoveryRejectCode, number>> = {}
  for (const r of orderedRejects) rejectCounts[r.code] = (rejectCounts[r.code] ?? 0) + 1

  return {
    date: input.date,
    candidates,
    trace: trace.slice(0, DISCOVERY_TRACE_MAX),
    stats: { scanned: features.size, selected: candidates.length, perLens, rejects: rejectCounts },
  }
}
