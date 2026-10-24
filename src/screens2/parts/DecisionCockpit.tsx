import type { BoardSlice } from '../../lib/apiViews'
import { boardChangeLine, decisionCockpitRead, type FreshnessState } from '../../lib/decisionCockpit'

const FRESHNESS_LABEL: Record<FreshnessState, string> = {
  fresh: 'fresh run', aging: 'aging', stale: 'stale', running: 'refreshing', failed: 'last refresh failed',
}

export function DecisionCockpit({ data }: { data: BoardSlice | null | undefined }) {
  if (!data) return null
  const read = decisionCockpitRead(data)
  const board = data.board
  if (!read || !board) return null
  const generated = new Date(board.generatedAt * 1000).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  })
  const age = read.ageMinutes < 60 ? `${read.ageMinutes}m old` : `${Math.round(read.ageMinutes / 60)}h old`
  const status = read.freshness === 'fresh' ? 'good' : read.freshness === 'failed' || read.freshness === 'stale' ? 'bad' : 'warn'
  const directions = data.riskState?.directions
  const riskLine = directions
    ? `long R${directions.long.rung} (n=${directions.long.gradedAtRung}) · short R${directions.short.rung} (n=${directions.short.gradedAtRung})`
    : `combined R${data.riskState?.rung ?? '—'}`
  return (
    <section className="decision-cockpit" aria-label="Decision cockpit">
      <div className="decision-cockpit-head">
        <span><b>Today at a glance</b> <span className="pill">Published predictions</span></span>
        <span className={`pill ${status}`}>{FRESHNESS_LABEL[read.freshness]}</span>
      </div>
      <div className="decision-cockpit-grid">
        <div className="decision-tile">
          <span className="sec-label">Trade plans</span>
          <strong>{read.sized}</strong>
          <small>{read.longs} expecting a rise · {read.shorts} expecting a fall</small>

        </div>
        <div className="decision-tile decision-tile-wide">
          <span className="sec-label">Changed since {read.priorDate ?? 'prior run'}</span>
          <strong className="decision-change">{boardChangeLine(read)}</strong>
        </div>
        <div className="decision-tile">
          <span className="sec-label">Completed results</span>
          <strong>{read.liveN ? String(read.liveN) : 'Awaiting results'}</strong>
          <small>{read.liveHitRate == null ? 'Success rate not available' : `${Math.round(read.liveHitRate * 100)}% passed the test`}</small>
        </div>
      </div>
      <details className="company-detail"><summary>See the evidence: test measures</summary><p>{riskLine}</p><p>Probability error (Brier score): {read.latestBrier == null ? 'Not available' : read.latestBrier.toFixed(3)}. Lower is better. Risk levels and success rates use the published prediction rules.</p></details>
      <div className="decision-provenance">
        <span>Generated {generated} UK · {age}</span>
        <span>Prices · charts · news · channel views · past results</span>
      </div>
    </section>
  )
}
