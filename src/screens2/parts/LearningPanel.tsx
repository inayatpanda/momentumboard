import { useId, useState } from 'react'
import { Link } from 'wouter'
import type { ResearchLearningSnapshot } from '../../../shared/engine/researchLearning'
import { BrandMark } from '../../components/BrandMark'
import { MarketComparison } from './MarketComparison'
import { HistoricalStudy } from './HistoricalStudy'

const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`
const change = (value: number | null | undefined, suffix = '%') => value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}${suffix}`
const decimal = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(3)
const date = (value: number | null) => value == null || !Number.isFinite(value) || value <= 0 ? 'Unknown' : new Date(value > 1e12 ? value : value * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const QUALIFICATION: Record<string, string> = {
  'short-horizon': 'A direction forecast needs enough completed price history. The engine records the forecast before measuring what happens next.',
  'quality-dip': 'Recovery candidates need a meaningful drawdown and supported business health. An actionable setup also needs signs of price stabilisation; a low price alone does not qualify.',
  'social-ignition': 'Channel attention becomes a tracked campaign only when an actionable setup is recorded. Mentions and watch-only ideas are not completed trades.',
}

/** Descriptive receipts only. Missing history is not a zero return, and a
 * pattern's history must never be presented as independent validation. */
export function LearningPanel({ learning, onResearch }: { learning?: ResearchLearningSnapshot | null; onResearch?: () => void }) {
  const [strategyKey, setStrategyKey] = useState('')
  const [conditionKey, setConditionKey] = useState('all')
  const id = useId()
  const strategy = learning?.strategies.find(s => s.key === strategyKey) ?? learning?.strategies[0]
  const condition = strategy?.conditions.find(c => c.key === conditionKey)
  const stats = condition?.stats ?? strategy?.overall
  const chronology = condition?.chronology ?? strategy?.chronology
  const state = condition?.status ?? strategy?.status
  const measured = (stats?.independentN ?? 0) > 0
  const tracking = strategy?.tracking
  const researchLink = onResearch ? <button className="research-text-link" onClick={onResearch}>Explore current research →</button> : <a className="research-text-link" href="#opportunities">Explore current research →</a>
  return <section className="research-learning" aria-label="Historical learning">
    <div className="research-section-head"><div><p className="research-eyebrow">The feedback loop</p><h2>{learning?.history.eligibleCompletedN ? 'What the evidence is teaching us' : 'Following ideas through to results'}</h2></div><span className="research-mode">{learning?.status === 'observing' ? 'Descriptive patterns' : 'Building the record'}</span></div>
    <p className="research-section-intro">{learning?.history.eligibleCompletedN ? 'Compare recorded conditions and outcomes, with uncertainty kept in view.' : 'Each forecast is saved first, then checked after its observation period. Performance appears here when comparable results are ready.'}</p>
    {!learning ? <div className="research-learning-empty"><BrandMark size={44} /><div><h3>The learning snapshot is not available.</h3><p>Historical learning is not available in this board snapshot. Refresh Today to check for an update; existing published-call results are available in Track record.</p><Link href="/record" className="research-text-link">View published-call results →</Link></div></div> : <>
      <HistoricalStudy study={learning.historicalStudy} />
      <MarketComparison snapshot={learning.marketComparison} />
      <div className="research-learning-census" aria-label="Learning history coverage">
        <div><strong className="num">{learning.history.eligibleCompletedN}</strong><span>Outcomes for current models</span></div>
        <div><strong className="num">{learning.history.currentPendingN ?? learning.history.pendingN}</strong><span>{learning.history.currentPendingN != null ? 'Current forecasts being tracked' : 'Unscored records · all versions'}</span></div>
      </div>
      {learning.marketComparison && <p className="learning-history-note">Forecast tracking includes watch-only direction estimates; the market test uses actionable setups.</p>}
      {learning.history.excludedCompletedN > 0 && <p className="learning-history-note">{learning.history.excludedCompletedN} completed records are kept separately because they are not comparable with this model. <a href="#learning-history-details" onClick={() => { const detail = document.getElementById('learning-history-details'); if (detail instanceof HTMLDetailsElement) detail.open = true }}>Why these are separate ↓</a></p>}
      {strategy && stats && <div className="research-learning-workbench">
        <div className="research-learning-controls">
          <label htmlFor={`${id}-strategy`}>Research strategy<select id={`${id}-strategy`} value={strategy.key} onChange={e => { setStrategyKey(e.target.value); setConditionKey('all') }}>{learning.strategies.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          {strategy.conditions.length > 0 && <label htmlFor={`${id}-condition`}>Observed condition<select id={`${id}-condition`} value={condition?.key ?? 'all'} onChange={e => setConditionKey(e.target.value)}><option value="all">All comparable campaigns</option>{strategy.conditions.map(c => <option key={c.key} value={c.key}>{c.label} · n={c.stats.independentN}</option>)}</select></label>}
        </div>
        {!measured ? <div className="learning-pending" aria-label="Research awaiting outcomes">
          <span className="research-eyebrow">{tracking?.pendingN ? 'Recorded and being followed' : tracking ? 'Waiting for qualifying research' : 'No comparable outcomes yet'}</span>
          <h3>{strategy.label}</h3>
          {tracking?.pendingN ? <><p><strong>{tracking.pendingN} saved forecasts</strong> are being followed for {strategy.horizonSessions} market sessions. The daily evaluation can score them once the full period and price data are available.</p><p className="research-muted">Earliest pending forecast: {date(tracking.firstPublicationAt)}. Weekends, market holidays and missing prices can delay results.</p><div className="learning-tracked-symbols" aria-label="Stocks currently being followed">{tracking.symbols.map(sym => <Link key={sym} href={`/stock/${encodeURIComponent(sym)}`}>{sym} ↗</Link>)}</div></> : <p>{tracking ? QUALIFICATION[strategy.key] : 'This snapshot has no comparable completed results for the selected strategy. The total unscored count may include older model versions.'}</p>}
          <div className="learning-next-step"><strong>What appears next</strong><p>Completed outcomes first; return and accuracy statistics where measurable. At least {learning.minimumPatternN} independent outcomes are needed to describe a pattern. That threshold alone does not prove predictive skill.</p></div>
          <div className="learning-actions">{researchLink}<Link href="/record" className="research-text-link">View published-call results →</Link></div>
        </div> : <>
        <div className="research-learning-summary" aria-live="polite"><div><span className="research-eyebrow">{state === 'observing' ? 'Observed association' : 'Evidence is still collecting'}</span><h3>{condition?.label ?? strategy.label}</h3><p>{condition?.summary ?? strategy.summary}</p></div><div className="research-learning-progress"><strong className="num">{stats.independentN}<small> independent campaigns</small></strong><progress value={Math.min(stats.independentN, learning.minimumPatternN)} max={learning.minimumPatternN} aria-label="Evidence toward descriptive pattern threshold" /><span>{learning.minimumPatternN} needed to describe a pattern; this is not proof of predictive skill.</span></div></div>
        <dl className="research-learning-stats" aria-label="Selected campaign results">
          <div><dt>Mean net return</dt><dd>{stats.filledN ? change(stats.meanNetReturnPct) : <small>No filled trades</small>}</dd><small>{stats.filledN} filled campaigns</small></div>
          <div><dt>{stats.brierEvent === 'finished-higher' ? 'Direction accuracy' : 'Target before stop'}</dt><dd>{(stats.brierEvent === 'finished-higher' ? stats.directionN : stats.filledN) ? percent(stats.brierEvent === 'finished-higher' ? stats.directionAccuracy : stats.targetHitRate) : <small>No scored outcomes</small>}</dd><small>{stats.brierEvent === 'finished-higher' ? `${stats.directionN} directional outcomes` : `${stats.filledN} filled campaigns`}</small></div>
          <div><dt>Probability error</dt><dd>{stats.brierN ? decimal(stats.brierScore) : <small>No scored forecasts</small>}</dd><small>Brier score · {stats.brierN} forecasts · lower is better</small></div>
        </dl>
        {condition?.comparison && <p className="research-learning-comparison">Against {condition.comparison.reference} (n={condition.comparison.referenceN}): mean return difference <b>{change(condition.comparison.returnDifferencePct, 'pp')}</b>; target-hit difference <b>{change(condition.comparison.targetHitDifferencePct, 'pp')}</b>. A difference is shown only when both groups have enough filled campaigns; association does not establish cause.</p>}
        <details className="research-method"><summary>Does the pattern hold in recent campaigns?</summary>{chronology && <><p>{chronology.summary}</p><div className="research-chronology"><div><span>Earlier campaigns</span><strong>{change(chronology.older.meanNetReturnPct)}</strong><small>{chronology.older.independentN} independent · {chronology.older.filledN} filled</small></div><div><span>Recent campaigns</span><strong>{change(chronology.recent.meanNetReturnPct)}</strong><small>{chronology.recent.independentN} independent · {chronology.recent.filledN} filled</small></div></div><p>Split by publication date{chronology.splitPublicationAt ? ` at ${date(chronology.splitPublicationAt)}` : ' when records are available'}. Recent-minus-earlier return: {change(chronology.returnDifferencePct, 'pp')}. This is a chronological diagnostic, not held-out validation.</p></>}</details>
        <details className="research-method"><summary>Calibration, dates & measurement limits</summary><p>Event: {stats.brierEvent === 'finished-higher' ? 'finished higher over the forecast horizon' : 'target reached before stop'}. Median net return {change(stats.medianNetReturnPct)}; cancelled entries {stats.cancelledN}.</p><p>Matched forecast Brier error {decimal(stats.pairedBrierScore)} vs recorded baseline {decimal(stats.baselineBrierScore)} across {stats.baselinePairedN} paired forecasts. Brier skill {decimal(stats.brierSkillScore)}{stats.brierSkillScore == null ? ' — baseline skill is not established.' : ' (positive means lower error than the recorded baseline).'}</p><p>First publication {date(stats.firstPublicationAt)} · latest outcome {date(stats.lastOutcomeAt)}. Strategy horizon {strategy.horizonSessions} sessions.</p><p>Model {strategy.modelVersion}</p></details>
        </>}
      </div>}
      <details id="learning-history-details" className="research-method research-history-method"><summary>Why some records are kept separately</summary><p>The new research model uses a consistent set of forecasting and execution rules. Results from earlier rules cannot establish this model’s performance.</p><p>Excluded from comparison: {learning.history.excludedLegacyN} incompatible model or execution records, {learning.history.excludedUnavailableN} unavailable or incomplete outcomes, and {learning.history.excludedOverlappingN} overlapping campaigns.</p>{learning.history.earlierPendingN != null && <p>{learning.history.earlierPendingN} additional unscored records belong to earlier or incompatible research. They remain saved and are separate from the current forecast count.</p>}<p>Rolling history: {learning.history.retainedCompletedN} completed records retained, up to {learning.history.completedLimit}; {learning.history.retainedRecordsN} records including pending campaigns. {learning.history.atCapacity ? 'Older completed records fall outside this window.' : 'The completed history has not reached its storage limit.'}</p><p>Latest learning snapshot: {date(learning.generatedAt)}.</p><p>The main engine’s published-call track record is a separate history. <Link href="/record">Open Track record →</Link></p>{learning.caveats.map((c, i) => <p key={i}>{c}</p>)}</details>
    </>}
  </section>
}
