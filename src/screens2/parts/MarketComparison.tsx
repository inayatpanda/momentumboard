import { holdingPeriod, strategyName } from '../../lib/plainLanguage'
import type { MarketComparisonSnapshot } from '../../../shared/engine/marketComparison'
const signed = (n: number | null, suffix = '%') => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}${suffix}`
const names: Record<string, string> = { 'composite-control': 'Published board audit', 'short-horizon': 'Three-session direction', 'quality-dip': 'Quality recovery', 'social-ignition': 'Social ignition' }

export function MarketComparison({ snapshot }: { snapshot?: MarketComparisonSnapshot }) {
  if (!snapshot) return null
  return <section className="market-comparison" aria-label="Market comparison">
    <div className="research-section-head"><div><p className="research-eyebrow">The market test</p><h3>Are our saved predictions beating the market?</h3></div><span className="research-mode">Not yet proven</span></div>
    <p>Predictions saved before the result was known, compared with a US market fund (SPY) over the same dates. Estimated trading costs are included.</p>
    {!snapshot.cohorts.some(c => c.current && c.matchedN > 0) && <p><b>The current models do not yet have completed, comparable market results.</b> Earlier-model audits below do not validate the new engine.</p>}
    {!snapshot.cohorts.length && <p>No published setups have a verifiable market comparison yet. The daily cloud scan checks saved forecasts as their horizons complete.</p>}
    <div className="market-comparison-grid">{snapshot.cohorts.filter(c => c.matchedN > 0).map(c => <article key={`${c.sleeve}:${c.modelVersion}:${c.horizonSessions}`}>
      <span className="research-eyebrow">{c.current ? 'Current model' : 'Earlier model · separate audit'}</span>
      <h4>{strategyName(c.sleeve, names[c.sleeve] ?? c.sleeve)} · {holdingPeriod(c.horizonSessions)}</h4>
      <p><b>{c.status === 'collecting' ? 'Awaiting comparable outcomes' : c.status === 'ahead' ? 'Ahead in this recorded sample' : c.status === 'behind' ? 'Behind the market in this sample' : 'Approximately level in this sample'}</b></p>
      {c.matchedN > 0 && <dl className="research-forecast-grid"><div><dt>Average return</dt><dd>{signed(c.meanReturnPct)}</dd></div><div><dt>US market</dt><dd>{signed(c.meanMarketPct)}</dd></div><div><dt>Difference</dt><dd>{signed(c.meanExcessPp, ' pts')}</dd></div><div><dt>Beat the market</dt><dd>{c.beatRate == null ? '—' : `${Math.round(c.beatRate * 100)}%`}</dd></div></dl>}
      <p className="research-muted">{c.matchedN} completed examples · {c.pendingN} awaiting results. A positive average does not prove future success.</p>
      <details><summary>See the evidence</summary><p>{c.publicationDays} publication days · {c.independentWindows} separate test periods. Difference is measured in percentage points.</p><p>{c.modelVersion}</p><p>{c.cancelledN} gap-cancelled · {c.missingBenchmarkN} missing benchmark · {c.overlappingN} overlapping or duplicate records excluded.</p></details>
    </article>)}</div>
    {snapshot.cohorts.some(c => c.matchedN === 0) && <details className="research-method"><summary>Models still awaiting results</summary>{snapshot.cohorts.filter(c => c.matchedN === 0).map(c => <p key={`${c.sleeve}:${c.modelVersion}`}><b>{names[c.sleeve] ?? c.sleeve}</b> · {c.current ? 'current model' : 'earlier model'} · {c.horizonSessions} sessions · {c.pendingN} pending. {c.modelVersion}</p>)}</details>}
    <details className="research-method"><summary>See the evidence: how this test works</summary><p>Earlier audits use retained records from before immutable-publication enforcement and may contain revision or selection bias. They do not validate the current engine.</p>{snapshot.caveats.map(text => <p key={text}>{text}</p>)}<p>{snapshot.auditCoverage ? `Board audit: ${snapshot.auditCoverage.inspectedPublications} publications across ${snapshot.auditCoverage.publicationDates} dates inspected; ${snapshot.auditCoverage.eligibleOriginalSizedCalls} original sized calls eligible. Refreshes, watch/shadow calls and missing timestamps are excluded. ` : ''}</p><p>{snapshot.excludedUnverifiableN} records lack verifiable execution; {snapshot.excludedUnsupportedN} use unsupported strategies or markets. Missing data is not a zero return.</p></details>
  </section>
}
