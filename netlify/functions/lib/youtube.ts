import type { VideoItem } from '../../shared/alerts'
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
          headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' },
        })
        if (!res.ok) return
        for (const item of parseFeed(await res.text()).slice(0, 5)) {
          if (nowSec - item.publishedSec < DAY) out.push({ title: item.title, url: item.url, channel: ch.name })
        }
      } catch {
        /* one dead channel must not kill the run */
      }
    }),
  )
  return out
}
