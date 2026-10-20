import type { VideoItem } from '../../../shared/alerts'
import { parseFeed } from './rss'

export interface ChannelDiscovery {
  id: string; name: string; checkedAt: number; status: 'ok' | 'unavailable'
  latestPublishedAt: number | null; recentVideos: number
}

/** Feed failures are distinct from a channel with no recent uploads. */
export async function discoverVideos(channels: { id: string; name: string }[], nowSec: number, fetchFn: typeof fetch = fetch, lookbackDays = 7) {
  const batches = await Promise.all(channels.map(async ch => {
    const check: ChannelDiscovery = { ...ch, checkedAt: nowSec, status: 'unavailable', latestPublishedAt: null, recentVideos: 0 }
    try {
      const res = await fetchFn(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (StreetSignal)' }, signal: AbortSignal.timeout(12_000),
      })
      if (!res.ok) return { check, videos: [] as VideoItem[] }
      const xml = await res.text()
      if (!/<feed[\s>]/.test(xml)) return { check, videos: [] as VideoItem[] }
      const entries = parseFeed(xml).filter(item => item.publishedSec > 0 && item.publishedSec <= nowSec)
      check.status = 'ok'
      check.latestPublishedAt = Math.max(0, ...entries.map(item => item.publishedSec)) || null
      const videos = entries.filter(item => nowSec - item.publishedSec < lookbackDays * 86400)
        .map(item => ({ title: item.title, url: item.url, channel: ch.name, channelId: ch.id, publishedAt: item.publishedSec }))
      check.recentVideos = videos.length
      return { check, videos }
    } catch { return { check, videos: [] as VideoItem[] } }
  }))
  return { videos: batches.flatMap(b => b.videos), channels: batches.map(b => b.check) }
}

export async function fetchVideos(channels: { id: string; name: string }[], nowSec: number, fetchFn: typeof fetch = fetch): Promise<VideoItem[]> {
  return (await discoverVideos(channels, nowSec, fetchFn)).videos
}
