import type { VideoItem } from '../../../shared/alerts'
import { parseFeed } from './rss'

export async function fetchVideos(
  channels: { id: string; name: string }[],
  nowSec: number,
  fetchFn: typeof fetch = fetch,
): Promise<VideoItem[]> {
  const DAY = 24 * 3600
  const out: VideoItem[] = []
  await Promise.all(
    channels.map(async ch => {
      try {
        const res = await fetchFn(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' }, signal: AbortSignal.timeout(12_000),
        })
        if (!res.ok) return
        // Read the full recent feed. Limiting this to five silently missed
        // uploads from busy channels between polling runs.
        for (const item of parseFeed(await res.text())) {
          if (item.publishedSec > 0 && item.publishedSec <= nowSec && nowSec - item.publishedSec < 7 * DAY) out.push({ title: item.title, url: item.url, channel: ch.name, channelId: ch.id, publishedAt: item.publishedSec })
        }
      } catch {
        /* one dead channel must not kill the run */
      }
    }),
  )
  return out
}
