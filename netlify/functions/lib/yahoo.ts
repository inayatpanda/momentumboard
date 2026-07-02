import type { Candle, Quote } from '../../../shared/types'

export function parseYahooChart(json: unknown, symbol: string): { candles: Candle[]; quote: Quote } {
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
  const prev =
    m.regularMarketPreviousClose ??
    (lastBarIsCurrent && candles.length >= 2
      ? candles[candles.length - 2].c
      : (lastClose ?? m.chartPreviousClose ?? m.previousClose))
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

export async function fetchYahooChart(symbol: string, range: '3mo' | '6mo' | '1y', fetchFn: typeof fetch = fetch) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`
  const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
  if (!res.ok) throw new Error(`yahoo-http-${res.status}`)
  return parseYahooChart(await res.json(), symbol)
}
