import { describe, it, expect, vi, beforeEach } from 'vitest'
import { routeVideoAnalyze } from '../video-analyze-background.mts'
import { memoryStore } from './store'
import type { VideoExtract } from './videoTrends'

// The extract tier's rung ladder: caption scrape → (Supadata) → Gemini watches
// the video. The scrape fails routinely from datacenter IPs, so the Gemini
// rung is what keeps channel consensus alive — these tests pin that ladder.

const transcriptMock = vi.hoisted(() => ({ fetchTranscriptAny: vi.fn() }))
vi.mock('./transcriptCapture', () => ({ captureTranscript: async () => { const value = await transcriptMock.fetchTranscriptAny(); return value ? { status: 'ready', transcript: { segments: [], language: 'en', ...value } } : { status: 'unavailable' } } }))
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
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=t1000000000'), { APP_TOKEN: 'app' }, store)
    expect(await res.text()).toBe('extracted:free')
    const rows = (await store.read<VideoExtract[]>('video-extracts'))!
    expect(rows[0].tickers[0].sym).toBe('NVDA')
    expect(rows[0].via).toBe('free')
  })

  it('supadata rung: the row is tagged supadata, not a generic transcript', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue({ text: 'a long transcript about NVDA', source: 'supadata' })
    llmMock.callLlm.mockResolvedValue({ text: EXTRACT_JSON })
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=s1000000000'), { APP_TOKEN: 'app', SUPADATA_API_KEY: 'k' }, store)
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
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=g1000000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
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
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=d1000000000'), { APP_TOKEN: 'app' }, store)
    expect(res.status).toBe(503)
  })

  it('gemini rung failure is caught → still 503, never a throw', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue(null)
    const watch = vi.fn(async () => {
      throw new Error('gemini-video: quota')
    })
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=f1000000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(res.status).toBe(503)
  })

  it('gemini fallback has its own daily cap — 2, an emergency valve, not a rung', async () => {
    // owner directive 2026-08-16: 49 of the week's 53 extracts were Gemini
    // WATCHING the video. With the local transcript store as the first rung
    // the video-watch fallback drops from 12/day to 2.
    const store = memoryStore()
    const now = Math.floor(Date.now() / 1000)
    await store.write(
      'video-extracts',
      Array.from({ length: 2 }, (_, i) => ({ url: `u${i}`, title: '', channel: '', at: now - 100, tickers: [], themes: [], via: 'gemini-video' })),
    )
    transcriptMock.fetchTranscriptAny.mockResolvedValue(null)
    const watch = vi.fn(async () => EXTRACT_JSON)
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=c1000000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await res.text()).toBe('gemini-extract-capped')
    expect(watch).not.toHaveBeenCalled()
  })

  it('malformed extraction is retryable and never persisted as a completed read', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue({ text: 'NVDA discussion '.repeat(10), source: 'free' })
    llmMock.callLlm.mockResolvedValue({ text: '{"error":"model did not read video"}' })
    const res = await routeVideoAnalyze(auth, body('https://youtu.be/abcdefghijk'), { APP_TOKEN: 'app' }, store)
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('unparseable-extract')
    expect(await store.read('video-extracts')).toBeNull()
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
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=c2000000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(await res.text()).toBe('extracted:gemini-video')
  })
})

// THE LOCAL RUNG (owner directive 2026-08-16): the Mac runner writes captions
// into `video-transcripts`, and the pipeline reads that store BEFORE any
// network rung — no scrape, no Supadata, and above all no Gemini video-watch.
describe('the local transcript store is the first rung', () => {
  const stored = (url: string) => ({ url, title: 'NVDA breakout', channel: 'Test Channel', text: 'a stored transcript about NVDA '.repeat(10), source: 'local', at: 1 })

  it('publishes a GitHub speech transcript into the app feed with its original provenance', async () => {
    const store = memoryStore()
    const url = 'https://www.youtube.com/watch?v=cloud000001'
    await store.write('video-transcript:cloud000001', { ...stored(url), source: 'github', method: 'speech' })
    llmMock.callLlm.mockResolvedValue({ text: EXTRACT_JSON })
    const watch = vi.fn()
    const res = await routeVideoAnalyze(auth, body(url), { APP_TOKEN: 'app' }, store, watch as never)
    expect(await res.text()).toBe('extracted:github')
    expect(transcriptMock.fetchTranscriptAny).not.toHaveBeenCalled()
    expect(watch).not.toHaveBeenCalled()
    expect(await store.read('video-extracts')).toMatchObject([{ via: 'github', transcriptMethod: 'speech', tickers: [{ sym: 'NVDA' }] }])
    expect(await store.read('video-extract:v1:cloud000001')).toMatchObject({ via: 'github' })
  })

  it('extract: a stored transcript short-circuits every network rung and tags via=local', async () => {
    const store = memoryStore()
    await store.write('video-transcripts', [stored('https://youtube.com/watch?v=loc10000000')])
    llmMock.callLlm.mockResolvedValue({ text: EXTRACT_JSON })
    const watch = vi.fn()
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=loc10000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch as never)
    expect(await res.text()).toBe('extracted:local')
    expect(transcriptMock.fetchTranscriptAny).not.toHaveBeenCalled()
    expect(watch).not.toHaveBeenCalled()
    const rows = (await store.read<VideoExtract[]>('video-extracts'))!
    expect(rows[0].via).toBe('local')
  })

  it('extract condensation runs DeepSeek-forced — Groq is not the video tier’s wallet', async () => {
    const store = memoryStore()
    await store.write('video-transcripts', [stored('https://youtube.com/watch?v=loc20000000')])
    llmMock.callLlm.mockResolvedValue({ text: EXTRACT_JSON })
    await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=loc20000000'), { APP_TOKEN: 'app' }, store)
    const envArg = llmMock.callLlm.mock.calls[0][1] as { LLM_PROVIDER?: string }
    expect(envArg.LLM_PROVIDER).toBe('openai')
  })

  it('a scraped transcript is PERSISTED to the store, so the words survive the extraction', async () => {
    const store = memoryStore()
    transcriptMock.fetchTranscriptAny.mockResolvedValue({ text: 'a scraped transcript about NVDA '.repeat(10), source: 'free' })
    llmMock.callLlm.mockResolvedValue({ text: EXTRACT_JSON })
    await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=scr10000000'), { APP_TOKEN: 'app' }, store)
    const kept = (await store.read<{ url: string; source: string }[]>('video-transcript-index:v2'))!
    expect(kept[0].url).toBe('https://www.youtube.com/watch?v=scr10000000')
    expect(kept[0].source).toBe('free')
  })
})

