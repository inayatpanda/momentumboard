import type { SocialHistoryPoint } from '../../../shared/engine/strategyLab'
import type { VideoExtract } from './videoTrends'

export interface SocialMemoryVideo {
  at: number
  title: string
  channel: string
  url: string
  stance: 'bull' | 'bear' | 'neutral'
  thesis?: string
  levels: number[]
  hype: boolean
}

export interface SocialMemoryDay {
  date: string
  observedAt: number
  summary: string
  metrics: {
    sources: number
    redditRank: number | null
    redditMentions: number | null
    redditUpvotes: number | null
    surgeMultiple: number | null
    stocktwits: boolean
    channelNet: number | null
    channelMentions: number | null
    channelBreadth: number | null
    evidenceScore: number | null
  }
  youtube: SocialMemoryVideo[]
}

const canonical = (symbol: string) => symbol.toUpperCase().split('.')[0].split('-')[0]
const isoDay = (at: number) => new Date(at * 1000).toISOString().slice(0, 10)

function summaryFor(day: SocialMemoryDay): string {
  const parts: string[] = []
  const m = day.metrics
  if (m.redditMentions != null) parts.push(`Reddit recorded ${m.redditMentions} mention${m.redditMentions === 1 ? '' : 's'}${m.redditRank != null ? ` at rank #${m.redditRank}` : ''}${m.surgeMultiple != null ? ` (${m.surgeMultiple}× versus 24 hours earlier)` : ''}.`)
  if (m.stocktwits) parts.push('The ticker was also trending on Stocktwits.')
  if (day.youtube.length) {
    const bulls = day.youtube.filter(v => v.stance === 'bull').length
    const bears = day.youtube.filter(v => v.stance === 'bear').length
    const neutral = day.youtube.length - bulls - bears
    const stance = bulls === bears ? 'split' : bulls > bears ? 'net bullish' : 'net bearish'
    const creators = [...new Set(day.youtube.map(v => v.channel))]
    parts.push(`YouTube had ${day.youtube.length} dated mention${day.youtube.length === 1 ? '' : 's'} across ${creators.length} creator${creators.length === 1 ? '' : 's'}; the read was ${stance} (${bulls} bull, ${bears} bear${neutral ? `, ${neutral} neutral` : ''}).`)
    const theses = day.youtube.map(v => v.thesis).filter((v): v is string => Boolean(v)).slice(0, 2)
    if (theses.length) parts.push(`Main claims: ${theses.join(' · ')}`)
    if (day.youtube.some(v => v.hype)) parts.push('At least one mention carried a promotion/hype flag.')
  }
  if (!parts.length) parts.push(`StreetSignal observed the ticker across ${m.sources} social source${m.sources === 1 ? '' : 's'}, but the older snapshot did not retain source-level detail.`)
  return parts.join(' ')
}

export function buildSocialMemory(symbol: string, history: SocialHistoryPoint[], extracts: VideoExtract[]): SocialMemoryDay[] {
  const sym = canonical(symbol)
  const byDate = new Map<string, SocialMemoryDay>()
  for (const point of history) {
    const row = point.rows?.find(candidate => canonical(candidate.sym) === sym)
    if (!row) continue
    const date = isoDay(point.observedAt)
    const previous = byDate.get(date)
    if (previous && previous.observedAt > point.observedAt) continue
    byDate.set(date, {
      date,
      observedAt: point.observedAt,
      summary: '',
      metrics: {
        sources: row.sources ?? 0,
        redditRank: row.redditRank ?? null,
        redditMentions: row.redditMentions ?? null,
        redditUpvotes: row.redditUpvotes ?? null,
        surgeMultiple: row.surgeMultiple ?? null,
        stocktwits: Boolean(row.stocktwits),
        channelNet: row.channelNet ?? null,
        channelMentions: row.channelMentions ?? null,
        channelBreadth: row.channelBreadth ?? null,
        evidenceScore: row.evidenceScore ?? null,
      },
      youtube: previous?.youtube ?? [],
    })
  }
  for (const extract of extracts) {
    const ticker = extract.tickers?.find(candidate => canonical(candidate.sym) === sym)
    if (!ticker) continue
    const date = isoDay(extract.at)
    const day = byDate.get(date) ?? {
      date,
      observedAt: extract.at,
      summary: '',
      metrics: { sources: 1, redditRank: null, redditMentions: null, redditUpvotes: null, surgeMultiple: null, stocktwits: false, channelNet: null, channelMentions: null, channelBreadth: null, evidenceScore: null },
      youtube: [],
    }
    day.observedAt = Math.max(day.observedAt, extract.at)
    day.youtube.push({ at: extract.at, title: extract.title, channel: extract.channel, url: extract.url, stance: ticker.stance, thesis: ticker.thesis, levels: ticker.levels ?? [], hype: Boolean(ticker.hype) })
    byDate.set(date, day)
  }
  return [...byDate.values()]
    .map(day => ({ ...day, youtube: day.youtube.sort((a, b) => b.at - a.at), summary: summaryFor(day) }))
    .sort((a, b) => b.observedAt - a.observedAt)
    .slice(0, 90)
}
