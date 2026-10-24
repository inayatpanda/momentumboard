import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { emptyBusinessHealth } from '../../../shared/businessHealth'
import { REPORT_TREND_METRICS, type FinancialReportPoint, type ReportTrendMetric } from '../../../shared/reportTrends'
import { ReportHistoryPanel } from './ReportHistoryPanel'

const report = (periodEnd: string, growth: number, kind: FinancialReportPoint['periodKind'] = 'quarter'): FinancialReportPoint => ({
  periodStart: null, periodEnd, periodKind: kind, durationDays: kind === 'annual' ? 365 : 90,
  cashFlowPeriodStart: null, cashFlowPeriodKind: kind, filed: periodEnd, availableAt: Date.parse(periodEnd) / 1000 + 86400,
  accession: '0000123456-25-000001', financialHealth: 'unknown', healthAssessment: { status: 'unknown', reasons: [], risks: [], gaps: [] },
  annualPeriodEnd: null, balancePeriodEnd: periodEnd, coverageStatus: 'partial',
  metrics: { ...Object.fromEntries(REPORT_TREND_METRICS.map(key => [key, null])) as Record<ReportTrendMetric, number | null>, revenueGrowthPct: growth, netMarginChangePp: 2, operatingCashFlowMarginChangePp: 3 }, evidence: {}, gaps: ['Leverage needs review'],
})
const snapshot = () => ({ ...emptyBusinessHealth('TEST', Date.now() / 1000, ''), cik: 123456, reportHistory: [report('2024-12-31', 2, 'annual'), report('2025-03-31', 5), report('2025-06-30', 8), report('2025-09-30', 11)] })

describe('historical company report explorer', () => {
  it('changes the selected report without mixing annual and quarter series', () => {
    render(<ReportHistoryPanel snapshot={snapshot()} />)
    expect(screen.getByText('Quarterly report · 2025-09-30')).toBeInTheDocument()
    const timeline = screen.getByRole('group', { name: 'Choose a historical report' })
    expect(within(timeline).getAllByRole('button')).toHaveLength(3)
    fireEvent.click(within(timeline).getByRole('button', { name: /Mar 25/ }))
    expect(screen.getByText('Quarterly report · 2025-03-31')).toBeInTheDocument()
    expect(screen.getByText('+5.0%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Annual$/ }))
    expect(screen.getByText('Annual report · 2024-12-31')).toBeInTheDocument()
    expect(screen.getByText(/At least two comparable/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Original report ↗' })).toHaveAttribute('href', 'https://www.sec.gov/Archives/edgar/data/123456/000012345625000001/0000123456-25-000001-index.html')
  })
  it('switches the metric with a labelled chart and keeps missing values unknown', () => {
    render(<ReportHistoryPanel snapshot={snapshot()} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Compare' }), { target: { value: 'netMarginChangePp' } })
    expect(screen.getByRole('img', { name: /Margin change versus/ })).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.getByText('Leverage needs review')).toBeInTheDocument()
  })
  it('never renders an unpublished future report as present evidence', () => {
    const data = snapshot()
    data.reportHistory.push({ ...report('2099-03-31', 99), availableAt: Date.now() / 1000 + 86400 })
    render(<ReportHistoryPanel snapshot={data} />)
    expect(screen.queryByText(/2099/)).not.toBeInTheDocument()
    expect(screen.getByText(/4 dated reports/)).toBeInTheDocument()
  })
})
