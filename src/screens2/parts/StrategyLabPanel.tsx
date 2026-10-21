import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'wouter'
import type { EngineLabSnapshot, StrategyObservation } from '../../../shared/engine/strategyLab'
import { recoveryChecklist } from '../../../shared/engine/recoveryChecklist'
import '../../styles/research.css'

const LABELS: Record<StrategyObservation['sleeve'], string> = {
  'short-horizon': '3-session read', 'quality-dip': 'Quality dip', 'social-ignition': 'Social ignition',
  'macro-event': 'Macro event', 'composite-control': 'Main engine',
}
const FILTERS = ['all', 'short-horizon', 'quality-dip', 'social-ignition'] as const
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 100)}%`
const signed = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
const price = (n: number | null) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })
const STATE_LABEL: Record<StrategyObservation['state'], string> = { setup: 'Setup forming', watch: 'Watching', avoid: 'Avoid for now', collecting: 'Collecting evidence' }

function stamp(at: number) {
  if (!Number.isFinite(at) || at <= 0) return 'Date unavailable'
  const ms = at > 1e12 ? at : at * 1000
  return `${new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`
}

function ObservationCard({ row, linked = true }: { row: StrategyObservation; linked?: boolean }) {
  const directional = row.sleeve === 'short-horizon'
  const stale = row.availableAt > 0 && Date.now() - (row.availableAt > 1e12 ? row.availableAt : row.availableAt * 1000) > 3 * 86_400_000
  return <article className={`research-decision research-decision-${row.sleeve}`} aria-label={`${row.sym} ${LABELS[row.sleeve]} research`}>
    <div className="research-card-top"><span className="research-eyebrow">{LABELS[row.sleeve]}</span><span className={`research-state ${row.state}`}>{STATE_LABEL[row.state]}</span></div>
    <div className="research-card-identity"><h3>{row.sym}</h3><span className={`pill ${row.side}`}>{row.side === 'neutral' ? 'watch' : row.side}</span><span className="research-rank num" title="Relative research ranking, not a probability of success">Rank {row.score}/100</span></div>
    <p className="research-thesis">{row.reasons[0] || 'The strategy is collecting evidence before forming a thesis.'}</p>
    <div className="research-estimate">
      <div><span>{directional ? 'Historical up frequency' : 'Target before stop'}</span><strong className="num">{directional ? pct(row.forecast.probabilityUp) : row.forecast.probabilityTarget == null ? 'Uncalibrated' : pct(row.forecast.probabilityTarget)}</strong></div>
      <div><span>Research horizon</span><strong className="num">{row.forecast.horizonSessions} <small>sessions</small></strong></div>
    </div>
    <div className="research-evidence-line"><span className="research-status-dot" aria-hidden="true" /><span>{directional ? `${row.forecast.calibratedN} historical analogues · ${row.forecast.liveN ?? 0} matured live forecasts` : `${row.forecast.calibratedN} matured campaigns`}</span></div>
    {directional && row.side === 'neutral' && <p className="research-muted"><b>No supported directional edge.</b></p>}
    <div className="research-risk"><span>What could break it</span><p>{row.risks[0] || 'No specific risk was recorded in this observation.'}</p></div>
    {row.dataGaps.length > 0 && <p className="research-missing"><b>Still missing</b> {row.dataGaps.slice(0, linked ? 2 : undefined).join(' · ')}</p>}
    {row.sleeve === 'quality-dip' && <div className="research-recovery" aria-label="Recovery evidence">
      <div><span>Business</span><strong>{String(row.metrics.financialHealth ?? 'unknown')}</strong></div>
      <div><span>Sector financial checks</span><strong>{String(row.metrics.financialSector ?? 'Needs classification')}</strong></div>
      <div><span>Valuation</span><strong>{row.metrics.valuationStatus === 'supported' ? 'Within research limits' : row.metrics.valuationStatus === 'demanding' ? 'Above research limits' : 'Needs evidence'}</strong></div>
      <div><span>Report trajectory</span><strong>{String(row.metrics.reportTrend ?? 'insufficient')}{typeof row.metrics.reportObservations === 'number' ? ` · ${row.metrics.reportObservations} reports` : ''}</strong></div>
      <div><span>Chart recovery</span><strong>{row.metrics.stabilising === true ? 'Confirmed' : 'Not confirmed'}</strong></div>
      <div><span>Sector</span><strong>{row.metrics.sectorName ? `${row.metrics.sectorName}: ${row.metrics.sectorRotation === 'in' ? 'improving' : row.metrics.sectorRotation === 'out' ? 'weakening' : 'mixed'}` : 'Not mapped'}</strong></div>
      <div><span>International markets</span><strong>{String(row.metrics.worldTone ?? 'unavailable')}</strong></div>
    </div>}
    {row.sleeve === 'quality-dip' && <details className="research-card-details"><summary>What needs to happen next</summary><ul className="recovery-checklist">{recoveryChecklist(row).map(check=><li key={check.label}><span className={check.passed?'met':'pending'}>{check.passed?'Met':'Pending'}</span><div><b>{check.label}</b><p>{check.detail}</p></div></li>)}</ul></details>}
    <details className="research-card-details" open={!linked}>
      <summary>Forecast & evidence <span aria-hidden="true">+</span></summary>
      <div className="research-card-detail-body">
        {directional ? <>
          <p className="research-muted">Historical analogue estimate</p>
          <dl className="research-forecast-grid"><div><dt>Up</dt><dd>{pct(row.forecast.probabilityUp)}</dd></div><div><dt>Down</dt><dd>{pct(row.forecast.probabilityDown)}</dd></div><div><dt>Flat</dt><dd>{pct(row.forecast.probabilityFlat)}</dd></div><div><dt>Median</dt><dd>{signed(row.forecast.expectedMovePct)}</dd></div><div className="research-range"><dt>Range</dt><dd>{signed(row.forecast.expectedLowPct)} to {signed(row.forecast.expectedHighPct)}</dd><small>Middle 60% of examples</small></div></dl>
          {row.forecast.probabilityUpInterval && <p>Up frequency uncertainty: {pct(row.forecast.probabilityUpInterval[0])}–{pct(row.forecast.probabilityUpInterval[1])} (95% interval; future outcomes can differ).</p>}
          {row.forecast.baselineProbabilityUp != null && <p>Historical base rate: {pct(row.forecast.baselineProbabilityUp)} up.</p>}
        </> : <dl className="research-forecast-grid"><div><dt>Entry</dt><dd>{price(row.entry)}</dd></div><div><dt>Stop</dt><dd>{price(row.stop)}</dd></div><div><dt>Target</dt><dd>{price(row.target)}</dd></div></dl>}
        {row.reasons.slice(1).map((reason, i) => <p key={`reason-${i}`}><b>Supporting evidence</b> {reason}</p>)}
        {row.risks.slice(1).map((risk, i) => <p key={`risk-${i}`}><b>Additional risk</b> {risk}</p>)}
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
    </details>
    <div className="research-card-footer"><span>{stale ? 'Older scan · ' : 'Scan · '}{stamp(row.availableAt)}<small>shadow only</small></span>{linked && <Link href={`/stock/${row.sym}`} className="research-text-link" aria-label={`Open ${row.sym} stock analysis`}>Analysis <span aria-hidden="true">↗</span></Link>}</div>
  </article>
}

export function StrategyLabPanel({ lab, observations, symbol }: { lab?: EngineLabSnapshot | null; observations?: StrategyObservation[]; symbol?: string }) {
  const [sleeve, setSleeve] = useState<(typeof FILTERS)[number]>('all')
  const [expanded, setExpanded] = useState(false)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const available = (lab?.observations ?? observations ?? []).filter(row => !symbol || row.sym.toUpperCase() === symbol.toUpperCase())
  const filtered = available.filter(row => sleeve === 'all' || row.sleeve === sleeve).sort((a, b) =>
    Number(a.state === 'avoid') - Number(b.state === 'avoid') || Number(b.sleeve === 'quality-dip') - Number(a.sleeve === 'quality-dip') || Number(b.state === 'setup') - Number(a.state === 'setup') || b.score - a.score)
  const rows = filtered.slice(0, expanded ? filtered.length : symbol ? 6 : 4)
  const select = (key: (typeof FILTERS)[number]) => { setSleeve(key); setExpanded(false) }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % FILTERS.length : event.key === 'ArrowLeft' ? (index + FILTERS.length - 1) % FILTERS.length : event.key === 'Home' ? 0 : event.key === 'End' ? FILTERS.length - 1 : null
    if (next == null) return
    event.preventDefault(); select(FILTERS[next]); tabs.current[next]?.focus()
  }
  return <section className={`research-section research-lab${symbol ? ' research-lab-stock' : ''}`} aria-label={symbol ? `${symbol} research lab` : 'Research lab'}>
    <div className="research-section-head"><div><p className="research-eyebrow">{symbol ? 'Independent research' : '02 / Ideas under observation'}</p><h2>{symbol ? 'Engine research for this stock' : 'Opportunities & recovery research'}</h2></div><span className="research-mode">Shadow research · daily</span></div>
    <p className="research-section-intro">{symbol ? `Separate research views for ${symbol}, with their own evidence and outcomes.` : 'A short-term direction read, a business recovery, or a change in attention. Each idea has its own test.'} Research stays in shadow mode while forward results accumulate.</p>
    {!available.length ? <div className="research-empty"><p>{symbol ? `No independent 3-session, quality-dip or social-ignition setup is active for ${symbol} in the latest lab run.` : 'No research observations are available from the latest engine run. The lab tracks 3-session direction, quality dips and social ignition as evidence becomes available.'}</p>{!symbol && <div className="research-awaiting" aria-label="Forecast sleeves awaiting first run"><span>3-session read</span><span>Quality dip</span><span>Social ignition</span></div>}</div> : <>
      {!symbol && <div className="research-tabs" role="tablist" aria-label="Filter forecast strategies">{FILTERS.map((key, i) => <button key={key} ref={el => { tabs.current[i] = el }} id={`${id}-${key}`} type="button" role="tab" aria-selected={sleeve === key} aria-controls={`${id}-results`} tabIndex={sleeve === key ? 0 : -1} onClick={() => select(key)} onKeyDown={e => keyboard(e, i)}>{key === 'all' ? 'All strategies' : LABELS[key]} <span className="num" aria-hidden="true">{available.filter(row => key === 'all' || row.sleeve === key).length}</span></button>)}</div>}
      <div id={`${id}-results`} role={symbol ? undefined : 'tabpanel'} aria-labelledby={symbol ? undefined : `${id}-${sleeve}`} tabIndex={symbol ? undefined : 0}>
        {filtered.length === 0 && <div className="research-empty"><p>No observations for this strategy in the latest scan.</p><p>{sleeve === 'quality-dip' ? 'A selloff needs supporting business evidence before it becomes a recovery candidate. This screen stays empty when the scan cannot establish that evidence.' : sleeve === 'social-ignition' ? 'The scan has not recorded a usable attention setup. Channel commentary is still available in The street.' : 'A direction read needs sufficient completed price history; missing evidence is not a forecast.'}</p><button type="button" className="research-text-link" onClick={() => select('all')}>View other research →</button></div>}
        <div className="research-decision-grid">{rows.map(row => <ObservationCard key={row.id} row={row} linked={!symbol} />)}</div>
        {rows.length < filtered.length && <button type="button" className="research-showmore" onClick={() => setExpanded(true)}>Show all {filtered.length} forecasts <span aria-hidden="true">↓</span></button>}
      </div>
    </>}
    {lab && !symbol && <details className="research-method"><summary>Strategy status & measurement</summary><p><b>Scan cadence:</b> {lab.cadence}</p><p>Repeated daily mentions stay one campaign. Promotion requires useful forward calibration and returns after costs.</p><div className="research-strategies" aria-label="Strategy sleeve status">{lab.sleeves.map(s => <div key={s.key}><strong>{s.key === 'short-horizon' ? LABELS[s.key] : s.label}</strong><span>{s.status}</span><span className="num">{s.evidenceN} matured</span></div>)}</div></details>}
  </section>
}
