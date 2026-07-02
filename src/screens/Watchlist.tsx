import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { getToken, setToken } from '../lib/api'
import { useMarketData } from '../hooks/useMarketData'
import { RegimeBanner } from '../components/RegimeBanner'
import { TickerRow } from '../components/TickerRow'
import { AddTickerForm } from '../components/AddTickerForm'
import { TabBar } from '../components/TabBar'

export function Watchlist() {
  const [symbols, setSymbols] = useState<string[]>([])
  const [hasToken, setHasToken] = useState(!!getToken())
  const { rows, regime, lastUpdated, error } = useMarketData(symbols)

  useEffect(() => {
    db.watchlist.toArray().then(items => setSymbols(items.map(i => i.symbol)))
  }, [])

  const add = async (symbol: string) => {
    if (symbols.includes(symbol) || symbols.length >= 30) return
    await db.watchlist.put({ symbol, addedAt: Date.now(), riskClass: 'normal' })
    setSymbols(s => [...s, symbol])
  }

  const remove = async (symbol: string) => {
    await db.watchlist.delete(symbol)
    setSymbols(s => s.filter(x => x !== symbol))
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
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          Momentum<span className="tick">Board</span>
        </span>
        <RegimeBanner regime={regime} />
      </header>
      <div className="content">
        <AddTickerForm onAdd={add} disabled={symbols.length >= 30} />
        {rows.map((row, i) => (
          <TickerRow key={row.symbol} row={row} index={i} onRemove={() => remove(row.symbol)} />
        ))}
        {rows.length === 0 && (
          <div className="empty">
            <p>Your watchlist is empty.</p>
            <p>
              Add US tickers plain (<code>AAPL</code>) and LSE with suffix (<code>3LTS.L</code>).
            </p>
          </div>
        )}
        <footer className="foot">
          {error ? <span className="stale">⚠ data stale: {error}</span> : lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : 'Loading…'}
          <br />
          Data delayed up to ~2 min. This app informs — it does not predict.
        </footer>
      </div>
      <TabBar active="watchlist" />
    </div>
  )
}
