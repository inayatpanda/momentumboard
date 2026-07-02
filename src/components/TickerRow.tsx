import type { Quote, SetupKind } from '../../shared/types'
import { fmtPrice, fmtPct } from '../lib/format'
import { Badge } from './Badge'
import { Sparkline } from './Sparkline'

export interface Row {
  symbol: string
  quote: Quote | null
  rvol: number | null
  setups: SetupKind[]
  spark?: number[]
  rsi?: number | null
}

export function TickerRow({ row, onRemove, index = 0 }: { row: Row; onRemove: () => void; index?: number }) {
  const { symbol, quote, rvol, setups, spark } = row
  const up = (quote?.changePct ?? 0) >= 0
  return (
    <div className="card" style={{ animationDelay: `${Math.min(index * 45, 400)}ms` }}>
      <div className="row-top">
        <span className="sym">{symbol}</span>
        {spark && spark.length > 1 && <Sparkline closes={spark} />}
        <span className="prices">
          <span className="price">{quote ? fmtPrice(quote.price, quote.currency) : '—'}</span>
          {quote && <span className={`chg ${up ? 'up' : 'down'}`}>{fmtPct(quote.changePct)}</span>}
        </span>
      </div>
      <div className="row-bottom">
        {rvol != null && <span className={`rvol ${rvol >= 2 ? 'hot' : ''}`}>RVOL {rvol.toFixed(1)}x</span>}
        {setups.map(s => (
          <Badge key={s} kind={s} />
        ))}
        <button className="remove" onClick={onRemove} aria-label={`Remove ${symbol}`}>
          ✕
        </button>
      </div>
    </div>
  )
}
