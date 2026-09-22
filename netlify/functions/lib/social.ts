import { normaliseTradableMention } from '../../../shared/marketEntities'

// Unified social pulse: Reddit (via ApeWisdom aggregator), StockTwits trending,
// and our own YouTube channel consensus, combined per ticker. Cross-platform
// agreement is the signal; a single platform's noise is not.

export interface RedditTrend {
  ticker: string
  name: string
  rank: number
  mentions: number
  mentions24hAgo: number
  upvotes?: number
  rank24hAgo?: number | null
}

export interface SocialPulseRow {
  sym: string
  name?: string
  redditRank: number | null
  redditMentions: number | null
  redditUpvotes?: number | null
  redditRankDelta?: number | null
  redditEngagement?: number | null
  surging: boolean // mentions ≥2x vs 24h ago
  surgeMultiple: number | null
  stocktwits: boolean
  channelNet: number | null // bull-bear balance from YouTube consensus
  channelMentions?: number | null
  channelMentionsPrior?: number | null
  sources: number
  onWatchlist: boolean
  // Richer evidence is optional because an upstream source can be unavailable
  // without invalidating the base pulse row.
  channelBreadth?: number | null
  channelVelocity?: number | null
  channelHype?: number
  channelEvidence?: { channel: string; stance: 'bull' | 'bear' | 'neutral'; thesis?: string; levels: number[]; hype: boolean; at: number; url: string }[]
  evidenceScore?: number
  scanVelocity?: number | null
}

