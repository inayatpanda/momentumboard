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
        <span><b>Decision cockpit</b> <span className="pill">Published calls</span></span>
        <span className={`pill ${status}`}>{FRESHNESS_LABEL[read.freshness]}</span>
      </div>
      <div className="decision-cockpit-grid">
        <div className="decision-tile">
          <span className="sec-label">Actionable now</span>
          <strong>{read.sized}</strong>
          <small>{read.longs} long · {read.shorts} short</small>
          <small>{riskLine}</small>
        </div>
        <div className="decision-tile decision-tile-wide">
          <span className="sec-label">Changed since {read.priorDate ?? 'prior run'}</span>
          <strong className="decision-change">{boardChangeLine(read)}</strong>
        </div>
        <div className="decision-tile">
          <span className="sec-label">Live evidence</span>
          <strong>{read.liveN ? `n=${read.liveN}` : 'collecting'}</strong>
          <small>{read.liveHitRate == null ? 'hit rate not mature' : `${Math.round(read.liveHitRate * 100)}% landed`}{read.latestBrier == null ? '' : ` · Brier ${read.latestBrier.toFixed(3)}`}</small>
        </div>
      </div>
      <div className="decision-provenance">
        <span>Generated {generated} UK · {age}</span>
        <span>Price · technicals · catalysts · social · calibrated outcomes</span>
      </div>
    </section>
  )
}
