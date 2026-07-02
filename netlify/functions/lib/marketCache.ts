import { fetchYahooChart } from './yahoo'
import { fetchFinnhubQuote } from './finnhub'
import { getCached, setCached } from './cache'
import { isYahooSymbol } from '../../../shared/symbols'
import type { Candle, Quote } from '../../../shared/types'

export async function cachedQuote(sym: string, finnhubKey: string): Promise<Quote | null> {
  const key = `quote:${sym}`
  const hit = await getCached<Quote>(key)
  if (hit) return hit
  try {
    const q = isYahooSymbol(sym) ? (await fetchYahooChart(sym, '3mo')).quote : await fetchFinnhubQuote(sym, finnhubKey)
    await setCached(key, q, 60)
    return q
  } catch {
    return null
  }
}

export async function cachedCandles(sym: string): Promise<Candle[] | null> {
  const key = `candles:${sym}:1y`
  const hit = await getCached<{ candles: Candle[] }>(key)
  if (hit) return hit.candles
  try {
    const data = await fetchYahooChart(sym, '1y')
    await setCached(key, data, 900)
    return data.candles
  } catch {
    return null
  }
}
