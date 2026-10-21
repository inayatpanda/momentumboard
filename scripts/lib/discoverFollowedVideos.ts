import type { AppStore } from '../../netlify/functions/lib/storeProvider'
import { discoverVideos } from '../../netlify/functions/lib/youtube'
import { recordInboxVideos } from '../../netlify/functions/lib/videoTranscriptStore'
import { withDefaults } from '../../shared/channels'

/** Each cloud run discovers uploads independently of the app and the Mac. */
export async function discoverFollowedVideos(store: AppStore, now: number, fetchFn: typeof fetch = fetch, metadataKey = '') {
  const config = await store.read<{ ytChannels?: { id: string; name: string }[] }>('config')
  const found = await discoverVideos(withDefaults(config?.ytChannels), now, fetchFn, 30)
  // GitHub runners can be blocked from YouTube feeds. Official public upload
  // playlists cost one unit per channel, with no search or account OAuth.
  const unavailable = found.channels.filter(c => c.status !== 'ok')
  if (metadataKey && unavailable.length) {
    const get = async (path: string) => {
      const response = await fetchFn(`https://www.googleapis.com/youtube/v3/${path}`, {
        headers: { 'x-goog-api-key': metadataKey }, signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error('public-upload-list-unavailable')
      return response.json()
    }
    try {
      const channels = await get(`channels?part=contentDetails&id=${unavailable.map(c => encodeURIComponent(c.id)).join(',')}&maxResults=50`) as {
        items?: { id: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[]
      }
      for (const channel of unavailable) {
        const uploads = channels.items?.find(c => c.id === channel.id)?.contentDetails?.relatedPlaylists?.uploads
        if (!uploads) continue
        try {
          // Only the newest page is needed: selection remains last 24h, five/day.
          const data = await get(`playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=50`) as {
            items?: { snippet?: { title?: string }; contentDetails?: { videoId?: string; videoPublishedAt?: string } }[]
          }
          if (!Array.isArray(data.items)) continue
          const videos = data.items.flatMap(item => {
            const id = item.contentDetails?.videoId, title = item.snippet?.title
            const publishedAt = Date.parse(item.contentDetails?.videoPublishedAt ?? '') / 1000
            return id && /^[\w-]{11}$/.test(id) && title && publishedAt > 0 && publishedAt <= now
              ? [{ url: `https://www.youtube.com/watch?v=${id}`, title, publishedAt, channel: channel.name, channelId: channel.id }] : []
          })
          const recent = videos.filter(v => now - v.publishedAt < 30 * 86400)
          channel.status = 'ok'; channel.latestPublishedAt = Math.max(0, ...videos.map(v => v.publishedAt)) || null
          channel.recentVideos = recent.length; found.videos.push(...recent)
        } catch { /* Keep this channel unavailable; continue other channels. */ }
      }
    } catch { /* Failed metadata access never masquerades as a quiet channel. */ }
  }
  const added = await recordInboxVideos(store, found.videos, now)
  await store.write('video-channel-discovery:v1', { at: now, lookbackDays: 30, channels: found.channels })
  return { discovered: found.videos.length, added, checkedChannels: found.channels.length, unavailableChannels: found.channels.filter(c => c.status !== 'ok').length }
}
