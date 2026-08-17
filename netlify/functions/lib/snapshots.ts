// THE PER-SYMBOL SNAPSHOT, ASSEMBLED ONCE (2026-08-17).
//
// alert-check built this inline: for each of up to forty watchlist names, a
// `cachedQuote` and a `cachedCandles`, each of which is a store read. On
// Cloudflare every store read spends one of an invocation's FIFTY subrequests,
// so the loop cost eighty before the handler had computed anything — and 33 of
// 50 production runs ended on 'Too many subrequests', with the tail starved and
// two Telegram sends lost in eight hours.
//
// Two things changed, and only two: the cache is primed with ONE batched read
// (marketCache's `warmMarketCache`, a single `key IN (…)` select), and the code
// lives here so the five-minute alert loop and the quarter-hour tail job build
// their snapshots identically instead of drifting. A COLD symbol behaves exactly
// as it always did — fetch, cache, use — so this is a cost change, not a
// behaviour change.

import { cachedCandles, cachedQuote, warmMarketCache } from './marketCache'
import { rsi } from '../../../shared/indicators'
import { avgDailyVolume, isMarketOpen, relativeVolume, sessionElapsedFraction } from '../../../shared/rvol'
import { detectSetups } from '../../../shared/setups'
import { exchangeFor } from '../../../shared/symbols'
import type { TickerSnapshot } from '../../../shared/alerts'
import type { Candle, Quote } from '../../../shared/types'

export interface WarmMarketData {
  quotes: Map<string, Quote>
  candles: Map<string, Candle[]>
}

export interface BuildSnapshotsOptions {
  /** Names to prime in the same batched read without snapshotting them — the
   * benchmarks (SPY, QQQ) the caller reads straight out of `warm`. */
  alsoWarm?: string[]
  /** One symbol's failure is recorded and skipped, never fatal (the inline
   * version's own rule: `errors.push(...)`, return null). */
  onError?: (message: string) => void
}

export interface BuiltSnapshots {
  /** One row per symbol that could be read; a symbol that threw is absent. */
  snapshots: TickerSnapshot[]
  /** What the batched read actually returned, for callers with a second loop
   * over the same names (the intraday-flag candidates) — reusing it is the
   * difference between one read and sixty. */
  warm: WarmMarketData
}

export async function buildSnapshots(symbols: string[], finnhubKey: string, nowSec: number, opts: BuildSnapshotsOptions = {}): Promise<BuiltSnapshots> {
  const warm = await warmMarketCache([...symbols, ...(opts.alsoWarm ?? [])])
  const rows = await Promise.all(
    symbols.map(async (symbol): Promise<TickerSnapshot | null> => {
      try {
        const exchange = exchangeFor(symbol)
        const open = isMarketOpen(exchange, nowSec)
        // warm first, then the per-symbol path for whatever came back cold —
        // which fetches, caches and returns exactly as it always has
        const [quote, candles] = await Promise.all([warm.quotes.get(symbol) ?? cachedQuote(symbol, finnhubKey), warm.candles.get(symbol) ?? cachedCandles(symbol)])
        let rvol: number | null = null
        let rsiVal: number | null = null
        let setups: TickerSnapshot['setups'] = []
        if (candles && candles.length > 25) {
          const avg = avgDailyVolume(candles)
          const todayVol = quote?.todayVolume ?? candles[candles.length - 1].v
          if (avg) rvol = relativeVolume(todayVol, avg, sessionElapsedFraction(exchange, nowSec))
          const r = rsi(candles.map(c => c.c))
          rsiVal = r[r.length - 1]
          setups = detectSetups(candles, rvol)
        }
        return { symbol, price: quote?.price ?? null, changePct: quote?.changePct ?? null, rvol, rsi: rsiVal, setups, marketOpen: open }
      } catch (e) {
        opts.onError?.(`${symbol}: ${e}`)
        return null
      }
    }),
  )
  return { snapshots: rows.filter((s): s is TickerSnapshot => s !== null), warm }
}
