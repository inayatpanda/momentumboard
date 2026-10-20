import type { StreetVideo } from './api'
import { canonicalVideoUrl } from '../../shared/youtubeCaptions.mjs'

export function latestStreetVideos(videos: StreetVideo[]): StreetVideo[] {
  const unique = new Map<string, StreetVideo>()
  for (const video of [...videos].sort((a, b) => b.at - a.at)) {
    const key = canonicalVideoUrl(video.url) ?? video.url
    if (!unique.has(key)) unique.set(key, video)
  }
  return [...unique.values()]
}

export function filterStreetVideos(videos: StreetVideo[], channel: string, query: string, sourcedOnly: boolean) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return videos.filter(v => {
    if (channel && v.channel !== channel) return false
    if (sourcedOnly && (v.provenance === 'third-party' || v.provenance === 'manual'
      || !v.claims?.some(c => c.sourceMatch === 'matched' && c.identityMatched))) return false
    const text = [v.title, v.channel, ...v.themes, ...v.tickers.flatMap(t => [t.sym, t.company ?? ''])].join(' ').toLowerCase()
    return words.every(word => text.includes(word))
  })
}
