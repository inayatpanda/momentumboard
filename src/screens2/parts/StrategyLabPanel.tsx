import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'wouter'
import type { EngineLabSnapshot, StrategyObservation } from '../../../shared/engine/strategyLab'
import { strategyName, holdingPeriod, businessStatus, reportStatus, directionName, researchWording, nextCheckWording } from '../../lib/plainLanguage'
import { recoveryChecklist } from '../../../shared/engine/recoveryChecklist'
import '../../styles/research.css'

const LABELS: Record<StrategyObservation['sleeve'], string> = {
  'short-horizon': 'Short-term direction', 'quality-dip': 'Recovery after a fall', 'social-ignition': 'Growing attention',
  'macro-event': 'Major market events', 'composite-control': 'Main engine',
}
const FILTERS = ['short-horizon', 'quality-dip', 'social-ignition'] as const
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 100)}%`
const signed = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
const price = (n: number | null) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })
const STATE_LABEL: Record<StrategyObservation['state'], string> = { setup: 'Worth a closer look', watch: 'Watching', avoid: 'Avoid for now', collecting: 'More information needed' }

function stamp(at: number) {
  if (!Number.isFinite(at) || at <= 0) return 'Date unavailable'
  const ms = at > 1e12 ? at : at * 1000
  return `${new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`
}

function ObservationCard({ row, linked = true }: { row: StrategyObservation; linked?: boolean }) {
  const directional = row.sleeve === 'short-horizon'
  const summary = row.sleeve === 'quality-dip' && typeof row.metrics.drawdownPct === 'number'
    ? `${row.sym} is ${Math.abs(row.metrics.drawdownPct).toFixed(1)}% below its recent high. We are checking whether the business and price show signs of recovery.`
    : directional && row.forecast.calibratedN > 0
      ? 'We are comparing this stock’s recent price pattern with similar periods in its history to test what might happen next.'
      : row.reasons[0] || 'There is not enough information to explain this idea yet.'
  const nextCheck = recoveryChecklist(row).find(check => !check.passed)
  const stale = row.availableAt > 0 && Date.now() - (row.availableAt > 1e12 ? row.availableAt : row.availableAt * 1000) > 3 * 86_400_000
  return <article className={`research-decision research-decision-${row.sleeve}`} aria-label={`${row.sym} ${LABELS[row.sleeve]} research`}>
    <div className="research-card-top"><span className="research-eyebrow">{LABELS[row.sleeve]}</span><span className={`research-state ${row.state}`}>{STATE_LABEL[row.state]}</span></div>
    <div className="research-card-identity"><h3>{row.sym}</h3><span className={`pill ${row.side}`}>{row.state === 'avoid' ? 'No trade idea' : row.state === 'watch' && row.side !== 'neutral' ? (row.side === 'long' ? 'Watching for a rise' : 'Watching for a fall') : directionName(row.side)}</span></div>
    <p className="research-eyebrow">Why it’s interesting</p><p className="research-thesis">{summary}</p>
    {directional && row.metrics.historyGate === 'not-supported' && <p className="research-missing">Earlier tests did not support this strategy. This is a watch idea only.</p>}
    <p className="research-muted">Time to follow: <b>{holdingPeriod(row.forecast.horizonSessions)}</b>. {row.forecast.calibratedN === 0 ? 'Not enough results to judge accuracy.' : 'Past examples do not tell us how reliably this will work next.'}</p>
    <div className="research-risk"><span>Main risk</span><p>{row.risks[0] ? researchWording(row.risks[0]) : 'No specific risk was recorded. This does not mean the idea is low risk.'}</p></div>
    {row.sleeve === 'quality-dip' && <p className="research-muted"><b>Business health:</b> {businessStatus(row.metrics.financialHealth)}. <b>What we’re waiting for:</b> {nextCheck ? nextCheckWording(nextCheck.label, nextCheck.detail) : 'The checks are met; review current prices and risks before deciding.'}</p>}
    {row.dataGaps.length > 0 && <p className="research-missing"><b>Still missing</b> {row.dataGaps.length} {row.dataGaps.length === 1 ? 'piece' : 'pieces'} of information to check. Open the evidence below for details.</p>}
    <details className="research-card-details"><summary>See the evidence</summary>
    <p className="research-muted">Research rank {row.score}/100. This orders ideas for review; it is not a chance of success.</p>
    <div className="research-estimate">
      <div><span>{directional ? 'Past examples that rose' : 'Chance of reaching the target before the loss limit'}</span><strong className="num">{directional ? pct(row.forecast.probabilityUp) : row.forecast.probabilityTarget == null ? 'Not enough results' : pct(row.forecast.probabilityTarget)}</strong></div>
      <div><span>Time followed</span><strong className="num">{row.forecast.horizonSessions} <small>trading days</small></strong></div>
    </div>
    <div className="research-evidence-line"><span className="research-status-dot" aria-hidden="true" /><span>{directional ? `${row.forecast.calibratedN} similar past examples · ${row.forecast.liveN ?? 0} completed saved forecasts` : `${row.forecast.calibratedN} completed ideas`}</span></div>
    {directional && row.side === 'neutral' && <p className="research-muted"><b>No reliable evidence for a rise or fall.</b></p>}
    {directional && row.metrics.historyGate && row.metrics.historyGate !== 'passed' && <p className="research-muted"><b>Historical safety check:</b> {row.metrics.historyGate === 'not-supported' ? 'Earlier results did not support this strategy. This remains a watch idea.' : 'This stock is not yet covered by a current, comparable long-history test.'}</p>}
    {row.dataGaps.length > 0 && <p><b>Full missing-information notes:</b> {row.dataGaps.join(' · ')}</p>}
    {row.sleeve === 'quality-dip' && <div className="research-recovery" aria-label="Recovery evidence">
      <div><span>Business</span><strong>{businessStatus(row.metrics.financialHealth)}</strong></div>
      <div><span>Sector financial checks</span><strong>{String(row.metrics.financialSector ?? 'Needs classification')}</strong></div>
      <div><span>Valuation</span><strong>{row.metrics.valuationStatus === 'supported' ? 'Within research limits' : row.metrics.valuationStatus === 'demanding' ? 'Above research limits' : 'Needs evidence'}</strong></div>
      <div><span>Company report trend</span><strong>{reportStatus(row.metrics.reportTrend)}{typeof row.metrics.reportObservations === 'number' ? ` · ${row.metrics.reportObservations} reports` : ''}</strong></div>
      <div><span>Signs of price recovery</span><strong>{row.metrics.stabilising === true ? 'Confirmed' : 'Not confirmed'}</strong></div>
      <div><span>Sector</span><strong>{row.metrics.sectorName ? `${row.metrics.sectorName}: ${row.metrics.sectorRotation === 'in' ? 'improving' : row.metrics.sectorRotation === 'out' ? 'weakening' : 'mixed'}` : 'Not mapped'}</strong></div>
      <div><span>International markets</span><strong>{String(row.metrics.worldTone ?? 'unavailable')}</strong></div>
    </div>}
    {row.sleeve === 'quality-dip' && <details className="research-card-details"><summary>What needs to happen next</summary><ul className="recovery-checklist">{recoveryChecklist(row).map(check=><li key={check.label}><span className={check.passed?'met':'pending'}>{check.passed?'Met':'Pending'}</span><div><b>{check.label}</b><p>{check.detail}</p></div></li>)}</ul></details>}
    <div>
      <div className="research-card-detail-body">
        {directional ? <>
          <p className="research-muted">What happened in similar past examples</p>
          <dl className="research-forecast-grid"><div><dt>Up</dt><dd>{pct(row.forecast.probabilityUp)}</dd></div><div><dt>Down</dt><dd>{pct(row.forecast.probabilityDown)}</dd></div><div><dt>Flat</dt><dd>{pct(row.forecast.probabilityFlat)}</dd></div><div><dt>Median</dt><dd>{signed(row.forecast.expectedMovePct)}</dd></div><div className="research-range"><dt>Range</dt><dd>{signed(row.forecast.expectedLowPct)} to {signed(row.forecast.expectedHighPct)}</dd><small>Middle 60% of examples</small></div></dl>
          {row.forecast.probabilityUpInterval && <p>Up frequency uncertainty: {pct(row.forecast.probabilityUpInterval[0])}–{pct(row.forecast.probabilityUpInterval[1])} (95% interval; future outcomes can differ).</p>}
          {row.forecast.baselineProbabilityUp != null && <p>Historical base rate: {pct(row.forecast.baselineProbabilityUp)} up.</p>}
        </> : <dl className="research-forecast-grid"><div><dt>Entry</dt><dd>{price(row.entry)}</dd></div><div><dt>Stop</dt><dd>{price(row.stop)}</dd></div><div><dt>Target</dt><dd>{price(row.target)}</dd></div></dl>}
        {row.reasons.slice(summary === row.reasons[0] ? 1 : 0).map((reason, i) => <p key={`reason-${i}`}><b>Supporting evidence</b> {reason}</p>)}
        {row.risks.slice(researchWording(row.risks[0] ?? '') === row.risks[0] ? 1 : 0).map((risk, i) => <p key={`risk-${i}`}><b>Additional risk</b> {risk}</p>)}
        {row.sleeve === 'quality-dip' && <>
          <p><b>Financial checks</b> {String(row.metrics.financialChecks ?? 'Sector checks are awaiting the next scan.')}</p>
          <p><b>Valuation evidence</b> {String(row.metrics.valuationSummary ?? 'Not available')}{typeof row.metrics.valuationObservedAt === 'number' ? ` Market capitalization observed ${stamp(row.metrics.valuationObservedAt)}.` : ''} Research limits are fixed hypotheses, not peer medians or fair-value estimates.</p>
          <p><b>Report availability</b> {typeof row.metrics.reportLatestAvailableAt === 'number' ? stamp(row.metrics.reportLatestAvailableAt) : 'Date unavailable'}. Business evidence is backward-looking.</p>
          <p><b>Probability basis</b> {row.forecast.calibrationBasis === 'validated-report-trend' ? 'Chronologically tested report-trend cohort' : 'Pooled forward campaigns'}.{row.forecast.conditioningReason ? ` ${row.forecast.conditioningReason}` : ' Condition-specific evidence is still collecting.'}</p>
          {row.forecast.calibrationBasis === 'validated-report-trend' && <p>The report cohort passed a chronological test on previously recorded outcomes. This is retrospective evidence; forward predictive skill is still being measured.</p>}
          {row.forecast.conditioningN != null && <p>Report-trend cohort: {row.forecast.conditioningContext ?? 'unknown'} · {row.forecast.conditioningN} campaigns · {row.forecast.conditioningValidationN ?? 0} chronological validation forecasts.</p>}
          <p><b>Selloff cause</b> {String(row.metrics.newsAssessment ?? 'not checked')}{row.metrics.newsMethod ? ' (headline interpretation)' : ''}</p>
          {typeof row.metrics.sectorRelative21Pct === 'number' && <p>Sector relative return: {row.metrics.sectorRelative21Pct >= 0 ? '+' : ''}{row.metrics.sectorRelative21Pct.toFixed(1)}pp vs SPY over 21 sessions.</p>}
          <p>Target is a half-drawdown recovery scenario to test, not an estimate of fair value.</p>
        </>}
        {row.forecast.brierScore != null && <p>Live Brier error {row.forecast.brierScore.toFixed(3)} (lower is better){row.forecast.brierSkillScore != null ? ` · ${row.forecast.brierSkillScore > 0 ? 'improved' : 'no improvement'} against the recorded base-rate forecast` : ' · baseline comparison not available'}.</p>}
        <p>Research ranking is not a success probability. Historical examples do not establish forward predictive skill.</p>
      </div>
    </div>
    </details>
    <div className="research-card-footer"><span>{stale ? 'Older scan · ' : 'Scan · '}{stamp(row.availableAt)}<small>Being tested · no real trades</small></span>{linked && <Link href={`/stock/${row.sym}`} className="research-text-link" aria-label={`Open ${row.sym} stock analysis`}>Analysis <span aria-hidden="true">↗</span></Link>}</div>
  </article>
}

export function StrategyLabPanel({ lab, observations, symbol }: { lab?: EngineLabSnapshot | null; observations?: StrategyObservation[]; symbol?: string }) {
  const [selectedSleeve, setSleeve] = useState<StrategyObservation['sleeve'] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const available = (lab?.observations ?? observations ?? []).filter(row => !symbol || row.sym.toUpperCase() === symbol.toUpperCase())
  const filters: StrategyObservation['sleeve'][] = [...FILTERS, ...(['macro-event', 'composite-control'] as const).filter(key => available.some(row => row.sleeve === key))]
  const sleeve = selectedSleeve && filters.includes(selectedSleeve) ? selectedSleeve : filters.find(key => available.some(row => row.sleeve === key)) ?? 'short-horizon'
  const filtered = available.filter(row => row.sleeve === sleeve).sort((a, b) =>
    Number(a.state === 'avoid') - Number(b.state === 'avoid') || Number(b.state === 'setup') - Number(a.state === 'setup') || b.score - a.score)
  const rows = filtered.slice(0, expanded ? filtered.length : symbol ? 6 : 4)
  const select = (key: StrategyObservation['sleeve']) => { setSleeve(key); setExpanded(false) }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % filters.length : event.key === 'ArrowLeft' ? (index + filters.length - 1) % filters.length : event.key === 'Home' ? 0 : event.key === 'End' ? filters.length - 1 : null
    if (next == null) return
    event.preventDefault(); select(filters[next]); tabs.current[next]?.focus()
  }
  return <section className={`research-section research-lab${symbol ? ' research-lab-stock' : ''}`} aria-label={symbol ? `${symbol} research lab` : 'Research lab'}>
    <div className="research-section-head"><div><p className="research-eyebrow">{symbol ? 'Independent research' : '02 / Ideas under observation'}</p><h2>{symbol ? 'Ideas for this stock' : 'Stock ideas to explore'}</h2></div><span className="research-mode">Being tested · updated daily</span></div>
    <p className="research-section-intro">{symbol ? `Separate research views for ${symbol}, with their own evidence and outcomes.` : 'Explore businesses recovering after a fall, short-term price moves and stocks getting more attention.'} Choose one strategy at a time. Its ideas and results stay separate. No real trades are placed.</p>
    {!available.length ? <div className="research-empty"><p>{symbol ? `No short-term, recovery or attention-based idea is available for ${symbol} in the latest scan.` : 'No research ideas are available from the latest scan. New ideas appear when there is enough information to assess them.'}</p>{!symbol && <div className="research-awaiting" aria-label="Forecast sleeves awaiting first run"><span>Short-term direction</span><span>Recovery after a fall</span><span>Growing attention</span></div>}</div> : <>
      <div className="research-tabs" role="tablist" aria-label="Filter forecast strategies">{filters.map((key, i) => <button key={key} ref={el => { tabs.current[i] = el }} id={`${id}-${key}`} type="button" role="tab" aria-selected={sleeve === key} aria-controls={`${id}-results`} tabIndex={sleeve === key ? 0 : -1} onClick={() => select(key)} onKeyDown={e => keyboard(e, i)}>{LABELS[key]} <span className="num" aria-hidden="true">{available.filter(row => row.sleeve === key).length}</span></button>)}</div>
      <div id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-${sleeve}`} tabIndex={0}>
        {filtered.length === 0 && <div className="research-empty"><p>No observations for this strategy in the latest scan.</p><p>{sleeve === 'quality-dip' ? 'A selloff needs supporting business evidence before it becomes a recovery candidate. This screen stays empty when the scan cannot establish that evidence.' : sleeve === 'social-ignition' ? 'The scan has not recorded a usable attention setup. Channel commentary is still available in YouTube & social.' : 'A direction read needs sufficient completed price history; missing evidence is not a forecast.'}</p><p>Choose another strategy above to see its own ideas.</p></div>}
        <div className="research-decision-grid">{rows.map(row => <ObservationCard key={row.id} row={row} linked={!symbol} />)}</div>
        {rows.length < filtered.length && <button type="button" className="research-showmore" onClick={() => setExpanded(true)}>Show all {filtered.length} ideas <span aria-hidden="true">↓</span></button>}
      </div>
    </>}
    {lab && !symbol && <details className="research-method"><summary>See the evidence: how ideas are tested</summary><p><b>Scan cadence:</b> {lab.cadence}</p><p>Repeated mentions of the same idea count once. We check saved predictions against later results, including trading costs.</p><div className="research-strategies" aria-label="Strategy sleeve status">{lab.sleeves.filter(s => s.key === sleeve).map(s => <div key={s.key}><strong>{strategyName(s.key, s.label)}</strong><span>{s.status}</span><span className="num">{s.evidenceN} completed</span></div>)}</div></details>}
  </section>
}
