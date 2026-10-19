/** Transcript chain: free scrape first (the same caption track the YouTube
 * player loads — what browser extensions like Glasp read), Supadata as the
 * paid fallback, null → callers degrade to titles. YouTube blocks datacenter
 * IPs unpredictably, so the free tier is best-effort by design. */

import { fetchCaptionTranscript } from '../../../shared/youtubeCaptions.mjs'
export { videoIdFrom, canonicalVideoUrl, videoKey, pickTrack, parseTimedText } from '../../../shared/youtubeCaptions.mjs'

export async function fetchTranscriptFree(videoUrl: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const result = await fetchCaptionTranscript(videoUrl, fetchFn)
  if (result.text) return result.text
  console.log(`TRANSCRIPT: ${result.fail}`)
  return null
}

interface PollOptions {
  attempts?: number
  wait?: (ms: number) => Promise<void>
}

function transcriptContent(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const row = body as { content?: unknown; result?: unknown }
  if (row.result) return transcriptContent(row.result)
  const text = typeof row.content === 'string' ? row.content : Array.isArray(row.content)
    ? row.content.map(c => c && typeof c.text === 'string' ? c.text : '').join(' ') : ''
  return text.replace(/\s+/g, ' ').trim() || null
}

/** Fetch existing captions only: auto mode can silently buy AI transcription
 * by the minute. The bounded async path handles providers returning a job ID.
 * API contract: https://docs.supadata.ai/get-transcript */
export async function fetchTranscript(videoUrl: string, apiKey: string, fetchFn: typeof fetch = fetch, polling: PollOptions = {}): Promise<string | null> {
  try {
    const res = await fetchFn(`https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(videoUrl)}&text=true&mode=native&lang=en`, {
      headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) {
      // loud: a bad key or exhausted 100/mo free quota shows here instead of
      // silently dropping straight through to the paid Gemini rung
      console.warn(`TRANSCRIPT: supadata HTTP ${res.status} — falling through to the Gemini rung`)
      return null
    }
    const j = (await res.json()) as { jobId?: string }
    if (res.status !== 202) return transcriptContent(j)
    if (typeof j.jobId !== 'string' || !j.jobId) return null
    const wait = polling.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    for (let attempt = 0; attempt < (polling.attempts ?? 20); attempt++) {
      await wait(1000)
      const result = await fetchFn(`https://api.supadata.ai/v1/transcript/${encodeURIComponent(j.jobId)}`, {
        headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(10_000),
      })
      if (!result.ok) return null
      const job = (await result.json()) as { status?: string }
      if (job.status === 'completed') return transcriptContent(job)
      if (job.status === 'failed') return null
    }
    console.warn('TRANSCRIPT: supadata job still pending after bounded polling')
    return null
  } catch (e) {
    console.warn(`TRANSCRIPT: supadata fetch failed: ${String(e).slice(0, 120)}`)
    return null
  }
}

/** The chain: free scrape → Supadata (if keyed) → null. */
export async function fetchTranscriptAny(videoUrl: string, supadataKey: string | undefined, fetchFn: typeof fetch = fetch): Promise<{ text: string; source: 'free' | 'supadata' } | null> {
  const free = await fetchTranscriptFree(videoUrl, fetchFn)
  if (free) return { text: free, source: 'free' }
  if (supadataKey) {
    const paid = await fetchTranscript(videoUrl, supadataKey, fetchFn)
    if (paid) return { text: paid, source: 'supadata' }
  }
  return null
}
