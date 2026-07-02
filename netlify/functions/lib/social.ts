// Unified social pulse: Reddit (via ApeWisdom aggregator), StockTwits trending,
// and our own YouTube channel consensus, combined per ticker. Cross-platform
// agreement is the signal; a single platform's noise is not.

export interface RedditTrend {
  ticker: string
  name: string
  rank: number
  mentions: number
  mentions24hAgo: number
}

export interface SocialPulseRow {
  sym: string
  name?: string
  redditRank: number | null
  redditMentions: number | null
  surging: boolean // mentions ≥2x vs 24h ago
  surgeMultiple: number | null
  stocktwits: boolean
  channelNet: number | null // bull-bear balance from YouTube consensus
  sources: number
  onWatchlist: boolean
}

export async function fetchRedditTrends(fetchFn: typeof fetch = fetch): Promise<RedditTrend[]> {
  try {
    const res = await fetchFn('https://apewisdom.io/api/v1.0/filter/all-stocks/page/1', { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return []
    const j = (await res.json()) as { results?: { ticker: string; name: string; rank: number; mentions: number | string; mentions_24h_ago: number | string }[] }
    return (j.results ?? []).slice(0, 30).map(r => ({
      ticker: r.ticker.toUpperCase(),
      name: r.name,
      rank: r.rank,
      mentions: Number(r.mentions) || 0,
      mentions24hAgo: Number(r.mentions_24h_ago) || 0,
    }))
  } catch {
    return []
  }
}

export async function fetchStocktwitsTrending(fetchFn: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchFn('https://api.stocktwits.com/api/2/trending/symbols.json', { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return []
    const j = (await res.json()) as { symbols?: { symbol: string }[] }
    return (j.symbols ?? []).map(s => s.symbol.toUpperCase()).slice(0, 30)
  } catch {
    return []
  }
}

// Household mega-caps: already on every screen; chatter about them is noise here.
const MEGA = new Set(['AAPL', 'MSFT', 'NVDA', 'META', 'GOOGL', 'GOOG', 'AMZN', 'TSLA', 'AVGO', 'BRK.B', 'BRK.A', 'JPM', 'V', 'MA', 'LLY', 'UNH', 'MU', 'AMD', 'NFLX', 'COST', 'WMT', 'XOM', 'ORCL', 'PLTR', 'COIN', 'INTC', 'BA', 'DIS', 'SPY', 'QQQ'])

export interface Discovery extends SocialPulseRow {
  capUsdM: number | null // market cap in $ millions (Finnhub), null if unknown
  companyName?: string
  surgeMultiple: number | null
  opinion?: string // the analyst's take, attached at the endpoint layer
}

/** The up-and-comers: NOT household names, with real momentum in the chatter.
 * capUsdM null is allowed (tiny names often lack data) but MEGA names never pass. */
export function pickDiscoveries(
  rows: (SocialPulseRow & { capUsdM?: number | null; companyName?: string; surgeMultiple?: number | null })[],
  maxCapUsdM = 20_000,
  count = 3,
): Discovery[] {
  return rows
    .filter(r => !MEGA.has(r.sym))
    .filter(r => r.capUsdM == null || r.capUsdM <= maxCapUsdM)
    .filter(r => r.surging || r.sources >= 2)
    .map(r => ({ ...r, capUsdM: r.capUsdM ?? null, surgeMultiple: r.surgeMultiple ?? null }))
    .sort((a, b) => (b.surgeMultiple ?? 1) - (a.surgeMultiple ?? 1) || b.sources - a.sources)
    .slice(0, count)
}

export const isMega = (sym: string) => MEGA.has(sym)

export function combineSocialPulse(
  reddit: RedditTrend[],
  stocktwits: string[],
  channelConsensus: { sym: string; net: number }[],
  watchlist: string[],
): SocialPulseRow[] {
  const bySym = new Map<string, SocialPulseRow>()
  const base = (sym: string): SocialPulseRow => ({
    sym,
    redditRank: null,
    redditMentions: null,
    surging: false,
    surgeMultiple: null,
    stocktwits: false,
    channelNet: null,
    sources: 0,
    onWatchlist: watchlist.some(w => w.split('.')[0].split('-')[0] === sym),
  })

  for (const r of reddit) {
    const row = bySym.get(r.ticker) ?? base(r.ticker)
    row.name = r.name
    row.redditRank = r.rank
    row.redditMentions = r.mentions
    row.surgeMultiple = r.mentions24hAgo > 0 ? Math.round((r.mentions / r.mentions24hAgo) * 10) / 10 : null
    row.surging = row.surgeMultiple != null && row.surgeMultiple >= 2
    row.sources++
    bySym.set(r.ticker, row)
  }
  for (const sym of stocktwits) {
    const row = bySym.get(sym) ?? base(sym)
    row.stocktwits = true
    row.sources++
    bySym.set(sym, row)
  }
  for (const c of channelConsensus) {
    const sym = c.sym.split('.')[0].split('-')[0]
    const row = bySym.get(sym) ?? base(sym)
    row.channelNet = c.net
    row.sources++
    bySym.set(sym, row)
  }

  return [...bySym.values()]
    .sort((a, b) => b.sources - a.sources || (b.redditMentions ?? 0) - (a.redditMentions ?? 0))
    .slice(0, 15)
}
