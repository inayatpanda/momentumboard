import { fetchYahooChart } from './yahoo'
import { fetchFinnhubQuote } from './finnhub'
import { getCached, getCachedMany, setCached } from './cache'
import { isYahooSymbol } from '../../../shared/symbols'
import type { Candle, Quote } from '../../../shared/types'
import type { ValuationCapitalization } from '../../../shared/sectorFinancials'

/** Separate dated valuation cache: old, undated screener caps are insufficient.
 * Reuses the existing free profile endpoint; never starts a paid data request. */
export async function cachedValuationCapitalization(sym: string, key: string): Promise<ValuationCapitalization | null> {
  if (!key || isYahooSymbol(sym)) return null
  const cacheKey = `valuation-cap:v1:${sym}`
  const hit = await getCached<ValuationCapitalization>(cacheKey)
  if (hit) return hit
  try {
    const response = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const profile = await response.json() as { ticker?: string; currency?: string; marketCapitalization?: number }
    if (profile.ticker?.toUpperCase() !== sym.toUpperCase() || profile.currency !== 'USD' || !Number.isFinite(profile.marketCapitalization) || profile.marketCapitalization! <= 0) return null
    const value: ValuationCapitalization = { sym, marketCapUsdM: profile.marketCapitalization!, currency: 'USD', source: 'finnhub-profile', observedAt: Math.floor(Date.now() / 1000) }
    await setCached(cacheKey, value, 6 * 3600)
    return value
  } catch { return null }
}

/** Every quote and candle series a symbol loop is about to ask for, in ONE
 * batched cache read (lib/cache.ts's `getCachedMany`).
 *
 * WHY IT EXISTS. `cachedQuote` and `cachedCandles` each cost a store read, so a
 * forty-name sweep spent eighty subrequests out of an invocation's fifty before
 * it had computed anything — 33 of 50 production alert-check runs died on 'Too
 * many subrequests'. The caller primes with this and then falls back to the
 * per-symbol functions for whatever came back cold, so a miss behaves exactly as
 * it always did (fetch, cache, use) and a hit costs a fraction of a read.
 *
 * Keys are the ones those two functions write, spelled once here so they cannot
 * drift apart. Absent = cold, never a null entry. */
export async function warmMarketCache(symbols: string[]): Promise<{ quotes: Map<string, Quote>; candles: Map<string, Candle[]> }> {
  const quotes = new Map<string, Quote>()
  const candles = new Map<string, Candle[]>()
  const syms = [...new Set(symbols.filter(s => typeof s === 'string' && s.length > 0))]
  if (!syms.length) return { quotes, candles }
  const rows = await getCachedMany<unknown>([...syms.map(s => `quote:${s}`), ...syms.map(s => `candles:${s}:1y`)])
  for (const sym of syms) {
    const q = rows.get(`quote:${sym}`) as Quote | undefined
    if (q) quotes.set(sym, q)
    const c = rows.get(`candles:${sym}:1y`) as { candles?: Candle[] } | undefined
    if (Array.isArray(c?.candles)) candles.set(sym, c.candles)
  }
  return { quotes, candles }
}

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
  const hit = await getCached<{ capUsdM: number | null; name?: string; industry?: string }>(key)
  if (hit) return hit.capUsdM
  try {
    const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${finnhubKey}`)
    const j = (await res.json()) as { marketCapitalization?: number; name?: string; finnhubIndustry?: string }
    const cap = { capUsdM: j.marketCapitalization ?? null, name: j.name, industry: j.finnhubIndustry }
    await setCached(key, cap, 86_400)
    return cap.capUsdM
  } catch {
    return null
  }
}

/** Finnhub industry classification (e.g. "Semiconductors"), sharing the `cap:`
 * cache blob. Older cached entries lack `industry` — one profile2 re-fetch
 * upgrades them in place. Null = unresolvable (Yahoo-routed, no key, unknown). */
export async function cachedIndustry(sym: string, finnhubKey: string): Promise<string | null> {
  const key = `cap:${sym}`
  const hit = await getCached<{ capUsdM: number | null; name?: string; industry?: string }>(key)
  if (hit?.industry) return hit.industry
  if (!finnhubKey || isYahooSymbol(sym)) return null
  try {
    const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${finnhubKey}`)
    const j = (await res.json()) as { marketCapitalization?: number; name?: string; finnhubIndustry?: string }
    if (!j.finnhubIndustry) return null
    await setCached(key, { capUsdM: j.marketCapitalization ?? hit?.capUsdM ?? null, name: j.name ?? hit?.name, industry: j.finnhubIndustry }, 86_400)
    return j.finnhubIndustry
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
