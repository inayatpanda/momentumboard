import { canonicalVideoUrl, videoKey, type CaptionSegment } from '../../shared/youtubeCaptions.mjs'
import { acquireLease, releaseLease, type AppStore } from '../../netlify/functions/lib/storeProvider'
import { enqueueSocialJobs, SOCIAL_JOBS_KEY, type SocialJob } from '../../netlify/functions/lib/socialJobs'
import { readStoredTranscript, readTranscriptIndex, saveTranscript, validatedSegments, type InboxVideo } from '../../netlify/functions/lib/videoTranscriptStore'

export const GITHUB_CAPTURE_KEY = 'video-github-runner'
export const GITHUB_ATTEMPTS_KEY = 'video-github-capture-attempts'
export interface CaptureAttempt { id: string; at: number; attempts: number; nextAt: number }
export interface GithubCaptureStatus {
  at: number; running: boolean; saved: number; unavailable: number; attempted: number
  captions: number; speech: number; status: 'running' | 'complete' | 'error'
  reasons: Record<string, number>
}
export type CaptureResult = { text: string; segments?: CaptionSegment[]; language?: string; automatic?: boolean; method?: 'captions' | 'speech'; fail?: never } | { fail: string; text?: never }
type CaptureFn = (url: string) => Promise<CaptureResult>

/** Retry gaps without letting one inaccessible channel occupy every run. */
export function captureCandidates(inbox: InboxVideo[], jobs: SocialJob[], known: Set<string>, attempts: CaptureAttempt[], now: number): InboxVideo[] {
  const rows = new Map<string, InboxVideo>()
  for (const v of [...jobs.filter(j => j.mode === 'extract' && j.stage !== 'complete'), ...inbox]) {
    const url = canonicalVideoUrl(v.url)
    if (url) rows.set(videoKey(url), { ...v, url })
  }
  const tried = new Map(attempts.map(a => [a.id, a]))
  return [...rows.values()].filter(v => !known.has(videoKey(v.url)) && (tried.get(videoKey(v.url))?.nextAt ?? 0) <= now)
    .sort((a, b) => (tried.get(videoKey(a.url))?.at ?? 0) - (tried.get(videoKey(b.url))?.at ?? 0) || (b.publishedAt ?? b.at) - (a.publishedAt ?? a.at))
}

export function captureFailure(reason?: string): string {
  if (/blocked|429|bot|RequestBlocked|IpBlocked/i.test(reason ?? '')) return 'youtube-blocked'
  if (/duration-limit/.test(reason ?? '')) return 'duration-limit'
  if (/transcribe/.test(reason ?? '')) return 'speech-unavailable'
  if (/not-configured/.test(reason ?? '')) return 'tools-unavailable'
  return 'source-unavailable'
}

/** Store only, no paid provider or model calls. Source words never enter logs.
 * The global lease prevents concurrent cloud collectors; saveTranscript keeps
 * simultaneous Mac/cloud saves idempotent. A restart repairs incomplete saves. */
