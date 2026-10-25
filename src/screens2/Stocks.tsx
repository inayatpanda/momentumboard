import { getStockContexts, getStrategyChoices } from '../lib/apiViews'
import { SectorIcon } from '../components/SectorIcon'
// Stocks opens with the watchlist; market research loads when selected.

import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { db, type WatchItem } from '../lib/db'
import { useSlice } from '../lib/useSlice'
import { usePullRefresh, useSlicesRefresh, type SliceRefreshEntry } from '../lib/usePullRefresh'
import { getQuotes, getMovers, getSectors } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import type { Quote } from '../../shared/types'
import { StockRow } from './parts/StockRow'
import { RefreshStrip } from './parts/RefreshStrip'
import { SessionLine } from './parts/SessionLine'
import { useLiveQuotes } from '../lib/useLiveQuotes'
import { searchStocks, useStockDirectory } from '../lib/stockDirectory'
import { WatchlistSectors, watchSector } from './parts/WatchlistSectors'
import { BrandMark } from '../components/BrandMark'

const StockContextPanel = lazy(() => import('./parts/StockContextPanel').then(module => ({ default: module.StockContextPanel })))
const StockDiscovery = lazy(() => import('./parts/StockDiscovery').then(module => ({ default: module.StockDiscovery })))
const StockMarkets = lazy(() => import('./parts/StockMarkets'))
const StrategyChoicesView = lazy(() => import('./parts/StrategyChoicesView'))
const SellReviewView = lazy(() => import('./parts/SellReviewView'))
type StockSection = 'watchlist' | 'discover' | 'strategies' | 'sell' | 'markets'
const sectionFromSearch = (search: string): StockSection => {
  const view = new URLSearchParams(search).get('view')
  return view === 'discover' || view === 'strategies' || view === 'sell' || view === 'markets' ? view : 'watchlist'
}

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,12}$/

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
function WatchlistRows({ items, onRemove, names }: { items: WatchItem[]; names: Map<string, string>; onRemove?: (sym: string) => void }) {
  const symbols = items.map(i => i.symbol)
  const { data: quotes, error, refresh, refreshing } = useSlice(`quotes:${symbols.join(',')}`, () => getQuotes(symbols))
  const { data: contexts, refreshing: contextLoading } = useSlice(`stock-contexts:${symbols.join(',')}`, () => getStockContexts(symbols))
  // the market-hours ticker (owner 2026-08-17: "are the prices of stocks being
  // gathered live now?"): 45s revalidation while visible and the market is
  // open, same gates as Today's call cards. Its row is fresher than the
  // slice's own paint, so it wins when present.
  const live = useLiveQuotes(symbols)
  const quoteFor = (sym: string): Quote | null => {
    const fresh = live[sym.toUpperCase()]
    if (fresh) return fresh
    return quotes?.find(q => q?.symbol === sym) ?? null
  }
  return (
    <>{error && <p className="watch-price-status" role="status">Live prices could not refresh. Available chart quotes are labelled. <button onClick={refresh} disabled={refreshing}>Retry prices</button></p>}<div className="stx-watchlist">
      {items.map(i => (
        <div key={i.symbol}><StockRow symbol={i.symbol} name={quoteFor(i.symbol)?.name ?? names.get(i.symbol)} quote={quoteFor(i.symbol)} onRemove={onRemove ? () => onRemove(i.symbol) : undefined} /><Suspense fallback={null}><StockContextPanel compact symbol={i.symbol} context={contexts?.items[i.symbol]} loading={contextLoading && !contexts} /></Suspense></div>
      ))}
    </div></>
  )
}

