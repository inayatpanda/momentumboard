import { acquireLease, releaseLease, type AppStore } from './storeProvider'
import { canonicalVideoUrl, videoKey } from '../../../shared/youtubeCaptions.mjs'
import { videoFailureReason, type WorkResult } from './videoQueue'

export const SOCIAL_PIPELINE_VERSION = 'source-evidence-v1'
export const SOCIAL_JOBS_KEY = 'social-jobs:v1'
export type SocialStage = 'queued' | 'captions' | 'waiting-provider' | 'extracting' | 'verifying' | 'publishing' | 'complete' | 'needs-attention'
export interface SocialJob {
  id: string; url: string; title: string; channel: string; channelId?: string; publishedAt?: number
  mode: 'extract' | 'watch'; at: number; updatedAt: number; stage: SocialStage
  attempts: number; nextAttemptAt: number; lastError?: string
}
export type SocialJobInput = Pick<SocialJob, 'url' | 'title' | 'channel'> & Partial<Pick<SocialJob, 'mode' | 'channelId' | 'publishedAt'>>
export const socialJobId = (url: string, mode = 'extract') => `${SOCIAL_PIPELINE_VERSION}:${mode}:${videoKey(url)}`

/** Only short store mutations hold this lease. Never hold it around a provider
 * call. D1's atomic acquisition serialises producers and the consumer. */
export async function mutateSocialJobs<T>(store: AppStore, mutate: (rows: SocialJob[]) => T): Promise<T> {
  const key = 'lease:social-jobs'
  let token: string | null = null
  for (let n = 0; n < 5 && !token; n++) {
    token = await acquireLease(store, key, Math.floor(Date.now() / 1000), 60)
    if (!token) await new Promise(resolve => setTimeout(resolve, 40 * (n + 1)))
  }
  if (!token) throw new Error('social-queue-busy')
  try {
    const rows = (await (store.readStrong?.<SocialJob[]>(SOCIAL_JOBS_KEY) ?? store.read<SocialJob[]>(SOCIAL_JOBS_KEY))) ?? []
    const result = mutate(rows)
    // Every unfinished/failed job survives. Completed entries are dispatch memory.
    const completed = rows.filter(j => j.stage === 'complete').sort((a, b) => a.updatedAt - b.updatedAt).slice(-1000)
    await store.write(SOCIAL_JOBS_KEY, [...rows.filter(j => j.stage !== 'complete'), ...completed])
    return result
  } finally { await releaseLease(store, key, token) }
}

export async function enqueueSocialJobs(store: AppStore, inputs: SocialJobInput[], nowSec: number, wake = false): Promise<void> {
  const valid = inputs.filter(i => i && canonicalVideoUrl(i.url))
  if (!valid.length) return
  if (!wake) {
    const existing = await store.read<SocialJob[]>(SOCIAL_JOBS_KEY) ?? []
    const known = new Set(existing.map(j => j.id))
    if (valid.every(input => known.has(socialJobId(input.url, input.mode ?? 'extract')))) return
  }
  await mutateSocialJobs(store, rows => {
    for (const input of valid) {
      const mode = input.mode ?? 'extract', id = socialJobId(input.url, mode)
      const old = rows.find(j => j.id === id)
      if (old) {
        if (wake) {
          old.nextAttemptAt = 0; old.attempts = 0; old.stage = 'queued'; delete old.lastError
        }
        continue
      }
      rows.push({ ...input, url: canonicalVideoUrl(input.url)!, id, mode, at: nowSec, updatedAt: nowSec, stage: 'queued', attempts: 0, nextAttemptAt: 0 })
    }
  })
}

export async function setSocialStage(store: AppStore, id: string, stage: SocialStage, nowSec: number, reason?: string): Promise<void> {
  await mutateSocialJobs(store, rows => {
    const job = rows.find(j => j.id === id)
    if (job) {
      job.stage = stage; job.updatedAt = nowSec
      if (reason) job.lastError = videoFailureReason(503, reason)
      else if (stage === 'queued') { delete job.lastError; job.nextAttemptAt = 0 }
    }
  })
}

export function eligibleSocialJobs(rows: SocialJob[], nowSec: number, limit = 8): SocialJob[] {
  return rows.filter(j => !['complete', 'needs-attention'].includes(j.stage) && j.nextAttemptAt <= nowSec)
    .sort((a, b) => Number(a.mode === 'watch') - Number(b.mode === 'watch') || a.updatedAt - b.updatedAt || a.at - b.at).slice(0, limit)
}

export async function finishSocialAttempt(store: AppStore, id: string, result: WorkResult, nowSec: number): Promise<void> {
  await mutateSocialJobs(store, rows => {
    const job = rows.find(j => j.id === id)
    if (!job) return
    job.updatedAt = nowSec
    if (result.ok) { job.stage = 'complete'; delete job.lastError; return }
    job.lastError = videoFailureReason(503, result.reason ?? '')
    // Provider/budget waits do not consume error retries or age out of the queue.
    if (!result.retryAfterSec) job.attempts++
    job.nextAttemptAt = nowSec + (result.retryAfterSec ?? Math.min(6 * 3600, 900 * 2 ** Math.min(job.attempts, 5)))
    if (job.attempts >= 6) job.stage = 'needs-attention'
  })
}
