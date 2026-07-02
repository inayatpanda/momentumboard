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
      keepalive: true,
    }).catch(() => {/* offline is fine */})

    // full backup rides along: trades + rules + watchlist + settings → private Blobs
    const [rules, watchlist, settings] = await Promise.all([db.rules.toArray(), db.watchlist.toArray(), db.settings.toArray()])
    fetch('/api/backup', {
      method: 'PUT',
      headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
      body: JSON.stringify({ trades, rules, watchlist, settings }),
    }).catch(() => {/* offline is fine */})
  }, delayMs)
}

/** Pull the server backup and restore it into local IndexedDB (merge by id/key). */
export async function restoreBackup(): Promise<{ trades: number; at: number } | null> {
  const res = await fetch('/api/backup', { headers: { 'x-app-token': getToken() ?? '' } })
  const body = (await res.json()) as { ok: boolean; data?: { trades?: unknown[]; rules?: unknown[]; watchlist?: unknown[]; settings?: unknown[]; at: number } | null }
  if (!body.ok || !body.data) return null
  const d = body.data
  if (Array.isArray(d.trades)) await db.trades.bulkPut(d.trades as never[])
  if (Array.isArray(d.rules)) await db.rules.bulkPut(d.rules as never[])
  if (Array.isArray(d.watchlist)) await db.watchlist.bulkPut(d.watchlist as never[])
  if (Array.isArray(d.settings)) await db.settings.bulkPut(d.settings as never[])
  return { trades: d.trades?.length ?? 0, at: d.at }
}
