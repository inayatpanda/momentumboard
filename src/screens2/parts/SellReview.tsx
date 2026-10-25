import { useEffect, useState } from 'react'
import { Link, useSearch } from 'wouter'
import type { SellReviewSnapshot, SellReviewRow } from '../../../shared/engine/sellReview'
import '../../styles/strategy-choices.css'
import '../../styles/sell-review.css'

const day = (at: number | string) => new Date(typeof at === 'number' ? at * 1000 : `${at}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const SECTORS: Record<string, string> = { XLK: 'Technology', XLV: 'Healthcare', XLF: 'Financials', XLY: 'Consumer discretionary', XLP: 'Consumer staples', XLE: 'Energy', XLI: 'Industrials', XLB: 'Materials', XLU: 'Utilities', XLRE: 'Real estate', XLC: 'Communication services' }
type Kind = 'all' | 'business' | 'price' | 'valuation'
const LABELS: Record<Kind, string> = { all: 'All reasons', business: 'Business weakening', price: 'Price trend weakening', valuation: 'Demanding valuation' }

function ReviewCard({ row, kind }: { row: SellReviewRow; kind: Kind }) {
  const signals = row.signals.filter(signal => kind === 'all' || signal.kind === kind)
  return <article aria-label={`${row.symbol} sell review`} className={`strategy-choice-card sell-review-card sell-review-${row.status}`}>
    <div className="strategy-choice-card-head"><div><Link href={`/stock/${encodeURIComponent(row.symbol)}`}>{row.symbol}</Link><span>{row.name}</span></div><span className="sell-review-state">{row.status === 'review' ? 'Worth reviewing' : row.status === 'data-gap' ? 'Checks incomplete' : 'No warning found'}</span></div>
    <p className="strategy-choice-sector">{SECTORS[row.sector ?? ''] ?? row.sector ?? 'Sector unavailable'}{row.asOf ? ` · prices ${day(row.asOf)}` : ''}</p>
    {signals.length ? signals.map(signal => <div className="sell-review-reason" key={signal.kind}><h3>{signal.label}</h3><p>{signal.summary}</p></div>) : <p className="strategy-choice-reason">{row.status === 'data-gap' ? 'We need more information before we can finish these checks.' : 'These checks found no current warning. That does not establish that the stock is safe or worth holding.'}</p>}
    {!!row.gaps.length && <p className="sell-review-gap">{row.gaps.length} {row.gaps.length === 1 ? 'check needs' : 'checks need'} more information.</p>}
    <details><summary>See the evidence</summary>
      {signals.map(signal => <section key={signal.kind}><h4>{signal.label}</h4><p>Evidence available by {day(signal.evidenceAt)}.{signal.periodEnd && signal.kind !== 'price' ? ` Financial period ended ${day(signal.periodEnd)}.` : ''}{signal.financialAvailableAt ? ` Filing available ${day(signal.financialAvailableAt)}.` : ''}{signal.priceObservedAt ? ` Price observed ${day(signal.priceObservedAt)}.` : ''}</p><ul>{signal.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>{signal.sources?.filter(source => /^https:\/\//i.test(source.url)).map(source => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></p>)}</section>)}
      {!!row.gaps.length && <><h4>What we could not check</h4><ul>{row.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></>}
      <p>These are fixed research checks, not a tested sell-timing strategy. A stock can keep rising after a warning, or fall without one.</p>
      <Link href={`/stock/${encodeURIComponent(row.symbol)}`}>Read the company reports and recent news →</Link>
    </details>
  </article>
}

export function SellReview({ snapshot, watchSymbols, watchLoaded = true, error, onRefresh, refreshing = false }: {
  snapshot?: SellReviewSnapshot | null; watchSymbols: string[]; watchLoaded?: boolean
  error?: string | null; onRefresh?: () => void; refreshing?: boolean
}) {
  const search = useSearch()
  const selectedStock = (new URLSearchParams(search).get('stock') ?? '').toUpperCase().slice(0, 12)
  const [scope, setScope] = useState<'watchlist' | 'all'>(selectedStock ? 'all' : 'watchlist')
  const [kind, setKind] = useState<Kind>('all')
  const [showChecks, setShowChecks] = useState(false)
  const [limit, setLimit] = useState(12)
  useEffect(() => { setScope(selectedStock ? 'all' : 'watchlist') }, [selectedStock])
  useEffect(() => setLimit(12), [scope, kind, showChecks, selectedStock])
  const now = Date.now() / 1000
  const fresh = !!snapshot && snapshot.version === 'sell-review-v1' && snapshot.generatedAt > 0 && snapshot.generatedAt <= now && now - snapshot.generatedAt <= 48 * 3600
  const watched = new Set(watchSymbols.map(s => s.toUpperCase()))
  const rows = fresh ? snapshot!.rows.filter(row => selectedStock ? row.symbol === selectedStock : scope === 'all' || watched.has(row.symbol)) : []
  const warnings = rows.filter(row => row.status === 'review')
  const gaps = rows.filter(row => row.gaps.length > 0)
  const covered = new Set(rows.map(row => row.symbol))
  const outside = fresh && !selectedStock && scope === 'watchlist' ? [...watched].filter(symbol => !covered.has(symbol)) : []
  const visible = rows.filter(row => (showChecks || !!selectedStock || row.status === 'review') && (kind === 'all' || row.signals.some(signal => signal.kind === kind)))

  return <section className="strategy-choices sell-review" aria-label="Review selling">
    <div className="strategy-choice-heading"><div><p className="strategy-choice-eyebrow">The other side of investing</p><h2>Review selling</h2></div>{onRefresh && <button className="strategy-choice-refresh" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>}</div>
    <p className="strategy-choice-intro">Has your reason for owning a stock changed? Check weakening businesses, sustained price weakness and demanding valuations separately.</p>
    <p className="sell-review-note">A warning is a reason to review your holding, not an instruction to sell. Your watchlist may include stocks you do not own.</p>
    {error && <p className="strategy-choice-alert" role="status">The latest scan could not load. {fresh ? 'Showing the recent saved scan.' : 'Try refreshing shortly.'}</p>}
    {!fresh ? <div className="strategy-choice-empty"><h3>{snapshot ? 'This review needs a fresh scan' : 'The first sell review is being prepared'}</h3><p>{snapshot ? 'Older or unverified results are hidden so they are not mistaken for current warnings.' : 'The cloud checks run alongside the daily stock scan. Your computer can stay off.'}</p></div> : <>
      <div className="sell-review-scope" role="group" aria-label="Stocks to review"><button aria-pressed={scope === 'watchlist' && !selectedStock} onClick={() => setScope('watchlist')} disabled={!!selectedStock}>My watchlist</button><button aria-pressed={scope === 'all' || !!selectedStock} onClick={() => setScope('all')}>{selectedStock ? selectedStock : `All ${snapshot!.coverage.scanned} stocks`}</button></div>
      {selectedStock && <p className="strategy-choice-muted">Reviewing {selectedStock}. <Link href="/stocks?view=sell">Back to your watchlist review</Link></p>}
      <p className="strategy-choice-muted">Updated {day(snapshot!.generatedAt)} · daily cloud research · no live trade monitoring</p>
      {!watchLoaded && scope === 'watchlist' ? <p role="status">Loading your watchlist…</p> : <>
        <div className="sell-review-counts"><div><strong>{warnings.length}</strong><span>Worth reviewing</span></div><div><strong>{gaps.length}</strong><span>Checks incomplete</span></div><div><strong>{rows.filter(row => row.status === 'no-warning').length}</strong><span>No warning found</span></div></div>
        <label className="strategy-choice-select sell-review-filter">Choose a reason<select value={kind} onChange={event => { setKind(event.target.value as Kind); if (event.target.value !== 'all') setShowChecks(false) }}>{(Object.keys(LABELS) as Kind[]).map(value => <option key={value} value={value}>{LABELS[value]}{value !== 'all' ? ` (${warnings.filter(row => row.signals.some(signal => signal.kind === value)).length})` : ''}</option>)}</select></label>
        <p className="strategy-choice-muted">A stock can have a warning and incomplete checks.</p>
        <label className="sell-review-toggle"><input type="checkbox" disabled={kind !== 'all'} checked={showChecks} onChange={event => setShowChecks(event.target.checked)} />Include stocks with no warning or incomplete checks</label>
        {kind !== 'all' && <p className="strategy-choice-muted">Choose All reasons to include stocks with no warning or incomplete checks.</p>}
        {!!outside.length && <p className="sell-review-gap">Outside this scan: {outside.join(', ')}. No sell review is available for these stocks.</p>}
        {visible.length ? <div className="strategy-choice-cards">{visible.slice(0, limit).map(row => <ReviewCard key={row.symbol} row={row} kind={kind} />)}</div> : <div className="strategy-choice-empty"><h3>{selectedStock && !rows.length ? `${selectedStock} is outside this scan` : !watchSymbols.length && scope === 'watchlist' ? 'Add stocks you want to review' : 'No warnings match this view'}</h3><p>{selectedStock && !rows.length ? 'We cannot assess a stock that has not been checked.' : 'No warning is not the same as a recommendation to hold. Include incomplete checks to see what information is missing, or explore all scanned stocks.'}</p></div>}
        {visible.length > limit && <button className="strategy-choice-more" onClick={() => setLimit(value => value + 12)}>Show more stocks</button>}
      </>}
    </>}
    <details className="sell-review-guide"><summary>See the evidence: how to use this review</summary><p>Start with the reason you bought the stock. Check the latest company report and whether the weakness is temporary. A high valuation, a weak chart and a deteriorating business are different reasons to investigate; they are not added into a made-up sell score.</p><p>Before deciding, consider your time horizon, how much of your portfolio this holding represents, and any costs or tax consequences. Reducing a position is also different from selling it all.</p><p>We do not know your full portfolio or personal circumstances. This pathway does not place trades. The existing buy-strategy backtests do not validate these sell checks.</p><a href="https://www.investor.gov/introduction-investing/investing-basics/asset-allocation" target="_blank" rel="noreferrer">Investor.gov: diversification and rebalancing</a></details>
  </section>
}
