import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { getToken, setToken, getRunlog, getMovers, type MoverRow } from '../lib/api'
import { seedStarterWatchlist } from '../lib/starter'
import { humanError } from '../lib/format'
import { mirrorConfig } from '../lib/configMirror'
import { useMarketData } from '../hooks/useMarketData'
import { useAlerts } from '../hooks/useAlerts'
import type { RuleItem } from '../lib/db'
import { RegimeBanner } from '../components/RegimeBanner'
import { TickerRow } from '../components/TickerRow'
import { AddTickerForm } from '../components/AddTickerForm'
import { Toasts } from '../components/Toasts'
import { IconGear, IconWarn } from '../components/icons'
import { MoverCard } from './Movers'

export function Watchlist({ onOpen, onOpenSettings }: { onOpen: (symbol: string) => void; onOpenSettings: () => void }) {
  const [items, setItems] = useState<{ symbol: string; category?: string }[]>([])
  const [categoryFilter, setCategoryFilter] = useState<string>('All')
  const [rules, setRules] = useState<RuleItem[]>([])
  const [hasToken, setHasToken] = useState(!!getToken())
  const [sortBy, setSortBy] = useState<'default' | 'change' | 'rvol' | 'setups'>('default')
  const [checkerStale, setCheckerStale] = useState(false)
  const [topMovers, setTopMovers] = useState<MoverRow[]>([])
  const symbols = items.map(i => i.symbol)
  const { rows, regime, lastUpdated, error } = useMarketData(symbols)
  const toasts = useAlerts(rows, regime, rules)

  useEffect(() => {
    db.watchlist.toArray().then(list => {
      setItems(list.map(i => ({ symbol: i.symbol, category: i.category })))
      if (list.length) mirrorConfig() // ensure the server sees pre-existing watchlists
    })
    db.rules.toArray().then(setRules)
    getRunlog()
      .then(log => {
        const last = log[log.length - 1]
        setCheckerStale(!!last && Date.now() / 1000 - last.at > 1200)
      })
      .catch(() => {})
    getMovers()
      .then(m => setTopMovers(m.gainers))
      .catch(() => {}) // fail-soft: home renders fine without the rail
  }, [])

  const categories = [...new Set(items.map(i => i.category).filter((c): c is string => !!c))]
  const visibleSymbols = categoryFilter === 'All' ? symbols : items.filter(i => i.category === categoryFilter).map(i => i.symbol)
  const sortedRows = rows
    .filter(r => visibleSymbols.includes(r.symbol))
    .sort((a, b) => {
      if (sortBy === 'change') return (b.quote?.changePct ?? -Infinity) - (a.quote?.changePct ?? -Infinity)
      if (sortBy === 'rvol') return (b.rvol ?? -Infinity) - (a.rvol ?? -Infinity)
      if (sortBy === 'setups') return b.setups.length - a.setups.length
      return 0
    })

  const add = async (symbol: string, category?: string) => {
    if (items.some(i => i.symbol === symbol) || items.length >= 30) return
    await db.watchlist.put({ symbol, addedAt: Date.now(), riskClass: 'normal', category })
    setItems(s => [...s, { symbol, category }])
    mirrorConfig()
  }

  const remove = async (symbol: string) => {
    await db.watchlist.delete(symbol)
    await db.rules.where('symbol').equals(symbol).delete()
    setItems(s => s.filter(x => x.symbol !== symbol))
    mirrorConfig()
  }

  if (!hasToken) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="logo">
            <svg width="26" height="26" viewBox="0 0 100 100">
              <polyline points="15,70 40,45 55,58 85,25" fill="none" stroke="var(--blue)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1>StreetSignal</h1>
          <p>Enter your licence key once. This device stays unlocked for life. Tip: the unlock link in your Telegram does this with one tap.</p>
          <form
            onSubmit={e => {
              e.preventDefault()
              const t = new FormData(e.currentTarget).get('t') as string
              if (t) {
                setToken(t.trim())
                setHasToken(true)
              }
            }}
          >
            <input name="t" type="password" placeholder="Licence key" autoComplete="off" />
            <button>Unlock</button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">
          Street<span className="tick">Signal</span>
        </span>
        <RegimeBanner regime={regime} />
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <div className="content">
        <AddTickerForm onAdd={add} disabled={symbols.length >= 30} categories={categories} />
        {checkerStale && <div className="risk-banner"><IconWarn /> The background alert checker hasn't run in 20+ minutes — alerts may be delayed.</div>}
        {topMovers.length > 0 && (
          <section className="home-movers">
            <h3 className="section-title">Top movers</h3>
            <div className="rail" aria-label="Top movers">
              {topMovers.slice(0, 8).map(r => (
                <MoverCard key={r.sym} r={r} onOpen={onOpen} />
              ))}
            </div>
          </section>
        )}
        {/* the engine board lives on ONE page — Signals; it was repeated here.
            Chips sit DIRECTLY above the grid they filter: with two market-wide
            sections wedged between, a tap looked like it did nothing. */}
        {categories.length > 0 && (
          <div className="sort-chips">
            {['All', ...categories].map(c => (
              <button key={c} className={categoryFilter === c ? 'active' : ''} onClick={() => setCategoryFilter(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        {rows.length > 1 && (
          <div className="sort-chips">
            {(['default', 'change', 'rvol', 'setups'] as const).map(k => (
              <button key={k} className={sortBy === k ? 'active' : ''} onClick={() => setSortBy(k)}>
                {k === 'default' ? 'A–Z' : k === 'change' ? '% chg' : k === 'rvol' ? 'RVOL' : 'Setups'}
              </button>
            ))}
          </div>
        )}
        {categoryFilter !== 'All' && (
          <p className="empty-line" style={{ margin: '2px 0 8px' }}>
            {sortedRows.length} of {rows.length} — {categoryFilter} · <button className="mini-btn ghost" style={{ fontSize: 11, padding: '0 6px' }} onClick={() => setCategoryFilter('All')}>show all</button>
          </p>
        )}
        <div className="card-grid">
          {sortedRows.map((row, i) => (
            <div key={row.symbol} onClick={() => onOpen(row.symbol)} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onOpen(row.symbol)} style={{ cursor: 'pointer' }}>
              <TickerRow
                row={row}
                index={i}
                onRemove={() => remove(row.symbol)}
              />
            </div>
          ))}
        </div>
        {rows.length === 0 && (
          <div className="empty">
            <p>Your watchlist is empty.</p>
            <p>
              Add US tickers plain (<code>AAPL</code>), LSE with suffix (<code>3LTS.L</code>), crypto with a dash (<code>BTC-USD</code>) — or start with the classics:
            </p>
            <button
              className="mini-btn"
              onClick={async () => {
                await seedStarterWatchlist(true)
                const list = await db.watchlist.toArray()
                setItems(list.map(i => ({ symbol: i.symbol, category: i.category })))
              }}
            >
              Load starter watchlist
            </button>
          </div>
        )}
        <footer className="foot">
          {error ? <span className="stale"><IconWarn size={12} /> {humanError(error)}</span> : lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : 'Loading…'}
          <br />
          Tap a ticker for charts, alerts and sizing. Data delayed up to ~2 min. Engine calls are calibrated analysis, not advice.
        </footer>
      </div>
      <Toasts toasts={toasts} />
    </>
  )
}
