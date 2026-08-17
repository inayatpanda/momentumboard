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
// waits on one. It now lives in parts/StockRow.tsx beside the record shape it
// decodes: two files each holding their own opinion of what a `candles:*` row
// looks like is exactly the drift B1 had to unpick. Watchlist rows are
// different: StockRow owns its own `candles:SYM:3mo` slice per row — see that
// file for why that is safe to do N times in parallel.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'wouter'
import { db, type WatchItem } from '../lib/db'
import { useSlice } from '../lib/useSlice'
import { useFlip } from '../lib/useFlip'
import { usePullRefresh, useSlicesRefresh, type SliceRefreshEntry } from '../lib/usePullRefresh'
import { getQuotes, getMovers, getSectors, type MoverRow } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { fmtPct } from '../lib/format'
import { Sparkline } from '../components/Sparkline'
import type { Quote } from '../../shared/types'
import { StockRow, useCachedSparkline } from './parts/StockRow'
import { HRail } from './parts/HRail'
import { RefreshStrip } from './parts/RefreshStrip'
import { SessionLine } from './parts/SessionLine'
import { isDeskWidth } from '../shell/DeskLayout'
import { sectorSign, SectorTileBody } from './parts/SectorTile'
import { CryptoWire } from './parts/CryptoWire'

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,12}$/

/** How many cards a rail shows — named once so the rail's own FLIP ordering
 * and its body can never disagree about which twelve those are. */
const railRows = (rows: MoverRow[]) => rows.slice(0, 12)

function RailSkeleton() {
  return (
    <>
      <div className="skeleton stx-rail-card" aria-hidden="true" />
      <div className="skeleton stx-rail-card" aria-hidden="true" />
      <div className="skeleton stx-rail-card" aria-hidden="true" />
    </>
  )
}

