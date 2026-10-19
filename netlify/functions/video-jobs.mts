import { appStore, type AppStore, acquireLease, releaseLease } from './lib/storeProvider'
import { mutateSocialJobs, SOCIAL_JOBS_KEY, type SocialJob } from './lib/socialJobs'
import { videoKey } from '../../shared/youtubeCaptions.mjs'
import type { CaptureCheckpoint } from './lib/transcriptCapture'

export async function retryVideoJob(headers: Headers, body: string, token: string | undefined, store: AppStore): Promise<Response> {
  if (!token || headers.get('x-app-token') !== token) return new Response('unauthorized', { status: 401 })
  let id: unknown
  try { id = JSON.parse(body)?.id } catch { return new Response('bad-json', { status: 400 }) }
  if (typeof id !== 'string') return new Response('bad-id', { status: 400 })
  const job = (await store.read<SocialJob[]>(SOCIAL_JOBS_KEY) ?? []).find(j => j.id === id)
  if (!job) return new Response('unknown-job', { status: 404 })
  if (job.stage === 'complete') return new Response('already-complete')
  const lock = `lease:video:${videoKey(job.url)}`
  const lease = await acquireLease(store, lock, Math.floor(Date.now() / 1000), 90)
  if (!lease) return new Response('currently-processing', { status: 409 })
  try {
    const captureKey = `video-capture:${videoKey(job.url)}`
    const capture = await store.read<CaptureCheckpoint>(captureKey)
    // Only an explicit owner retry can replace a known failed/expired job.
    if (capture?.lastError) await store.write(captureKey, {})
    await mutateSocialJobs(store, rows => {
      const current = rows.find(j => j.id === id)
      if (!current || current.stage === 'complete') return
      current.stage = 'queued'; current.attempts = 0; current.nextAttemptAt = 0; current.updatedAt = Math.floor(Date.now() / 1000); delete current.lastError
    })
    return new Response('queued')
  } finally { await releaseLease(store, lock, lease) }
}
export default async (req: Request) => req.method === 'POST' ? retryVideoJob(req.headers, await req.text(), process.env.APP_TOKEN, appStore) : new Response('method-not-allowed', { status: 405 })
