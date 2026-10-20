import { reserveSocialBudget } from './socialBudget'
import { fetchCaptionTranscript, type CaptionSegment } from '../../../shared/youtubeCaptions.mjs'
import type { AppStore } from './storeProvider'
import { PROVIDER_HEALTH_KEY, type TranscriptProviderHealth } from './transcriptProviderHealth'

export interface CapturedTranscript { text: string; segments: CaptionSegment[]; language: string; source: 'free' | 'supadata'; automatic?: boolean }
export type CaptureResult = { status: 'ready'; transcript: CapturedTranscript } | { status: 'waiting' } | { status: 'unavailable' }
export interface CaptureCheckpoint { providerJobId?: string; requestedAt?: number; lastError?: string }

function readContent(data: unknown): CapturedTranscript | null {
  if (!data || typeof data !== 'object') return null
  const row = data as { result?: unknown; content?: unknown; lang?: string }
  if (row.result) return readContent(row.result)
  const segments: CaptionSegment[] = Array.isArray(row.content) ? row.content.flatMap((c: { text?: unknown; offset?: unknown; duration?: unknown }) => {
    if (typeof c?.text !== 'string' || !c.text.trim()) return []
    const startSec = typeof c.offset === 'number' && Number.isFinite(c.offset) && c.offset >= 0 ? c.offset / 1000 : undefined
    return [{ text: c.text.trim(), ...(startSec != null ? { startSec, endSec: startSec + (typeof c.duration === 'number' && Number.isFinite(c.duration) && c.duration >= 0 ? c.duration / 1000 : 0) } : {}) }]
  }) : []
  const text = (typeof row.content === 'string' ? row.content : segments.map(s => s.text).join(' ')).replace(/\s+/g, ' ').trim()
  return text.length >= 100 && text.length <= 300_000 ? { text, segments, language: typeof row.lang === 'string' ? row.lang.slice(0, 20) : 'und', source: 'supadata' } : null
}

/** One durable provider operation per attempt. A 202 job is saved before
 * returning; the next worker polls that exact job instead of buying another. */
export async function captureTranscript(store: AppStore, checkpointKey: string, url: string, key?: string, fetchFn: typeof fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<CaptureResult> {
  const state = await store.read<CaptureCheckpoint>(checkpointKey) ?? {}
  if (!state.providerJobId) {
    const free = await fetchCaptionTranscript(url, fetchFn)
    if (free.text) return { status: 'ready', transcript: { ...free, source: 'free' } }
  }
  if (!key) return { status: 'unavailable' }
  const health = await store.read<TranscriptProviderHealth>(PROVIDER_HEALTH_KEY)
  if (!state.providerJobId && health && nowSec - health.checkedAt < 6 * 3600 && ['exhausted', 'unauthorized'].includes(health.status)) return { status: 'unavailable' }
  // Do not silently resubmit a lost/failed job. Retain its identity for diagnosis.
  if (state.lastError) return { status: 'unavailable' }
  if (state.requestedAt != null && nowSec - state.requestedAt > 7 * 86_400) {
    await store.write(checkpointKey, { ...state, lastError: 'provider-job-expired' })
    return { status: 'unavailable' }
  }
  if (!state.providerJobId && !await reserveSocialBudget(store, 'native', nowSec)) return { status: 'unavailable' }
  const endpoint = state.providerJobId ? `https://api.supadata.ai/v1/transcript/${encodeURIComponent(state.providerJobId)}`
    : `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}&text=false&mode=native&lang=en`
  const res = await fetchFn(endpoint, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(25_000) })
  if (!res.ok) {
    if (state.providerJobId && res.status === 404) {
      await store.write(checkpointKey, { ...state, lastError: 'provider-job-expired' })
      return { status: 'unavailable' }
    }
    if (!state.providerJobId && [404, 422].includes(res.status)) return { status: 'unavailable' }
    throw new Error(`transcript-provider-http-${res.status}`)
  }
  const data = await res.json() as { jobId?: unknown; status?: string }
  if (res.status === 202 && typeof data.jobId === 'string' && data.jobId) {
    await store.write(checkpointKey, { providerJobId: data.jobId, requestedAt: nowSec })
    return { status: 'waiting' }
  }
  if (state.providerJobId && ['queued', 'active', 'processing', 'pending'].includes(data.status ?? '')) return { status: 'waiting' }
  if (data.status === 'failed') {
    await store.write(checkpointKey, { ...state, lastError: 'provider-job-failed' })
    return { status: 'unavailable' }
  }
  const transcript = readContent(data)
  if (transcript) return { status: 'ready', transcript }
  if (state.providerJobId && data.status !== 'completed') return { status: 'waiting' }
  return { status: 'unavailable' }
}
