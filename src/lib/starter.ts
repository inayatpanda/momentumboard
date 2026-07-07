import { db } from './db'
import { mirrorConfig } from './configMirror'

// The starter watchlist: a first launch should show a market, not a blank
// page. Common liquid names, pre-categorised so the category chips appear
// immediately. Seeded ONCE — a user who later empties their list chose empty,
// so the localStorage flag stops the reseed; the empty-state button forces it.

export const STARTER_WATCHLIST: { symbol: string; category: string }[] = [
  { symbol: 'SPY', category: 'Index' },
  { symbol: 'QQQ', category: 'Index' },
  { symbol: 'AAPL', category: 'Megacap' },
  { symbol: 'MSFT', category: 'Megacap' },
  { symbol: 'NVDA', category: 'Chips' },
  { symbol: 'AMD', category: 'Chips' },
  { symbol: 'AMZN', category: 'Megacap' },
  { symbol: 'GOOGL', category: 'Megacap' },
  { symbol: 'META', category: 'Megacap' },
  { symbol: 'TSLA', category: 'Megacap' },
  { symbol: 'XOM', category: 'Energy' },
  { symbol: 'CEG', category: 'Energy' },
  { symbol: 'RR.L', category: 'UK' },
  { symbol: 'BTC-USD', category: 'Crypto' },
  { symbol: 'ETH-USD', category: 'Crypto' },
]

const FLAG = 'mb-starter-seeded'

/** Seed the starter list. Auto mode (force=false) runs only on a truly first
 * launch: empty local list, never seeded before — called AFTER the server
 * sync so an existing phone/desktop watchlist is never polluted. Returns
 * true when anything was added. */
export async function seedStarterWatchlist(force = false): Promise<boolean> {
  if (!force && localStorage.getItem(FLAG)) return false
  const existing = new Set((await db.watchlist.toArray()).map(i => i.symbol))
  if (!force && existing.size > 0) {
    localStorage.setItem(FLAG, '1') // synced list exists — never auto-seed over it
    return false
  }
  const missing = STARTER_WATCHLIST.filter(s => !existing.has(s.symbol)).slice(0, Math.max(0, 30 - existing.size))
  if (!missing.length) return false
  await db.watchlist.bulkPut(missing.map(s => ({ symbol: s.symbol, addedAt: Date.now(), riskClass: 'normal' as const, category: s.category })))
  localStorage.setItem(FLAG, '1')
  mirrorConfig()
  return true
}
