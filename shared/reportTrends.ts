import type { BusinessHealthAssessment, BusinessHealthEvidence } from './businessHealth'

export type ReportPeriodKind = 'annual' | 'quarter' | 'year-to-date'
export type ReportTrendStatus = 'improving' | 'stable' | 'deteriorating' | 'insufficient'
export const REPORT_TREND_METRICS = [
  'revenue', 'netIncome', 'operatingCashFlow', 'capitalExpenditure', 'freeCashFlow',
  'revenueGrowthPct', 'netMarginPct', 'netMarginChangePp',
  'operatingCashFlowMarginPct', 'operatingCashFlowMarginChangePp',
  'freeCashFlowMarginPct', 'freeCashFlowMarginChangePp',
  'shareCountChangePct', 'currentRatio', 'debtToEquity', 'liabilitiesToEquity',
] as const
export type ReportTrendMetric = typeof REPORT_TREND_METRICS[number]

/** One reporting period, reconstructed using only filings available at its
 * first publication cutoff. Comparative figures are not additional reports. */
export interface FinancialReportPoint {
  periodStart: string | null
  periodEnd: string
  periodKind: ReportPeriodKind
  durationDays: number | null
  cashFlowPeriodStart: string | null
  cashFlowPeriodKind: ReportPeriodKind | null
  filed: string
  availableAt: number
  accession: string
  financialHealth: 'healthy' | 'unknown' | 'deteriorating'
  healthAssessment: BusinessHealthAssessment
  annualPeriodEnd: string | null
  balancePeriodEnd: string | null
  coverageStatus: 'available' | 'partial' | 'unavailable' | 'stale'
  metrics: Record<ReportTrendMetric, number | null>
  evidence: Partial<Record<ReportTrendMetric, BusinessHealthEvidence>>
  gaps: string[]
}

export interface ReportTrendSummary {
  methodVersion: 'comparable-filings-v1'
  status: ReportTrendStatus
  observations: number
  comparisonN: number
  fromPeriodEnd: string | null
  toPeriodEnd: string | null
  latestAvailableAt: number | null
  metrics: {
    revenueGrowthPct: number | null
    /** Change between the two latest equally long reporting windows only. */
    revenueGrowthChangePp: number | null
    netMarginChangePp: number | null
    operatingCashFlowMarginChangePp: number | null
    freeCashFlowMarginChangePp: number | null
    shareCountChangePct: number | null
    positiveCashFlowReports: number
    cashFlowReports: number
    improvingReports: number
    deterioratingReports: number
  }
  reasons: string[]
  gaps: string[]
}

const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value)
const r2 = (value: number) => Math.round(value * 100) / 100
const DAY = 86_400

/** A transparent financial trajectory screen, not a fitted return model.
 * Three operating families get at most one vote each: revenue, profitability,
 * and cash conversion. OCF and FCF cannot double-count the same cash flow. */
