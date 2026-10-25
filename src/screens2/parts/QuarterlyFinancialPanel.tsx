import type { BusinessHealthSnapshot } from '../../../shared/businessHealth'
import { quarterlyTrend } from '../../../shared/quarterlyFinancials'
const money = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n)
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? 'Unavailable' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
const labels = { improving: 'Improving', stable: 'Broadly steady', deteriorating: 'Getting weaker', insufficient: 'More evidence needed' }
export function QuarterlyFinancialPanel({ snapshot }: { snapshot: BusinessHealthSnapshot }) {
  const now = Date.now() / 1000, data = snapshot.quarterly
  const quarters = (data?.quarters ?? []).filter(q => q.availableAt <= now && Date.parse(q.end) / 1000 <= now).sort((a,b) => a.end.localeCompare(b.end))
  const last = quarters.at(-1), status = quarterlyTrend(quarters, now)
  const year = data?.trailingYear && data.trailingYear.availableAt <= now && Date.parse(data.trailingYear.end) / 1000 <= now ? data.trailingYear : null
  return <section className="quarterly-financials" aria-label="Quarterly business trends">
    <div className="dossier-section-head"><div><span className="dossier-eyebrow">Quarter by quarter</span><h3>Is the business getting stronger?</h3></div><span className={`report-status ${status}`}>{labels[status]}</span></div>
    <p className="dossier-caption">{last ? `Latest quarter ended ${last.end}. Changes compare with the same quarter a year earlier.` : 'Comparable quarterly figures are not available yet. Missing figures do not count as a healthy business.'}</p>
    {last && <><dl className="report-metrics">
      <div><dt>Sales growth</dt><dd>{pct(last.revenueGrowthPct)}</dd><small>same quarter last year</small></div>
      <div><dt>Profit from sales</dt><dd>{pct(last.netMarginPct)}</dd><small>net profit margin</small></div>
      <div><dt>Cash left after investment</dt><dd>{money(last.values.freeCashFlow)}</dd><small>free cash flow this quarter</small></div>
    </dl><p className="dossier-caption">{status === 'deteriorating' ? 'Repeated weakening blocks a recovery setup, even if the share price looks cheap.' : status === 'improving' ? 'Recent operating trends are improving. Price, debt and valuation checks still need to pass.' : status === 'stable' ? 'Recent comparisons show no persistent broad improvement or decline.' : 'There are not enough recent, comparable quarters to judge a sustained trend.'}</p></>}
    <details className="report-gaps"><summary>See the evidence: quarterly figures</summary>
      {year && <p>Last four consecutive quarters ({year.start} to {year.end}): sales <b>{money(year.values.revenue)}</b>, profit <b>{money(year.values.netIncome)}</b>, free cash flow <b>{money(year.values.freeCashFlow)}</b>.</p>}
      {quarters.length > 0 && <div className="history-table-scroll"><table><caption>Individual quarters · USD · most recent eight</caption><thead><tr><th>Quarter ended</th><th>Sales</th><th>Sales growth</th><th>Profit</th><th>Free cash flow</th><th>Known from</th></tr></thead><tbody>{quarters.slice(-8).map(q => <tr key={q.end}><th>{q.end}{q.derived ? '*' : ''}</th><td>{money(q.values.revenue)}</td><td>{pct(q.revenueGrowthPct)}</td><td>{money(q.values.netIncome)}</td><td>{money(q.values.freeCashFlow)}</td><td>{new Date(q.availableAt*1000).toISOString().slice(0,10)}</td></tr>)}</tbody></table></div>}
      <p>* Some quarterly amounts are calculated by subtracting earlier year-to-date totals from later totals. Four-quarter figures never add overlapping reporting periods. Later corrections are only used after publication.</p>
      <p>Three consecutive recent quarters are required. At least two operating measures must be comparable in each. Repeated improvement or weakness in sales growth and profit or cash margins determines the label. This is an accounting screen, not a return forecast.</p>
      {(data?.gaps ?? []).map(gap => <p key={gap}>{gap}</p>)}
    </details>
  </section>
}
