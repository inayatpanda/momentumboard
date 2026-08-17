import type { Candle, Quote } from '../../../shared/types'

/** EVERY range the chart endpoint will serve, with the bar size Yahoo gives it
 * at and how long the answer may be cached. A day of tape moves while you watch
 * it, a year of it does not — so the short ranges expire sooner.
 *
 * This is also the whitelist: `range` arrives from a query string and is
 * interpolated into the upstream URL, so anything not named here is refused
 * rather than forwarded (see {@link candleRange}). */
export const CANDLE_RANGES = {
  '1d': { interval: '5m', ttlSec: 300 },
  '5d': { interval: '15m', ttlSec: 600 },
  '1mo': { interval: '1d', ttlSec: 900 },
  '3mo': { interval: '1d', ttlSec: 900 },
  '6mo': { interval: '1d', ttlSec: 900 },
  '1y': { interval: '1d', ttlSec: 900 },
  // the engine's long read (seasonality counts SESSIONS) — daily bars, not weekly
  '5y': { interval: '1d', ttlSec: 900 },
} as const

export type ChartRange = keyof typeof CANDLE_RANGES

export const DEFAULT_CANDLE_RANGE: ChartRange = '1y'

/** `Object.keys`, not `in` — `'constructor' in CANDLE_RANGES` is true, and an
 * inherited key must not become a range. */
const RANGE_NAMES = new Set<string>(Object.keys(CANDLE_RANGES))

export const candleRange = (raw: string | null | undefined): ChartRange =>
  raw && RANGE_NAMES.has(raw) ? (raw as ChartRange) : DEFAULT_CANDLE_RANGE

/** 5m/15m/1h are bars WITHIN a session; 1d/1wk/1mo are sessions. */
const isIntradayInterval = (interval: string) => /^\d+(m|h)$/.test(interval)

export function parseYahooChart(json: unknown, symbol: string, interval?: string): { candles: Candle[]; quote: Quote } {
  const r = (json as any)?.chart?.result?.[0]
  const q = r?.indicators?.quote?.[0]
  if (!r?.meta || !Array.isArray(r?.timestamp) || !q) throw new Error('yahoo-shape')
  const candles: Candle[] = []
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i]
    if (c == null) continue
    candles.push({ t: r.timestamp[i], o: q.open[i] ?? c, h: q.high[i] ?? c, l: q.low[i] ?? c, c, v: q.volume[i] ?? 0 })
  }
  // Pre/post-market Yahoo appends a zero-volume placeholder bar whose OHLC all
  // mirror the last price — it corrupts prev-close, RVOL and indicators. Drop it.
  while (candles.length) {
    const lastBar = candles[candles.length - 1]
    if (lastBar.v === 0 && lastBar.o === lastBar.c && lastBar.h === lastBar.l) candles.pop()
    else break
  }
  const m = r.meta
  // chartPreviousClose is relative to the RANGE START (6mo ago on a 6mo chart),
  // not yesterday — derive the true previous close from the bars instead.
  const lastClose = candles.length ? candles[candles.length - 1].c : null
  // Tolerance, not equality: meta reports 197.58 while the bar holds 197.5800018…
  const lastBarIsCurrent = lastClose != null && Math.abs(lastClose - m.regularMarketPrice) <= Math.abs(m.regularMarketPrice) * 0.0005
  // …but on an INTRADAY series "the bar before the live one" is five minutes
  // ago, and a day's change measured against it reads +0.02% on a −3% day. On
  // those ranges Yahoo carries `previousClose` — the prior SESSION's close,
  // which is the frame the price change means — so use it and never the bars.
  // (`regularMarketPreviousClose` is a v7-quote field; v8 chart meta has no
  // such key, verified live 2026-08-17, so the ?? chain always fell through.)
  const intraday = isIntradayInterval(interval ?? String(m.dataGranularity ?? '1d'))
  const prev = intraday
    ? (m.previousClose ?? m.chartPreviousClose ?? lastClose)
    : (m.regularMarketPreviousClose ??
      (lastBarIsCurrent && candles.length >= 2
        ? candles[candles.length - 2].c
        : (lastClose ?? m.chartPreviousClose ?? m.previousClose)))
  return {
    candles,
    quote: {
      symbol,
      name: m.longName ?? m.shortName ?? undefined,
      price: m.regularMarketPrice,
      prevClose: prev,
      changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : 0,
      currency: m.currency ?? 'USD',
      todayVolume: m.regularMarketVolume ?? null,
      asOf: m.regularMarketTime ?? Math.floor(Date.now() / 1000),
      source: 'yahoo',
    },
  }
}

export async function fetchYahooChart(symbol: string, range: ChartRange, fetchFn: typeof fetch = fetch) {
  const { interval } = CANDLE_RANGES[range] ?? CANDLE_RANGES[DEFAULT_CANDLE_RANGE]
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`
  const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
  if (!res.ok) throw new Error(`yahoo-http-${res.status}`)
  return parseYahooChart(await res.json(), symbol, interval)
}
