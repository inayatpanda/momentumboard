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

/** Company display name, fetch-on-miss. Resolution order: (1) the `cap:` cache
 * profile2 already writes; (2) Yahoo-routed symbols (LSE .L, crypto -USD): the
 * quote's own name — Yahoo carries shortName, Finnhub's quote doesn't; (3) US
 * symbols with a key: cachedCapUsdM's profile2 fetch, which caches the name as
 * a side effect. Resolved names merge back into `cap:` so every path warms the
 * same cache. Null = genuinely unresolvable; callers render without it. */
export async function cachedCompanyName(sym: string, finnhubKey = ''): Promise<string | null> {
  const key = `cap:${sym}`
  const hit = await getCached<{ capUsdM: number | null; name?: string }>(key)
  if (hit?.name) return hit.name
  try {
    if (isYahooSymbol(sym)) {
      const q = await cachedQuote(sym, finnhubKey)
      if (q?.name) {
        await setCached(key, { capUsdM: hit?.capUsdM ?? null, name: q.name }, 86_400)
        return q.name
      }
      return null
    }
    if (!finnhubKey) return null
    await cachedCapUsdM(sym, finnhubKey) // fetches profile2 and caches {capUsdM, name}
    const after = await getCached<{ capUsdM: number | null; name?: string }>(key)
    return after?.name ?? null
  } catch {
    return null
  }
}
