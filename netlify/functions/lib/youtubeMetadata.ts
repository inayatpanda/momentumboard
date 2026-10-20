import type { AppStore } from './storeProvider'
import type { YouTubeAvailability } from './youtubeAvailability'
import { videoKey } from '../../../shared/youtubeCaptions.mjs'

export function parseVideoDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value)
  if (!match) return
  const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/** Public metadata only. No account OAuth, transcript service or paid fallback. */
export async function publicVideoMetadata(store: AppStore, urls: string[], key: string, now: number, fetchFn = fetch) {
  const cache = await store.read<Record<string, YouTubeAvailability & { at: number }>>('video-public-metadata:v1') ?? {}
  const ids = [...new Set(urls.map(videoKey).filter(id => /^[\w-]{11}$/.test(id)))]
  const pending = ids.filter(id => !cache[id] || now - cache[id].at > (cache[id].state === 'ready' ? 7 * 86400 : 1800))
  let unavailable = false
  for (let start = 0; key && start < pending.length; start += 50) {
    const batch = pending.slice(start, start + 50)
    try {
      const response = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,status&id=${batch.join(',')}`, {
        headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) { unavailable = true; break }
      const data = await response.json() as { items?: { id: string; contentDetails?: { duration?: string }; snippet?: { liveBroadcastContent?: string }; status?: { privacyStatus?: string } }[] }
      if (!Array.isArray(data.items)) { unavailable = true; break }
      for (const item of data.items) {
        if (!batch.includes(item.id)) continue
        const live = item.snippet?.liveBroadcastContent
        const durationSeconds = parseVideoDuration(item.contentDetails?.duration)
        cache[item.id] = { at: now, ...(live === 'upcoming' || live === 'live' ? { state: live }
          : item.status?.privacyStatus === 'private' ? { state: 'unavailable' }
          : durationSeconds ? { state: 'ready', durationSeconds } : { state: 'unknown' }) }
      }
      // Missing entries may be inaccessible. Never infer duration or completion.
      for (const id of batch) if (!data.items.some(item => item.id === id)) cache[id] = { at: now, state: 'unavailable' }
      await store.write('video-public-metadata:v1', cache)
    } catch { unavailable = true; break }
  }
  return { metadata: Object.fromEntries(ids.filter(id => cache[id] && (cache[id].state === 'ready' || now - cache[id].at < 1800)).map(id => [id, cache[id]])), unavailable }
}
