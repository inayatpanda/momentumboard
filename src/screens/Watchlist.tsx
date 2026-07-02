import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { getToken, setToken } from '../lib/api'
import { useMarketData } from '../hooks/useMarketData'
import { RegimeBanner } from '../components/RegimeBanner'
import { TickerRow } from '../components/TickerRow'
import { AddTickerForm } from '../components/AddTickerForm'

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
      <main style={{ padding: 16, maxWidth: 480, margin: '0 auto' }}>
        <h1>MomentumBoard</h1>
        <p style={{ color: 'var(--muted)' }}>Enter your app token (the APP_TOKEN you set in Netlify).</p>
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
          <input name="t" type="password" placeholder="App token" style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #2a3242', background: 'var(--panel)', color: 'var(--text)' }} />
          <button style={{ marginTop: 10, width: '100%', padding: 10, borderRadius: 8, border: 'none', background: 'var(--accent)', fontWeight: 600 }}>Save</button>
        </form>
      </main>
    )
  }

  return (
    <main style={{ padding: 16, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22 }}>MomentumBoard</h1>
      <RegimeBanner regime={regime} />
      <AddTickerForm onAdd={add} disabled={symbols.length >= 30} />
      {rows.map(row => (
        <TickerRow key={row.symbol} row={row} onRemove={() => remove(row.symbol)} />
      ))}
      {rows.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>Add a ticker to get started. US symbols plain (AAPL); LSE with suffix (3LTS.L).</p>
      )}
      <footer style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16 }}>
        {error ? `⚠ data stale: ${error}` : lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : 'Loading…'}
        {' · '}Data delayed up to ~2 min. This app informs — it does not predict.
      </footer>
    </main>
  )
}
