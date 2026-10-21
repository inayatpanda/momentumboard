import { BOARD_AUDIT_EXECUTION } from './publishedMarketAudit'
import type { Candle } from '../types'
import { completedLabCandles, LAB_EXECUTION_VERSION, QUALITY_DIP_MODEL_VERSION, SHORT_HORIZON_MODEL_VERSION, SOCIAL_IGNITION_MODEL_VERSION, type StrategyLabRecord } from './strategyLab'

export const MARKET_COMPARISON_VERSION = 'published-next-open-spy-v1'
const DAY = 86_400
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const currentVersions: Record<string, string> = { 'composite-control': 'prospective-board-not-established', 'short-horizon': SHORT_HORIZON_MODEL_VERSION, 'quality-dip': QUALITY_DIP_MODEL_VERSION, 'social-ignition': SOCIAL_IGNITION_MODEL_VERSION }
export interface MarketComparisonCohort {
  sleeve: string; modelVersion: string; current: boolean; horizonSessions: number
  matchedN: number; pendingN: number; missingBenchmarkN: number; overlappingN: number; cancelledN: number
  meanReturnPct: number | null; meanMarketPct: number | null; meanExcessPp: number | null; beatRate: number | null
  publicationDays: number; independentWindows: number
  status: 'collecting' | 'ahead' | 'behind' | 'level'
  firstPublicationAt: number | null; lastOutcomeAt: number | null
}
export interface MarketComparisonSnapshot {
  auditCoverage?: { inspectedPublications: number; eligibleOriginalSizedCalls: number; publicationDates: number; retainedAuditRecords: number }
  version: string; generatedAt: number; benchmark: 'SPY'; costBpsPerSide: number
  cohorts: MarketComparisonCohort[]; excludedUnverifiableN: number; excludedUnsupportedN: number
  caveats: string[]
}

/** Audit frozen, actually published setups. No reranking with today's features,
 * no mixing model versions and no portfolio compounding of overlapping calls.
 * The comparison is descriptive: it cannot establish out-of-sample alpha. */