export default function Stocks() {
  const [location, navigate] = useLocation()
  const search = useSearch()
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState(false)
  const [items, setItems] = useState<WatchItem[]>([])
  const [watchLoaded, setWatchLoaded] = useState(false)
  const [section, updateSection] = useState<StockSection>(() => sectionFromSearch(search))
  useEffect(() => { updateSection(sectionFromSearch(search)) }, [search])
  const activeSection = query.trim() ? 'discover' : section
  useEffect(() => {
    const reveal = () => {
      const button = document.getElementById(`stock-tab-${activeSection}`), tabs = button?.parentElement
      if (!button || !tabs || tabs.scrollWidth <= tabs.clientWidth) return
      // Keep the selected view readable on narrow phones, including direct
      // links and orientation changes, without moving the page vertically.
      tabs.scrollLeft += button.getBoundingClientRect().left - tabs.getBoundingClientRect().left - (tabs.clientWidth - button.clientWidth) / 2
    }
    reveal()
    window.addEventListener('resize', reveal)
    return () => window.removeEventListener('resize', reveal)
  }, [activeSection])
  const setSection = (value: StockSection) => {
    updateSection(value)
    const params = new URLSearchParams(window.location.search)
    if (value === 'watchlist') params.delete('view'); else params.set('view', value)
    if (value !== 'strategies') params.delete('strategy')
    if (value !== 'sell') params.delete('stock')
    navigate(`${location}${params.size ? `?${params}` : ''}`, { replace: true })
  }
  const [sector, setSector] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState(false)
  const [watchFilter, setWatchFilter] = useState('')
  const [removed, setRemoved] = useState<WatchItem | null>(null)
  const { data: directory, error: directoryError } = useStockDirectory()
  const names = useMemo(() => new Map(directory?.rows.map(r => [r.sym, r.name])), [directory])

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
  if (section === 'strategies' || section === 'sell') refreshEntries.push({ key: 'strategy-choices', fetcher: getStrategyChoices })
  const filteredItems = watchFilter ? items.filter(i => watchSector(i.symbol, directory?.rows ?? []) === watchFilter) : items
  const visibleItems = showAll ? filteredItems : filteredItems.slice(0, 6)
  const visibleSymbols = visibleItems.map(i => i.symbol)
  if (visibleSymbols.length) refreshEntries.push({ key: `quotes:${visibleSymbols.join(',')}`, fetcher: () => getQuotes(visibleSymbols) }, { key: `stock-contexts:${visibleSymbols.join(',')}`, fetcher: () => getStockContexts(visibleSymbols) })
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
    const item = items.find(i => i.symbol === symbol)
    await db.watchlist.delete(symbol)
    setItems(s => s.filter(i => i.symbol !== symbol))
    setRemoved(item ?? null)
    mirrorConfig()
  }
  const undoRemove = async () => {
    if (!removed) return
    await db.watchlist.put(removed)
    setItems(s => s.some(i => i.symbol === removed.symbol) ? s : [...s, removed].sort((a, b) => a.symbol.localeCompare(b.symbol)))
    setRemoved(null); mirrorConfig()
  }

  const handleSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = query.trim()
    const matches = directory ? searchStocks(directory.rows, trimmed) : []
    const exact = matches.find(r => r.sym.toLowerCase() === trimmed.toLowerCase() || r.name.toLowerCase() === trimmed.toLowerCase())
    if (exact) { navigate(`/stock/${exact.sym}`); return }
    if (matches.length) { setSection('discover'); return }
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
      <div className="stocks-title"><div><p className="stocks-brandline"><BrandMark size={24} />StreetSignal</p><h1>Stocks</h1></div><button type="button" className="stocks-refresh" aria-label="Refresh stocks" disabled={refreshing} onClick={refresh}>↻</button></div>
      {/* the session's own state (dynamism wave) — a watchlist of flat prices
          reads as broken until the line above it says the market is shut */}
      <SessionLine />
      <form className="stx-search" onSubmit={handleSearch}>
        {/* THE PLACEHOLDER FITS THE FIELD NOW (visibility wave, 2026-08-17).
            Three examples overflowed a phone's input and the reader met a
            truncated one; two teach the whole shape — a plain ticker and a
            suffixed one — and the ellipsis says there are more. */}
        <input
          aria-label="Search ticker or company"
          placeholder="Search companies or tickers"
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setSector('')
            setSearchError(false)
          }}
        />
        <button type="submit">Search</button>
      </form>
      {searchError && <p className="stx-search-error">Enter a valid ticker — letters, numbers, &quot;.&quot; or &quot;-&quot;, up to 12 characters.</p>}

      <div className="stocks-tabs" role="tablist" aria-label="Stock views">
        {(['watchlist', 'discover', 'strategies', 'sell', 'markets'] as const).map((key, index, tabs) => <button key={key} role="tab" id={`stock-tab-${key}`} aria-controls="stock-view" tabIndex={(query.trim() ? 'discover' : section) === key ? 0 : -1} aria-selected={(query.trim() ? 'discover' : section) === key}
          onClick={() => { setQuery(''); setSearchError(false); setSection(key) }} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
            if (next >= 0) { event.preventDefault(); setQuery(''); setSearchError(false); setSection(tabs[next]); document.getElementById(`stock-tab-${tabs[next]}`)?.focus() }
          }}>{key === 'watchlist' ? 'Watchlist' : key === 'discover' ? 'Discover' : key === 'strategies' ? 'Strategies' : key === 'sell' ? 'Sell review' : 'Markets'}</button>)}
      </div>
      <div id="stock-view" role="tabpanel" aria-labelledby={`stock-tab-${query.trim() ? 'discover' : section}`}>
      {query.trim() || section === 'discover' ? <Suspense fallback={<p role="status">Loading stock discovery…</p>}><StockDiscovery directory={directory} error={directoryError} query={query} sector={sector} onSector={setSector} watchSymbols={new Set(symbols)} onAdd={add} /></Suspense> : section === 'watchlist' ? <>
        <div className="discovery-heading"><div><h2>{watchFilter || 'Your watchlist'} <span className="stocks-count">{filteredItems.length}</span></h2><span className="cc-reason">Price · day change · 3-month trend</span></div>{items.length > 0 && <button className="stocks-text-link" aria-pressed={editing} onClick={() => setEditing(v => !v)}>{editing ? 'Done' : 'Edit watchlist'}</button>}</div>
        {watchFilter && <button className="discovery-back" onClick={() => setWatchFilter('')}>← All watched stocks</button>}
        {removed && <div className="watch-undo" role="status">{removed.symbol} removed <button onClick={undoRemove}>Undo</button></div>}
        {!watchLoaded ? <div className="skeleton" style={{ height: 280 }} /> : !items.length ? <div className="stocks-empty"><p>Your watchlist is empty.</p><p>Find a company you want to follow, then tap +.</p><button onClick={() => setSection('discover')}>Discover stocks</button></div> : !visibleItems.length ? <p className="cc-reason">No watched stocks remain in this sector.</p> : <WatchlistRows key={visibleSymbols.join(',')} items={visibleItems} onRemove={editing ? remove : undefined} names={names} />}
        {filteredItems.length > 6 && <button className="discovery-more" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer' : `View all ${filteredItems.length} stocks`}</button>}
        {!!directory && <WatchlistSectors symbols={symbols} directory={directory.rows} selected={watchFilter} onSelect={value => { setWatchFilter(value); setShowAll(false) }} />}
        <section className="stocks-sector-preview" aria-label="Browse by sector"><div className="discovery-heading"><h2>Explore sectors</h2><button className="stocks-text-link" onClick={() => { setSector(''); setSection('discover') }}>View all →</button></div>
          <div className="sector-preview-grid">{['Technology', 'Healthcare', 'Financials', 'Energy'].map(name => <button key={name} onClick={() => { setSector(name); setSection('discover') }}><span aria-hidden="true"><SectorIcon sector={name} /></span><strong>{name}</strong><span aria-hidden="true">↗</span></button>)}</div>
        </section>
        <Link href="/today" className="stocks-today-link"><span><strong>Today’s research</strong><small>Market context, stock setups and what changed</small></span><span aria-hidden="true">→</span></Link>
        <Link href="/more/street" className="stocks-today-link"><span><strong>From your channels</strong><small>Latest video findings and supporting evidence</small></span><span aria-hidden="true">→</span></Link>
      </> : section === 'strategies' ? <Suspense fallback={<p role="status">Loading strategies…</p>}><StrategyChoicesView /></Suspense> : section === 'sell' ? <Suspense fallback={<p role="status">Loading sell review…</p>}><SellReviewView watchSymbols={symbols} watchLoaded={watchLoaded} /></Suspense> : <Suspense fallback={<p role="status">Loading markets…</p>}><StockMarkets watchSymbols={new Set(symbols)} onAdd={add} /></Suspense>}
      </div>
    </div>
  )
}
