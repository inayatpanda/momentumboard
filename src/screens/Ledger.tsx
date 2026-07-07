import { useEffect, useMemo, useState } from 'react'
import { getEngine, type LedgerPrediction } from '../lib/api'
import { flattenLedger, statusOf, summariseLedger } from '../lib/ledgerStats'
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
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getEngine()
      .then(d => setRows(flattenLedger(d.ledger ?? [], 100)))
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

      <div className="sort-chips">
        {(['all', 'live', 'shadow', 'graded'] as const).map(f => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'live' ? 'Live' : f === 'shadow' ? 'Shadows' : 'Graded'}
          </button>
        ))}
      </div>

      {error && <p className="empty-line">Ledger unavailable: {error}</p>}
      {rows && visible.length === 0 && <p className="empty-line">Nothing here yet — the ledger fills as the engine makes and grades calls.</p>}
      {!rows && !error && <p className="empty-line">Loading the ledger…</p>}

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
