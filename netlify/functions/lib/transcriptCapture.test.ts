import { describe, expect, it, vi } from 'vitest'
import { captureTranscript } from './transcriptCapture'
import { memoryStore } from './store'
import { parseCaptionSegments } from '../../../shared/youtubeCaptions.mjs'
import { validatedSegments, readStoredTranscript, saveTranscript } from './videoTranscriptStore'
const url = 'https://www.youtube.com/watch?v=abcdefghijk'
const text = 'Tesla is bullish with durable annual revenue and a clear management plan. '.repeat(3).trim()

describe('timestamped transcript capture and recovery', () => {
  it('parses XML srv1, srv3 and JSON3 without fabricating missing timecodes', () => {
    expect(parseCaptionSegments('<text start="2.5" dur="2">A &amp; B</text>')).toEqual([{ text: 'A & B', startSec: 2.5, endSec: 4.5 }])
    expect(parseCaptionSegments('<p t="2500" d="2000"><s>A</s> B</p>')).toEqual([{ text: 'A B', startSec: 2.5, endSec: 4.5 }])
    expect(parseCaptionSegments('{"events":[{"tStartMs":500,"dDurationMs":1500,"segs":[{"utf8":"A"}]},{"segs":[{"utf8":"B"}]}]}')).toEqual([{ text: 'A', startSec: .5, endSec: 2 }, { text: 'B' }])
  })
  it('persists async identity, resumes it without a new purchase and preserves milliseconds', async () => {
    const store = memoryStore()
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({ jobId: 'durable-job' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: 'active' })).mockResolvedValueOnce(Response.json({ status: 'completed', result: { content: [{ text, offset: 6500, duration: 3000 }], lang: 'en' } }))
    expect(await captureTranscript(store, 'checkpoint', url, 'key', fetch, 100)).toEqual({ status: 'waiting' })
    expect(await store.read('checkpoint')).toEqual({ providerJobId: 'durable-job', requestedAt: 100 })
    expect(await captureTranscript(store, 'checkpoint', url, 'key', fetch, 101)).toEqual({ status: 'waiting' })
    expect(await captureTranscript(store, 'checkpoint', url, 'key', fetch, 102)).toMatchObject({ status: 'ready', transcript: { segments: [{ text, startSec: 6.5, endSec: 9.5 }] } })
    expect(fetch.mock.calls.filter(c => String(c[0]).includes('?url='))).toHaveLength(1)
    expect(fetch.mock.calls[1][0]).toContain('mode=native')
  })
  it('retains expired IDs and never silently pays for a replacement', async () => {
    const store = memoryStore(); await store.write('checkpoint', { providerJobId: 'expired', requestedAt: 100 })
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    expect(await captureTranscript(store, 'checkpoint', url, 'key', fetch, 200)).toEqual({ status: 'unavailable' })
    expect(await store.read('checkpoint')).toMatchObject({ providerJobId: 'expired', lastError: 'provider-job-expired' })
    await captureTranscript(store, 'checkpoint', url, 'key', fetch, 201)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('durably retrieves transcripts outside the display window, and permits timing upgrades only for identical words', async () => {
    const store = memoryStore(), rec = { url, title: 'T', channel: 'C', text, source: 'local' as const, at: 100 }
    await saveTranscript(store, rec)
    await store.write('video-transcripts', [])
    expect((await readStoredTranscript(store, url))?.text).toBe(text)
    await saveTranscript(store, { ...rec, segments: [{ text, startSec: 0, endSec: 10 }] })
    expect((await readStoredTranscript(store, url))?.version).toBe(2)
    expect(await store.read(`video-transcript:abcdefghijk:v1`)).toMatchObject({ text })
    expect(await saveTranscript(store, { ...rec, text: 'rewritten words' })).toBe('already')
    expect(validatedSegments([{ text: 'wrong words', startSec: 0, endSec: 10 }], text)).toEqual([])
  })
})