export function buildMarketComparison(records: StrategyLabRecord[], spy: Candle[], now: number): MarketComparisonSnapshot {
  const tape = completedLabCandles(spy, now, 'SPY')
  const byDay = new Map(tape.map(c => [Math.floor(c.t / DAY), c]))
  let excludedUnverifiableN = 0, excludedUnsupportedN = 0
  const groups = new Map<string, StrategyLabRecord[]>()
  for (const r of records) {
    // A watch-only direction forecast is not an executed investment strategy.
    if (r.state !== 'setup' || r.side === 'neutral') continue
    if (!currentVersions[r.sleeve] || !/^[A-Z][A-Z0-9.-]*$/.test(r.sym) || r.sym.endsWith('.L') || r.sym.endsWith('-USD')) { excludedUnsupportedN++; continue }
    const o = r.outcome
    if (!finite(r.availableAt) || r.availableAt > now || (o && (![LAB_EXECUTION_VERSION, BOARD_AUDIT_EXECUTION].includes(o.executionVersion ?? '') || !finite(o.horizonEndAt) || o.horizonEndAt <= r.availableAt || o.horizonEndAt > now || !finite(o.executionStartAt) || o.executionStartAt <= r.availableAt || o.executionStartAt > o.horizonEndAt || !['filled', 'cancelled-gap'].includes(o.executionStatus ?? '') || !finite(o.returnPct)))) { excludedUnverifiableN++; continue }
    const key = `${r.sleeve}:${r.forecast.modelVersion ?? 'legacy-unversioned'}:${r.forecast.horizonSessions}:${r.forecast.definition}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const cohorts = [...groups.values()].map(rows => {
    rows.sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))
    const first = rows[0]
    const c: MarketComparisonCohort = { sleeve: first.sleeve, modelVersion: first.forecast.modelVersion ?? 'legacy-unversioned', current: first.forecast.modelVersion === currentVersions[first.sleeve], horizonSessions: first.forecast.horizonSessions,
      matchedN: 0, pendingN: 0, missingBenchmarkN: 0, overlappingN: 0, cancelledN: 0,
      meanReturnPct: null, meanMarketPct: null, meanExcessPp: null, beatRate: null,
      publicationDays: 0, independentWindows: 0, status: 'collecting', firstPublicationAt: null, lastOutcomeAt: null }
    const seen = new Set<string>(), horizonBySymbol = new Map<string, number>(), dates = new Set<number>()
    const pairs: { strategy: number; market: number; start: number; end: number }[] = []
    for (const r of rows) {
      if (seen.has(r.id)) { c.overlappingN++; continue }
      seen.add(r.id)
      if (!r.outcome) { c.pendingN++; continue }
      const o = r.outcome
      if (r.availableAt <= (horizonBySymbol.get(r.sym) ?? -Infinity)) { c.overlappingN++; continue }
      horizonBySymbol.set(r.sym, o.horizonEndAt!)
      if (o.executionStatus === 'cancelled-gap') { c.cancelledN++; continue }
      const start = byDay.get(Math.floor(o.executionStartAt! / DAY)), end = byDay.get(Math.floor(o.horizonEndAt! / DAY))
      if (!start || !end || !finite(start.o) || start.o <= 0 || !finite(end.c) || end.c <= 0) { c.missingBenchmarkN++; continue }
      // Same start and fixed end. Early strategy exits remain cash at zero until
      // that end, while SPY is held. Charge 10 bp each way on both alternatives.
      const market = (end.c * .999 / (start.o * 1.001) - 1) * 100
      pairs.push({ strategy: o.returnPct, market, start: o.executionStartAt!, end: o.horizonEndAt! })
      dates.add(Math.floor(r.availableAt / DAY))
      c.firstPublicationAt ??= r.availableAt
      c.lastOutcomeAt = Math.max(c.lastOutcomeAt ?? 0, o.horizonEndAt!)
    }
    c.matchedN = pairs.length; c.publicationDays = dates.size
    c.meanReturnPct = mean(pairs.map(p => p.strategy)); c.meanMarketPct = mean(pairs.map(p => p.market))
    c.meanExcessPp = mean(pairs.map(p => p.strategy - p.market)); c.beatRate = mean(pairs.map(p => Number(p.strategy > p.market)))
    // Count distinct nonoverlapping market windows as a dependence warning.
    // This is NOT an effective sample size or a significance calculation.
    let priorEnd = -Infinity
    for (const p of pairs.sort((a, b) => a.end - b.end)) if (p.start > priorEnd) { c.independentWindows++; priorEnd = p.end }
    if (pairs.length) c.status = c.meanExcessPp! > .01 ? 'ahead' : c.meanExcessPp! < -.01 ? 'behind' : 'level'
    return c
  }).sort((a, b) => Number(b.current) - Number(a.current) || b.matchedN - a.matchedN)
  return { version: MARKET_COMPARISON_VERSION, generatedAt: now, benchmark: 'SPY', costBpsPerSide: 10, cohorts, excludedUnverifiableN, excludedUnsupportedN,
    caveats: [
      'Published actionable research setups only; each model and horizon is separate. Watch-only forecasts are excluded. Earlier unversioned records are an audit of older rules, not evidence for the current model.',
      'US-listed USD equities versus SPY price returns over identical entry and horizon dates. Dividends, taxes, financing and short-borrow costs are excluded; this is not a total-return or investable portfolio backtest.',
      'Published-board audits retrospectively test original sized calls with their saved horizon and daily-close stop, not intraday target exits. These audits are separate from research-model validation.',
      'Both alternatives pay estimated 10 basis points per side. Strategy stops and targets use next-open execution and stop-first same-bar handling; early exits sit in cash at zero until the horizon ends. Gap-cancelled orders are counted separately.',
      'Same-symbol overlapping campaigns are excluded. Different stocks can share market exposure; publication days and nonoverlapping windows disclose this dependence. Average excess per forecast is descriptive, not statistical proof of skill.',
      'Missing or delisted price history can bias results. Unverifiable executions and missing benchmark dates are counted, never filled with zero. Retention is limited to the saved research ledger.',
    ] }
}
