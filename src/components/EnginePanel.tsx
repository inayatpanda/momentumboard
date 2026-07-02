import { useEffect, useState } from 'react'
import { getEngine, type EngineData } from '../lib/api'

// The engine's accountability pane: risk rung with its evidence, scorecard,
// calibration (claimed vs realized), weight drift, channel credibility,
// roster churn. Everything self-reported, everything checkable.

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')

export function EnginePanel() {
  const [data, setData] = useState<EngineData | null>(null)
  useEffect(() => {
    getEngine().then(setData).catch(() => {})
  }, [])
  if (!data) return null
  const { scorecard, weights, calibration, riskState, roster, channelCred } = data
  const lastRungChange = riskState?.history.at(-1)
  const brier = scorecard?.brierTail ?? []
  const brierTrend =
    brier.length >= 10
      ? brier.slice(-5).reduce((s, x) => s + x.mean, 0) / 5 <= brier.slice(-10, -5).reduce((s, x) => s + x.mean, 0) / 5
        ? '↓ improving'
        : '↑ worsening'
      : 'accumulating'
  const creds = Object.entries(channelCred ?? {}).sort((a, b) => b[1].graded - a[1].graded)

  return (
    <section className="digest-section">
      <h3 className="section-title">The Engine — self-graded</h3>

      {riskState && (
        <div className="perf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
          <span>
            Risk ladder: <b>R{riskState.rung}</b>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {[1.0, 1.25, 1.5, 2.0][riskState.rung]}% per idea · {riskState.gradedAtRung} graded at this rung</span>
          </span>
          {lastRungChange && (
            <span style={{ color: 'var(--faint)', fontSize: 11.5 }}>
              last change {lastRungChange.date}: R{lastRungChange.from}→R{lastRungChange.to} — {lastRungChange.evidence}
            </span>
          )}
        </div>
      )}

      {scorecard && scorecard.totalGraded > 0 && (
        <>
          <div className="perf-row"><span>Graded predictions</span><span>{scorecard.totalGraded} · Brier {brierTrend}</span></div>
          {Object.entries(scorecard.byGrade).map(([g, s]) => (
            <div key={g} className="perf-row">
              <span>Grade {g}</span>
              <span>
                {pct(s.hits, s.n)} hit ({s.hits}/{s.n}) · avg excess {s.n ? (s.sumExcess / s.n).toFixed(1) : '—'}%
              </span>
            </div>
          ))}
          {Object.entries(scorecard.overlays ?? {}).map(([f, s]) => (
            <div key={f} className="perf-row">
              <span>LLM overlay: {f}</span>
              <span>{pct(s.hits, s.n)} {f === 'veto' ? 'dodged a loser' : 'hit'} ({s.hits}/{s.n})</span>
            </div>
          ))}
        </>
      )}

      {calibration && (
        <>
          <h3 className="section-title" style={{ marginTop: 10 }}>Calibration — claimed vs realized{calibration.seeded ? ' (seeded from 2y backtest)' : ''}</h3>
          {Object.entries(calibration.buckets)
            .filter(([, b]) => b.n >= 5)
            .sort((a, b) => b[1].n - a[1].n)
            .slice(0, 10)
            .map(([key, b]) => (
              <div key={key} className="perf-row" style={{ fontSize: 12 }}>
                <span>{key}</span>
                <span>claims {Math.round(((b.hits + 2) / (b.n + 4)) * 100)}% · realized {pct(b.hits, b.n)} (n={b.n})</span>
              </div>
            ))}
        </>
      )}

      {weights && (
        <>
          <h3 className="section-title" style={{ marginTop: 10 }}>Factor weights — earned, not assumed</h3>
          {Object.entries(weights.current).map(([f, w]) => {
            const drift = weights.base[f] ? w / weights.base[f] : 1
            return (
              <div key={f} className="perf-row" style={{ fontSize: 12 }}>
                <span>{f}</span>
                <span>
                  {w.toFixed(2)} <span style={{ color: drift > 1.02 ? 'var(--green, #37b26c)' : drift < 0.98 ? 'var(--red, #ff5d73)' : 'var(--faint)' }}>({drift > 1 ? '+' : ''}{Math.round((drift - 1) * 100)}% vs base)</span>
                </span>
              </div>
            )
          })}
          {weights.history.at(-1) && Object.keys(weights.history.at(-1)!.changes).length > 0 && (
            <p className="empty-line" style={{ fontSize: 11 }}>
              last nudge {weights.history.at(-1)!.date}: {Object.entries(weights.history.at(-1)!.changes).map(([f, c]) => `${f} ${c.from}→${c.to}`).join(', ')}
            </p>
          )}
        </>
      )}

      {creds.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 10 }}>Channel credibility — graded like everyone else</h3>
          {creds.slice(0, 8).map(([ch, c]) => (
            <div key={ch} className="perf-row" style={{ fontSize: 12 }}>
              <span>{ch}</span>
              <span>{pct(c.hits, c.graded)} on {c.graded} calls{c.avgExcess != null ? ` · avg ${c.avgExcess > 0 ? '+' : ''}${c.avgExcess}% vs SPY` : ''}</span>
            </div>
          ))}
        </>
      )}

      {roster && (
        <>
          <h3 className="section-title" style={{ marginTop: 10 }}>The roster — {roster.entries.length} names the engine follows</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 6px' }}>
            {roster.entries.filter(e => e.capUsdM != null && e.capUsdM < 2000).length} small caps ·{' '}
            {roster.entries.slice(0, 18).map(e => e.sym).join(' · ')}
            {roster.entries.length > 18 ? ' …' : ''}
          </p>
          {roster.changes.at(-1) && (roster.changes.at(-1)!.joined.length > 0 || roster.changes.at(-1)!.dropped.length > 0) && (
            <p className="empty-line" style={{ fontSize: 11 }}>
              {roster.changes.at(-1)!.date}: {roster.changes.at(-1)!.joined.length ? `joined ${roster.changes.at(-1)!.joined.join(', ')}` : ''}
              {roster.changes.at(-1)!.dropped.length ? ` · dropped ${roster.changes.at(-1)!.dropped.map(d => `${d.sym} (${d.why})`).join(', ')}` : ''}
            </p>
          )}
        </>
      )}
    </section>
  )
}
