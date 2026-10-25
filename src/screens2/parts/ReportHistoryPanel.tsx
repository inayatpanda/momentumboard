import { QuarterlyFinancialPanel } from './QuarterlyFinancialPanel'
import { useState } from 'react'
import type { BusinessHealthSnapshot } from '../../../shared/businessHealth'
import { summarizeReportTrends, type FinancialReportPoint, type ReportPeriodKind, type ReportTrendMetric } from '../../../shared/reportTrends'

const PERIODS: Record<ReportPeriodKind, string> = { annual: 'Annual', quarter: 'Quarterly', 'year-to-date': 'Year to date' }
const CHARTS: { key: ReportTrendMetric; label: string; unit: '%' | 'pp' }[] = [
  { key: 'revenueGrowthPct', label: 'Revenue growth', unit: '%' },
  { key: 'netMarginChangePp', label: 'Margin change', unit: 'pp' },
  { key: 'operatingCashFlowMarginChangePp', label: 'Cash flow margin change', unit: 'pp' },
]
const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n)
const value = (n: number | null | undefined, unit = '%') => finite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}${unit}` : 'Unavailable'
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })

function TrendChart({ points, metric, unit, label, selected }: { points: FinancialReportPoint[]; metric: ReportTrendMetric; unit: string; label: string; selected: string }) {
  const values = points.map(point => point.metrics[metric]).filter(finite)
  if (values.length < 2) return <div className="report-chart-empty">At least two comparable reported values are needed to draw this trend.</div>
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values, lo + 1)
  const span = hi - lo
  const x = (i: number) => 48 + i / Math.max(1, points.length - 1) * 524
  const y = (n: number) => 145 - (n - lo) / span * 116
  let previousKnown = false
  const path = points.map((point, i) => {
    const n = point.metrics[metric]
    if (!finite(n)) { previousKnown = false; return '' }
    const part = `${previousKnown ? 'L' : 'M'} ${x(i)} ${y(n)}`
    previousKnown = true
    return part
  }).join(' ')
  return <div className="report-chart-frame" role="img" aria-label={`${label} versus the comparable prior-year period across ${points.length} reports`}>
    <div className="report-chart-axis" aria-hidden="true"><span>{hi.toFixed(0)}{unit}</span><span>{lo.toFixed(0)}{unit}</span></div>
    <svg className="report-trend-chart" viewBox="0 0 620 180" preserveAspectRatio="none" aria-hidden="true">
    <line x1="48" x2="572" y1={y(0)} y2={y(0)} className="report-zero" />
    <path d={path} className="report-trend-line" />
    {points.map((point, i) => finite(point.metrics[metric]) && <g key={point.periodEnd}>
      <path d={`M ${x(i)} ${y(point.metrics[metric]!)} l 0.001 0`} className={`report-trend-point${point.periodEnd === selected ? ' selected' : ''}`} />
      <title>{point.periodEnd}: {value(point.metrics[metric], unit)}; filed {point.filed}</title>
    </g>)}
    </svg>
    <div className="report-chart-dates" aria-hidden="true"><span>{shortDate(points[0].periodEnd)}</span><span>{shortDate(points.at(-1)!.periodEnd)}</span></div>
  </div>
}

export function ReportHistoryPanel({ snapshot }: { snapshot: BusinessHealthSnapshot }) {
  const now = Math.floor(Date.now() / 1000)
  const history = [...(snapshot.reportHistory ?? [])].filter(point => Number.isFinite(point.availableAt) && point.availableAt <= now && Date.parse(`${point.periodEnd}T00:00:00Z`) / 1000 <= now).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
  const trend = summarizeReportTrends(history, now)
  const [period, setPeriod] = useState<ReportPeriodKind | null>(null)
  const selectedPeriod = period && history.some(point => point.periodKind === period) ? period : history.at(-1)?.periodKind ?? 'quarter'
  const points = history.filter(point => point.periodKind === selectedPeriod)
  const [selectedEnd, setSelectedEnd] = useState<string | null>(null)
  const selected = points.find(point => point.periodEnd === selectedEnd) ?? points.at(-1)
  const [metricKey, setMetricKey] = useState<ReportTrendMetric>('revenueGrowthPct')
  const metric = CHARTS.find(item => item.key === metricKey)!
  const reportUrl = selected && snapshot.cik && /^\d{10}-\d{2}-\d{6}$/.test(selected.accession)
    ? `https://www.sec.gov/Archives/edgar/data/${snapshot.cik}/${selected.accession.replace(/-/g, '')}/${selected.accession}-index.html` : null

  return <div className="report-history" aria-label="Report history and business trajectory">
    <QuarterlyFinancialPanel snapshot={snapshot} />
    <div className="dossier-section-head"><div><span className="dossier-eyebrow">Past company reports</span><h3>How the business is changing</h3></div><span className={`report-status ${trend.status}`}>{trend.status === 'insufficient' ? 'Building history' : trend.status}</span></div>
    <p className="dossier-caption">{history.length ? `${trend.observations} dated reports · ${trend.comparisonN} with comparable operating evidence` : 'Historical filings are not available for this company yet.'}</p>
    {history.length > 0 && <>
      <div className="report-toolbar">
        <div className="report-segments" role="group" aria-label="Report period type">
          {(Object.keys(PERIODS) as ReportPeriodKind[]).filter(kind => history.some(point => point.periodKind === kind)).map(kind => <button type="button" key={kind} aria-pressed={selectedPeriod === kind} onClick={() => { setPeriod(kind); setSelectedEnd(null) }}>{PERIODS[kind]}</button>)}
        </div>
        <label className="report-metric-label">Compare <select value={metricKey} onChange={event => setMetricKey(event.target.value as ReportTrendMetric)}>{CHARTS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      </div>
      <TrendChart points={points} metric={metric.key} unit={metric.unit} label={metric.label} selected={selected?.periodEnd ?? ''} />
      <div className="report-timeline" role="group" aria-label="Choose a historical report">
        {points.map(point => <button type="button" key={point.periodEnd} aria-pressed={point.periodEnd === selected?.periodEnd} onClick={() => setSelectedEnd(point.periodEnd)}><span>{shortDate(point.periodEnd)}</span><small>Filed {point.filed.slice(5)}</small></button>)}
      </div>
      {selected && <div className="report-selected" aria-live="polite">
        <div className="report-selected-head"><b>{PERIODS[selected.periodKind]} report · {selected.periodEnd}</b><span>Known from {new Date(selected.availableAt * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC' })}{reportUrl && <> · <a href={reportUrl} target="_blank" rel="noreferrer">Original report ↗</a></>}</span></div>
        <dl className="report-metrics">
          <div><dt>Revenue growth</dt><dd>{value(selected.metrics.revenueGrowthPct)}</dd><small>vs comparable prior year</small></div>
          <div><dt>Profit margin change</dt><dd>{value(selected.metrics.netMarginChangePp, 'pp')}</dd><small>vs comparable prior year</small></div>
          <div><dt>Operating cash margin</dt><dd>{value(selected.metrics.operatingCashFlowMarginChangePp, 'pp')}</dd><small>{selected.cashFlowPeriodKind ? PERIODS[selected.cashFlowPeriodKind] : 'Unknown period'} · vs prior year</small></div>
          <div><dt>Change in share count</dt><dd>{value(selected.metrics.shareCountChangePct)}</dd><small>same-filing comparison</small></div>
        </dl>
        <p className="dossier-caption">Financial screen at publication: <b>{selected.financialHealth}</b>. {selected.gaps.length > 0 ? `${selected.gaps.length} evidence gaps remain.` : 'Reported measures were available at the saved cutoff.'}</p>
        {selected.gaps.length > 0 && <details className="report-gaps"><summary>Evidence gaps in this report</summary><ul>{selected.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></details>}
      </div>}
    </>}
    <p className="report-method">Each point uses information available at that filing date. Growth compares like reporting windows with the prior year; quarter and year-to-date amounts are kept separate. Historical improvement does not establish a future return.</p>
    <details className="report-gaps"><summary>See the evidence: how we assess the trend</summary><ul>{[...trend.reasons, ...trend.gaps].map((reason, i) => <li key={i}>{reason}</li>)}</ul></details>
  </div>
}