// THE WATCH TIER on the same diet: it reads ONLY the transcript store (the
// extract tier and the runner both feed it), analyses the words via the
// DeepSeek-forced text LLM, and may fall back to a real Gemini watch at most
// ONCE a day — down from three.
describe('watch tier, transcript-first', () => {
  const watchBody = (url: string) => JSON.stringify({ url, title: 'TSLA levels', channel: 'Stocks with Josh', mode: 'watch' })

  it('reads sections beyond the old cutoff before synthesizing a narrative', async () => {
    const store = memoryStore()
    await store.write('video-transcripts', [{ url: 'https://youtu.be/abcdefghijk', text: 'TSLA levels. '.repeat(2000) + 'Closing view: Rocket Lab.', source: 'local', at: 1 }])
    llmMock.callLlm.mockResolvedValue({ text: 'Section summary.' })
    await routeVideoAnalyze(auth, watchBody('https://youtube.com/watch?v=abcdefghijk'), { APP_TOKEN: 'app' }, store)
    expect(llmMock.callLlm).toHaveBeenCalledTimes(3)
    expect(llmMock.callLlm.mock.calls[1][0]).toContain('Closing view: Rocket Lab.')
    expect(llmMock.callLlm.mock.calls[2][0]).toContain('Combine these section summaries')
  })

  it('a stored transcript is analysed by the text LLM — Gemini never watches', async () => {
    const store = memoryStore()
    await store.write('video-transcripts', [{ url: 'https://youtube.com/watch?v=w1000000000', title: 'TSLA levels', channel: 'Stocks with Josh', text: 'TSLA support at 180 '.repeat(20), source: 'local', at: 1 }])
    llmMock.callLlm.mockResolvedValue({ text: 'TSLA discussed; support stated at 180; bullish.' })
    const watch = vi.fn()
    const res = await routeVideoAnalyze(auth, watchBody('https://youtube.com/watch?v=w1000000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch as never)
    expect(res.status).toBe(200)
    expect(watch).not.toHaveBeenCalled()
    const envArg = llmMock.callLlm.mock.calls[0][1] as { LLM_PROVIDER?: string }
    expect(envArg.LLM_PROVIDER).toBe('openai')
    const list = (await store.read<{ analysis: string; via?: string }[]>('video-analyses'))!
    expect(list[0].analysis).toContain('support stated at 180')
    expect(list[0].via).toBe('transcript')
  })

  it('no transcript yet: one Gemini watch a day, then deferred so the queue retries', async () => {
    const store = memoryStore()
    const now = Math.floor(Date.now() / 1000)
    await store.write('video-analyses', [{ url: 'u-g', title: '', channel: '', analysis: 'x', at: now - 100, via: 'gemini-video' }])
    const watch = vi.fn(async () => 'y')
    const res = await routeVideoAnalyze(auth, watchBody('https://youtube.com/watch?v=w2000000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(res.status).toBe(429)
    expect(watch).not.toHaveBeenCalled()
  })

  it('legacy via-less analyses count as Gemini watches — they were', async () => {
    const store = memoryStore()
    const now = Math.floor(Date.now() / 1000)
    await store.write('video-analyses', [{ url: 'u-old', title: '', channel: '', analysis: 'x', at: now - 100 }])
    const watch = vi.fn(async () => 'y')
    const res = await routeVideoAnalyze(auth, watchBody('https://youtube.com/watch?v=w3000000000'), { APP_TOKEN: 'app', GEMINI_API_KEY: 'k' }, store, watch)
    expect(res.status).toBe(429)
    expect(watch).not.toHaveBeenCalled()
  })
})

it('resumes a long narrative from saved sections after a worker restart', async () => {
  const store = memoryStore(), url = 'https://www.youtube.com/watch?v=checkpoint1'
  await store.write('video-transcripts', [{ url, text: 'Tesla discussion. '.repeat(3000), source: 'local', at: 1 }])
  llmMock.callLlm.mockResolvedValue({ text: 'A sourced section summary.' })
  const input = JSON.stringify({ url, title: 'Long discussion', channel: 'Test', mode: 'watch' })
  expect((await routeVideoAnalyze(auth, input, { APP_TOKEN: 'app' }, store)).status).toBe(429)
  expect(llmMock.callLlm).toHaveBeenCalledTimes(2)
  expect(await store.read('video-analyses')).toBeNull()
  expect((await routeVideoAnalyze(auth, input, { APP_TOKEN: 'app' }, store)).status).toBe(200)
  expect(llmMock.callLlm).toHaveBeenCalledTimes(4) // third section + final synthesis
})
