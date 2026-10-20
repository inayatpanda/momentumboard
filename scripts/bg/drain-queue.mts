import { canonicalVideoUrl } from '../../shared/youtubeCaptions.mjs'
import { enqueueSocialJobs, eligibleSocialJobs, SOCIAL_JOBS_KEY, type SocialJob } from '../../netlify/functions/lib/socialJobs'
import { refreshTranscriptProviderHealth } from '../../netlify/functions/lib/transcriptProviderHealth'
import { readTranscriptIndex } from '../../netlify/functions/lib/videoTranscriptStore'
import { videoKey } from '../../shared/youtubeCaptions.mjs'
// The work-queue drain, GitHub Actions edition (currently every 3 hours). Netlify's
// scheduled functions (alert-check, watchdog) enqueue long jobs into the
// `work-queue` blob — video analysis, event dossiers, a compose retry — and
// this worker executes them by calling the SAME handler modules the old
// background-function HTTP kicks used to reach. Leased so overlapping runs
// (or a manual dispatch during the cron) can't double-process.

import { acquireLease, appStore as blobAppStore, releaseLease } from '../../netlify/functions/lib/storeProvider'
import { configureStoreForScript } from '../lib/configureStore'

import { applyWorkResults, workResultFromResponse, type WorkItem, type WorkResult } from '../../netlify/functions/lib/videoQueue'

const MAX_ITEMS_PER_RUN = 8
const MAX_ATTEMPTS = 3
const videosOnly = process.env.VIDEOS_ONLY === 'true'
const storedOnly = process.env.STORED_TRANSCRIPTS_ONLY === 'true'
const selectedVideo = process.env.VIDEO_URL ? canonicalVideoUrl(process.env.VIDEO_URL) : null

const adminReq = (body?: unknown) =>
  new Request('https://actions.local/', {
    method: 'POST',
    headers: { 'x-app-token': process.env.APP_TOKEN ?? '', 'content-type': 'application/json' },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  })

const runItem = async (item: WorkItem): Promise<WorkResult> => {
  try {
    if (item.kind === 'video') {
      const { default: handler } = await import('../../netlify/functions/video-analyze-background.mts')
      const res = await handler(adminReq(item.body))
      const body = await res.text().catch(() => '')
      const result = workResultFromResponse(res.status, body, res.headers.get('retry-after'))
      console.log(`video ${((item.body as { title?: string })?.title ?? '').slice(0, 60)}: ${res.status} ${result.ok ? 'completed' : result.reason}`)
      return result
    }
    if (item.kind === 'dossier') {
      const { default: handler } = await import('../../netlify/functions/event-dossier-background.mts')
      const res = await handler(adminReq(item.body))
      console.log(`dossier: ${res.status}`)
      return { ok: res.status < 400, reason: `http-${res.status}` }
    }
    if (item.kind === 'compose') {
      const { default: handler } = await import('../../netlify/functions/report-compose-background.mts')
      const res = await handler(adminReq())
      console.log(`compose retry: ${res.status}`)
      return { ok: res.status < 400, reason: `http-${res.status}` }
    }
    console.log(`unknown work kind ${(item as { kind?: string }).kind} — dropping`)
    return { ok: true }
  } catch (e) {
    console.error(`work item ${item.kind} threw:`, e)
    return { ok: false, reason: 'worker-error' }
  }
}