export function summarizeReportTrends(history: FinancialReportPoint[], asOf: number): ReportTrendSummary {
  const seen = new Set<string>()
  const points = [...history]
    .filter(p => Number.isFinite(p.availableAt) && p.availableAt <= asOf && Number.isFinite(Date.parse(p.periodEnd)) && Date.parse(p.periodEnd) / 1000 <= asOf)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.availableAt - b.availableAt)
    .filter(p => { if (seen.has(p.periodEnd)) return false; seen.add(p.periodEnd); return true })
    .slice(-12)
  const latest = points.at(-1)
  const previous = points.at(-2)
  const classify = (p: FinancialReportPoint) => {
    const cash = p.metrics.freeCashFlowMarginChangePp ?? p.metrics.operatingCashFlowMarginChangePp
    const measures = [[p.metrics.revenueGrowthPct, 2], [p.metrics.netMarginChangePp, 1], [cash, 1]] as const
    const known = measures.filter(([value]) => finite(value))
    const improving = known.filter(([value, threshold]) => value! > threshold).length
    const deteriorating = known.filter(([value, threshold]) => value! < -threshold).length
    const state = known.length < 2 ? 'insufficient' : deteriorating >= 2 || (p.metrics.shareCountChangePct ?? 0) > 10
      ? 'deteriorating' : improving >= 2 ? 'improving' : 'stable'
    return { point: p, state }
  }
  const classified = points.map(classify)
  const comparable = classified.filter(p => p.state !== 'insufficient')
  const recent = classified.slice(-3)
  const latestState = classified.at(-1)?.state
  const cashReports = points.filter(p => finite(p.metrics.operatingCashFlow))
  const sameSpan = latest && previous && latest.periodKind === previous.periodKind && latest.durationDays != null && previous.durationDays != null && Math.abs(latest.durationDays - previous.durationDays) <= 15
  const result: ReportTrendSummary = {
    methodVersion: 'comparable-filings-v1', status: 'insufficient', observations: points.length,
    comparisonN: comparable.length, fromPeriodEnd: points[0]?.periodEnd ?? null,
    toPeriodEnd: latest?.periodEnd ?? null, latestAvailableAt: latest?.availableAt ?? null,
    metrics: {
      revenueGrowthPct: latest?.metrics.revenueGrowthPct ?? null,
      revenueGrowthChangePp: sameSpan && finite(latest.metrics.revenueGrowthPct) && finite(previous.metrics.revenueGrowthPct)
        ? r2(latest.metrics.revenueGrowthPct - previous.metrics.revenueGrowthPct) : null,
      netMarginChangePp: latest?.metrics.netMarginChangePp ?? null,
      operatingCashFlowMarginChangePp: latest?.metrics.operatingCashFlowMarginChangePp ?? null,
      freeCashFlowMarginChangePp: latest?.metrics.freeCashFlowMarginChangePp ?? null,
      shareCountChangePct: latest?.metrics.shareCountChangePct ?? null,
      positiveCashFlowReports: cashReports.filter(p => p.metrics.operatingCashFlow! > 0).length,
      cashFlowReports: cashReports.length,
      improvingReports: comparable.filter(p => p.state === 'improving').length,
      deterioratingReports: comparable.filter(p => p.state === 'deteriorating').length,
    }, reasons: [], gaps: [],
  }
  if (!latest) {
    result.gaps.push('No point-in-time reporting history is available.')
    return result
  }
  if (points.length < 3 || recent.some(p => p.state === 'insufficient')) {
    result.gaps.push('Three recent reporting periods with at least two comparable operating measures each are required.')
  }
  const age = (asOf - Date.parse(`${latest.periodEnd}T00:00:00Z`) / 1000) / DAY
  if (age > (latest.periodKind === 'annual' ? 550 : 180)) result.gaps.push('The latest reporting period is stale; historical improvement cannot establish current health.')
  if (!result.gaps.length) {
    const improving = recent.filter(p => p.state === 'improving').length
    const deteriorating = recent.filter(p => p.state === 'deteriorating').length
    result.status = latestState === 'deteriorating' && deteriorating >= 2 ? 'deteriorating'
      : latestState === 'improving' && improving >= 2 ? 'improving' : 'stable'
  }
  result.reasons.push(`${points.length} distinct reporting periods reconstructed at their original filing availability; ${comparable.length} have comparable operating evidence.`)
  if (result.status === 'improving') result.reasons.push('The latest report and at least one of the prior two improved in two operating families versus comparable prior-year periods.')
  else if (result.status === 'deteriorating') result.reasons.push('The latest report and at least one of the prior two show weakening operating comparisons or material dilution.')
  else if (result.status === 'stable') result.reasons.push('Recent comparable reports are stable or mixed; the screen does not establish a persistent direction.')
  result.gaps.push('Financial trajectory is descriptive, not a calibrated stock-return probability. Report windows can overlap and are not independent trading outcomes.')
  return result
}
