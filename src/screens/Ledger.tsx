import { useEffect, useMemo, useState } from 'react'
import { getEngine, type LedgerPrediction, type PaperBookData } from '../lib/api'
import { flattenLedger, gradeBreakdown, statusOf, summariseLedger } from '../lib/ledgerStats'
import { humanError } from '../lib/format'
import { GradeChip } from '../components/GradeChip'
import { IconBack } from '../components/icons'

// THE FULL LEDGER: every prediction the engine has made (last 30 dates, up to
// 100 rows), column-wise, with what actually happened. This page exists so
// the reader can judge the tool, not trust it: open calls stay unscored,
// shadows are shown dimmed but never hidden, and the topline only counts
// graded rows.

type Filter = 'all' | 'live' | 'shadow' | 'graded'

const STATUS_BADGE: Record<string, string> = { hit: 'good', miss: 'bad', stopped: 'bad', open: '' }

export function Ledger({ onBack, onOpen }: { onBack: () => void; onOpen: (symbol: string) => void }) {
  const [rows, setRows] = useState<LedgerPrediction[] | null>(null)
  const [lifetime, setLifetime] = useState<{ live: { graded: number; hits: number; sumExcess: number }; since: string } | null>(null)
  const [book, setBook] = useState<PaperBookData | null>(null)
  const [months, setMonths] = useState<{ month: string; endGBP: number; returnPct: number; trades: number; wins: number }[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getEngine()
      .then(d => {
        setRows(flattenLedger(d.ledger ?? [], 100))
        if (d.scorecard?.lifetime) setLifetime({ live: d.scorecard.lifetime.live, since: d.scorecard.lifetime.since })
        setBook(d.paperBook ?? null)
        setMonths(d.paperMonths ?? [])
      })
      .catch(e => setError(String((e as Error)?.message ?? e)))
  }, [])

  const visible = useMemo(() => {
    if (!rows) return []
    if (filter === 'live') return rows.filter(r => !r.shadow)
    if (filter === 'shadow') return rows.filter(r => r.shadow)
    if (filter === 'graded') return rows.filter(r => r.outcome5)
    return rows
  }, [rows, filter])

  const summary = useMemo(() => summariseLedger(visible), [visible])
  const byGrade = useMemo(() => (rows ? gradeBreakdown(rows) : []), [rows])

  return (
    <div className="detail">
      <header className="detail-head">
        <button className="back" onClick={onBack} aria-label="Back to research"><IconBack /></button>
        <div>
          <h2>Prediction ledger</h2>
          <span className="detail-price" style={{ fontSize: 12 }}>every call, and what happened</span>
        </div>
      </header>

      {rows && (
        <div className="stats-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, margin: '10px 0' }}>
          <span><strong>{summary.total}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>calls</span></span>
          <span><strong>{summary.graded}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>graded</span></span>
          <span><strong>{summary.hitRate != null ? `${Math.round(summary.hitRate * 100)}%` : '—'}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>hit rate</span></span>
          <span>
            <strong className={summary.avgExcess5 != null && summary.avgExcess5 >= 0 ? 'up-text' : 'down-text'}>
              {summary.avgExcess5 != null ? `${summary.avgExcess5 >= 0 ? '+' : ''}${summary.avgExcess5}%` : '—'}
            </strong>{' '}
            <span style={{ color: 'var(--faint)', fontSize: 11 }}>avg excess @5d</span>
          </span>
          <span><strong>{summary.stopped}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>stopped</span></span>
          <span><strong>{summary.open}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>still open</span></span>
        </div>
      )}

      {book && (() => {
        const equity = book.history[book.history.length - 1]?.equity ?? book.startGBP
        const retPct = Math.round(((equity - book.startGBP) / book.startGBP) * 1000) / 10
        const weekAgo = book.history[Math.max(0, book.history.length - 6)]?.equity
        const weekPct = weekAgo ? Math.round(((equity - weekAgo) / weekAgo) * 1000) / 10 : null
        return (
          <section className="digest-section" style={{ marginBottom: 12 }}>
            <h3 className="section-title">The £10,000 book — {new Date(book.month + '-02').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h3>
            <div className="stats-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, margin: '8px 0' }}>
              <span><strong className="num">£{equity.toLocaleString('en-GB', { maximumFractionDigits: 0 })}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>equity</span></span>
              <span><strong className={retPct >= 0 ? 'up-text' : 'down-text'}>{retPct >= 0 ? '+' : ''}{retPct}%</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>this month</span></span>
              {weekPct != null && (
                <span><strong className={weekPct >= 0 ? 'up-text' : 'down-text'}>{weekPct >= 0 ? '+' : ''}{weekPct}%</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>this week</span></span>
              )}
              <span><strong>{book.positions.length}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>open</span></span>
              <span><strong>{book.closed.length}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>closed</span></span>
            </div>
            {book.positions.map(p => (
              <div key={p.sym + p.side} className="perf-row" onClick={() => onOpen(p.sym)} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
                <span><strong>{p.sym}</strong> <span className={p.side === 'long' ? 'up-text' : 'down-text'}>{p.side}</span> <span style={{ color: 'var(--faint)', fontSize: 11 }}>{p.grade} · in {p.entry} · £{Math.round(p.costGBP)}</span></span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>stop {p.stop} · tgt {p.target}</span>
              </div>
            ))}
            {book.closed.slice(-5).reverse().map(t => (
              <div key={t.sym + t.side + t.closedDate} className="perf-row" style={{ opacity: 0.75 }}>
                <span><strong>{t.sym}</strong> <span style={{ color: 'var(--faint)', fontSize: 11 }}>{t.side} · {t.reason} · {t.closedDate.slice(5)}</span></span>
                <span className={t.plGBP >= 0 ? 'up-text' : 'down-text'}>{t.plGBP >= 0 ? '+' : '−'}£{Math.abs(t.plGBP).toFixed(0)} ({t.plPct >= 0 ? '+' : ''}{t.plPct}%)</span>
              </div>
            ))}
            {months.length > 0 && (
              <>
                {months.slice().reverse().map(m => (
                  <div key={m.month} className="perf-row">
                    <span>{new Date(m.month + '-02').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} <span style={{ color: 'var(--faint)', fontSize: 11 }}>×{m.trades} trades · {m.trades ? Math.round((m.wins / m.trades) * 100) : 0}% won</span></span>
                    <span className={m.returnPct >= 0 ? 'up-text' : 'down-text'}>£{m.endGBP.toLocaleString('en-GB', { maximumFractionDigits: 0 })} ({m.returnPct >= 0 ? '+' : ''}{m.returnPct}%)</span>
                  </div>
                ))}
              </>
            )}
            <p className="empty-line" style={{ fontSize: 11 }}>
              A fresh mock £10,000 every month, traded mechanically on the engine's live calls: risk-ladder sizing, exits on daily closes at the published stop,
              target or 10-session horizon; whatever remains closes at month-end. Finished months are banked above, permanently.
            </p>
          </section>
        )
      })()}

      {lifetime && lifetime.live.graded > 0 && (
        <p className="empty-line" style={{ fontSize: 12, marginBottom: 10 }}>
          Since {new Date(lifetime.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} (all live calls, never resets):{' '}
          <strong>{lifetime.live.graded}</strong> graded · <strong>{Math.round((lifetime.live.hits / lifetime.live.graded) * 100)}%</strong> hit ·{' '}
          <strong className={lifetime.live.sumExcess >= 0 ? 'up-text' : 'down-text'}>
            {(lifetime.live.sumExcess / lifetime.live.graded).toFixed(1)}%
          </strong>{' '}
          avg excess @5d
        </p>
      )}

      {byGrade.some(b => b.graded > 0) && (
        <section className="digest-section" style={{ marginBottom: 12 }}>
          <h3 className="section-title">By grade — do the tiers separate?</h3>
          {byGrade.map(b => (
            <div key={b.key} className="perf-row">
              <span>
                {b.key === 'shadow' ? <span className="badge">shadow</span> : <GradeChip grade={b.key as 'A' | 'B' | 'C'} provisional={false} />}{' '}
                <span style={{ color: 'var(--faint)', fontSize: 11 }}>×{b.n} · {b.graded} graded</span>
              </span>
              <span style={{ fontSize: 12.5 }}>
                {b.graded > 0 ? (
                  <>
                    {Math.round((b.hitRate ?? 0) * 100)}% hit ·{' '}
                    <span className={b.avgExcess5 != null && b.avgExcess5 >= 0 ? 'up-text' : 'down-text'}>
                      {b.avgExcess5 != null ? `${b.avgExcess5 >= 0 ? '+' : ''}${b.avgExcess5}%` : '—'}
                    </span>{' '}
                    avg @5d
                  </>
                ) : (
                  <span style={{ color: 'var(--faint)' }}>none graded yet</span>
                )}
              </span>
            </div>
          ))}
          <p className="empty-line" style={{ fontSize: 11 }}>
            Higher grades should earn higher hit rates and excess. If they don't over ~30+ graded calls per tier, the grading is decoration — and you'll see it here first.
          </p>
        </section>
      )}

      <div className="sort-chips">
        {(['all', 'live', 'shadow', 'graded'] as const).map(f => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'live' ? 'Live' : f === 'shadow' ? 'Shadows' : 'Graded'}
          </button>
        ))}
      </div>

      {error && <p className="empty-line">Ledger unavailable — {humanError(error)}.</p>}
      {rows && visible.length === 0 && <p className="empty-line">Nothing here yet — the ledger fills as the engine makes and grades calls.</p>}
      {!rows && !error && (
        <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 36 }} />)}
        </div>
      )}

      {visible.length > 0 && (
        <div className="ledger-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Sym</th>
                <th>Side</th>
                <th>Gr</th>
                <th className="num">P%</th>
                <th className="num">Entry</th>
                <th className="num">Stop</th>
                <th className="num">Tgt</th>
                <th className="num">5d vs SPY</th>
                <th className="num">10d vs SPY</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(p => {
                const st = statusOf(p)
                return (
                  <tr
                    key={p.id}
                    className={p.shadow ? 'shadow-row' : ''}
                    title={p.note}
                    onClick={() => onOpen(p.sym)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{p.date.slice(5)}</td>
                    <td style={{ fontWeight: 700 }}>{p.sym}</td>
                    <td className={p.side === 'long' ? 'up-text' : 'down-text'}>{p.side === 'long' ? '▲L' : '▼S'}</td>
                    <td><GradeChip grade={p.grade} provisional={p.provisional} />{p.shadow ? <span style={{ color: 'var(--faint)', fontSize: 10 }}> sh</span> : ''}</td>
                    <td className="num">{Math.round(p.probability * 100)}</td>
                    <td className="num">{p.entry}</td>
                    <td className="num">{p.stop}</td>
                    <td className="num">{p.target}</td>
                    <td className={`num ${p.outcome5 ? (p.outcome5.excessPct >= 0 ? 'up-text' : 'down-text') : ''}`}>
                      {p.outcome5 ? `${p.outcome5.excessPct >= 0 ? '+' : ''}${p.outcome5.excessPct}%` : '·'}
                    </td>
                    <td className={`num ${p.outcome10 ? (p.outcome10.excessPct >= 0 ? 'up-text' : 'down-text') : ''}`}>
                      {p.outcome10 ? `${p.outcome10.excessPct >= 0 ? '+' : ''}${p.outcome10.excessPct}%` : '·'}
                    </td>
                    <td><span className={`badge ${STATUS_BADGE[st]}`}>{st}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="empty-line" style={{ fontSize: 11 }}>
        Excess = the call's move minus SPY's, side-adjusted; a hit must clear +1pp with the stop (daily-close basis) never breached. Shadows (sh) were
        suppressed from the board but graded anyway — the learning loop eats everything. Scroll the table sideways; tap a row for the chart. Last 30
        trading days, up to 100 calls.
      </p>
    </div>
  )
}
