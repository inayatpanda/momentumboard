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
        <p className="sec-label">Practice portfolio</p>
        <p className="cc-reason">The practice portfolio has not completed its first update yet.</p>
      </section>
    )
  }
  const s = paperBookStats(book)
  const tiles = [
    ['Portfolio value', money(s.equity), `${signed(s.returnPct)} this month`],
    ['Biggest fall', `${s.maxDrawdownPct.toFixed(1)}%`, 'from its highest value'],
    ['Win rate', s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}%`, `${s.wins} wins · ${s.losses} losses`],
    ['Profit factor', s.profitFactor == null ? '—' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2), 'gross wins ÷ gross losses'],
    ['Average gain or loss', s.expectancyGBP == null ? '—' : money(s.expectancyGBP), 'average per closed trade'],
    ['Money invested', `${s.exposurePct.toFixed(1)}%`, `${book.positions.length} open`],
    ['Turnover', `${s.turnover.toFixed(1)}×`, 'capital deployed'],
  ]
  return (
    <section aria-label="Paper book" className="paper-book-panel">
      <p className="sec-label">Practice portfolio</p>
      <p className="cc-reason">A simulation using pretend money, planned entry prices and loss limits. No real trades are placed.</p>
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
          Completed months: {data.months.slice(-4).reverse().map(m => `${m.month} ${signed(m.returnPct)}`).join(' · ')}
        </p>
      )}
      <p className="cc-reason paper-book-note">Pretend money only. Check losses and average results as well as the winners.</p>
    </section>
  )
}