export async function fetchRedditTrends(fetchFn: typeof fetch = fetch): Promise<RedditTrend[]> {
  // Loud on failure: this used to return [] silently, so an ApeWisdom outage
  // was indistinguishable from a genuinely quiet market. The warn lines land in
  // the function/Actions log — the only place a degraded source can be seen.
  try {
    const res = await fetchFn('https://apewisdom.io/api/v1.0/filter/all-stocks/page/1', { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) {
      console.warn(`SOCIAL: apewisdom (reddit) HTTP ${res.status} — reddit sentiment missing this cycle`)
      return []
    }
    const j = (await res.json()) as { results?: { ticker: string; name: string; rank: number; mentions: number | string; mentions_24h_ago: number | string; upvotes?: number | string; rank_24h_ago?: number | string }[] }
    const rows = (j.results ?? []).slice(0, 30).map(r => ({
      ticker: r.ticker.toUpperCase(),
      name: r.name,
      rank: r.rank,
      mentions: Number(r.mentions) || 0,
      mentions24hAgo: Number(r.mentions_24h_ago) || 0,
      ...(r.upvotes != null ? { upvotes: Number(r.upvotes) || 0 } : {}),
      ...(r.rank_24h_ago != null ? { rank24hAgo: Number(r.rank_24h_ago) || null } : {}),
    }))
    if (!rows.length) console.warn('SOCIAL: apewisdom (reddit) returned 0 rows — reddit sentiment empty this cycle')
    return rows
  } catch (e) {
    console.warn(`SOCIAL: apewisdom (reddit) fetch failed: ${String(e).slice(0, 120)} — reddit sentiment missing this cycle`)
    return []
  }
}

export async function fetchStocktwitsTrending(fetchFn: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchFn('https://api.stocktwits.com/api/2/trending/symbols.json', { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) {
      console.warn(`SOCIAL: stocktwits trending HTTP ${res.status} — stocktwits signal missing this cycle`)
      return []
    }
    const j = (await res.json()) as { symbols?: { symbol: string }[] }
    return (j.symbols ?? []).map(s => s.symbol.toUpperCase()).slice(0, 30)
  } catch (e) {
    console.warn(`SOCIAL: stocktwits trending fetch failed: ${String(e).slice(0, 120)} — stocktwits signal missing this cycle`)
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

/** THE SOCIAL BOARD PRINTED "$1072.7B" BESIDE MU — a name worth roughly a tenth
 * of that. The cause sits upstream and is not always knowable (a provider
 * returning a figure in the wrong unit, a symbol collision with a foreign
 * listing, a cached profile for something else entirely), which is exactly why
 * the guard belongs at the door instead: a number nobody can believe must not be
 * typeset as a measurement. Unknown renders as the "·" empty state — and unknown
 * is the honest word for it.
 *
 * Two bounds, because "implausible" needs the name to mean anything:
 *  - NOBODY is worth $5T. Beyond that it is arithmetic, not a company.
 *  - The trillion-dollar club is a dozen names long and everybody knows who is in
 *    it. A trillion-dollar cap on a symbol outside it is far likelier to be a bad
 *    field than a surprise: MU at $1.07T sat inside the first bound and is the
 *    defect this exists for. Without a symbol only the hard bound applies.
 *
 * $M in, $M out; null for non-finite, non-positive or unbelievable. */
export const MAX_PLAUSIBLE_CAP_USD_M = 5_000_000 // $5T — nobody, ever
export const TRILLION_CAP_USD_M = 1_000_000 // $1T — and only for a name that could be

/** Who can credibly print a trillion-dollar market cap. Deliberately generous:
 * a name wrongly on this list only loses the guard, while a name wrongly off it
 * loses its cap cell — and the cell is not the paper's point. */
const TRILLION_CLUB = new Set([
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'AVGO', 'TSLA', 'BRK.A', 'BRK.B',
  'TSM', 'LLY', 'JPM', 'WMT', 'ORCL', 'V', 'MA', 'XOM', 'NVO', 'SPY', 'QQQ',
])

export function plausibleCapUsdM(capUsdM: number | null | undefined, sym?: string): number | null {
  if (typeof capUsdM !== 'number' || !Number.isFinite(capUsdM)) return null
  if (capUsdM <= 0 || capUsdM > MAX_PLAUSIBLE_CAP_USD_M) return null
  if (capUsdM >= TRILLION_CAP_USD_M && sym && !TRILLION_CLUB.has(sym.toUpperCase())) return null
  return capUsdM
}

export function combineSocialPulse(
  reddit: RedditTrend[],
  stocktwits: string[],
  channelConsensus: {
    sym: string; net: number; mentions7d?: number; mentionsPrior7d?: number; mentionVelocity?: number | null
    channels?: number; hypeCount?: number; evidence?: SocialPulseRow['channelEvidence']
  }[],
  watchlist: string[],
): SocialPulseRow[] {
  const bySym = new Map<string, SocialPulseRow>()
  const base = (sym: string): SocialPulseRow => ({
    sym,
    redditRank: null,
    redditMentions: null,
    redditUpvotes: null,
    redditRankDelta: null,
    redditEngagement: null,
    surging: false,
    surgeMultiple: null,
    stocktwits: false,
    channelNet: null,
    channelMentions: null,
    channelMentionsPrior: null,
    channelVelocity: null,
    channelBreadth: null,
    channelHype: 0,
    channelEvidence: [],
    evidenceScore: 0,
    sources: 0,
    onWatchlist: watchlist.some(w => normaliseTradableMention(w) === sym),
  })

  for (const r of reddit) {
    const sym = normaliseTradableMention(r.ticker)
    if (!sym) continue
    const row = bySym.get(sym) ?? base(sym)
    row.name = r.name
    row.redditRank = r.rank
    row.redditMentions = r.mentions
    row.redditUpvotes = r.upvotes ?? null
    row.redditRankDelta = r.rank24hAgo == null ? null : r.rank24hAgo - r.rank
    row.redditEngagement = r.mentions > 0 && r.upvotes != null ? Math.round((r.upvotes / r.mentions) * 10) / 10 : null
    row.surgeMultiple = r.mentions24hAgo > 0 ? Math.round((r.mentions / r.mentions24hAgo) * 10) / 10 : null
    row.surging = row.surgeMultiple != null && row.surgeMultiple >= 2
    row.sources++
    bySym.set(sym, row)
  }
  for (const raw of stocktwits) {
    const sym = normaliseTradableMention(raw)
    if (!sym) continue
    const row = bySym.get(sym) ?? base(sym)
    row.stocktwits = true
    row.sources++
    bySym.set(sym, row)
  }
  for (const c of channelConsensus) {
    const sym = normaliseTradableMention(c.sym)
    if (!sym) continue
    const row = bySym.get(sym) ?? base(sym)
    row.channelNet = c.net
    row.channelMentions = c.mentions7d ?? null
    row.channelMentionsPrior = c.mentionsPrior7d ?? null
    row.channelVelocity = c.mentionVelocity ?? null
    row.channelBreadth = c.channels ?? null
    row.channelHype = c.hypeCount ?? 0
    row.channelEvidence = c.evidence ?? []
    row.sources++
    bySym.set(sym, row)
  }

  for (const row of bySym.values()) {
    let score = row.sources * 18
    if ((row.surgeMultiple ?? 0) >= 2) score += Math.min(20, Math.round((row.surgeMultiple ?? 0) * 4))
    if ((row.redditRankDelta ?? 0) > 0) score += Math.min(12, row.redditRankDelta ?? 0)
    if ((row.redditEngagement ?? 0) >= 3) score += 8
    if ((row.channelBreadth ?? 0) >= 2) score += 10
    if ((row.channelVelocity ?? 0) >= 1.5) score += 8
    if ((row.channelHype ?? 0) > 0) score -= Math.min(15, (row.channelHype ?? 0) * 5)
    row.evidenceScore = Math.max(0, Math.min(100, score))
  }

  return [...bySym.values()]
    .sort((a, b) => (b.evidenceScore ?? 0) - (a.evidenceScore ?? 0) || (b.redditMentions ?? 0) - (a.redditMentions ?? 0))
    .slice(0, 15)
}
