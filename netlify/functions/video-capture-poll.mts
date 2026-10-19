import type { Config } from '@netlify/functions'
import { appStore, acquireLease, releaseLease, type AppStore } from './lib/storeProvider'
import { captureTranscript, type CaptureCheckpoint } from './lib/transcriptCapture'
import { readStoredTranscript, saveTranscript } from './lib/videoTranscriptStore'
import { SOCIAL_JOBS_KEY, setSocialStage, type SocialJob } from './lib/socialJobs'
import { videoKey } from '../../shared/youtubeCaptions.mjs'

/** Provider jobs expire one hour after completion. Poll them on the existing
 * five-minute trigger, separately from the three-hour LLM worker. This door
 * ONLY polls saved IDs; it cannot create or buy a transcription. */
export async function pollVideoCaptures(store: AppStore, apiKey?: string, nowSec = Math.floor(Date.now() / 1000), fetchFn: typeof fetch = fetch): Promise<number> {
  if (!apiKey) return 0
  const jobs = await store.read<SocialJob[]>(SOCIAL_JOBS_KEY) ?? []
  const pending = jobs.filter(j => j.stage === 'waiting-provider').sort((a, b) => a.updatedAt - b.updatedAt).slice(0, 2)
  let saved = 0
  for (const job of pending) {
    const lock = `lease:video:${videoKey(job.url)}`
    const token = await acquireLease(store, lock, nowSec, 120)
    if (!token) continue
    try {
      const checkpointKey = `video-capture:${videoKey(job.url)}`
      const checkpoint = await store.read<CaptureCheckpoint>(checkpointKey)
      if (!checkpoint?.providerJobId) continue
      const local = await readStoredTranscript(store, job.url)
      const result = local ? null : await captureTranscript(store, checkpointKey, job.url, apiKey, fetchFn, nowSec)
      if (result?.status === 'ready') {
        await saveTranscript(store, { url: job.url, title: job.title, channel: job.channel, publishedAt: job.publishedAt, channelId: job.channelId, at: nowSec, ...result.transcript })
        saved++
      }
      const failure = result?.status === 'unavailable' ? (await store.read<CaptureCheckpoint>(checkpointKey))?.lastError ?? 'no-transcript-no-video-read' : undefined
      await setSocialStage(store, job.id, local || result?.status === 'ready' ? 'queued' : result?.status === 'unavailable' ? 'needs-attention' : 'waiting-provider', nowSec, failure)
    } catch {
      // Rotate network failures behind other jobs; saved provider IDs survive.
      await setSocialStage(store, job.id, 'waiting-provider', nowSec, 'provider-unavailable')
    } finally { await releaseLease(store, lock, token) }
  }
  return saved
}

export default async (req: Request) => {
  const body = await req.text()
  const admin = !!process.env.APP_TOKEN && req.headers.get('x-app-token') === process.env.APP_TOKEN
  if (!admin && !body.includes('next_run')) return new Response('forbidden', { status: 401 })
  const { claimScheduleSlot } = await import('./lib/schedule')
  if (!(await claimScheduleSlot('video-capture-poll', 240, false))) return new Response('throttled', { status: 429 })
  const saved = await pollVideoCaptures(appStore, process.env.SUPADATA_API_KEY)
  return Response.json({ saved })
}
// Two jobs per five minutes: retrieve all eight worker submissions in 20 min,
// below the provider's one-hour result lifetime, within the request budget.
export const config: Config = { schedule: '*/5 * * * *' }
