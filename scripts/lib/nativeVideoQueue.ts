import { acquireLease, releaseLease, type AppStore } from '../../netlify/functions/lib/storeProvider'
import { nativeDraftText, publishNativeDraft, publishFreeVideoExtract, readNativeVideo, type NativeVideoDraft } from '../../netlify/functions/lib/nativeVideo'
import { readFreeVideoText } from '../../netlify/functions/lib/freeVideoText'
import { readNativeBudget, reserveNativeRead, pauseNativeReads } from '../../netlify/functions/lib/nativeVideoBudget'
import { readStoredTranscript, type InboxVideo } from '../../netlify/functions/lib/videoTranscriptStore'
import { extractTranscriptFacts, ExtractionPending } from '../../netlify/functions/lib/videoTranscriptAnalysis'
import { youtubeAvailability } from '../../netlify/functions/lib/youtubeAvailability'
import { enqueueSocialJobs, finishSocialAttempt, socialJobId } from '../../netlify/functions/lib/socialJobs'
import { videoKey } from '../../shared/youtubeCaptions.mjs'
import { isFollowedChannel, withDefaults } from '../../shared/channels'
import { NATIVE_CHUNK_SECONDS, NATIVE_DAILY_REQUESTS, NATIVE_DAILY_SECONDS, NATIVE_MAX_CALLS_PER_RUN } from '../../shared/nativeVideoPolicy'

export const NATIVE_PROGRESS_KEY = 'video-native-progress:v2'
export interface NativeVideoWork {
  video: InboxVideo; nextOffset: number; sourceDurationSeconds?: number; chunkSeconds?: number
  parts: { startSeconds: number; endSeconds: number; key: string }[]
  stage: 'pending' | 'partial' | 'complete' | 'end-reported' | 'retry' | 'needs-attention'
  mode?: 'captions' | 'video'; attempts: number; failures: number; nextAttemptAt: number; lastAttemptAt: number
  updatedAt: number; lastError?: string
}
export interface NativeRunStatus {
  at: number; running: boolean; published: number; attempted: number; failed: number; reused: number
  capped: boolean; scheduled: boolean; status: string; pauseReason?: string; retryAt?: number
  dailyRequests: number; dailyMinutes: number; requestLimit: number; minuteLimit: number
  pending: number; partial: number; completed: number; endReported: number
}
const finished = (w: NativeVideoWork) => w.stage === 'complete' || w.stage === 'end-reported'
// A clipped input often makes the model repeat the requested end time as the
// video duration. That is not evidence of the original video's ending.
const reportsEnding = (part: NativeVideoDraft) => part.result.complete === true && !!part.section
  && typeof part.result.durationSeconds === 'number' && part.result.durationSeconds > part.section.startSeconds
  && part.result.durationSeconds < part.section.endSeconds
const channel = (w: NativeVideoWork) => w.video.channelId || w.video.channel

/** Rotate channels, resume their unfinished sections, then prefer recent uploads. */
export function nextNativeWork(rows: NativeVideoWork[], now: number, excluded = new Set<string>()): NativeVideoWork | undefined {
  const served = new Map<string, number>()
  for (const w of rows) served.set(channel(w), Math.max(served.get(channel(w)) ?? 0, w.lastAttemptAt))
  return rows.filter(w => !finished(w) && w.stage !== 'needs-attention' && w.nextAttemptAt <= now && !excluded.has(videoKey(w.video.url)))
    .sort((a, b) => (served.get(channel(a)) ?? 0) - (served.get(channel(b)) ?? 0)
      || Number(b.stage === 'partial') - Number(a.stage === 'partial')
      || (b.video.publishedAt ?? b.video.at) - (a.video.publishedAt ?? a.video.at))[0]
}

export async function assembledNativeDraft(store: AppStore, work: NativeVideoWork, now: number): Promise<NativeVideoDraft | null> {
  const drafts: NativeVideoDraft[] = []
  let offset = 0
  for (const part of work.parts) {
    const draft = await store.read<NativeVideoDraft>(part.key)
    if (!draft || nativeDraftText(draft) === null || videoKey(draft.url) !== videoKey(work.video.url)
      || part.startSeconds !== offset || draft.section?.startSeconds !== offset || draft.section.endSeconds !== part.endSeconds) return null
    drafts.push(draft); offset = part.endSeconds
  }
  if (!drafts.length) return null
  const transcript = drafts.map(d => nativeDraftText(d)!).join('\n\n')
  if (transcript.length < 100 || transcript.length > 500_000) return null
  const unique = new Map<string, unknown>()
  for (const d of drafts) for (const t of d.result.tickers ?? []) unique.set(JSON.stringify(t), t)
  return { url: work.video.url, at: now, model: drafts[0].model, finishReason: 'STOP', limitSeconds: offset,
    progress: { sections: drafts.length, processedSeconds: offset, sourceDurationSeconds: work.sourceDurationSeconds ?? null,
      completion: work.stage === 'complete' ? 'complete' : work.stage === 'end-reported' ? 'end-reported' : 'partial' },
    result: { canAccessAudio: true, complete: finished(work), durationSeconds: work.sourceDurationSeconds ?? null,
      language: drafts[0].result.language, transcript, tickers: [...unique.values()], themes: [...new Set(drafts.flatMap(d => d.result.themes ?? []))] },
  }
}

