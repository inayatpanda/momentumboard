import { businessStatus } from '../../lib/plainLanguage'
import { assessBusinessHealth, type BusinessHealthMetric, type BusinessHealthSnapshot } from '../../../shared/businessHealth'
import { getBusinessHealth } from '../../lib/api'
import { useSlice } from '../../lib/useSlice'
import { ReportHistoryPanel } from './ReportHistoryPanel'
import '../../styles/dossier.css'

const METRICS: [BusinessHealthMetric, string, 'money' | 'pct' | 'ratio'][] = [
  ['revenue', 'Annual revenue', 'money'], ['netIncome', 'Annual net income', 'money'],
  ['operatingCashFlow', 'Operating cash flow', 'money'], ['freeCashFlow', 'Free cash flow', 'money'],
  ['revenueGrowthPct', 'Annual revenue growth', 'pct'], ['netMarginPct', 'Net margin', 'pct'],
  ['totalDebt', 'Reported debt', 'money'], ['cash', 'Cash', 'money'],
  ['currentRatio', 'Current ratio', 'ratio'], ['debtToEquity', 'Debt / equity', 'ratio'],
  ['shareCountChangePct', 'Annual share count change', 'pct'],
  ['recentNetIncome', 'Latest reported interim profit', 'money'],
  ['recentOperatingCashFlow', 'Latest reported interim operating cash flow', 'money'],
  ['recentRevenueGrowthPct', 'Comparable interim revenue growth', 'pct'],
  ['recentShareCountChangePct', 'Comparable interim share count change', 'pct'],
  ['liabilitiesToEquity', 'Total liabilities / equity', 'ratio'],
]
const formatValue = (n: number | null, type: 'money' | 'pct' | 'ratio') => n == null ? 'Unavailable'
  : type === 'money' ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(n)
  : type === 'pct' ? `${n.toFixed(1)}%` : `${n.toFixed(2)}×`

export function BusinessHealthRead({ snapshot }: { snapshot: BusinessHealthSnapshot }) {
  const assessment = assessBusinessHealth(snapshot, Math.floor(Date.now() / 1000))
  return <>
    <div className="business-status-line"><span className={`report-status ${assessment.status}`}><b>{businessStatus(assessment.status)}</b></span><span>{snapshot.company ?? snapshot.sym} · {snapshot.balancePeriodEnd ?? 'Reporting date unavailable'}</span></div>
    <p className="cc-reason">A lower share price can be worth a closer look. We check company profits, cash and debt. Passing these checks does not mean the stock is cheap or will recover.</p>
    <dl className="business-key-figures">
      <div><dt>Annual profit</dt><dd>{formatValue(snapshot.metrics.netIncome, 'money')}</dd><small>{snapshot.evidence.netIncome?.periodEnd ?? 'No reported value'}</small></div>
      <div><dt>Free cash flow</dt><dd>{formatValue(snapshot.metrics.freeCashFlow, 'money')}</dd><small>Cash left after running and investing in the business</small></div>
      <div><dt>Revenue growth</dt><dd>{formatValue(snapshot.metrics.revenueGrowthPct, 'pct')}</dd><small>Comparable prior year</small></div>
      <div><dt>Debt / equity</dt><dd>{formatValue(snapshot.metrics.debtToEquity, 'ratio')}</dd><small>{snapshot.balancePeriodEnd ?? 'Leverage unverified'}</small></div>
    </dl>
    <div className="business-evidence-grid">
      {assessment.reasons.length > 0 && <div><h3>What looks healthy</h3><ul>{assessment.reasons.slice(0, 3).map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
      {(assessment.risks.length > 0 || assessment.gaps.length > 0) && <div className="business-cautions"><h3>{assessment.risks.length ? 'What needs attention' : 'Not established'}</h3><ul>{[...assessment.risks, ...assessment.gaps].slice(0, 4).map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
    </div>
    {(assessment.reasons.length > 3 || assessment.risks.length + assessment.gaps.length > 4) && <details className="report-gaps"><summary>See the evidence: financial checks</summary><ul>{[...assessment.reasons, ...assessment.risks, ...assessment.gaps].map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
    <ReportHistoryPanel key={snapshot.sym} snapshot={snapshot} />
    <details>
      <summary>See the evidence: company figures and reports</summary>
      <div className="health-table-scroll"><table className="health-table">
        <thead><tr><th scope="col">Measure</th><th scope="col">Value</th><th scope="col">Reported period</th><th scope="col">Filed</th></tr></thead>
        <tbody>{METRICS.map(([key, label, type]) => <tr key={key}>
          <th scope="row">{label}</th><td>{formatValue(snapshot.metrics[key], type)}</td>
          <td>{snapshot.evidence[key]?.periodStart ? `${snapshot.evidence[key]?.periodStart} to ` : ''}{snapshot.evidence[key]?.periodEnd ?? '—'}</td><td>{snapshot.evidence[key]?.filed ?? '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
    <p className="sp-source-line">SEC company filings · retrieved {new Date(snapshot.asOf * 1000).toLocaleDateString('en-GB')}{snapshot.sourceUrl && <> · <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">Source data</a></>}</p>
    {snapshot.warnings.length > 0 && <p className="cc-reason">{snapshot.warnings.join(' ')}</p>}
    <p className="cc-reason">Financial-company ratios, international accounting and forward earnings estimates need separate analysis. Unavailable fields remain unknown; this screen does not cover every business risk.</p>
  </>
}

export function BusinessHealthPanel({ sym }: { sym: string }) {
  const { data, error, refreshing, refresh } = useSlice(`business-health:${sym}`, () => getBusinessHealth(sym))
  return <section id={`${sym}-business`} className="card itl-section dossier-business" aria-label="Business health">
    <div className="dossier-section-head"><div><span className="dossier-eyebrow">Company finances</span><h2>How healthy is the business?</h2></div><button className="dossier-caption" type="button" onClick={refresh} disabled={refreshing}>{refreshing ? 'Updating…' : 'Update reports'}</button></div>
    {error && <p role="alert" className="cc-reason">Business filings could not be refreshed. {data ? 'Showing saved evidence.' : 'Financial health is unknown.'} <button type="button" onClick={refresh} disabled={refreshing}>Retry business health</button></p>}
    {data ? <BusinessHealthRead snapshot={data} /> : !error && <p role="status" className="cc-reason">Checking reported business fundamentals…</p>}
  </section>
}
