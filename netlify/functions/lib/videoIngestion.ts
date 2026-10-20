import { SOCIAL_JOBS_KEY, type SocialJob } from './socialJobs'
import type { AppStore } from './storeProvider'
import { videoKey } from '../../../shared/youtubeCaptions.mjs'
import { videoFailureReason, type WorkItem } from './videoQueue'
import { readTranscriptIndex } from './videoTranscriptStore'
import { PROVIDER_HEALTH_KEY, type TranscriptProviderHealth } from './transcriptProviderHealth'

export async function videoIngestionHealth(store: AppStore, extracts: { url: string; at: number }[], nowSec: number, analyses: { url: string }[] = []) {
  const [inbox, transcripts, queue, deadletters, socialJobs, heartbeat, provider, localRunner] = await Promise.all([
    store.read<{ url: string }[]>('video-inbox'),
    readTranscriptIndex(store),
    store.read<WorkItem[]>('work-queue'),
    store.read<WorkItem[]>('work-queue-deadletter'),
    store.read<SocialJob[]>(SOCIAL_JOBS_KEY),
    store.read<{ at: number; status: string }>('social-worker-heartbeat'),
    store.read<TranscriptProviderHealth>(PROVIDER_HEALTH_KEY),
    store.read<{ at: number; running: boolean; saved: number; unavailable: number; buffered: number }>('video-local-runner'),
  ])
  const completed = new Set(extracts.map(v => videoKey(v.url)))
  const watched = new Set(analyses.map(v => videoKey(v.url)))
  const words = new Set((transcripts ?? []).map(v => videoKey(v.url)))
  const isOutstanding = (j: WorkItem) => j?.kind === 'video' && typeof (j.body as { url?: unknown })?.url === 'string'
    && !((j.body as { mode?: string }).mode === 'extract' ? completed : watched).has(videoKey((j.body as { url: string }).url))
  const queued = (queue ?? []).filter(isOutstanding)
  const jobKey = (j: WorkItem) => `${(j.body as { mode?: string }).mode ?? 'watch'}:${videoKey((j.body as { url: string }).url)}`
  const active = new Set(queued.map(jobKey))
  const failed = (deadletters ?? []).filter(isOutstanding).filter(j => !active.has(jobKey(j)))
  const latest = (rows: { at: number }[]) => rows.reduce<number | null>((at, row) => Number.isFinite(row.at) && row.at > (at ?? 0) ? row.at : at, null)
  const activeSocial = (socialJobs ?? []).filter(j => j.stage !== 'complete')
  const durableIds = new Set(activeSocial.map(j => `${j.mode}:${videoKey(j.url)}`))
  const legacyQueued = queued.filter(j => !durableIds.has(jobKey(j)))
  const legacyFailed = failed.filter(j => !durableIds.has(jobKey(j)))
  const retries = queued.map(j => j.nextAttemptAt ?? 0).filter(at => at > nowSec)
  retries.push(...activeSocial.map(j => j.nextAttemptAt).filter(at => at > nowSec))
  return {
    provider: provider ?? null,
    localRunner: localRunner ? { ...localRunner, stale: nowSec - localRunner.at > 2 * 3600 } : null,
    localLastSavedAt: latest(transcripts.filter(t => t.source === 'local')),
    localSpeechCount: transcripts.filter(t => t.method === 'speech').length,
    workerLastSeenAt: heartbeat?.at ?? null,
    workerStale: !!activeSocial.length && (!heartbeat || nowSec - heartbeat.at > 6 * 3600),
    oldestPendingAt: activeSocial.length ? Math.min(...activeSocial.map(j => j.at)) : null,
    jobs: [...activeSocial].sort((a, b) => a.at - b.at).slice(0, 12).map(j => ({ id: j.id, title: j.title, url: j.url, mode: j.mode, stage: j.stage, at: j.at, attempts: j.attempts, nextAttemptAt: j.nextAttemptAt, ...(j.lastError ? { reason: videoFailureReason(503, j.lastError) } : {}) })),
    pendingTranscripts: new Set((inbox ?? []).filter(v => !words.has(videoKey(v.url))).map(v => videoKey(v.url))).size,
    queued: legacyQueued.length + activeSocial.filter(j => j.stage !== 'needs-attention').length,
    deferred: legacyQueued.filter(j => (j.nextAttemptAt ?? 0) > nowSec).length + activeSocial.filter(j => j.stage !== 'needs-attention' && j.nextAttemptAt > nowSec).length,
    failed: legacyFailed.length + activeSocial.filter(j => j.stage === 'needs-attention').length,
    lastTranscriptAt: latest(transcripts ?? []),
    lastExtractAt: latest(extracts),
    nextRetryAt: retries.length ? Math.min(...retries) : null,
    recentFailures: [...queued, ...failed].filter(j => j.lastError || (j.attempts ?? 0) > 0)
      .sort((a, b) => (b.lastAttemptAt ?? b.at) - (a.lastAttemptAt ?? a.at)).slice(0, 5)
      .map(j => ({
        title: typeof (j.body as { title?: unknown })?.title === 'string' ? (j.body as { title: string }).title.replace(/[\u0000-\u001f]/g, ' ').slice(0, 160) : 'Video analysis',
        reason: videoFailureReason(503, j.lastError ?? ''),
        at: j.lastAttemptAt ?? j.at,
      })),
  }
}
