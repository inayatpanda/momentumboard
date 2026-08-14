// Stocks (plan Task 15) — search + the user's watchlist + T212-Discover-style
// horizontal rails (Top movers / Top losers / Sectors).
//
// Rails cost NOTHING at boot: HRail's IntersectionObserver only tells this
// screen a rail scrolled into view; the actual `useSlice` call for that
// rail's data lives in a component mounted ONLY once that happens (the same
// "wait for X, then mount a child that fetches" shape Board.tsx's
// RefusedSection uses for the funnel slice). Top movers and Top losers are
// two separate rails sharing ONE 'movers' slice — MoversFetcher below is the
// single mount point for that fetch; whichever rail is reached first
// triggers it, and the other rail reads the very same slice once it lands.
//
// Rail cards (movers/losers) NEVER fetch candles — useCachedSparkline is a
// raw Dexie read (readSlice), never a `useSlice`/network call, so a symbol
// already charted elsewhere shows a sparkline for free and nothing else
// waits on one. Watchlist rows are different: StockRow (parts/StockRow.tsx)
// owns its own `candles:SYM:3mo` slice per row — see that file for why that
// is safe to do N times in parallel.

import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'wouter'
import { db, type WatchItem } from '../lib/db'
import { useSlice } from '../lib/useSlice'
import { readSlice } from '../lib/store'
import { getQuotes, getMovers, getSectors, type MoverRow } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { fmtPct } from '../lib/format'
import { Sparkline } from '../components/Sparkline'
import type { Candle, Quote } from '../../shared/types'
import { StockRow } from './parts/StockRow'
import { HRail } from './parts/HRail'

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,12}$/

function RailSkeleton() {
  return (
    <>
      <div className="skeleton stx-rail-card" aria-hidden="true" />
      <div className="skeleton stx-rail-card" aria-hidden="true" />
      <div className="skeleton stx-rail-card" aria-hidden="true" />
    </>
  )
}

/** Rail cards never fetch — they read whatever the slice store already has
 * cached for this symbol (Dexie only, no network) so a sparkline shows up
 * for free when another part of the app already pulled it. */
function useCachedSparkline(symbol: string): number[] | undefined {
  const [closes, setCloses] = useState<number[] | undefined>(undefined)
  useEffect(() => {
    let alive = true
    readSlice<Candle[]>(`candles:${symbol}:3mo`).then(rec => {
      if (alive && rec && rec.data.length > 1) setCloses(rec.data.slice(-30).map(c => c.c))
    })
    return () => {
      alive = false
    }
  }, [symbol])
  return closes
}

function RailMoverCard({ r, inWatchlist, onAdd }: { r: MoverRow; inWatchlist: boolean; onAdd: (sym: string) => void }) {
  const closes = useCachedSparkline(r.sym)
  const up = (r.changePct ?? 0) >= 0
  return (
    <div className="card pressable stx-rail-card">
      <Link href={`/stock/${r.sym}`} className="stx-rail-card-link">
        <span className="stx-rail-card-top">{r.sym}</span>
        {closes && closes.length > 1 && <Sparkline closes={closes} width={100} height={26} />}
        <span className="num">{r.price != null ? r.price.toFixed(2) : '—'}</span>
        {r.changePct != null && <span className={`pill ${up ? 'long' : 'short'}`}>{fmtPct(r.changePct)}</span>}
      </Link>
      {!inWatchlist && (
        <button className="stx-rail-add" onClick={() => onAdd(r.sym)} aria-label={`Add ${r.sym} to watchlist`}>
          +
        </button>
      )}
    </div>
  )
}

/** Owns the ONE 'movers' slice fetch, mounted only once EITHER rail below
 * has been scrolled into view — Top movers and Top losers both read off it,
 * so reaching Losers first never fires a second request for Movers. */
function MoversFetcher({ onData }: { onData: (d: { gainers: MoverRow[]; losers: MoverRow[] }) => void }) {
  const { data } = useSlice('movers', getMovers)
  useEffect(() => {
    if (data) onData({ gainers: data.gainers, losers: data.losers })
  }, [data, onData])
  return null
}

function MoversRails({ watchSymbols, onAdd }: { watchSymbols: Set<string>; onAdd: (sym: string) => void }) {
  const [requested, setRequested] = useState(false)
  const [data, setData] = useState<{ gainers: MoverRow[]; losers: MoverRow[] } | null>(null)

  const body = (kind: 'gainers' | 'losers') => {
    if (!data) return <RailSkeleton />
    const rows = data[kind].slice(0, 12)
    return rows.length ? (
      rows.map(r => <RailMoverCard key={r.sym} r={r} inWatchlist={watchSymbols.has(r.sym)} onAdd={onAdd} />)
    ) : (
      <p className="cc-reason">Nothing to show right now.</p>
    )
  }

  return (
    <>
      <HRail title="Top movers" seeAllPath="/stocks/movers" onVisible={() => setRequested(true)}>
        {body('gainers')}
      </HRail>
      <HRail title="Top losers" seeAllPath="/stocks/movers" onVisible={() => setRequested(true)}>
        {body('losers')}
      </HRail>
      {requested && <MoversFetcher onData={setData} />}
    </>
  )
}

