import type { AppStore } from '../../netlify/functions/lib/storeProvider'
import { videoKey } from '../../shared/youtubeCaptions.mjs'
import { nativeQuotaDay } from '../../shared/nativeVideoPolicy'
import type { NativeVideoWork } from './nativeVideoQueue'

export const DAILY_VIDEO_LIMIT = 5
export interface DailyVideoSelection { day: string; ids: string[]; channels: string[] }

/** A small daily reading list, not an instruction to exhaust the archive.
 * Existing selections retain their remaining sections across midnight. */
export async function selectDailyVideos(store: AppStore, rows: NativeVideoWork[], now: number) {
  const day = nativeQuotaDay(now), key = `video-daily-selection:v1:${day}`
  const selection = await store.read<DailyVideoSelection>(key) ?? { day, ids: [], channels: [] }
  const history = await store.read<Record<string, number>>('video-channel-last-selected:v1') ?? {}
  const complete = (w: NativeVideoWork) => ['complete', 'end-reported'].includes(w.stage)
  const channel = (w: NativeVideoWork) => w.video.channelId || w.video.channel
  const carry = rows.filter(w => w.selectedAt && !complete(w) && w.stage !== 'needs-attention')
  const active = new Set([...selection.ids, ...carry.map(w => videoKey(w.video.url))])
  const activeChannels = new Set([...selection.channels, ...carry.map(channel)])
  const candidates = rows.filter(w => !w.selectedAt && !complete(w) && w.stage !== 'needs-attention'
    && !!w.video.publishedAt && w.video.publishedAt >= now - 86400 && w.video.publishedAt <= now
    && !['upcoming', 'live', 'unavailable'].includes(w.lastError ?? ''))
    .sort((a, b) => (history[channel(a)] ?? 0) - (history[channel(b)] ?? 0)
      || b.video.publishedAt! - a.video.publishedAt!)
  let unfinished = rows.filter(w => active.has(videoKey(w.video.url)) && !complete(w)).length
  for (const work of candidates) {
    if (selection.ids.length >= DAILY_VIDEO_LIMIT || unfinished >= DAILY_VIDEO_LIMIT) break
    const id = videoKey(work.video.url), source = channel(work)
    if (active.has(id) || activeChannels.has(source)) continue
    selection.ids.push(id); selection.channels.push(source)
    active.add(id); activeChannels.add(source); unfinished++
    work.selectedAt = now; history[source] = now
  }
  for (const work of rows) {
    work.parked = !active.has(videoKey(work.video.url))
    if (!work.parked && !work.selectedAt) work.selectedAt = now
  }
  await store.write(key, selection)
  await store.write('video-channel-last-selected:v1', history)
  await store.write('video-reading-plan:v1', { at: now, latestOnly: true, freeOnly: true, ids: [...active], dailyVideoLimit: DAILY_VIDEO_LIMIT })
  return { selectedToday: selection.ids.length, dailyVideoLimit: DAILY_VIDEO_LIMIT, latestOnly: true as const }
}
