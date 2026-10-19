import { describe, expect, it } from 'vitest'
import { REPORT_TREND_METRICS, summarizeReportTrends, type FinancialReportPoint } from './reportTrends'

const sec = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000
const NOW = sec('2026-10-19')
const point = (end: string, available: string, changes: Partial<FinancialReportPoint['metrics']> = {}): FinancialReportPoint => ({
  periodStart: `${end.slice(0, 4)}-01-01`, periodEnd: end, periodKind: 'quarter', durationDays: 90,
  cashFlowPeriodStart: `${end.slice(0, 4)}-01-01`, cashFlowPeriodKind: 'year-to-date',
  filed: available, availableAt: sec(available), accession: `report-${end}`, financialHealth: 'healthy',
  healthAssessment: { status: 'healthy', reasons: [], risks: [], gaps: [] },
  annualPeriodEnd: '2025-12-31', balancePeriodEnd: end, coverageStatus: 'available',
  metrics: { ...Object.fromEntries(REPORT_TREND_METRICS.map(key => [key, null])) as FinancialReportPoint['metrics'],
    revenueGrowthPct: 10, netMarginChangePp: 2, operatingCashFlowMarginChangePp: 3, freeCashFlowMarginChangePp: 2,
    shareCountChangePct: 0, operatingCashFlow: 100, ...changes }, evidence: {}, gaps: [],
})
const history = (changes: Partial<FinancialReportPoint['metrics']> = {}) => [
  point('2025-12-31', '2026-02-16', changes), point('2026-03-31', '2026-05-16', changes), point('2026-06-30', '2026-08-02', changes),
]

describe('reported financial trajectories', () => {
  it('requires repeated comparable improvement across three real report periods', () => {
    const summary = summarizeReportTrends(history(), NOW)
    expect(summary.status).toBe('improving')
    expect(summary.observations).toBe(3)
    expect(summary.comparisonN).toBe(3)
    expect(summary.metrics.positiveCashFlowReports).toBe(3)
    expect(summary.metrics.improvingReports).toBe(3)
    expect(summary.fromPeriodEnd).toBe('2025-12-31')
    expect(summary.toPeriodEnd).toBe('2026-06-30')
  })

  it('identifies sustained deterioration and dilution without turning it into a price probability', () => {
    const weak = history({ revenueGrowthPct: -10, netMarginChangePp: -3, operatingCashFlow: -50 })
    expect(summarizeReportTrends(weak, NOW).status).toBe('deteriorating')
    expect(summarizeReportTrends(weak, NOW).metrics.positiveCashFlowReports).toBe(0)
    expect(summarizeReportTrends(history({ shareCountChangePct: 20 }), NOW).status).toBe('deteriorating')
    expect(summarizeReportTrends(weak, NOW).gaps.join(' ')).toContain('not a calibrated stock-return probability')
  })

  it('does not let correlated cash measures provide two independent operating votes', () => {
    const summary = summarizeReportTrends(history({ revenueGrowthPct: 0, netMarginChangePp: 0, operatingCashFlowMarginChangePp: 5, freeCashFlowMarginChangePp: 5 }), NOW)
    expect(summary.status).toBe('stable')
    expect(summary.metrics.improvingReports).toBe(0)
  })

  it('requires sufficient latest evidence and does not fabricate confidence from a large report count', () => {
    expect(summarizeReportTrends(history().slice(0, 2), NOW).status).toBe('insufficient')
    expect(summarizeReportTrends(history({ netMarginChangePp: null, operatingCashFlowMarginChangePp: null, freeCashFlowMarginChangePp: null }), NOW).status).toBe('insufficient')
    expect(summarizeReportTrends(history(), sec('2027-06-01')).status).toBe('insufficient')
  })

  it('ignores future reports and duplicate/amended copies of the same period', () => {
    const original = history()
    const enriched = [...original, { ...original[0], availableAt: sec('2026-09-01'), metrics: { ...original[0].metrics, revenueGrowthPct: -100 } },
      point('2026-09-30', '2026-11-01', { revenueGrowthPct: -100, netMarginChangePp: -10 })]
    expect(summarizeReportTrends(enriched, NOW)).toEqual(summarizeReportTrends(original, NOW))
  })

  it('does not compare raw quarter dollars with annual or YTD totals', () => {
    const reports = history({ revenueGrowthPct: 0, netMarginChangePp: 0, freeCashFlowMarginChangePp: 0, operatingCashFlowMarginChangePp: 0 })
    reports[1].periodKind = 'annual'
    reports[1].durationDays = 365
    reports[1].metrics.revenue = 100_000
    reports[2].metrics.revenue = 1_000
    const summary = summarizeReportTrends(reports, NOW)
    expect(summary.status).toBe('stable')
    expect(summary.metrics.revenueGrowthChangePp).toBeNull()
  })

  it('does not carry an older improving label through a reversal in the latest report', () => {
    const reports = history()
    reports[2].metrics = { ...reports[2].metrics, revenueGrowthPct: -10, netMarginChangePp: -5 }
    expect(summarizeReportTrends(reports, NOW).status).toBe('stable')
  })
})
