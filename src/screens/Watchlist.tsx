import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { getToken, setToken, getRunlog } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { useMarketData } from '../hooks/useMarketData'
import { useAlerts } from '../hooks/useAlerts'
import type { RuleItem } from '../lib/db'
import { RegimeBanner } from '../components/RegimeBanner'
import { TickerRow } from '../components/TickerRow'
import { AddTickerForm } from '../components/AddTickerForm'
import { Toasts } from '../components/Toasts'

export function Watchlist({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [symbols, setSymbols] = useState<string[]>([])
  const [rules, setRules] = useState<RuleItem[]>([])
  const [hasToken, setHasToken] = useState(!!getToken())
  const [sortBy, setSortBy] = useState<'default' | 'change' | 'rvol' | 'setups'>('default')
  const [checkerStale, setCheckerStale] = useState(false)
  const { rows, regime, lastUpdated, error } = useMarketData(symbols)
  const toasts = useAlerts(rows, regime, rules)

  useEffect(() => {
    db.watchlist.toArray().then(items => {
      setSymbols(items.map(i => i.symbol))
      if (items.length) mirrorConfig() // ensure the server sees pre-existing watchlists
    })
    db.rules.toArray().then(setRules)
    getRunlog()
      .then(log => {
        const last = log[log.length - 1]
        setCheckerStale(!!last && Date.now() / 1000 - last.at > 1200)
      })
      .catch(() => {})
  }, [])

  const sortedRows = [...rows].sort((a, b) => {
    if (sortBy === 'change') return (b.quote?.changePct ?? -Infinity) - (a.quote?.changePct ?? -Infinity)
    if (sortBy === 'rvol') return (b.rvol ?? -Infinity) - (a.rvol ?? -Infinity)
    if (sortBy === 'setups') return b.setups.length - a.setups.length
    return 0
  })

  const add = async (symbol: string) => {
    if (symbols.includes(symbol) || symbols.length >= 30) return
    await db.watchlist.put({ symbol, addedAt: Date.now(), riskClass: 'normal' })
    setSymbols(s => [...s, symbol])
    mirrorConfig()
  }

  const remove = async (symbol: string) => {
    await db.watchlist.delete(symbol)
    await db.rules.where('symbol').equals(symbol).delete()
    setSymbols(s => s.filter(x => x !== symbol))
    mirrorConfig()
  }

  if (!hasToken) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="logo">
            <svg width="26" height="26" viewBox="0 0 100 100">
              <polyline points="15,70 40,45 55,58 85,25" fill="none" stroke="var(--green)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1>MomentumBoard</h1>
          <p>Enter your app token — the APP_TOKEN value from your Netlify environment.</p>
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
            <input name="t" type="password" placeholder="App token" autoComplete="off" />
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
          Momentum<span className="tick">Board</span>
        </span>
        <RegimeBanner regime={regime} />
      </header>
      <div className="content">
        <AddTickerForm onAdd={add} disabled={symbols.length >= 30} />
        {rows.length > 1 && (
          <div className="sort-chips">
            {(['default', 'change', 'rvol', 'setups'] as const).map(k => (
              <button key={k} className={sortBy === k ? 'active' : ''} onClick={() => setSortBy(k)}>
                {k === 'default' ? 'A–Z' : k === 'change' ? '% chg' : k === 'rvol' ? 'RVOL' : 'Setups'}
              </button>
            ))}
          </div>
        )}
        {checkerStale && <div className="risk-banner">⚠ The background alert checker hasn't run in 20+ minutes — alerts may be delayed.</div>}
        {sortedRows.map((row, i) => (
          <div key={row.symbol} onClick={() => onOpen(row.symbol)} role="button" style={{ cursor: 'pointer' }}>
            <TickerRow
              row={row}
              index={i}
              onRemove={() => remove(row.symbol)}
            />
          </div>
        ))}
        {rows.length === 0 && (
          <div className="empty">
            <p>Your watchlist is empty.</p>
            <p>
              Add US tickers plain (<code>AAPL</code>), LSE with suffix (<code>3LTS.L</code>), crypto with a dash (<code>BTC-USD</code>).
            </p>
          </div>
        )}
        <footer className="foot">
          {error ? <span className="stale">⚠ data stale: {error}</span> : lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : 'Loading…'}
          <br />
          Tap a ticker for charts, alerts and sizing. Data delayed up to ~2 min. This app informs — it does not predict.
        </footer>
      </div>
      <Toasts toasts={toasts} />
    </>
  )
}
