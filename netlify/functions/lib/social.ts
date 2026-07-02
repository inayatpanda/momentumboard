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
    row.surging = r.mentions24hAgo > 0 && r.mentions >= 2 * r.mentions24hAgo
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
