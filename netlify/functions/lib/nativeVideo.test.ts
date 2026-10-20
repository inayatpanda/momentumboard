import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from './store'
import { nativeDraftExtract, nativeDraftText, publishNativeDraft, readNativeVideo, NATIVE_VIDEO_MODEL, type NativeVideoDraft } from './nativeVideo'
import { computeConsensus } from './videoTrends'
import type { InboxVideo } from './videoTranscriptStore'

const video: InboxVideo = { url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Fresh company discussion', channel: 'Creator', channelId: 'UCexample', publishedAt: 100, at: 101 }
const quote = 'NVIDIA faces weaker orders and I remain cautious about NVIDIA.'
const draft = (): NativeVideoDraft => ({
  url: video.url, at: 200, model: NATIVE_VIDEO_MODEL, finishReason: 'STOP', limitSeconds: 5400,
  result: { canAccessAudio: true, complete: true, durationSeconds: 52, transcript: `${quote} This is a discussion of a business, not a verified investment conclusion.`,
    tickers: [{ sym: 'NVDA', company: 'NVIDIA', stance: 'bear', evidenceQuote: quote, thesis: 'Orders may weaken.', condition: null, levels: [] }], themes: ['chip-demand'] },
})

describe('direct cloud video reads', () => {
  it('keeps claims from later sections beyond the per-request ticker limit', () => {
    const data = draft()
    data.progress = { sections: 4, processedSeconds: 2400, sourceDurationSeconds: 2400, completion: 'complete' }
    data.result.transcript += ' Apple faces a decline in demand for its products.'
    data.result.tickers = [...Array(11).fill(data.result.tickers![0]), { sym: 'AAPL', company: 'Apple', stance: 'bear', evidenceQuote: 'Apple faces a decline in demand' }]
    const extract = nativeDraftExtract(data, video, 300)!
    expect(extract.tickers.map(t => t.sym)).toEqual(['NVDA', 'AAPL'])
    expect(extract.coverage).toMatchObject({ chunks: 4, complete: false })
  })
  it('uses a bounded native video input and stores no provider credentials in the result', async () => {
    const fetcher = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(draft().result) }] } }] }))
    const result = await readNativeVideo(video.url, 'test-key', fetcher as typeof fetch)
    const [url, opts] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`/models/${NATIVE_VIDEO_MODEL}:generateContent`)
    const request = JSON.parse(String(opts.body))
    expect(request.contents[0].parts[0]).toEqual({ fileData: { fileUri: video.url, mimeType: 'video/*' }, videoMetadata: { startOffset: '0s', endOffset: '1200s' } })
    expect(request.generationConfig.maxOutputTokens).toBe(16000)
    expect(nativeDraftText(result)).toContain(quote)
    expect(JSON.stringify(result)).not.toContain('test-key')
  })
  it('rejects inaccessible, truncated, malformed and wrong-video outputs', () => {
    expect(nativeDraftText({ ...draft(), finishReason: 'MAX_TOKENS' })).toBeNull()
    expect(nativeDraftText({ ...draft(), result: { ...draft().result, canAccessAudio: false } })).toBeNull()
    expect(nativeDraftText({ ...draft(), result: { ...draft().result, transcript: 'A summary' } })).toBeNull()
    expect(nativeDraftExtract(draft(), { ...video, url: 'https://youtu.be/zzzzzzzzzzz' }, 300)).toBeNull()
  })
  it('uses the whole source when public metadata confirms a short completed video', async () => {
    const fetcher = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(draft().result) }] } }] }))
    await readNativeVideo(video.url, 'key', fetcher as typeof fetch, 117)
    const opts = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(opts.body)).contents[0].parts[0]).toEqual({ fileData: { fileUri: video.url, mimeType: 'video/*' } })
  })
  it('never treats a model transcript as independent quote verification or a consensus vote', () => {
    const extract = nativeDraftExtract(draft(), video, 300)!
    expect(extract.claims?.[0]).toMatchObject({ sym: 'NVDA', sourceMatch: 'visual-unchecked', identityMatched: false, unconditional: false })
    expect(extract.coverage).toMatchObject({ complete: false, timedSegments: 0, visual: 'model-reviewed-unverified' })
    expect(extract.nativeTranscript).toMatchObject({ reportedComplete: true, characters: draft().result.transcript!.length })
    expect(computeConsensus([extract], 301).tickers).toEqual([])
  })
  it('drops claims whose quoted words are absent, and marks over-limit reads partial', () => {
    const data = draft()
    data.result.tickers!.push({ sym: 'AAPL', evidenceQuote: 'Apple is a guaranteed winner tomorrow.' })
    data.result.durationSeconds = 6000
    expect(nativeDraftExtract(data, video, 300)).toMatchObject({ tickers: [{ sym: 'NVDA' }], nativeTranscript: { reportedComplete: false } })
    expect(nativeDraftExtract(data, video, 300)!.tickers).toHaveLength(1)
  })
  it('publishes durably and idempotently while keeping machine text out of the caption store', async () => {
    const store = memoryStore()
    expect(await publishNativeDraft(store, draft(), video, 300)).toBe('published')
    expect(await publishNativeDraft(store, draft(), video, 400)).toBe('already')
    expect(await store.read('video-extracts')).toMatchObject([{ at: 300, via: 'gemini-video', nativeTranscript: { model: NATIVE_VIDEO_MODEL } }])
    expect(await store.read('video-extract:v1:abcdefghijk')).toMatchObject({ via: 'gemini-video' })
    expect(await store.read('video-transcript:abcdefghijk')).toBeNull()
    expect(await store.read('lease:video-extract-publish')).toMatchObject({ expiresAt: 0 })
  })
  it('repairs a completion-key interruption without replacing independent evidence', async () => {
    const store = memoryStore()
    const existing = { ...nativeDraftExtract(draft(), video, 250)!, via: 'github' as const }
    await store.write('video-extracts', [existing])
    expect(await publishNativeDraft(store, draft(), video, 300)).toBe('already')
    expect(await store.read('video-extract:v1:abcdefghijk')).toMatchObject({ at: 250, via: 'github' })
  })
  it('returns only a categorical HTTP error and makes no second request on quota failure', async () => {
    const fetcher = vi.fn(async () => new Response('private provider diagnostics', { status: 429 }))
    await expect(readNativeVideo(video.url, 'key', fetcher as typeof fetch)).rejects.toThrow('native-http-429')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
