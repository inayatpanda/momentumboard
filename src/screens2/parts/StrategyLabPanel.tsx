import { Link } from 'wouter'
import type { EngineLabSnapshot, StrategyObservation } from '../../../shared/engine/strategyLab'

const LABELS: Record<StrategyObservation['sleeve'], string> = {
  'short-horizon': '2–3 day read',
  'quality-dip': 'Quality dip',
  'social-ignition': 'Social ignition',
  'macro-event': 'Macro event',
  'composite-control': 'Main engine',
}

const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`)
const signed = (n: number | null | undefined) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`)

const STATE_LABEL: Record<StrategyObservation['state'], string> = {
  setup: 'setup forming',
  watch: 'watching',
  avoid: 'avoid for now',
  collecting: 'collecting evidence',
}

function ObservationCard({ row, linked = true }: { row: StrategyObservation; linked?: boolean }) {
  const body = (
    <>
      <div className="lab2-head">
        <span className="lab2-sym">{row.sym}</span>
        <span className={`pill ${row.side === 'long' ? 'long' : row.side === 'short' ? 'short' : ''}`}>{row.side === 'neutral' ? 'watch' : row.side}</span>
        <span className="lab2-score num">{row.score}/100</span>
      </div>
      <div className="lab2-kind">
        <span>{LABELS[row.sleeve]}</span>
        <span className={`lab2-state ${row.state}`}>{STATE_LABEL[row.state]}</span>
      </div>
      {row.sleeve === 'short-horizon' ? (
        <>
          <div className="lab2-forecast">
            <span>Up <b className="num">{pct(row.forecast.probabilityUp)}</b></span>
            <span>Down <b className="num">{pct(row.forecast.probabilityDown)}</b></span>
            <span>Median <b className="num">{signed(row.forecast.expectedMovePct)}</b></span>
            <span>Range <b className="num">{signed(row.forecast.expectedLowPct)} to {signed(row.forecast.expectedHighPct)}</b></span>
          </div>
        </>
      ) : (
        <div className="lab2-levels">
          {row.entry != null && <span>Entry <b className="num">{row.entry}</b></span>}
          {row.stop != null && <span>Stop <b className="num">{row.stop}</b></span>}
          {row.target != null && <span>Target <b className="num">{row.target}</b></span>}
        </div>
      )}
      <div className="lab2-evidence">
        <p><b>Why it surfaced</b> {row.reasons.slice(0, 2).join(' · ') || 'The sleeve is collecting evidence.'}</p>
        {row.risks[0] && <p><b>What could break it</b> {row.risks[0]}</p>}
        {row.dataGaps.length > 0 && <p><b>Still missing</b> {row.dataGaps.slice(0, 2).join(' · ')}</p>}
      </div>
      <div className="lab2-foot">
        <span>{row.forecast.horizonSessions} sessions</span>
        <span className="num">{row.forecast.calibratedN} matured</span>
        {row.forecast.provisional && <span className="lab2-provisional">shadow only</span>}
      </div>
      {linked && <span className="lab2-open">Open stock analysis →</span>}
    </>
  )
  return linked ? <Link href={`/stock/${row.sym}`} className="card pressable lab2-card">{body}</Link> : <div className="card lab2-card">{body}</div>
}

export function StrategyLabPanel({ lab, observations, symbol }: { lab?: EngineLabSnapshot | null; observations?: StrategyObservation[]; symbol?: string }) {
  const rows = (lab?.observations ?? observations ?? [])
    .filter(row => !symbol || row.sym.toUpperCase() === symbol.toUpperCase())
    .sort((a, b) => Number(b.state === 'setup') - Number(a.state === 'setup') || b.score - a.score)
    .slice(0, symbol ? 6 : 4)
  if (!rows.length) {
    return (
      <section className="lab2 lab2-empty" aria-label={symbol ? `${symbol} research lab` : 'Research lab'}>
        <div className="lab2-title">
          <p className="sec-label">{symbol ? 'Engine research for this stock' : 'New engine — forecast lab'}</p>
          <span>shadow · daily</span>
        </div>
        <p className="cc-reason lab2-intro">
          {symbol
            ? `No independent 2–3 day, quality-dip or social-ignition setup is active for ${symbol} in the latest lab run.`
            : 'The upgraded forecast lab is deployed and waiting for its first post-upgrade engine run. It will publish measured 2–3 day, quality-dip and social-ignition observations here.'}
        </p>
        {!symbol && (
          <div className="lab2-awaiting" aria-label="Forecast sleeves awaiting first run">
            <span>2–3 day direction</span>
            <span>Quality dip</span>
            <span>Social ignition</span>
          </div>
        )}
      </section>
    )
  }
  return (
    <section className="lab2" aria-label={symbol ? `${symbol} research lab` : 'Research lab'}>
      <div className="lab2-title">
        <p className="sec-label">{symbol ? 'Engine research for this stock' : 'New engine — forecast lab'}</p>
        <span>{lab ? `${lab.mode} · ${lab.cadence}` : 'shadow · daily'}</span>
      </div>
      <p className="cc-reason lab2-intro">
        Quality dips, social ignition and 2–3 day direction are measured separately. Repeated daily mentions stay one campaign, so the engine cannot learn from the same idea twice.
      </p>
      {lab && !symbol && (
        <div className="lab2-sleeves" aria-label="Strategy sleeve status">
          {lab.sleeves.map(sleeve => (
            <div className="lab2-sleeve" key={sleeve.key}>
              <span>{sleeve.label}</span>
              <b className={`lab2-sleeve-status ${sleeve.status}`}>{sleeve.status}</b>
              <span className="num">{sleeve.evidenceN} matured</span>
            </div>
          ))}
        </div>
      )}
      <div className="lab2-grid">
        {rows.map(row => <ObservationCard key={row.id} row={row} linked={!symbol} />)}
      </div>
    </section>
  )
}
