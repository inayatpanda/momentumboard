// Trading 212 read-only portfolio fetch, extracted so BOTH the /api/t212 route
// and the daily engine run can reuse it. We never place orders — portfolio reads
// only. The key(s) live ONLY in Netlify env vars.

export interface T212Position {
  symbol: string // normalized: AAPL_US_EQ → AAPL
  rawTicker: string
  quantity: number
  averagePrice: number
  currentPrice: number
  pplPct: number | null
}

export interface T212Env {
  T212_API_KEY?: string
  T212_SECRET_KEY?: string
  T212_HOST?: string
}

export function normalizeT212Ticker(t: string): string {
  // AAPL_US_EQ → AAPL; 3LTSl_EQ style LSE tickers → 3LTS.L (T212 marks LSE with lowercase l suffix)
  const base = t.split('_')[0]
  return base.endsWith('l') && base.length > 1 && base.slice(0, -1) === base.slice(0, -1).toUpperCase()
    ? `${base.slice(0, -1)}.L`
    : base.toUpperCase()
}

// T212's current credentials are a pair; Basic auth is secret:apiKey (verified
// live 2026-07-02). Legacy single-key accounts still send the key bare. Returns
// null when there is no API key at all (T212 not configured).
export function t212AuthHeader(env: T212Env): string | null {
  const apiKey = env.T212_API_KEY
  if (!apiKey) return null
  const secret = env.T212_SECRET_KEY
  return secret ? `Basic ${Buffer.from(`${secret}:${apiKey}`).toString('base64')}` : apiKey
}

// Fetch + normalize the live portfolio. Returns null on ANY failure (no key,
// non-2xx, network/parse error) so every caller can treat it fail-soft.
export async function fetchT212Positions(env: T212Env, fetchFn: typeof fetch = fetch): Promise<T212Position[] | null> {
  const authHeader = t212AuthHeader(env)
  if (!authHeader) return null
  try {
    const host = env.T212_HOST ?? 'https://live.trading212.com'
    const res = await fetchFn(`${host}/api/v0/equity/portfolio`, { headers: { Authorization: authHeader } })
    if (!res.ok) return null
    const raw = (await res.json()) as { ticker: string; quantity: number; averagePrice: number; currentPrice: number; ppl: number }[]
    if (!Array.isArray(raw)) return null
    return raw.map(p => ({
      symbol: normalizeT212Ticker(p.ticker),
      rawTicker: p.ticker,
      quantity: p.quantity,
      averagePrice: p.averagePrice,
      currentPrice: p.currentPrice,
      pplPct: p.averagePrice > 0 ? Math.round(((p.currentPrice - p.averagePrice) / p.averagePrice) * 1000) / 10 : null,
    }))
  } catch {
    return null
  }
}
