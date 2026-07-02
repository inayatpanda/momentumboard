import { useEffect, useRef, useState } from 'react'
import type { RegimeColor } from '../../shared/types'
import { evaluateAlerts, emptyAlertState, type AlertState, type TickerSnapshot } from '../../shared/alerts'
import { isMarketOpen } from '../../shared/rvol'
import { exchangeFor } from '../../shared/symbols'
import { db, type RuleItem } from '../lib/db'
import type { Row } from '../components/TickerRow'

export interface Toast {
  id: string
  text: string
}

/** Runs the shared alert engine in-browser for instant toasts while the tab is open. */
export function useAlerts(rows: Row[], regime: RegimeColor | null, rules: RuleItem[]) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const stateRef = useRef<AlertState | null>(null)

  useEffect(() => {
    if (!rows.length || rows.every(r => !r.quote)) return
    let cancelled = false

    async function run() {
      if (!stateRef.current) {
        const saved = await db.settings.get('alertState')
        stateRef.current = saved ? (JSON.parse(saved.value) as AlertState) : emptyAlertState()
      }
      const nowSec = Math.floor(Date.now() / 1000)
      const first = stateRef.current.lastBatchAt === 0 && Object.keys(stateRef.current.lastSetups).length === 0
      const tickers: TickerSnapshot[] = rows.map(r => ({
        symbol: r.symbol,
        price: r.quote?.price ?? null,
        rvol: r.rvol,
        rsi: r.rsi ?? null,
        setups: r.setups,
        marketOpen: isMarketOpen(exchangeFor(r.symbol), nowSec),
      }))
      const { events, state } = evaluateAlerts(
        { rules, watchlist: rows.map(r => r.symbol) },
        { tickers, regime, news: [], videos: [], nowSec },
        stateRef.current,
      )
      state.queue = [] // client never sends digests; the server owns batching
      if (first) state.lastBatchAt = nowSec
      stateRef.current = state
      await db.settings.put({ key: 'alertState', value: JSON.stringify(state) })
      if (cancelled || first) return
      const instant = events.filter(e => e.tier === 'instant')
      if (instant.length) {
        setToasts(t => [...t, ...instant.map(e => ({ id: e.id, text: e.text }))])
        setTimeout(() => setToasts(t => t.filter(x => !instant.some(e => e.id === x.id))), 6000)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [rows, regime, rules])

  return toasts
}
