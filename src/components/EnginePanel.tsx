import { useEffect, useState } from 'react'
import { getEngine, type EngineData } from '../lib/api'
import { LedgerCard } from './LedgerCard'
import { CalibrationPlot } from './CalibrationPlot'

// THE LEDGER — the receipts. Every prediction as a card with its outcome trail,
// the calibration dot-plot (claimed vs realized), weight drift with its
// evidence, channel credibility, the shadow toggle, and roster churn. The app's
// accountability pane: everything self-reported, everything checkable, the
// misses shown as plainly as the hits.

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

export function EnginePanel() {
  const [data, setData] = useState<EngineData | null>(null)
  const [showShadows, setShowShadows] = useState(false)
  useEffect(() => {
    getEngine().then(setData).catch(() => {})
  }, [])
  if (!data) return null

  const { scorecard, weights, calibration, riskState, roster, channelCred, ledger } = data
  const lastRungChange = riskState?.history.at(-1)
  const brier = scorecard?.brierTail ?? []
  const brierTrend =
    brier.length >= 10
      ? brier.slice(-5).reduce((s, x) => s + x.mean, 0) / 5 <= brier.slice(-10, -5).reduce((s, x) => s + x.mean, 0) / 5
        ? '↓ improving'
        : '↑ worsening'
      : 'accumulating'
  const creds = Object.entries(channelCred ?? {}).sort((a, b) => b[1].graded - a[1].graded)

  const days = ledger ?? []
  const hasShadows = days.some(d => d.predictions.some(p => p.shadow))
  const visibleDays = days
    .map(d => ({ date: d.date, preds: d.predictions.filter(p => showShadows || !p.shadow) }))
    .filter(d => d.preds.length > 0)

  return (
    <section className="digest-section">
      <h3 className="section-title">The Ledger — the receipts</h3>
      <p className="empty-line" style={{ fontSize: 12, marginTop: -2 }}>
        Every call the engine made, graded against what price actually did — excess vs SPY at 5 and 10 sessions, stops honoured. No other tool shows you its own misses this plainly.
      </p>

      {hasShadows && (
        <div className="ledger-shadow-ctl">
          <button
            className={`mini-btn ghost${showShadows ? ' is-on' : ''}`}
            aria-pressed={showShadows}
            onClick={() => setShowShadows(s => !s)}
          >
            {showShadows ? 'hide shadows' : 'reveal shadows'}
          </button>
          <span className="ledger-shadow-note">
            Shadows are the engine's suppressed hypotheses — graded for learning, never published.
          </span>
        </div>
      )}

      {visibleDays.length === 0 ? (
        <p className="empty-line">No predictions on the ledger yet. The receipts arrive once the engine has run and graded.</p>
      ) : (
        visibleDays.map(d => (
          <div key={d.date} className="ledger-day">
            <div className="ledger-date">{dayLabel(d.date)}</div>
            {d.preds.map(p => (
              <LedgerCard key={p.id} p={p} />
            ))}
          </div>
        ))
      )}

      {calibration && <CalibrationPlot buckets={calibration.buckets} seeded={calibration.seeded} />}

      {riskState && (
        <div className="ledger-block">
          <h3 className="section-title">Risk ladder — earned, not set</h3>
          <div className="perf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
            <span>
              <b>R{riskState.rung}</b>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {[1.0, 1.25, 1.5, 2.0][riskState.rung]}% per idea · {riskState.gradedAtRung} graded at this rung</span>
            </span>
            {lastRungChange && (
              <span style={{ color: 'var(--faint)', fontSize: 11.5 }}>
                last change {lastRungChange.date}: R{lastRungChange.from}→R{lastRungChange.to} — {lastRungChange.evidence}
              </span>
            )}
          </div>
        </div>
      )}

      {scorecard && scorecard.totalGraded > 0 && (
        <div className="ledger-block">
          <h3 className="section-title">Scorecard — is the engine earning?</h3>
          <div className="perf-row"><span>Graded predictions</span><span>{scorecard.totalGraded} · Brier {brierTrend}</span></div>
          {Object.entries(scorecard.byGrade).map(([g, s]) => (
            <div key={g} className="perf-row">
              <span>{g === 'shadow' ? 'Shadows' : `Grade ${g}`}</span>
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
        </div>
      )}

      {weights && (
        <div className="ledger-block">
          <h3 className="section-title">Factor weights — drifting toward what works</h3>
          {Object.entries(weights.current).map(([f, w]) => {
            const drift = weights.base[f] ? w / weights.base[f] : 1
            return (
              <div key={f} className="perf-row" style={{ fontSize: 12 }}>
                <span>{f}</span>
                <span>
                  {w.toFixed(2)}{' '}
                  <span style={{ color: drift > 1.02 ? 'var(--green)' : drift < 0.98 ? 'var(--red)' : 'var(--faint)' }}>
                    ({drift > 1 ? '+' : ''}{Math.round((drift - 1) * 100)}% vs base)
                  </span>
                </span>
              </div>
            )
          })}
          {weights.history.at(-1) && Object.keys(weights.history.at(-1)!.changes).length > 0 && (
            <p className="empty-line" style={{ fontSize: 11 }}>
              last nudge {weights.history.at(-1)!.date}: {Object.entries(weights.history.at(-1)!.changes).map(([f, c]) => `${f} ${c.from}→${c.to}`).join(', ')} — {weights.history.at(-1)!.evidence}
            </p>
          )}
        </div>
      )}

      {creds.length > 0 && (
        <div className="ledger-block">
          <h3 className="section-title">Channel credibility — graded like everyone else</h3>
          {creds.slice(0, 8).map(([ch, c]) => (
            <div key={ch} className="perf-row" style={{ fontSize: 12 }}>
              <span>{ch}</span>
              <span>{pct(c.hits, c.graded)} on {c.graded} calls{c.avgExcess != null ? ` · avg ${c.avgExcess > 0 ? '+' : ''}${c.avgExcess}% vs SPY` : ''}</span>
            </div>
          ))}
        </div>
      )}

      {roster && (
        <div className="ledger-block">
          <h3 className="section-title">The roster — {roster.entries.length} names the engine follows</h3>
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
        </div>
      )}
    </section>
  )
}
