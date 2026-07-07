import { useEffect, useState } from 'react'
import { getEngine, type EngineData } from '../lib/api'
import { GradeChip } from './GradeChip'

// TODAY'S CALLS: the engine board, front and centre on the watchlist. Each
// call carries its reason line (the top weighted factors) in the open — the
// full evidence and levels live one tap away on the ticker page and in
// Intel → Markets.

const MAX_SHOWN = 6

export function TodaysCalls({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [data, setData] = useState<EngineData | null>(null)
  useEffect(() => {
    getEngine().then(setData).catch(() => {})
  }, [])
  const b = data?.board
  if (!b) return null
  const todayLondon = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const weekend = [0, 6].includes(new Date().getDay())
  const stale = b.date !== todayLondon
  const calls = b.board.slice(0, MAX_SHOWN)
  return (
    <section className="digest-section" style={{ marginBottom: 14 }}>
      <h3 className="section-title">
        Today's calls
        <span className={`badge ${b.regime === 'green' ? '' : b.regime === 'red' ? 'bad' : 'warn'}`} style={{ marginLeft: 6 }}>{b.regime}</span>
        {stale && <span className="badge warn" style={{ marginLeft: 6 }}>{weekend ? 'markets closed — last session' : `as of ${b.date}`}</span>}
      </h3>
      {calls.length === 0 && <p className="empty-line">No edge today — every candidate failed the gates. An honest empty board beats a forced call.</p>}
      {calls.map(p => (
        <div
          key={p.id}
          className="perf-row"
          style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2, cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(p.sym)}
          onKeyDown={e => e.key === 'Enter' && onOpen(p.sym)}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 700 }}>
              <GradeChip grade={p.grade} provisional={p.provisional} /> {p.sym}
              <span style={{ color: p.side === 'long' ? 'var(--green)' : 'var(--red)', fontSize: 11, marginLeft: 6 }}>
                {p.side === 'long' ? '▲ LONG' : '▼ SHORT'}
              </span>
              {p.earningsRisk && <span className="badge bad" style={{ marginLeft: 4 }}>earnings ≤10d</span>}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{Math.round(p.probability * 100)}% · ~{p.expectedMovePct}%</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.note}</div>
        </div>
      ))}
      {b.board.length > MAX_SHOWN && (
        <p className="empty-line" style={{ fontSize: 11 }}>+{b.board.length - MAX_SHOWN} more on the full board — Intel → Markets.</p>
      )}
      {calls.length > 0 && (
        <p className="empty-line" style={{ fontSize: 11 }}>Tap a call for the chart and full factor evidence. Calibrated analysis, not advice.</p>
      )}
    </section>
  )
}
