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
    // Yahoo refused — fall back to Stooq EOD bars so the engine sees
    // yesterday's close instead of nothing. Shorter TTL: retry Yahoo soon.
    const { fetchStooqCandles } = await import('./stooq')
    const candles = await fetchStooqCandles(sym)
    if (candles) {
      console.log('CANDLES: yahoo failed, stooq fallback served', sym)
      await setCached(key, { candles }, 600)
      return candles
    }
    return null
  }
}

/** 5y bars exist ONLY for seasonality — the lib refuses to call a tendency
 * reliable under ~2 years, and the 1y cache can never satisfy that. Weekly TTL:
 * five years of history doesn't change overnight. */
export async function cachedCandles5y(sym: string): Promise<Candle[] | null> {
  const key = `candles:${sym}:5y`
  const hit = await getCached<{ candles: Candle[] }>(key)
  if (hit) return hit.candles
  try {
    const data = await fetchYahooChart(sym, '5y')
    await setCached(key, data, 7 * 86_400)
    return data.candles
  } catch {
    return null
  }
}

/** Market cap in $M — same `cap:` keys market-data already writes, so the two
 * paths share one cache. */
export async function cachedCapUsdM(sym: string, finnhubKey: string): Promise<number | null> {
  const key = `cap:${sym}`
  const hit = await getCached<{ capUsdM: number | null; name?: string }>(key)
  if (hit) return hit.capUsdM
  try {
    const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${finnhubKey}`)
    const j = (await res.json()) as { marketCapitalization?: number; name?: string }
    const cap = { capUsdM: j.marketCapitalization ?? null, name: j.name }
    await setCached(key, cap, 86_400)
    return cap.capUsdM
  } catch {
    return null
  }
}

/** Company display name from the same `cap:` cache profile2 already writes —
 * read-only, no dedicated network call (it rides along with cap lookups). Used
 * to match roster tickers against 13F issuer names; a cache miss just means that
 * name falls back to the alias map. */
export async function cachedCompanyName(sym: string): Promise<string | null> {
  const hit = await getCached<{ capUsdM: number | null; name?: string }>(`cap:${sym}`)
  return hit?.name ?? null
}
