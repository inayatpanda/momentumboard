// StockRow (plan Task 15) — one watchlist row: avatar, symbol + name, price,
// change pill, sparkline. The sparkline is THIS row's own `candles:SYM:3mo`
// slice — mounting N rows fires N independent `useSlice` calls, which React
// kicks off in parallel (never a serial await loop; that was the original
// sin — see useMarketData.ts's `refreshCandles`, ported here as "give every
// row its own slice", not as a for-loop). The slice store's own dedupe means
// a symbol already charted elsewhere (a rail card, a past StockPage visit)
// costs nothing twice. Price and symbol render straight from the `quote`
// prop — a row NEVER waits on its candles to paint.
//
// ONE KEY, ONE SHAPE (final wave, B1). `candles:SYM:3mo` is ALSO written by
// StockPage's chart slice, which caches the whole `{ candles, quote }` payload
// `getCandles` returns. This row used to unwrap to the bare array and write
// THAT under the very same key, so whichever component cached first handed the
// other a shape it could not read — for the full 15-minute TTL. The object is
// the shape everywhere now (here, StockPage, and Stocks' rail sparklines);
// every reader takes `.candles` off it.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../../lib/useSlice'
import { readSlice } from '../../lib/store'
import { getCandles } from '../../lib/api'
import { symbolHue } from '../../components/TickerRow'
import { Sparkline } from '../../components/Sparkline'
import { fmtPrice, fmtPct } from '../../lib/format'
import type { Candle, Quote } from '../../../shared/types'

/** What `getCandles` returns and what every `candles:*` slice therefore holds. */
export interface CandleSlice {
  candles: Candle[]
}

/** The last 30 closes, or undefined when there is not enough tape to draw. */
export const sparkCloses = (rec: CandleSlice | null | undefined): number[] | undefined =>
  rec && rec.candles && rec.candles.length > 1 ? rec.candles.slice(-30).map(c => c.c) : undefined

/** CACHE-ONLY SPARKLINE: whatever the slice store already holds for this
 * symbol, read straight out of Dexie — never a fetch, never a `useSlice`. It
 * lives here, beside the shape it reads, so the one place that knows what a
 * `candles:*` record looks like is the one place that decodes it (the shape
 * drift B1 fixed came from two files each holding their own opinion). Stocks'
 * rail cards and Movers' long list both take this path. */
export function useCachedSparkline(symbol: string): number[] | undefined {
  const [closes, setCloses] = useState<number[] | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void readSlice<CandleSlice>(`candles:${symbol}:3mo`).then(rec => {
      const c = sparkCloses(rec?.data)
      if (alive && c) setCloses(c)
    })
    return () => {
      alive = false
    }
  }, [symbol])
  return closes
}

/** The row's own slice: one `candles:SYM:3mo` per row, fetched if stale. Safe
 * N times over because React fires the mounts in parallel and the store dedupes
 * a shared key — but only at watchlist LENGTHS. See `sparkCachedOnly`. */
function SparkLive({ symbol }: { symbol: string }) {
  const { data } = useSlice<CandleSlice>(`candles:${symbol}:3mo`, () => getCandles(symbol, '3mo'))
  const closes = sparkCloses(data)
  return closes ? <Sparkline closes={closes} /> : null
}

/** Dexie only. The rail cards' bargain, offered to any list long enough to need
 * it: a sparkline when the tape happens to be cached, silence when it is not. */
function SparkCached({ symbol }: { symbol: string }) {
  const closes = useCachedSparkline(symbol)
  return closes ? <Sparkline closes={closes} /> : null
}

/** How long the tick colour lingers. Matches the CSS animation in base.css. */
const FLASH_MS = 900

/** THE PRICE FLASH (dynamism wave), ported from the legacy row
 * (src/components/TickerRow.tsx:34-44), which was the only place in the app
 * that ever showed a price MOVING — and which no v2 screen renders. A changed
 * price flashes green or red for the length of the animation and then goes
 * quiet; the FIRST price a row ever sees is not a change and never flashes. */
function usePriceFlash(price: number | null | undefined): 'up' | 'down' | null {
  const prev = useRef(price)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = price
    if (before == null || price == null || price === before) return
    setFlash(price > before ? 'up' : 'down')
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [price])
  return flash
}

export function StockRow({
  symbol,
  name,
  quote,
  onRemove,
  sparkCachedOnly,
  flipKey,
}: {
  symbol: string
  name?: string | null
  quote?: Quote | null
  /** Opts this row into the list's FLIP reorder animation (src/lib/useFlip.ts)
   * under a STABLE identity — the symbol, never the index. */
  flipKey?: string
  /** Presence implies the watchlist context — renders a ✕ remove button. */
  onRemove?: () => void
  /** NEVER fetch this row's candles — draw a sparkline only if the store
   * already has the series (D3). A watchlist is a dozen rows and each one
   * pulling its own 3-month series is a fair trade; Movers renders FORTY, and
   * forty parallel candle requests on a screen whose sparklines are decoration
   * is a burst of traffic nobody asked for. The rail cards in Stocks.tsx have
   * always taken this deal; this is the same deal, offered as a prop. */
  sparkCachedOnly?: boolean
}) {
  const up = quote && quote.changePct != null ? quote.changePct >= 0 : false
  const flash = usePriceFlash(quote?.price)
  return (
    <div className="card pressable stx-row" data-flip-key={flipKey}>
      <Link href={`/stock/${symbol}`} className="stx-row-link">
        <span className="stx-avatar" style={{ '--h': symbolHue(symbol) } as CSSProperties} aria-hidden="true">
          {symbol.slice(0, 2)}
        </span>
        <span className="stx-row-main">
          <span className="stx-sym">{symbol}</span>
          {name && <span className="stx-name">{name}</span>}
        </span>
        {sparkCachedOnly ? <SparkCached symbol={symbol} /> : <SparkLive symbol={symbol} />}
        <span className="stx-row-prices">
          <span className={`num${flash ? ` flash-${flash}` : ''}`}>{quote ? fmtPrice(quote.price, quote.currency) : '—'}</span>
          {quote && quote.changePct != null && <span className={`pill ${up ? 'long' : 'short'}`}><span className="num">{fmtPct(quote.changePct)}</span></span>}
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
