import { useEffect, useState } from 'react'
import { getEngine, type EngineData } from '../lib/api'
import { capBand } from '../lib/format'
import { RUNG_RISK_PCT } from '../../shared/engine/riskLadder'
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
  // trades lead; watch-only fills what's left of the shown slots
  const trades = b.board.filter(p => !p.watchOnly)
  const calls = [...trades, ...b.board.filter(p => p.watchOnly)].slice(0, MAX_SHOWN)
  return (
    <section className="digest-section" style={{ marginBottom: 14 }}>
      <h3 className="section-title">
        Today's calls
        <span className={`badge ${b.regime === 'green' ? '' : b.regime === 'red' ? 'bad' : 'warn'}`}>{b.regime}</span>
        {stale && <span className="badge warn">{weekend ? 'markets closed — last session' : `as of ${b.date}`}</span>}
      </h3>
      {calls.length === 0 && <p className="empty-line">No edge today — every candidate failed the gates. An honest empty board beats a forced call.</p>}
      {calls.length > 0 && trades.length === 0 && !calls.every(p => p.nearMiss) && (
        <p className="empty-line">Nothing reached even half size today — these are watch-only observations, not calls.</p>
      )}
      {calls.length > 0 && calls.every(p => p.nearMiss) && (
        <p className="empty-line">Nothing cleared the gates today — these are the nearest misses, named so the board is never blank. No grade, no size.</p>
      )}
      {calls.map(p => {
        const band = capBand(p.capUsdM) ?? (p.smallCap ? 'small cap' : null)
        return (
          <div
            key={p.id}
            className="perf-row calls-row"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(p.sym)}
            onKeyDown={e => e.key === 'Enter' && onOpen(p.sym)}
          >
            <span className="calls-top">
              {/* a near miss was never scored — a letter grade would be a fiction */}
              {p.nearMiss ? <span className="badge">—</span> : <GradeChip grade={p.grade} provisional={p.provisional} />}
              <span className="calls-sym">{p.sym}</span>
              {p.name && <span className="calls-name">{p.name}</span>}
              <span className={`chg-pill calls-side ${p.side === 'long' ? 'up' : 'down'}`}>{p.side === 'long' ? '▲ Long' : '▼ Short'}</span>
              {p.watchOnly && <span className="badge warn">{p.nearMiss ? 'near miss' : 'watch'}</span>}
              <span className="calls-odds">{Math.round(p.probability * 100)}% · ~{p.expectedMovePct}%</span>
            </span>
            {/* what the row is WORTH, said on the card: full size, half size, or nothing */}
            <span className="calls-risk" style={{ fontSize: 11, color: 'var(--muted)' }}>
              {p.riskPct > 0 ? `${p.riskPct}% risk${p.riskPct < RUNG_RISK_PCT[p.riskRung] ? ' (half size)' : ''}` : p.nearMiss ? 'nearest miss — no size' : 'watch only'}
            </span>
            {(band || (p.themes ?? []).length > 0 || p.earningsRisk) && (
              <span className="calls-tags">
                {band && <span className="badge">{band}</span>}
                {(p.themes ?? []).slice(0, 2).map(t => (
                  <span key={t} className="badge">{t}</span>
                ))}
                {p.earningsRisk && <span className="badge bad">earnings ≤10d</span>}
              </span>
            )}
            <span className="calls-note">{p.note}</span>
          </div>
        )
      })}
      {b.board.length > MAX_SHOWN && (
        <p className="empty-line calls-foot">+{b.board.length - MAX_SHOWN} more on the full board — Intel → Markets.</p>
      )}
      {calls.length > 0 && (
        <p className="empty-line calls-foot">Tap a call for the chart and full factor evidence. Calibrated analysis, not advice.</p>
      )}
    </section>
  )
}
