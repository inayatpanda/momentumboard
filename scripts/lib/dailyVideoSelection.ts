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
  // Only an unread, unattempted inaccessible source can return today's slot.
  // Paid/free request accounting is never refunded, and completed videos remain counted.
  selection.ids = selection.ids.filter(id => {
    const work = rows.find(w => videoKey(w.video.url) === id)
    return !work?.deferredReason || work.attempts > 0 || work.parts.length > 0 || complete(work)
  })
  selection.channels = [...new Set(selection.ids.map(id => rows.find(w => videoKey(w.video.url) === id)).filter((w): w is NativeVideoWork => !!w).map(channel))]
  const carry = rows.filter(w => w.selectedAt && !w.deferredReason && !complete(w) && w.stage !== 'needs-attention')
  // Recovered sources keep their progress but wait if five reads are already open.
  const selectedUnfinished = rows.filter(w => selection.ids.includes(videoKey(w.video.url)) && !w.deferredReason && !complete(w)).length
  const resumable = carry.filter(w => !selection.ids.includes(videoKey(w.video.url))).slice(0, Math.max(0, DAILY_VIDEO_LIMIT - selectedUnfinished))
  const active = new Set([...selection.ids, ...resumable.map(w => videoKey(w.video.url))])
  const activeChannels = new Set([...selection.channels, ...resumable.map(channel)])
  const candidates = rows.filter(w => !w.selectedAt && !w.deferredReason && !complete(w) && w.stage !== 'needs-attention'
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
    work.parked = !!work.deferredReason || !active.has(videoKey(work.video.url))
    if (!work.parked && !work.selectedAt) work.selectedAt = now
  }
  await store.write(key, selection)
  await store.write('video-channel-last-selected:v1', history)
  await store.write('video-reading-plan:v1', { at: now, latestOnly: true, freeOnly: true, ids: [...active].filter(id => rows.some(w => videoKey(w.video.url) === id && !w.parked)), dailyVideoLimit: DAILY_VIDEO_LIMIT })
  return { selectedToday: selection.ids.length, dailyVideoLimit: DAILY_VIDEO_LIMIT, latestOnly: true as const }
}