function RailMoverCard({ r, inWatchlist, onAdd }: { r: MoverRow; inWatchlist: boolean; onAdd: (sym: string) => void }) {
  const closes = useCachedSparkline(r.sym)
  const up = (r.changePct ?? 0) >= 0
  return (
    <div className="card pressable stx-rail-card" data-flip-key={r.sym}>
      <Link href={`/stock/${r.sym}`} className="stx-rail-card-link">
        <span className="stx-rail-card-top">{r.sym}</span>
        {closes && closes.length > 1 && <Sparkline closes={closes} width={100} height={26} />}
        <span className="num">{r.price != null ? r.price.toFixed(2) : '—'}</span>
        {r.changePct != null && <span className={`pill ${up ? 'long' : 'short'}`}><span className="num">{fmtPct(r.changePct)}</span></span>}
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
  const [requested, setRequested] = useState(isDeskWidth) // desk: eager — a pane with room shows its data, no scroll-into-view dance
  const [data, setData] = useState<{ gainers: MoverRow[]; losers: MoverRow[] } | null>(null)
  // REORDER MOTION (dynamism wave, feature 8), one ruler per rail: a refresh
  // re-ranks both, and the cards should slide to their new places rather than
  // teleport. The wrappers exist only to give each rail a container ref —
  // HRail owns its own markup and the cards stay direct children of `.hrail`.
  const gainersRef = useRef<HTMLDivElement>(null)
  const losersRef = useRef<HTMLDivElement>(null)
  const order = (kind: 'gainers' | 'losers') => (data ? railRows(data[kind]).map(r => r.sym).join(',') : '')
  useFlip(gainersRef, order('gainers'))
  useFlip(losersRef, order('losers'))

  const body = (kind: 'gainers' | 'losers') => {
    if (!data) return <RailSkeleton />
    const rows = railRows(data[kind])
    return rows.length ? (
      rows.map(r => <RailMoverCard key={r.sym} r={r} inWatchlist={watchSymbols.has(r.sym)} onAdd={onAdd} />)
    ) : (
      <p className="cc-reason">Nothing to show right now.</p>
    )
  }

  return (
    <>
      <div ref={gainersRef}>
        <HRail title="Top movers" seeAllPath="/stocks/movers" onVisible={() => setRequested(true)}>
          {body('gainers')}
        </HRail>
      </div>
      <div ref={losersRef}>
        <HRail title="Top losers" seeAllPath="/stocks/movers" onVisible={() => setRequested(true)}>
          {body('losers')}
        </HRail>
      </div>
      {requested && <MoversFetcher onData={setData} />}
    </>
  )
}

function SectorTile({ row }: { row: { sym: string; name: string; rs21: number | null } }) {
  return (
    <Link href={`/stock/${row.sym}`} className="card pressable stx-sector-tile" data-sign={sectorSign(row.rs21)}>
      <SectorTileBody name={row.name} rs={row.rs21} />
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
  const [requested, setRequested] = useState(isDeskWidth) // desk: eager — a pane with room shows its data, no scroll-into-view dance
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
 * whenever the watchlist itself changes.
 *
 * That remount is BELT AND BRACES now, not the fix. The race it was written
 * against — an in-place key swap racing a still-in-flight fetch for the old key
 * — is closed inside the hook: `useSlice` bumps a generation on every key change
 * and orphans the old key's continuations (and, since the final wave, pins each
 * load's fetcher to the key it was made for). A fresh instance per watchlist is
 * still the clearer thing to reason about, so it stays. */
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
    const read = () =>
      db.watchlist.toArray().then(list => {
        setItems(list)
        setWatchLoaded(true)
        return list
      })
    // The starter seeding (App.tsx boot) can land AFTER this first read — on a
    // brand-new install the list painted "empty" until a reload (owner's first
    // DMG launch). Two nets, both needed: starter.ts announces (the listener),
    // but on a DIRECT /app/stocks load this lazy chunk can still be downloading
    // when the event fires — a missed event repaints nothing (live-verified).
    // So an empty first read also re-reads once after the seed window.
    let retry: ReturnType<typeof setTimeout> | undefined
    void read().then(list => {
      if (list.length === 0) retry = setTimeout(read, 1500)
    })
    window.addEventListener('mb-watchlist-changed', read)
    return () => {
      clearTimeout(retry)
      window.removeEventListener('mb-watchlist-changed', read)
    }
  }, [])

  const symbols = items.map(i => i.symbol)

  // PULL TO REFRESH (dynamism wave). This screen's slices live in its
  // CHILDREN — the watchlist's quote batch, the rails' movers and sectors — so
  // the refresh names their keys and force-revalidates them through the same
  // store call a slice's own refresh() makes; every mounted reader repaints off
  // the write announcement. An empty watchlist contributes no `quotes:` key
  // rather than asking the API for nothing.
  const refreshEntries: SliceRefreshEntry[] = [
    { key: 'movers', fetcher: getMovers },
    { key: 'sectors', fetcher: getSectors },
  ]
  if (symbols.length) refreshEntries.push({ key: `quotes:${symbols.join(',')}`, fetcher: () => getQuotes(symbols) })
  const { refresh, refreshing } = useSlicesRefresh(refreshEntries)
  const { pull } = usePullRefresh(refresh)

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
      <RefreshStrip refreshing={refreshing} pull={pull} onRefresh={refresh} />
      <h1>Stocks</h1>
      {/* the session's own state (dynamism wave) — a watchlist of flat prices
          reads as broken until the line above it says the market is shut */}
      <SessionLine />
      <form className="stx-search" onSubmit={handleSearch}>
        {/* THE PLACEHOLDER FITS THE FIELD NOW (visibility wave, 2026-08-17).
            Three examples overflowed a phone's input and the reader met a
            truncated one; two teach the whole shape — a plain ticker and a
            suffixed one — and the ellipsis says there are more. */}
        <input
          aria-label="Search ticker"
          placeholder="Search a ticker — AAPL, VOD.L…"
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setSearchError(false)
          }}
        />
        <button type="submit">Search</button>
      </form>
      {searchError && <p className="stx-search-error">Enter a valid ticker — letters, numbers, &quot;.&quot; or &quot;-&quot;, up to 12 characters.</p>}

      {/* One structure, two densities: on phones these blocks simply stack
          (the grid classes have no rules there); at desk width the .desk2
          rules lay them out two-column with sectors full-width below —
          the owner's first-DMG review: use the space. */}
      <div className="stx-desk-grid">
        {/* THE CRYPTO WIRE (owner: "i dont see any crpto information
            anywhere") — first on the page and full-width at desk, ALWAYS
            rendered. It leads rather than follows because the starter
            watchlist alone is seventeen rows: a section that sits under it is
            a section he has to go looking for, which is the complaint. */}
        <div className="stx-crypto-block">
          <CryptoWire />
        </div>
        <div>
          <p className="sec-label">Your watchlist</p>
          {!watchLoaded ? (
            <div className="skeleton" style={{ height: 64, marginBottom: 8 }} />
          ) : items.length === 0 ? (
            <p className="cc-reason">Your watchlist is empty. Search a ticker above, or add one from the rails below.</p>
          ) : (
            <WatchlistRows key={symbols.join(',')} items={items} onRemove={remove} />
          )}
        </div>
        <div>
          <MoversRails watchSymbols={new Set(symbols)} onAdd={add} />
        </div>
        <div className="stx-sectors-block">
          <SectorsRail />
        </div>
      </div>
    </div>
  )
}