const run = async () => {
  // FIRST, before the lease or the queue read. This worker is the CONSUMER of a
  // queue the scheduled functions produce; if the producer ever moves to D1 and
  // this stayed on Blobs, both halves would report success over an empty list
  // and nothing would ever drain. Explicit selection, or a throw.
  const backend = await configureStoreForScript()
  if (storedOnly && (!videosOnly || process.env.VIDEO_URL)) throw new Error('Stored-only analysis requires videos-only mode without a selected URL')
  console.log(`store backend: ${backend}`)
  // fail loudly without creds — otherwise the mem-fallback store reads an
  // empty queue and the run reports success while doing nothing at all
  const needed = backend === 'blobs' ? ['NETLIFY_SITE_ID', 'NETLIFY_AUTH_TOKEN', 'APP_TOKEN'] : ['APP_TOKEN']
  const missing = needed.filter(n => !process.env[n])
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`)
  const nowSec = Math.floor(Date.now() / 1000)
  const lease = await acquireLease(blobAppStore, 'lease:queue-worker', nowSec, 21 * 60)
  if (!lease) {
    console.log('another worker holds the lease — exiting')
    return
  }
  try {
    const queue = (await blobAppStore.read<WorkItem[]>('work-queue')) ?? []
    if (process.env.SUPADATA_API_KEY) await refreshTranscriptProviderHealth(blobAppStore, process.env.SUPADATA_API_KEY).catch(() => console.log('transcript provider status unavailable'))
    await blobAppStore.write('social-worker-heartbeat', { at: nowSec, status: 'running' })
    // Migration is idempotent. Old video jobs only leave the shared queue after
    // durable admission; paper/dossier work keeps its own eight-item allowance.
    const legacyVideos = queue.filter(j => j.kind === 'video')
    await enqueueSocialJobs(blobAppStore, legacyVideos.map(j => j.body as SocialJob), nowSec)
    if (process.env.VIDEO_URL && (!videosOnly || !selectedVideo)) throw new Error('A selected video requires videos-only mode and a valid YouTube URL')
    if (selectedVideo) {
      const inbox = await blobAppStore.read<SocialJob[]>('video-inbox') ?? []
      const source = inbox.find(v => canonicalVideoUrl(v.url) === selectedVideo)
      if (!source) throw new Error('Selected video is not in the discovered inbox')
      await enqueueSocialJobs(blobAppStore, [{ ...source, mode: 'extract' }], nowSec, true)
    }
    const socialQueue = await blobAppStore.read<SocialJob[]>(SOCIAL_JOBS_KEY) ?? []
    const words = storedOnly ? new Set((await readTranscriptIndex(blobAppStore)).map(t => videoKey(t.url))) : null
    const readyQueue = words ? socialQueue.filter(j => j.mode === 'extract' && words.has(videoKey(j.url))) : socialQueue
    const videoBatch = selectedVideo ? socialQueue.filter(j => j.mode === 'extract' && j.url === selectedVideo) : eligibleSocialJobs(readyQueue, nowSec, 8)
    const runDeadline = Date.now() + 16 * 60_000
    const batch = videosOnly ? [] : queue.filter(item => item.kind !== 'video' && (item.nextAttemptAt ?? 0) <= nowSec).slice(0, MAX_ITEMS_PER_RUN)
    console.log(`draining ${batch.length} of ${queue.length} item(s)…`)
    const results = new Map<string, WorkResult>()
    for (const item of legacyVideos) {
      const body = item.body as { url?: string; mode?: string } | null
      results.set(item.id, body && canonicalVideoUrl(body.url) ? { ok: true } : { ok: false, reason: 'bad-url' })
    }
    for (const item of batch) {
      if (Date.now() > runDeadline) break
      results.set(item.id, await runItem(item))
    }
    for (const job of videoBatch) {
      if (Date.now() > runDeadline) break
      for (let step = 0; step < 8 && Date.now() < runDeadline; step++) {
        const result = await runItem({ id: job.id, kind: 'video', body: job, at: job.at, attempts: job.attempts })
        if (result.reason !== 'extraction-in-progress') break
        // Continue saved text chunks in this run; do not wait three hours
        // between sections of the same video. Provider jobs use the collector.
      }
    }
    console.log(`video analysis batch: ${videoBatch.length}; stored transcripts only: ${storedOnly}`)
    await blobAppStore.write('social-worker-heartbeat', { at: Math.floor(Date.now() / 1000), status: 'complete' })
    // re-read before writing: alert-check may have enqueued while we worked
    const fresh = (await blobAppStore.read<WorkItem[]>('work-queue')) ?? []
    const { next, deadlettered } = applyWorkResults(fresh, results, Math.floor(Date.now() / 1000))
    await blobAppStore.write('work-queue', next)
    if (deadlettered.length) {
      // audit M-1: a recoverable job used to vanish silently after 3 attempts.
      // Keep it in a dead-letter blob and page the owner so a persistent failure
      // (e.g. a video that never yields a transcript) is visible, not lost.
      const dl = (await blobAppStore.read<WorkItem[]>('work-queue-deadletter')) ?? []
      await blobAppStore.write('work-queue-deadletter', [...dl, ...deadlettered].slice(-50))
      const tok = process.env.TELEGRAM_BOT_TOKEN
      const chat = process.env.TELEGRAM_CHAT_ID
      if (!videosOnly && tok && chat) {
        const { sendTelegram } = await import('../../netlify/functions/lib/telegram')
        await sendTelegram(tok, chat, `⚠️ StreetSignal queue: dropped ${deadlettered.length} item(s) after ${MAX_ATTEMPTS} attempts — ${deadlettered.map(i => i.kind).join(', ')}. Kept in work-queue-deadletter.`).catch(() => {})
      }
    }
    console.log(`done: ${[...results.values()].filter(r => r.ok).length} ok, ${[...results.values()].filter(r => !r.ok).length} deferred/failed, ${next.length} left in queue`)
  } finally {
    await releaseLease(blobAppStore, 'lease:queue-worker', lease)
  }
}

run().catch(e => {
  console.error('drain-queue failed:', e)
  process.exit(1)
})
