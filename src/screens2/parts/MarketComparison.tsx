import type { MarketComparisonSnapshot } from '../../../shared/engine/marketComparison'
const signed = (n: number | null, suffix = '%') => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}${suffix}`
const names: Record<string, string> = { 'composite-control': 'Published board audit', 'short-horizon': 'Three-session direction', 'quality-dip': 'Quality recovery', 'social-ignition': 'Social ignition' }

export function MarketComparison({ snapshot }: { snapshot?: MarketComparisonSnapshot }) {
  if (!snapshot) return null
  return <section className="market-comparison" aria-label="Market comparison">
    <div className="research-section-head"><div><p className="research-eyebrow">The market test</p><h3>Are the forecasts beating SPY?</h3></div><span className="research-mode">Predictive edge unproven</span></div>
    <p>Saved setups versus holding the US market over the same dates, after estimated trading costs. Each model keeps its own record.</p>
    {!snapshot.cohorts.some(c => c.current && c.matchedN > 0) && <p><b>The current models do not yet have completed, comparable market results.</b> Earlier-model audits below do not validate the new engine.</p>}
    {!snapshot.cohorts.length && <p>No published setups have a verifiable market comparison yet. The daily cloud scan checks saved forecasts as their horizons complete.</p>}
    <div className="market-comparison-grid">{snapshot.cohorts.map(c => <article key={`${c.sleeve}:${c.modelVersion}:${c.horizonSessions}`}>
      <span className="research-eyebrow">{c.current ? 'Current model' : 'Earlier model · separate audit'}</span>
      <h4>{names[c.sleeve] ?? c.sleeve} · {c.horizonSessions} sessions</h4>
      <p><b>{c.status === 'collecting' ? 'Awaiting comparable outcomes' : c.status === 'ahead' ? 'Ahead in this recorded sample' : c.status === 'behind' ? 'Behind the market in this sample' : 'Approximately level in this sample'}</b></p>
      {c.matchedN > 0 && <dl className="research-forecast-grid"><div><dt>Forecast return</dt><dd>{signed(c.meanReturnPct)}</dd></div><div><dt>SPY return</dt><dd>{signed(c.meanMarketPct)}</dd></div><div><dt>Excess per forecast</dt><dd>{signed(c.meanExcessPp, 'pp')}</dd></div><div><dt>Beat SPY</dt><dd>{c.beatRate == null ? '—' : `${Math.round(c.beatRate * 100)}%`}</dd></div></dl>}
      <p className="research-muted">{c.matchedN} matched setups · {c.pendingN} pending · {c.publicationDays} publication days · {c.independentWindows} nonoverlapping windows</p>
      <details><summary>Coverage and model</summary><p>{c.modelVersion}</p><p>{c.cancelledN} gap-cancelled · {c.missingBenchmarkN} missing benchmark · {c.overlappingN} overlapping or duplicate records excluded.</p></details>
    </article>)}</div>
    <details className="research-method"><summary>How this test works</summary>{snapshot.caveats.map(text => <p key={text}>{text}</p>)}<p>{snapshot.auditCoverage ? `Board audit: ${snapshot.auditCoverage.inspectedPublications} publications across ${snapshot.auditCoverage.publicationDates} dates inspected; ${snapshot.auditCoverage.eligibleOriginalSizedCalls} original sized calls eligible. Refreshes, watch/shadow calls and missing timestamps are excluded. ` : ''}</p><p>{snapshot.excludedUnverifiableN} records lack verifiable execution; {snapshot.excludedUnsupportedN} use unsupported strategies or markets. Missing data is not a zero return.</p></details>
  </section>
}
