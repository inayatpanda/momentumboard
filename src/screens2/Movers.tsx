// Movers (plan Task 16) — the "See all" landing for the Stocks rails' Top
// movers / Top losers cards. Same 'movers' slice the rail already fetches, so
// arriving here from a rail's "See all" link paints instantly from Dexie —
// no second network round trip. No candles-fetching code lives HERE: each
// full-width row below is a real `StockRow` (parts/StockRow.tsx), which
// already owns its own per-row candles:SYM:3mo slice — Movers.tsx only shapes
// a MoverRow into the Quote-ish prop StockRow expects.
//
// …and it asks those rows for CACHED sparklines only (D3). A watchlist row
// fetching its own three months of tape is a fair trade at a dozen rows; this
// page opens with FORTY, and forty parallel candle requests for decoration is a
// burst of traffic nobody asked for — on a screen the reader reached to scan
// names, not to chart them. A name already charted elsewhere still draws for
// free, which is exactly the bargain the Stocks rail cards have always taken.
//
// Windowing is deliberately simple (no virtualiser dependency): render the
// first PAGE rows, a "Show more" button reveals the rest. Switching gainers
// <-> losers resets the window back to PAGE.

import { useRef, useState } from 'react'
import { useSlice } from '../lib/useSlice'
import { useFlip } from '../lib/useFlip'
import { getMovers, type MoverRow } from '../lib/api'
import { StockRow } from './parts/StockRow'
import type { Quote } from '../../shared/types'

const PAGE = 40

function moverQuote(r: MoverRow): Quote | null {
  // Return null if price is missing — StockRow will render '—' instead of fabricated $0.00
  if (r.price == null) {
    return null
  }
  return {
    symbol: r.sym,
    price: r.price,
    prevClose: r.price,
    changePct: r.changePct,
    currency: 'USD',
    todayVolume: null,
    asOf: 0,
    source: 'finnhub',
  }
}

export default function Movers() {
  const { data } = useSlice('movers', getMovers)
  const [view, setView] = useState<'gainers' | 'losers'>('gainers')
  const [visible, setVisible] = useState(PAGE)

  const rows = data ? data[view] : []
  const shown = rows.slice(0, visible)
  // REORDER MOTION (dynamism wave, feature 8): a refresh re-ranks this list,
  // and a row that climbed six places used to simply appear six places up —
  // the one moment something genuinely changed showed nothing at all.
  const listRef = useRef<HTMLDivElement>(null)
  useFlip(listRef, shown.map(r => r.sym).join(','))

  const setViewAndReset = (v: 'gainers' | 'losers') => {
    setView(v)
    setVisible(PAGE)
  }

  return (
    <div className="stx">
      <h1>Movers</h1>
      <div className="seg" role="group" aria-label="Gainers or losers">
        <button type="button" aria-pressed={view === 'gainers'} onClick={() => setViewAndReset('gainers')}>
          Gainers
        </button>
        <button type="button" aria-pressed={view === 'losers'} onClick={() => setViewAndReset('losers')}>
          Losers
        </button>
      </div>

      {!data ? (
        <div className="skeleton" style={{ height: 64, marginTop: 12 }} />
      ) : rows.length === 0 ? (
        <p className="cc-reason">Nothing to show right now.</p>
      ) : (
        <>
          <div className="stx-watchlist" ref={listRef}>
            {shown.map(r => (
              <StockRow key={r.sym} symbol={r.sym} name={r.name} quote={moverQuote(r)} sparkCachedOnly flipKey={r.sym} />
            ))}
          </div>
          {visible < rows.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(rows.length)}>
              Show more ({rows.length - visible})
            </button>
          )}
        </>
      )}
    </div>
  )
}
