import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Quote, SetupKind } from '../../shared/types'
import { fmtPrice } from '../lib/format'
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

/** Stable per-symbol hue for the letter-avatar tile (shared with Movers). */
export const symbolHue = (symbol: string) => [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360

export function TickerRow({
  row,
  onRemove,
  index = 0,
  action,
}: {
  row: Row
  onRemove?: () => void
  index?: number
  // replaces the ✕ with a labelled action (the universe browser's "+ Add")
  action?: { label: string; onClick: () => void; disabled?: boolean }
}) {
  const { symbol, quote, rvol, setups, spark } = row
  const up = quote && quote.changePct != null ? quote.changePct >= 0 : false
  const prevPrice = useRef(quote?.price)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)
  useEffect(() => {
    const prev = prevPrice.current
    const cur = quote?.price
    prevPrice.current = cur
    if (prev != null && cur != null && cur !== prev) {
      setFlash(cur > prev ? 'up' : 'down')
      const t = setTimeout(() => setFlash(null), 900)
      return () => clearTimeout(t)
    }
  }, [quote?.price])
  return (
    <div className="card trow" style={{ animationDelay: `${Math.min(index * 45, 400)}ms` }}>
      <span className="avatar-sq" style={{ '--h': symbolHue(symbol) } as CSSProperties} aria-hidden="true">
        {symbol.slice(0, 2)}
      </span>
      <span className="trow-main">
        <span className="trow-sym">{symbol}</span>
        {(rvol != null || setups.length > 0) && (
          <span className="trow-meta">
            {rvol != null && <span className={`rvol ${rvol >= 2 ? 'hot' : ''}`}>RVOL {rvol.toFixed(1)}x</span>}
            {setups.map(s => (
              <Badge key={s} kind={s} />
            ))}
          </span>
        )}
      </span>
      {spark && spark.length > 1 && <Sparkline closes={spark} />}
      <span className="trow-prices">
        <span className={`price ${flash ? `flash-${flash}` : ''}`}>{quote ? fmtPrice(quote.price, quote.currency) : '—'}</span>
        {quote && quote.changePct != null && (
          <span className={`trow-chg ${up ? 'up' : 'down'}`}>
            {up ? '↗' : '↘'} {Math.abs(quote.changePct).toFixed(2)}%
          </span>
        )}
      </span>
      {action ? (
        <button
          className="mini-btn ghost trow-action"
          disabled={action.disabled}
          onClick={e => {
            e.stopPropagation()
            action.onClick()
          }}
        >
          {action.label}
        </button>
      ) : (
        <button
          className="remove trow-remove"
          onClick={e => {
            e.stopPropagation() // row tap navigates; ✕ must only remove
            onRemove?.()
          }}
          aria-label={`Remove ${symbol}`}
        >
          ✕
        </button>
      )}
    </div>
  )
}
