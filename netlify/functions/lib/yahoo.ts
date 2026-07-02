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
  const m = r.meta
  const prev = m.chartPreviousClose ?? m.previousClose
  return {
    candles,
    quote: {
      symbol,
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