export async function collectGithubVideos(store: AppStore, deps: {
  captions: CaptureFn; library: CaptureFn; audio: CaptureFn
  now?: () => number; maxVideos?: number; maxAudio?: number; deadline?: number
}): Promise<GithubCaptureStatus | null> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const token = await acquireLease(store, 'lease:github-video-capture', now(), 40 * 60)
  if (!token) return null
  const report: GithubCaptureStatus = { at: now(), running: true, status: 'running', saved: 0, unavailable: 0, attempted: 0, captions: 0, speech: 0, reasons: {} }
  const heartbeat = () => store.write(GITHUB_CAPTURE_KEY, { ...report, at: now() })
  try {
    await heartbeat()
    const [inbox, index, jobs, previous] = await Promise.all([
      store.read<InboxVideo[]>('video-inbox'), readTranscriptIndex(store),
      store.read<SocialJob[]>(SOCIAL_JOBS_KEY), store.read<CaptureAttempt[]>(GITHUB_ATTEMPTS_KEY),
    ])
    // Recover a crash after storing words but before admitting the analysis.
    for (const row of index.filter(t => t.source === 'github')) {
      const job = jobs?.find(j => j.mode === 'extract' && videoKey(j.url) === videoKey(row.url))
      const newWordsAfterAnalysis = job?.stage === 'complete' && row.at >= job.updatedAt
        && (await store.read<{ via?: string }>(`video-extract:v1:${videoKey(row.url)}`))?.via !== 'github'
      if (!job || newWordsAfterAnalysis || (job.stage !== 'complete' && /no-transcript|caption-job/.test(job.lastError ?? ''))) {
        await enqueueSocialJobs(store, [{ ...row, mode: 'extract' }], now(), !!job)
      }
    }
    const attempts = previous ?? []
    const pending = captureCandidates(inbox ?? [], jobs ?? [], new Set(index.map(t => videoKey(t.url))), attempts, now())
    let audioRemaining = Math.max(0, Math.min(2, deps.maxAudio ?? 2))
    for (const video of pending.slice(0, Math.max(1, Math.min(20, deps.maxVideos ?? 12)))) {
      if (deps.deadline && now() >= deps.deadline) break
      // A partial save may have durable words but no recent index yet.
      const existing = await readStoredTranscript(store, video.url)
      let got: CaptureResult = existing ?? await deps.captions(video.url)
      let captionFailure: string | undefined
      if (!got.text) { got = await deps.library(video.url); captionFailure = got.fail }
      if (!got.text && audioRemaining > 0 && (!deps.deadline || now() < deps.deadline - 60)) {
        audioRemaining--
        got = await deps.audio(video.url)
      }
      report.attempted++
      const id = videoKey(video.url), old = attempts.find(a => a.id === id)
      if (typeof got.text === 'string' && got.text.length >= 100 && got.text.length <= 300_000) {
        const result = await saveTranscript(store, existing ?? {
          url: video.url, title: video.title, channel: video.channel, channelId: video.channelId, publishedAt: video.publishedAt,
          text: got.text, segments: validatedSegments(got.segments, got.text), language: got.language?.slice(0, 20) ?? 'und',
          automatic: got.automatic, method: got.method ?? 'captions', source: 'github', at: now(), version: 2,
        })
        const job = (await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))?.find(j => j.mode === 'extract' && videoKey(j.url) === id)
        // Fresh words can improve an earlier video-only model read, even when
        // that older job is complete. The analyser decides if it is an upgrade.
        if (result === 'stored' || job?.stage !== 'complete') await enqueueSocialJobs(store, [{ ...video, mode: 'extract' }], now(), true)
        if (result === 'stored') { report.saved++; report[got.method === 'speech' ? 'speech' : 'captions']++ }
        if (old) attempts.splice(attempts.indexOf(old), 1)
      } else {
        report.unavailable++
        const reason = captureFailure(captionFailure === 'RequestBlocked' || captionFailure === 'IpBlocked' ? captionFailure : got.fail)
        report.reasons[reason] = (report.reasons[reason] ?? 0) + 1
        const count = (old?.attempts ?? 0) + 1
        const next = { id, at: now(), attempts: count, nextAt: now() + Math.min(24 * 3600, 3 * 3600 * 2 ** Math.min(count - 1, 3)) }
        if (old) attempts.splice(attempts.indexOf(old), 1)
        attempts.push(next)
      }
      await store.write(GITHUB_ATTEMPTS_KEY, attempts.slice(-1000))
      await heartbeat()
    }
    report.status = 'complete'
    return report
  } catch {
    report.status = 'error'
    // Never forward external HTML, token-bearing URLs or transcript text.
    throw new Error('github-capture-failed')
  } finally {
    report.running = false
    try { await heartbeat() } finally { await releaseLease(store, 'lease:github-video-capture', token) }
  }
}
