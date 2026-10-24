import { Link } from 'wouter'
import type { StockContext } from '../../../shared/engine/stockContext'
import '../../styles/stockContext.css'
const labels = { supportive: 'Price support', mixed: 'Mixed signals', caution: 'Reasons for caution', limited: 'More information needed' }
const stamp = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
const value = (n: number | null, unit = '%') => n == null ? 'Unavailable' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}${unit}`
export function StockContextPanel({ context: c, symbol, compact = false, loading = false }: { context?: StockContext | null; symbol: string; compact?: boolean; loading?: boolean }) {
  const stale = !!c && (Date.now() / 1000 - c.generatedAt > 3 * 86400 || c.generatedAt > Date.now() / 1000 + 300)
  const body = !c ? <p>{loading ? 'Reading the latest saved market view…' : 'A stock-specific market view is not available yet. Watched stocks are included in the next cloud scan; some listings do not have comparable sector data.'}</p> : <>
    <p className="stock-context-summary">{c.summary}</p>
    {stale && <p role="status" className="stock-context-warning">This saved view needs updating. Check the evidence dates before using it.</p>}
    {c.changes && <section className="stock-context-update" aria-label="Daily changes"><h3>{c.changes.heading}</h3>
      {c.changes.session && <p>{c.changes.session}</p>}
      {c.changes.lines.slice(0, 3).map((line, i) => <p key={i}>{line}</p>)}
    </section>}
    {c.dropCheck && <section className="stock-context-update" aria-label="Big drop business check"><h3>Big drop or weaker business?</h3>
      <strong>{c.dropCheck.label}</strong><p>{c.dropCheck.summary}</p>
      {c.dropCheck.drawdownPct != null && <p className="stock-context-note">{Math.abs(c.dropCheck.drawdownPct).toFixed(1)}% below the highest close in {c.dropCheck.sessions} trading sessions.</p>}
      {!['no-large-drop', 'not-applicable'].includes(c.dropCheck.status) && <p><strong>Next check: </strong>{c.dropCheck.next}</p>}
    </section>}
    <div className="stock-context-reasons">
      <div><h4>What helps</h4>{c.support.length ? c.support.slice(0, 2).map((s, i) => <p key={i}>{s}</p>) : <p>No clear supporting signal in this comparison.</p>}</div>
      <div><h4>What to watch</h4>{c.risks.length ? c.risks.slice(0, 2).map((s, i) => <p key={i}>{s}</p>) : <p>No specific warning in these inputs. Other risks may still matter.</p>}</div>
    </div>
    <div className="stock-context-next"><strong>What would change the view?</strong><p>{c.nextCheck}</p></div>
    {c.news.length > 0 ? <p className="stock-context-news"><strong>Recent headline</strong><a href={c.news[0].url} target="_blank" rel="noreferrer">{c.news[0].title} ↗</a><small>Collected {stamp(c.news[0].collectedAt)} · publication time not verified</small></p> : <p className="stock-context-note">Company news coverage is incomplete. No recent linked headline is available in this view.</p>}
    <details className="stock-context-evidence"><summary>See the evidence</summary>
      <p>Prepared {stamp(c.generatedAt)} London time. Stock prices through {c.priceDate ?? 'unknown'}.</p>
      <dl><div><dt>Stock over the month</dt><dd>{value(c.stockMonthPct)}</dd></div><div><dt>Stock compared with {c.sector ?? 'its sector'}</dt><dd>{value(c.stockVsSectorPp, ' percentage points')}</dd></div><div><dt>Sector compared with the US market</dt><dd>{value(c.sectorVsMarketPp, ' percentage points')}</dd></div></dl>
      <p>The price comparisons use the same starting and ending dates, 21 completed stock sessions apart. They exclude dividends and trading costs.</p>
      {c.market && <><h4>Wider markets</h4><p>{c.market.explanation}</p><p>Market prices through {c.market.through}. <a href="https://www.frbsf.org/research-and-insights/publications/economic-letter/2026/08/financial-markets-oil-prices-and-supply-side-risks/" target="_blank" rel="noreferrer">Why oil and shares can move together or apart</a>.</p><h4>What followed similar market conditions?</h4><p>{c.market.historical}</p></>}
      {c.changes && <><h4>Daily comparison</h4><p>{c.changes.baselineAt ? `Compared with the saved view from ${stamp(c.changes.baselineAt)} London time.` : 'No earlier saved daily view is available. We do not reconstruct old news or company assessments.'}</p>{c.changes.lines.slice(3).map((line, i) => <p key={i}>{line}</p>)}<p>Material changes include a changed market view, a one-point change in the sector’s monthly lead, newly collected linked headlines and updated filing checks. Missing coverage can hide changes.</p></>}
      {c.dropCheck && <><h4>Business and price evidence</h4><p>The large-drop check means at least 15% below the highest close in up to 252 completed sessions (at least 60 required), or a fall of at least 8% over five sessions. These are research rules, not a prediction of recovery.</p>
        <p>Five-session price move: {value(c.dropCheck.weekPct)}. Latest balance-sheet period: {c.dropCheck.reportPeriod ?? 'unavailable'}.</p>
        {c.dropCheck.reportAvailableAt && <p>Filing evidence available from {stamp(c.dropCheck.reportAvailableAt)}. Financial reports describe past periods and may predate the drop.</p>}
        {c.dropCheck.facts.map((fact, i) => <p key={`f${i}`}>{fact}</p>)}
        {c.dropCheck.newsReason && <p>Headline screen: {c.dropCheck.newsReason}. This is a simple reading of linked titles, not a verified cause of the fall. It cannot establish that a setback is temporary.</p>}
        {c.dropCheck.gaps.map((gap, i) => <p key={`g${i}`}>{gap}</p>)}
        {c.dropCheck.sourceUrl && <p><a href={c.dropCheck.sourceUrl} target="_blank" rel="noreferrer">Read the SEC financial source ↗</a></p>}
        <p>A healthy business is not necessarily a cheap stock. This check does not change published prediction percentages or position sizes.</p>
      </>}
      <h4>News and sources</h4>{c.news.map(n => <p key={n.url}><a href={n.url} target="_blank" rel="noreferrer">{n.title}</a><small>Collected {stamp(n.collectedAt)}{n.source ? ` · ${n.source}` : ''}</small>{n.interpretation && <span>News editor’s interpretation: {n.interpretation}</span>}</p>)}
      {c.newsView && <p>Directional news interpretation: {c.newsView.reason}. The news model’s explanation has not been independently verified against every linked article.</p>}
      {c.support.slice(2).map((s, i) => <p key={`s${i}`}>{s}</p>)}{c.risks.slice(2).map((s, i) => <p key={`r${i}`}>{s}</p>)}
      {c.gaps.length > 0 && <><h4>What we do not know</h4>{c.gaps.map((s, i) => <p key={i}>{s}</p>)}</>}
      <p>Market history is context for this stock, not a backtest of this company. A strong sector or a favourable season cannot establish business health or fair value.</p>
      <p>We save this context with new forecasts and test an experimental adjustment separately. Displayed prediction percentages and position sizes do not receive an unproven boost.</p>
      <Link href="/today?view=patterns">Explore market history and the context test →</Link>
    </details>
  </>
  return compact ? <details className="stock-context-compact"><summary><span>Market view</span><strong>{stale ? 'Needs updating' : c ? labels[c.status] : loading ? 'Loading…' : 'Not available yet'}</strong></summary><div className="stock-context-body">{body}<Link href={`/stock/${encodeURIComponent(symbol)}`}>Open {symbol} research →</Link></div></details>
    : <section className="stock-context-panel" aria-label={`Market view for ${symbol}`}><div className="stock-context-heading"><h2>What this means for {symbol}</h2><span>{stale ? 'Needs updating' : c ? labels[c.status] : 'Awaiting a market view'}</span></div>{body}</section>
}
