import { Link } from 'wouter'
import type { PaperBookSlice } from '../../lib/apiViews'
import { paperBookStats } from '../../lib/paperBookStats'

const money = (n: number) => `${n < 0 ? '−' : ''}£${Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`

export function PaperBookPanel({ data }: { data: PaperBookSlice | null | undefined }) {
  if (data === undefined) return <div className="skeleton" style={{ height: 170, marginBottom: 18 }} />
  const book = data?.book
  if (!book) {
    return (
      <section aria-label="Paper book" className="paper-book-panel">
        <p className="sec-label">Paper book · execution reality</p>
        <p className="cc-reason">The mock book has not completed its first run yet.</p>
      </section>
    )
  }
  const s = paperBookStats(book)
  const tiles = [
    ['Equity', money(s.equity), `${signed(s.returnPct)} this month`],
    ['Maximum drawdown', `${s.maxDrawdownPct.toFixed(1)}%`, 'peak-to-trough'],
    ['Win rate', s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}%`, `${s.wins} wins · ${s.losses} losses`],
    ['Profit factor', s.profitFactor == null ? '—' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2), 'gross wins ÷ gross losses'],
    ['Expectancy', s.expectancyGBP == null ? '—' : money(s.expectancyGBP), 'average per closed trade'],
    ['Exposure', `${s.exposurePct.toFixed(1)}%`, `${book.positions.length} open`],
    ['Turnover', `${s.turnover.toFixed(1)}×`, 'capital deployed'],
  ]
  return (
    <section aria-label="Paper book" className="paper-book-panel">
      <p className="sec-label">Paper book · execution reality</p>
      <p className="cc-reason">The forecast is only useful if its simulated entries, stops and sizing survive contact with execution.</p>
      <div className="paper-book-grid">
        {tiles.map(([label, value, detail]) => (
          <div className="card paper-book-stat" key={label}>
            <span>{label}</span><strong className="num">{value}</strong><small>{detail}</small>
          </div>
        ))}
      </div>
      {book.positions.length > 0 && (
        <div className="paper-book-list" aria-label="Open paper positions">
          <p className="sec-label">Open positions</p>
          {book.positions.map(p => (
            <Link href={`/stock/${p.sym}`} className="paper-book-row pressable" key={`${p.sym}-${p.side}`}>
              <span><b>{p.sym}</b> <span className={p.side === 'long' ? 'long' : 'short'}>{p.side}</span></span>
              <span className="num">{money(p.costGBP)} · stop {p.stop} · target {p.target}</span>
            </Link>
          ))}
        </div>
      )}
      {data.months.length > 0 && (
        <p className="paper-book-history">
          Banked months: {data.months.slice(-4).reverse().map(m => `${m.month} ${signed(m.returnPct)}`).join(' · ')}
        </p>
      )}
      <p className="cc-reason paper-book-note">Mock capital only. Drawdown and expectancy matter more than a few spectacular winners.</p>
    </section>
  )
}
