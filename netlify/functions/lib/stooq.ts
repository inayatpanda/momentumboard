import type { Candle } from '../../../shared/types'

// Stooq: the fallback daily-bar source for when Yahoo refuses service. Free,
// stable CSV, EOD only — good enough to keep the engine seeing yesterday's
// close instead of nothing. Timestamps are UTC midnight of the session date;
// the engine's maths works off close arrays and >=date lookups, so the
// coarser stamps are safe.

/** Quote currencies / crypto counters. A dash followed by one of these is a
 * PAIR (SOL-USD, ETH-BTC) and Stooq has no reliable mapping for it; a dash
 * followed by anything else is a US share class — Yahoo writes Berkshire's B
 * line as `BRK-B` and Brown-Forman's as `BF-B`, and Stooq writes both exactly
 * the same way. Refusing every dash meant the two biggest names in the S&P that
 * carry one could never reach the fallback at all. */
const PAIR_COUNTERS = new Set(['USD', 'USDT', 'USDC', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'BTC', 'ETH'])

export function stooqSymbol(sym: string): string | null {
  const s = sym.toUpperCase()
  if (s.startsWith('^') || s.includes('=')) return null // indices & futures stay Yahoo-only
  if (s.endsWith('.L')) return `${s.slice(0, -2).toLowerCase()}.uk`
  if (s === 'BTC-USD') return 'btcusd'
  if (s === 'ETH-USD') return 'ethusd'
  if (s.includes('-')) {
    const parts = s.split('-')
    // one dash only, and the tail must not be a currency: BRK-B yes, SOL-USD no
    if (parts.length !== 2 || !parts[0] || !parts[1] || PAIR_COUNTERS.has(parts[1])) return null
  }
  if (/^[A-Z0-9.-]{1,10}$/.test(s)) return `${s.toLowerCase().replace(/\./g, '-')}.us` // BRK.B and BRK-B → brk-b.us
  return null
}

export function parseStooqCsv(csv: string, maxRows = 300): Candle[] {
  const lines = csv.trim().split('\n')
  if (lines.length < 2 || !lines[0].toLowerCase().startsWith('date')) return []
  const out: Candle[] = []
  for (const line of lines.slice(1)) {
    const [d, o, h, l, c, v] = line.split(',')
    const t = Date.parse(`${d}T00:00:00Z`) / 1000
    const candle = { t, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v || 0) }
    if (Number.isFinite(t) && Number.isFinite(candle.c) && candle.c > 0) out.push(candle)
  }
  return out.slice(-maxRows)
}

export async function fetchStooqCandles(sym: string, fetchFn: typeof fetch = fetch): Promise<Candle[] | null> {
  const code = stooqSymbol(sym)
  if (!code) return null
  try {
    const res = await fetchFn(`https://stooq.com/q/d/l/?s=${encodeURIComponent(code)}&i=d`, { headers: { 'user-agent': 'Mozilla/5.0 (StreetSignal fallback)' } })
    if (!res.ok) return null
    const candles = parseStooqCsv(await res.text())
    return candles.length >= 30 ? candles : null
  } catch {
    return null
  }
}
