import { useId, useState } from 'react'
import type { ResearchLearningSnapshot } from '../../../shared/engine/researchLearning'

const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`
const change = (value: number | null | undefined, suffix = '%') => value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}${suffix}`
const decimal = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(3)
const date = (value: number | null) => value == null || !Number.isFinite(value) || value <= 0 ? 'Unknown' : new Date(value > 1e12 ? value : value * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** Descriptive receipts only. Missing history is not a zero return, and a
 * pattern's history must never be presented as independent validation. */
export function LearningPanel({ learning }: { learning?: ResearchLearningSnapshot | null }) {
  const [strategyKey, setStrategyKey] = useState('')
  const [conditionKey, setConditionKey] = useState('all')
  const id = useId()
  const strategy = learning?.strategies.find(s => s.key === strategyKey) ?? learning?.strategies[0]
  const condition = strategy?.conditions.find(c => c.key === conditionKey)
  const stats = condition?.stats ?? strategy?.overall
  const chronology = condition?.chronology ?? strategy?.chronology
  const state = condition?.status ?? strategy?.status
  return <section className="research-learning" aria-label="Historical learning">
    <div className="research-section-head"><div><p className="research-eyebrow">03 / The feedback loop</p><h2>What the evidence is teaching us</h2></div><span className="research-mode">{learning?.status === 'observing' ? 'Descriptive patterns' : 'Collecting evidence'}</span></div>
    <p className="research-section-intro">Follow the same idea from publication to outcome. Compare conditions, check recent results, and keep uncertainty in view.</p>
    {!learning ? <div className="research-learning-empty"><div className="research-learning-mark" aria-hidden="true">↗</div><div><h3>The record starts with real outcomes.</h3><p>Historical learning is not available in this board snapshot. Completed campaigns will appear here once the engine publishes comparable results.</p><span>No performance claim yet</span></div></div> : <>
      <div className="research-learning-census" aria-label="Learning history coverage">
        <div><strong className="num">{learning.history.eligibleCompletedN}</strong><span>Comparable outcomes</span></div>
        <div><strong className="num">{learning.history.pendingN}</strong><span>Awaiting their horizon</span></div>
        <div><strong className="num">{learning.history.excludedCompletedN}</strong><span>Excluded from comparison</span></div>
      </div>
      {strategy && stats && <div className="research-learning-workbench">
        <div className="research-learning-controls">
          <label htmlFor={`${id}-strategy`}>Research strategy<select id={`${id}-strategy`} value={strategy.key} onChange={e => { setStrategyKey(e.target.value); setConditionKey('all') }}>{learning.strategies.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          <label htmlFor={`${id}-condition`}>Observed condition<select id={`${id}-condition`} value={condition?.key ?? 'all'} onChange={e => setConditionKey(e.target.value)}><option value="all">All comparable campaigns</option>{strategy.conditions.map(c => <option key={c.key} value={c.key}>{c.label} · n={c.stats.independentN}</option>)}</select></label>
        </div>
        <div className="research-learning-summary" aria-live="polite"><div><span className="research-eyebrow">{state === 'observing' ? 'Observed association' : 'Evidence is still collecting'}</span><h3>{condition?.label ?? strategy.label}</h3><p>{condition?.summary ?? strategy.summary}</p></div><div className="research-learning-progress"><strong className="num">{stats.independentN}<small> independent campaigns</small></strong><progress value={Math.min(stats.independentN, learning.minimumPatternN)} max={learning.minimumPatternN} aria-label="Evidence toward descriptive pattern threshold" /><span>{learning.minimumPatternN} needed to describe a pattern; this is not proof of predictive skill.</span></div></div>
        <dl className="research-learning-stats" aria-label="Selected campaign results">
          <div><dt>Mean net return</dt><dd>{change(stats.meanNetReturnPct)}</dd><small>{stats.filledN} filled campaigns</small></div>
          <div><dt>{stats.brierEvent === 'finished-higher' ? 'Direction accuracy' : 'Target before stop'}</dt><dd>{percent(stats.brierEvent === 'finished-higher' ? stats.directionAccuracy : stats.targetHitRate)}</dd><small>{stats.brierEvent === 'finished-higher' ? `${stats.directionN} directional outcomes` : `${stats.filledN} filled campaigns`}</small></div>
          <div><dt>Probability error</dt><dd>{decimal(stats.brierScore)}</dd><small>Brier score · {stats.brierN} forecasts · lower is better</small></div>
        </dl>
        {condition?.comparison && <p className="research-learning-comparison">Against {condition.comparison.reference} (n={condition.comparison.referenceN}): mean return difference <b>{change(condition.comparison.returnDifferencePct, 'pp')}</b>; target-hit difference <b>{change(condition.comparison.targetHitDifferencePct, 'pp')}</b>. A difference is shown only when both groups have enough filled campaigns; association does not establish cause.</p>}
        <details className="research-method"><summary>Does the pattern hold in recent campaigns?</summary>{chronology && <><p>{chronology.summary}</p><div className="research-chronology"><div><span>Earlier campaigns</span><strong>{change(chronology.older.meanNetReturnPct)}</strong><small>{chronology.older.independentN} independent · {chronology.older.filledN} filled</small></div><div><span>Recent campaigns</span><strong>{change(chronology.recent.meanNetReturnPct)}</strong><small>{chronology.recent.independentN} independent · {chronology.recent.filledN} filled</small></div></div><p>Split by publication date{chronology.splitPublicationAt ? ` at ${date(chronology.splitPublicationAt)}` : ' when records are available'}. Recent-minus-earlier return: {change(chronology.returnDifferencePct, 'pp')}. This is a chronological diagnostic, not held-out validation.</p></>}</details>
        <details className="research-method"><summary>Calibration, dates & measurement limits</summary><p>Event: {stats.brierEvent === 'finished-higher' ? 'finished higher over the forecast horizon' : 'target reached before stop'}. Median net return {change(stats.medianNetReturnPct)}; cancelled entries {stats.cancelledN}.</p><p>Matched forecast Brier error {decimal(stats.pairedBrierScore)} vs recorded baseline {decimal(stats.baselineBrierScore)} across {stats.baselinePairedN} paired forecasts. Brier skill {decimal(stats.brierSkillScore)}{stats.brierSkillScore == null ? ' — baseline skill is not established.' : ' (positive means lower error than the recorded baseline).'}</p><p>First publication {date(stats.firstPublicationAt)} · latest outcome {date(stats.lastOutcomeAt)}. Strategy horizon {strategy.horizonSessions} sessions.</p><p>Model {strategy.modelVersion}</p></details>
      </div>}
      <details className="research-method research-history-method"><summary>What this learning record includes</summary><p>Rolling history: {learning.history.retainedCompletedN} completed records retained, up to {learning.history.completedLimit}; {learning.history.retainedRecordsN} records including pending campaigns. {learning.history.atCapacity ? 'Older completed records fall outside this window.' : 'The completed history has not reached its storage limit.'}</p><p>Excluded: {learning.history.excludedLegacyN} incompatible model or execution records, {learning.history.excludedUnavailableN} unavailable or incomplete outcomes, and {learning.history.excludedOverlappingN} overlapping campaigns.</p><p>History begins {date(learning.history.oldestPublicationAt)} · latest outcome {date(learning.history.latestOutcomeAt)}.</p>{learning.caveats.map((c, i) => <p key={i}>{c}</p>)}</details>
    </>}
  </section>
}