export async function collectNativeVideos(store: AppStore, deps: {
  key: string; freeTierConfirmed: boolean; scheduled: boolean; cachedOnly?: boolean; target?: string; forceVideo?: boolean
  now?: () => number; wait?: (seconds: number) => Promise<void>; deadline?: number; maxCalls?: number
  availability?: typeof youtubeAvailability; readSection?: typeof readNativeVideo; readText?: typeof readFreeVideoText
  onPublish?: (video: InboxVideo, kind: 'captions' | 'video', publication: string) => Promise<void>
  log?: (data: Record<string, unknown>) => void
}): Promise<NativeRunStatus> {
  if (!deps.cachedOnly && (!deps.freeTierConfirmed || !deps.key)) throw new Error('free-tier-not-configured')
  if (deps.target && !/^[A-Za-z0-9_-]{11}$/.test(deps.target)) throw new Error('invalid-target')
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000)), wait = deps.wait ?? (seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)))
  const started = now(), deadline = deps.deadline ?? started + 10 * 60
  const lock = 'lease:github-native-videos', lease = await acquireLease(store, lock, started, 14 * 60)
  if (!lease) throw new Error('native-running')
  const status: NativeRunStatus = { at: started, running: true, published: 0, attempted: 0, failed: 0, reused: 0, capped: false,
    scheduled: deps.scheduled, status: 'running', dailyRequests: 0, dailyMinutes: 0, requestLimit: NATIVE_DAILY_REQUESTS,
    minuteLimit: NATIVE_DAILY_SECONDS / 60, pending: 0, partial: 0, completed: 0, endReported: 0 }
  let rows: NativeVideoWork[] = []
  const updateCounts = () => {
    status.pending = rows.filter(w => !finished(w)).length; status.partial = rows.filter(w => w.stage === 'partial' || w.parts.length > 0 && !finished(w)).length
    status.completed = rows.filter(w => w.stage === 'complete').length; status.endReported = rows.filter(w => w.stage === 'end-reported').length
  }
  const save = async () => {
    await store.write(NATIVE_PROGRESS_KEY, rows)
    updateCounts(); await store.write('video-native-runner', status)
  }
  try {
    const initialBudget = await readNativeBudget(store, started)
    status.dailyRequests = initialBudget.requests; status.dailyMinutes = Math.ceil(initialBudget.seconds / 60)
    await store.write('video-native-runner', status)
    rows = await store.read<NativeVideoWork[]>(NATIVE_PROGRESS_KEY) ?? []
    const config = await store.read<{ ytChannels?: { id: string; name: string }[] }>('config'), followed = withDefaults(config?.ytChannels)
    const inbox = await store.read<InboxVideo[]>('video-inbox') ?? []
    // Older caption analyses predate per-video completion keys. Check the
    // saved display index too, so missing markers never spend another call.
    const previous = await store.read<{ url: string; via?: string; tickers?: unknown[] }[]>('video-extracts') ?? []
    const alreadyRead = new Set(previous.filter(e => e && typeof e.url === 'string' && Array.isArray(e.tickers) && e.via !== 'gemini-video').map(e => videoKey(e.url)))
    const known = new Set(rows.map(w => videoKey(w.video.url)))
    for (const video of inbox.filter(v => isFollowedChannel(v, followed))) {
      if (known.has(videoKey(video.url)) || alreadyRead.has(videoKey(video.url))) continue
      const extract = await store.read<{ via?: string }>(`video-extract:v1:${videoKey(video.url)}`)
      if (extract && extract.via !== 'gemini-video') continue
      rows.push({ video, nextOffset: 0, parts: [], stage: 'pending', attempts: 0, failures: 0, nextAttemptAt: 0, lastAttemptAt: 0, updatedAt: now() })
      known.add(videoKey(video.url))
    }
    await save()
    const selected = rows.filter(w => isFollowedChannel(w.video, followed) && (!deps.target || videoKey(w.video.url) === deps.target))
    if (deps.target && !selected.length) throw new Error('target-not-eligible')
    // An explicit owner retry may retry a transport timeout immediately; the
    // persistent provider quota/cooldown is still enforced by reserveNativeRead.
    for (const work of selected) if (deps.target && deps.forceVideo && ['native-timeout', 'native-read-failed'].includes(work.lastError ?? '')) {
      work.chunkSeconds = Math.min(work.chunkSeconds ?? NATIVE_CHUNK_SECONDS, 300)
      work.nextAttemptAt = 0
    }
    for (const work of selected) if (alreadyRead.has(videoKey(work.video.url))) {
      work.stage = 'complete'; work.nextAttemptAt = 0; work.failures = 0; delete work.lastError
    }
    for (const work of selected.filter(w => w.stage === 'end-reported' && !w.sourceDurationSeconds)) {
      const last = work.parts.at(-1)
      const part = last ? await store.read<NativeVideoDraft>(last.key) : null
      if (part && !reportsEnding(part)) { work.stage = 'partial'; work.nextAttemptAt = 0 }
    }
    await save()
    // Repair a process ending between the section checkpoint and publication.
    // Already completed reads need no model access to become visible again.
    for (const work of selected.filter(w => w.parts.length > 0 && !alreadyRead.has(videoKey(w.video.url)))) {
      if (work.sourceDurationSeconds && work.nextOffset >= work.sourceDurationSeconds) work.stage = 'complete'
      const saved = await assembledNativeDraft(store, work, now())
      if (!saved) continue
      const publication = await publishNativeDraft(store, saved, work.video, now())
      if (publication === 'published') { status.published++; status.reused++; await deps.onPublish?.(work.video, 'video', publication) }
    }
    const excluded = new Set<string>(), checked = new Set<string>()
    let iterations = 0
    while (status.attempted < (deps.maxCalls ?? NATIVE_MAX_CALLS_PER_RUN) && now() < deadline - 245 && iterations++ < 40) {
      const work = nextNativeWork(selected, now(), excluded)
      if (!work) break
      const id = videoKey(work.video.url)
      const existing = await store.read<{ via?: string }>(`video-extract:v1:${id}`)
      if (existing && existing.via !== 'gemini-video') { work.stage = 'complete'; await save(); continue }
      const transcript = await readStoredTranscript(store, work.video.url)
      // A saved direct read is finished before changing lanes, so retries do not
      // abandon sections already captured. Captions still upgrade it afterward.
      const useText = !!transcript?.text && work.parts.length === 0 && !(deps.target && deps.forceVideo)
      work.mode = useText ? 'captions' : 'video'
      const partKey = `video-native-part:v2:${id}:${work.nextOffset}`
      let part = useText ? null : await store.read<NativeVideoDraft>(partKey)
      if (part && (nativeDraftText(part) === null || part.section?.startSeconds !== work.nextOffset || videoKey(part.url) !== id)) part = null
      if (!part && deps.cachedOnly) {
        const saved = await store.read<NativeVideoDraft>(`video-native-draft:${id}`)
        if (saved && nativeDraftText(saved)) {
          const publication = await publishNativeDraft(store, saved, work.video, now())
          status.reused++; if (publication === 'published') status.published++
          await deps.onPublish?.(work.video, 'video', publication)
        }
        excluded.add(id); continue
      }
      if (!useText && !part && !checked.has(id)) {
        if (checked.size >= 16) break
        checked.add(id)
        const availability = await (deps.availability ?? youtubeAvailability)(work.video.url)
        if (['upcoming', 'live', 'unavailable'].includes(availability.state)) {
          work.nextAttemptAt = now() + 3 * 3600; work.lastError = availability.state; work.updatedAt = now(); await save()
          deps.log?.({ videoId: id, deferred: availability.state }); continue
        }
        if (availability.durationSeconds) work.sourceDurationSeconds = availability.durationSeconds
      }
      const startSeconds = work.nextOffset, endSeconds = part?.section?.endSeconds ?? Math.min(startSeconds + (work.chunkSeconds ?? NATIVE_CHUNK_SECONDS), work.sourceDurationSeconds ?? Infinity)
      if (!useText && endSeconds <= startSeconds) { work.stage = 'complete'; await save(); continue }
      let reserved = false
      const reserve = async () => {
        if (reserved) return
        let reservation = await reserveNativeRead(store, now(), useText ? 0 : endSeconds - startSeconds)
        if (!reservation.allowed && reservation.reason === 'pacing' && reservation.retryAt! < deadline - 245) {
          await wait(Math.min(65, Math.max(1, reservation.retryAt! - now())))
          reservation = await reserveNativeRead(store, now(), useText ? 0 : endSeconds - startSeconds)
        }
        if (!reservation.allowed) {
          status.capped = reservation.reason !== 'pacing' && reservation.reason !== 'busy'
          status.pauseReason = reservation.reason; status.retryAt = reservation.retryAt
          throw new Error('native-waiting-budget')
        }
        reserved = true; status.attempted++; work.attempts++; work.lastAttemptAt = now(); work.updatedAt = now()
        status.dailyRequests = reservation.budget.requests; status.dailyMinutes = Math.ceil(reservation.budget.seconds / 60)
        // A killed process leaves a retry delay; the media reservation remains.
        work.nextAttemptAt = now() + 900; await save()
      }
      try {
        let publication: string | undefined
        if (useText) {
          const extract = await extractTranscriptFacts(transcript!.text, { ...work.video, at: now() }, '', async prompt => {
            await reserve()
            return (deps.readText ?? readFreeVideoText)(prompt, deps.key)
          }, { segments: transcript!.segments, language: transcript!.language, store, checkpointKey: `free-video-text:${id}`, maxNewChunks: 1 })
          if (!extract) throw new Error('native-invalid-text')
          Object.assign(extract, { via: transcript!.source, transcriptMethod: transcript!.method, channelId: work.video.channelId, publishedAt: work.video.publishedAt, provenance: 'first-party' })
          publication = await publishFreeVideoExtract(store, extract, now()); work.stage = 'complete'
        } else {
          if (!part) {
            await reserve()
            part = await (deps.readSection ?? readNativeVideo)(work.video.url, deps.key, fetch, work.sourceDurationSeconds, { startSeconds, endSeconds })
            await store.write(partKey, part)
          } else status.reused++
          work.parts.push({ startSeconds, endSeconds, key: partKey }); work.nextOffset = endSeconds
          work.stage = work.sourceDurationSeconds && endSeconds >= work.sourceDurationSeconds ? 'complete'
            : !work.sourceDurationSeconds && reportsEnding(part) ? 'end-reported' : 'partial'
          // Save sections before publication. Recovery never spends another call
          // merely to repair a failed publication.
          await save()
          const assembled = await assembledNativeDraft(store, work, now())
          if (!assembled) throw new Error('native-assembly-incomplete')
          await store.write(`video-native-draft:${id}`, assembled); publication = await publishNativeDraft(store, assembled, work.video, now())
        }
        work.failures = 0; work.nextAttemptAt = 0; work.updatedAt = now(); delete work.lastError
        await save()
        if (publication === 'published') status.published++
        if (publication) await deps.onPublish?.(work.video, useText ? 'captions' : 'video', publication)
        if (finished(work)) {
          await enqueueSocialJobs(store, [{ ...work.video, mode: 'extract' }], now())
          await finishSocialAttempt(store, socialJobId(work.video.url), { ok: true }, now())
        }
        deps.log?.({ videoId: id, mode: work.mode, sections: work.parts.length, processedSeconds: work.nextOffset, completion: work.stage, publication })
      } catch (error) {
        if (error instanceof ExtractionPending) { work.stage = 'partial'; work.nextAttemptAt = 0; work.updatedAt = now(); await save(); continue }
        const message = ['TimeoutError', 'AbortError'].includes((error as Error).name) ? 'native-timeout' : (error as Error).message
        if (message === 'native-timeout') work.chunkSeconds = Math.max(120, Math.floor((work.chunkSeconds ?? NATIVE_CHUNK_SECONDS) / 2))
        if (message === 'native-waiting-budget') {
          // Exhausting media minutes must not strand available text captions.
          if (status.pauseReason === 'video-allowance') { excluded.add(id); continue }
          break
        }
        status.failed++; work.failures++; work.updatedAt = now(); work.stage = work.failures >= 5 ? 'needs-attention' : 'retry'
        work.lastError = /^native-[a-z0-9-]+$/.test(message) ? message : 'native-read-failed'
        work.nextAttemptAt = now() + (message === 'native-http-403' ? 86400 : Math.min(86400, 1800 * 2 ** (work.failures - 1)))
        excluded.add(id); await save()
        deps.log?.({ videoId: id, reason: work.lastError, nextAttemptAt: work.nextAttemptAt })
        // A 400 can reject one video's media/interval. Back off that video,
        // without starving the other channels. Authentication/model failures
        // and quota refusals still pause the shared provider.
        if (message === 'native-http-429' || /native-http-(401|404)/.test(message)) {
          status.pauseReason = message === 'native-http-429' ? 'provider-quota' : 'provider-configuration'; status.retryAt = now() + 3600; status.capped = true
          await pauseNativeReads(store, now(), status.retryAt, status.pauseReason); break
        }
      }
    }
    status.status = status.failed ? 'partial' : 'complete'
    return status
  } catch (error) { status.status = 'error'; throw error }
  finally {
    const budget = await readNativeBudget(store, now())
    status.running = false; status.at = now(); status.dailyRequests = budget.requests; status.dailyMinutes = Math.ceil(budget.seconds / 60)
    updateCounts()
    try { await store.write('video-native-runner', status) } finally { await releaseLease(store, lock, lease) }
  }
}