function SectorTile({ row }: { row: { sym: string; name: string; rs21: number | null } }) {
  // Tinted by sign only — --long/--short at low alpha via color-mix, never a
  // third hue (the app's decoration colour is always indigo/accent).
  const sign = row.rs21 != null && row.rs21 < 0 ? 'neg' : 'pos'
  return (
    <Link href={`/stock/${row.sym}`} className="card pressable stx-sector-tile" data-sign={sign}>
      <span className="stx-sector-name">{row.name}</span>
      <span className="num stx-sector-rs">{row.rs21 != null ? row.rs21.toFixed(1) : '—'}</span>
    </Link>
  )
}

function SectorsRailBody() {
  const { data } = useSlice('sectors', getSectors)
  if (!data) return <RailSkeleton />
  return data.rows.length ? (
    <>
      {data.rows.map(row => (
        <SectorTile key={row.sym} row={row} />
      ))}
    </>
  ) : (
    <p className="cc-reason">No sector data right now.</p>
  )
}

function SectorsRail() {
  const [requested, setRequested] = useState(false)
  return (
    <HRail title="Sectors" seeAllPath="/stocks/sectors" onVisible={() => setRequested(true)}>
      {requested ? <SectorsRailBody /> : <RailSkeleton />}
    </HRail>
  )
}

/** The watchlist rows, split out so `useSlice`'s ONE `quotes:<joined>` batch
 * call only ever mounts once the real symbol list is known (Stocks' parent
 * effect resolves `db.watchlist` first) — `key={symbols.join(',')}` on the
 * call site below forces a full remount, not an in-place key transition,
 * whenever the watchlist itself changes. That matters: `useSlice`'s cleanup
 * flag is a single re-armable ref, so an in-place key swap can race a
 * still-in-flight fetch for the OLD key against the new one (the same
 * hazard Board.tsx's `key={blob.date}` on RefusedSection works around for
 * the funnel slice) — a remount gives the new key a wholly fresh hook
 * instance instead. */
function WatchlistRows({ items, onRemove }: { items: WatchItem[]; onRemove: (sym: string) => void }) {
  const symbols = items.map(i => i.symbol)
  const { data: quotes } = useSlice(`quotes:${symbols.join(',')}`, () => getQuotes(symbols))
  const quoteFor = (sym: string): Quote | null => {
    const i = symbols.indexOf(sym)
    return i === -1 ? null : (quotes?.[i] ?? null)
  }
  return (
    <div className="stx-watchlist">
      {items.map(i => (
        <StockRow key={i.symbol} symbol={i.symbol} name={quoteFor(i.symbol)?.name} quote={quoteFor(i.symbol)} onRemove={() => onRemove(i.symbol)} />
      ))}
    </div>
  )
}

export default function Stocks() {
  const [, navigate] = useLocation()
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState(false)
  const [items, setItems] = useState<WatchItem[]>([])
  const [watchLoaded, setWatchLoaded] = useState(false)

  useEffect(() => {
    db.watchlist.toArray().then(list => {
      setItems(list)
      setWatchLoaded(true)
    })
  }, [])

  const symbols = items.map(i => i.symbol)

  const add = async (symbol: string) => {
    const sym = symbol.toUpperCase()
    if (items.some(i => i.symbol === sym)) return
    const row: WatchItem = { symbol: sym, addedAt: Date.now(), riskClass: 'normal' }
    await db.watchlist.put(row)
    setItems(s => [...s, row])
    mirrorConfig() // CX-22: server alerts + cross-device sync depend on this
  }

  const remove = async (symbol: string) => {
    await db.watchlist.delete(symbol)
    setItems(s => s.filter(i => i.symbol !== symbol))
    mirrorConfig()
  }

  const handleSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = query.trim()
    if (!SYMBOL_RE.test(trimmed)) {
      setSearchError(true)
      return
    }
    setSearchError(false)
    navigate(`/stock/${trimmed.toUpperCase()}`)
  }

  return (
    <div className="stx">
      <h1>Stocks</h1>
      <form className="stx-search" onSubmit={handleSearch}>
        <input
          aria-label="Search ticker"
          placeholder="Search a ticker — AAPL, 3LTS.L, BTC-USD"
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setSearchError(false)
          }}
        />
        <button type="submit">Search</button>
      </form>
      {searchError && <p className="stx-search-error">Enter a valid ticker — letters, numbers, &quot;.&quot; or &quot;-&quot;, up to 12 characters.</p>}

      <p className="sec-label">Your watchlist</p>
      {!watchLoaded ? (
        <div className="skeleton" style={{ height: 64, marginBottom: 8 }} />
      ) : items.length === 0 ? (
        <p className="cc-reason">Your watchlist is empty. Search a ticker above, or add one from the rails below.</p>
      ) : (
        <WatchlistRows key={symbols.join(',')} items={items} onRemove={remove} />
      )}

      <MoversRails watchSymbols={new Set(symbols)} onAdd={add} />
      <SectorsRail />
    </div>
  )
}
