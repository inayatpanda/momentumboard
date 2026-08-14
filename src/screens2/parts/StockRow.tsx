// StockRow (plan Task 15) — one watchlist row: avatar, symbol + name, price,
// change pill, sparkline. The sparkline is THIS row's own `candles:SYM:3mo`
// slice — mounting N rows fires N independent `useSlice` calls, which React
// kicks off in parallel (never a serial await loop; that was the original
// sin — see useMarketData.ts's `refreshCandles`, ported here as "give every
// row its own slice", not as a for-loop). The slice store's own dedupe means
// a symbol already charted elsewhere (a rail card, a past StockPage visit)
// costs nothing twice. Price and symbol render straight from the `quote`
// prop — a row NEVER waits on its candles to paint.

import type { CSSProperties } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../../lib/useSlice'
import { getCandles } from '../../lib/api'
import { symbolHue } from '../../components/TickerRow'
import { Sparkline } from '../../components/Sparkline'
import { fmtPrice, fmtPct } from '../../lib/format'
import type { Quote } from '../../../shared/types'

export function StockRow({
  symbol,
  name,
  quote,
  onRemove,
}: {
  symbol: string
  name?: string | null
  quote?: Quote | null
  /** Presence implies the watchlist context — renders a ✕ remove button. */
  onRemove?: () => void
}) {
  const { data: candles } = useSlice(`candles:${symbol}:3mo`, () => getCandles(symbol, '3mo').then(d => d.candles))
  const closes = candles && candles.length > 1 ? candles.slice(-30).map(c => c.c) : undefined
  const up = (quote?.changePct ?? 0) >= 0
  return (
    <div className="card pressable stx-row">
      <Link href={`/stock/${symbol}`} className="stx-row-link">
        <span className="stx-avatar" style={{ '--h': symbolHue(symbol) } as CSSProperties} aria-hidden="true">
          {symbol.slice(0, 2)}
        </span>
        <span className="stx-row-main">
          <span className="stx-sym">{symbol}</span>
          {name && <span className="stx-name">{name}</span>}
        </span>
        {closes && <Sparkline closes={closes} />}
        <span className="stx-row-prices">
          <span className="num">{quote ? fmtPrice(quote.price, quote.currency) : '—'}</span>
          {quote && <span className={`pill ${up ? 'long' : 'short'}`}><span className="num">{fmtPct(quote.changePct)}</span></span>}
        </span>
      </Link>
      {onRemove && (
        <button className="stx-remove" onClick={onRemove} aria-label={`Remove ${symbol}`}>
          ✕
        </button>
      )}
    </div>
  )
}
