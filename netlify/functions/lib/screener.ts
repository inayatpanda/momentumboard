// Yahoo's predefined screeners are the roster's discovery inflow. Everything
// here fails soft: a dead screener returns [] and the roster lives off the
// other sources that day.

export type ScreenKind = 'day_gainers' | 'day_losers' | 'most_actives' | 'small_cap_gainers'

export interface ScreenRow {
  sym: string
  price: number | null
  capUsdM: number | null
  changePct: number | null
  name: string | null
}

export function parseScreen(json: unknown, count = 25): ScreenRow[] {
  const quotes = (json as { finance?: { result?: { quotes?: unknown[] }[] } })?.finance?.result?.[0]?.quotes
  if (!Array.isArray(quotes)) return []
  return (quotes as { symbol?: string; regularMarketPrice?: number; marketCap?: number; regularMarketChangePercent?: number; shortName?: string }[])
    .filter(q => typeof q?.symbol === 'string' && /^[A-Z0-9.-]{1,10}$/i.test(q.symbol))
    .slice(0, count)
    .map(q => ({
      sym: q.symbol!.toUpperCase(),
      price: typeof q.regularMarketPrice === 'number' ? q.regularMarketPrice : null,
      capUsdM: typeof q.marketCap === 'number' ? Math.round(q.marketCap / 1e6) : null,
      changePct: typeof q.regularMarketChangePercent === 'number' ? Math.round(q.regularMarketChangePercent * 10) / 10 : null,
      name: typeof q.shortName === 'string' ? q.shortName : null,
    }))
}

/** `count` is the depth asked of Yahoo AND kept locally — the two must agree. */
export async function fetchScreen(kind: ScreenKind, fetchFn: typeof fetch = fetch, count = 25): Promise<ScreenRow[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${kind}&count=${count}&lang=en-US&region=US`
    const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return []
    return parseScreen(await res.json(), count)
  } catch {
    return []
  }
}

/** Crumb-free fallback discovery when the screeners are refusing service. */
export async function fetchTrending(fetchFn: typeof fetch = fetch): Promise<ScreenRow[]> {
  try {
    const res = await fetchFn('https://query1.finance.yahoo.com/v1/finance/trending/US?count=20', {
      headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' },
    })
    if (!res.ok) return []
    const json = (await res.json()) as { finance?: { result?: { quotes?: { symbol?: string }[] }[] } }
    return (json?.finance?.result?.[0]?.quotes ?? [])
      .filter(q => typeof q?.symbol === 'string' && /^[A-Z0-9.-]{1,10}$/i.test(q.symbol!))
      .slice(0, 20)
      .map(q => ({ sym: q.symbol!.toUpperCase(), price: null, capUsdM: null, changePct: null, name: null }))
  } catch {
    return []
  }
}
