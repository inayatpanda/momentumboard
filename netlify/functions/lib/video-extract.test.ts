import { describe, it, expect, vi, beforeEach } from 'vitest'
import { routeVideoAnalyze } from '../video-analyze-background.mts'
import { memoryStore } from './store'
import type { VideoExtract } from './videoTrends'

// The extract tier's rung ladder: caption scrape → (Supadata) → Gemini watches
// the video. The scrape fails routinely from datacenter IPs, so the Gemini
// rung is what keeps channel consensus alive — these tests pin that ladder.

const transcriptMock = vi.hoisted(() => ({ fetchTranscriptAny: vi.fn() }))
vi.mock('./transcripts', () => transcriptMock)
const llmMock = vi.hoisted(() => ({ callLlm: vi.fn() }))
vi.mock('../ai-insights.mts', () => llmMock)

const auth = new Headers({ 'x-app-token': 'app' })
const EXTRACT_JSON = '{"tickers":[{"sym":"NVDA","stance":"bull","levels":[1200]}],"themes":["ai-capex"]}'
const body = (url: string) => JSON.stringify({ url, title: 'NVDA breakout', channel: 'Test Channel', mode: 'extract' })

beforeEach(() => {
  transcriptMock.fetchTranscriptAny.mockReset()
  llmMock.callLlm.mockReset()
})

describe('extract tier rung ladder', () => {
  it('transcript rung: extracts via the text LLM and tags the row', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue({ text: 'a long transcript about NVDA', source: 'free' })
    llmMock.callLlm.mockResolvedValue({ text: EXTRACT_JSON })
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=t1'), { APP_TOKEN: 'app' }, store)
    expect(await res.text()).toBe('extracted:free')
    const rows = (await store.read<VideoExtract[]>('video-extracts'))!
    expect(rows[0].tickers[0].sym).toBe('NVDA')
    expect(rows[0].via).toBe('free')
  })

  it('supadata rung: the row is tagged supadata, not a generic transcript', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue({ text: 'a long transcript about NVDA', source: 'supadata' })
    llmMock.callLlm.mockResolvedValue({ text: EXTRACT_JSON })
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=s1'), { APP_TOKEN: 'app', SUPADATA_API_KEY: 'k' }, store)
    expect(await res.text()).toBe('extracted:supadata')
    const rows = (await store.read<VideoExtract[]>('video-extracts'))!
    expect(rows[0].via).toBe('supadata')
  })

  it('no transcript: Gemini watches the video and the row is tagged gemini-video', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue(null)
    const watch = vi.fn(async (_url: string, prompt: string) => {
      expect(prompt).toContain('Watch this stock-market video') // the video-native prompt, not the transcript one
      return EXTRACT_JSON
    })
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=g1'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(await res.text()).toBe('extracted:gemini-video')
    expect(watch).toHaveBeenCalledTimes(1)
    expect(llmMock.callLlm).not.toHaveBeenCalled()
    const rows = (await store.read<VideoExtract[]>('video-extracts'))!
    expect(rows[0].via).toBe('gemini-video')
    // monthly archive gets the same row
    const month = new Date().toISOString().slice(0, 7)
    expect(((await store.read<VideoExtract[]>(`video-extracts:${month}`)) ?? []).length).toBe(1)
  })

  it('every rung dead → 503 so the queue retries (captions may appear later)', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue(null)
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=d1'), { APP_TOKEN: 'app' }, store)
    expect(res.status).toBe(503)
  })

  it('gemini rung failure is caught → still 503, never a throw', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue(null)
    const watch = vi.fn(async () => {
      throw new Error('gemini-video: quota')
    })
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=f1'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(res.status).toBe(503)
  })

  it('gemini fallback has its own daily cap', async () => {
    const store = memoryStore()
    const now = Math.floor(Date.now() / 1000)
    await store.write(
      'video-extracts',
      Array.from({ length: 12 }, (_, i) => ({ url: `u${i}`, title: '', channel: '', at: now - 100, tickers: [], themes: [], via: 'gemini-video' })),
    )
    transcriptMock.fetchTranscriptAny.mockResolvedValue(null)
    const watch = vi.fn(async () => EXTRACT_JSON)
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=c1'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(await res.text()).toBe('gemini-extract-capped')
    expect(watch).not.toHaveBeenCalled()
  })

  it('transcript-rung rows do not eat the gemini cap', async () => {
    const store = memoryStore()
    const now = Math.floor(Date.now() / 1000)
    await store.write(
      'video-extracts',
      Array.from({ length: 12 }, (_, i) => ({ url: `u${i}`, title: '', channel: '', at: now - 100, tickers: [], themes: [], via: 'transcript' })),
    )
    transcriptMock.fetchTranscriptAny.mockResolvedValue(null)
    const watch = vi.fn(async () => EXTRACT_JSON)
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=c2'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(await res.text()).toBe('extracted:gemini-video')
  })
})
