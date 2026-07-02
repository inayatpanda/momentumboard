import { db, getCapital } from './db'
import { getToken } from './api'
import { computeStats, exposureWarnings, tradePnl } from '../../shared/journal'

let timer: ReturnType<typeof setTimeout> | undefined

/** Debounced push of a journal-derived snapshot to /api/portfolio — this is what
 * makes the morning research routine aware of what the user actually holds. */
export function mirrorPortfolio(delayMs = 1500) {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const [trades, capital] = await Promise.all([db.trades.toArray(), getCapital()])
    const open = trades.filter(t => t.exitPrice == null)
    const closed = trades
      .filter(t => t.exitPrice != null)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, 10)
    const snapshot = {
      capital,
      openPositions: open.map(t => ({
        symbol: t.symbol, direction: t.direction, instrument: t.instrument, leverage: t.leverage,
        playbook: t.playbook, entryPrice: t.entryPrice, stop: t.stop, units: t.units,
        positionValue: t.positionValue, openedAt: t.openedAt, fromSuggestion: t.fromSuggestion, thesis: t.thesis,
      })),
      recentClosed: closed.map(t => ({
        symbol: t.symbol, playbook: t.playbook, pnl: tradePnl(t), openedAt: t.openedAt,
        closedAt: t.closedAt, fromSuggestion: t.fromSuggestion,
      })),
      stats: computeStats(trades),
      warnings: exposureWarnings(open, capital, Math.floor(Date.now() / 1000)).map(w => w.message),
    }
    fetch('/api/portfolio', {
      method: 'PUT',
      headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    }).catch(() => {/* offline is fine */})
  }, delayMs)
}
