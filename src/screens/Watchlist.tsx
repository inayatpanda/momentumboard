import { useCallback, useEffect, useRef, useState } from 'react'
import { db, type RuleItem } from '../lib/db'
import { getToken, setToken, putConfig } from '../lib/api'
import { useMarketData } from '../hooks/useMarketData'
import { useAlerts } from '../hooks/useAlerts'
import { RegimeBanner } from '../components/RegimeBanner'
import { TickerRow } from '../components/TickerRow'
import { AddTickerForm } from '../components/AddTickerForm'
import { AlertEditor } from '../components/AlertEditor'
import { TabBar } from '../components/TabBar'
import { Toasts } from '../components/Toasts'
import { DEFAULT_CHANNELS } from '../../shared/channels'

export function Watchlist() {
  const [symbols, setSymbols] = useState<string[]>([])
  const [rules, setRules] = useState<RuleItem[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [hasToken, setHasToken] = useState(!!getToken())
  const { rows, regime, lastUpdated, error } = useMarketData(symbols)
  const toasts = useAlerts(rows, regime, rules)
  const mirrorTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    db.watchlist.toArray().then(items => setSymbols(items.map(i => i.symbol)))
    db.rules.toArray().then(setRules)
  }, [])

  const mirror = useCallback(() => {
    clearTimeout(mirrorTimer.current)
    mirrorTimer.current = setTimeout(async () => {
      const [watch, ruleItems] = await Promise.all([db.watchlist.toArray(), db.rules.toArray()])
      putConfig({
        watchlist: watch.map(w => ({ symbol: w.symbol, riskClass: w.riskClass })),
        rules: ruleItems.map(({ id, symbol, kind, level }) => ({ id, symbol, kind, level })),
        ytChannels: DEFAULT_CHANNELS,
        capital: 5000,
      }).catch(() => {/* offline is fine; next change retries */})
    }, 1500)
  }, [])

  const add = async (symbol: string) => {
    if (symbols.includes(symbol) || symbols.length >= 30) return
    await db.watchlist.put({ symbol, addedAt: Date.now(), riskClass: 'normal' })
    setSymbols(s => [...s, symbol])
    mirror()
  }

  const remove = async (symbol: string) => {
    await db.watchlist.delete(symbol)
    await db.rules.where('symbol').equals(symbol).delete()
    setSymbols(s => s.filter(x => x !== symbol))
    setRules(r => r.filter(x => x.symbol !== symbol))
    mirror()
  }

  const saveRule = async (symbol: string, kind: 'priceAbove' | 'priceBelow', level: number) => {
    const existing = rules.find(r => r.symbol === symbol && r.kind === kind)
    const item: RuleItem = { id: existing?.id ?? `${symbol}-${kind}-${Date.now()}`, symbol, kind, level, createdAt: existing?.createdAt ?? Date.now() }
    await db.rules.put(item)
    setRules(r => [...r.filter(x => x.id !== item.id), item])
    mirror()
  }

  const deleteRule = async (id: string) => {
    await db.rules.delete(id)
    setRules(r => r.filter(x => x.id !== id))
    mirror()
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
          <div key={row.symbol} onClick={() => setExpanded(e => (e === row.symbol ? null : row.symbol))}>
            <TickerRow row={row} index={i} onRemove={() => remove(row.symbol)} />
            {expanded === row.symbol && (
              <div onClick={e => e.stopPropagation()}>
                <AlertEditor
                  symbol={row.symbol}
                  rules={rules.filter(r => r.symbol === row.symbol)}
                  onSave={(kind, level) => saveRule(row.symbol, kind, level)}
                  onDelete={deleteRule}
                />
              </div>
            )}
          </div>
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
          Tap a ticker to set price alerts. Data delayed up to ~2 min. This app informs — it does not predict.
        </footer>
      </div>
      <Toasts toasts={toasts} />
      <TabBar active="watchlist" />
    </div>
  )
}
