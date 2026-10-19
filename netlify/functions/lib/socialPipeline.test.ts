import { describe, expect, it, vi, afterEach } from 'vitest'
import { memoryStore } from './store'
import { enqueueSocialJobs, eligibleSocialJobs, finishSocialAttempt, SOCIAL_JOBS_KEY, socialJobId, type SocialJob } from './socialJobs'
import { recordInboxVideos } from './videoTranscriptStore'
import { routeVideoTranscripts } from '../video-transcripts.mts'
import { routeVideoAnalyze } from '../video-analyze-background.mts'
import { pollVideoCaptures } from '../video-capture-poll.mts'
import { retryVideoJob } from '../video-jobs.mts'
import { SOCIAL_LEDGER_KEY } from './socialLedger'
import { videoIngestionHealth } from './videoIngestion'
import type { VideoExtract } from './videoTrends'
import { extractTranscriptFacts, ExtractionPending } from './videoTranscriptAnalysis'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { d1AppStore, ensureD1Schema } from './d1Store'
import { reserveSocialBudget } from './socialBudget'

const llm = vi.hoisted(() => vi.fn())
vi.mock('../ai-insights.mts', () => ({ callLlm: llm }))
const source = { url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Tesla outlook', channel: 'Research channel', channelId: 'UCstable' }
const quote = 'Tesla is bullish for the next year.'
const text = quote + ' This is a discussion of the company and its business risks, with no guarantee of investment returns.'
const raw = JSON.stringify({ tickers: [{ sym: 'TSLA', company: 'Tesla', stance: 'bull', evidenceQuote: quote, condition: null, horizon: 'next year' }], themes: ['ev'] })
afterEach(() => { llm.mockReset(); vi.restoreAllMocks() })

describe('social evidence pipeline, end to end', () => {
  it('discovers → receives timed captions → extracts → publishes → retains a pending outcome independently of the feed', async () => {
    const store = memoryStore(), now = Math.floor(Date.now() / 1000)
    await recordInboxVideos(store, [{ ...source, publishedAt: now - 86400 }], now)
    const upload = await routeVideoTranscripts(new Headers({ 'x-transcript-token': 'runner' }), 'POST', new URLSearchParams(), JSON.stringify({ ...source, text, segments: [{ text: quote, startSec: 30, endSec: 34 }, { text: text.slice(quote.length).trim(), startSec: 34, endSec: 45 }], language: 'en' }), { TRANSCRIPT_TOKEN: 'runner' }, store)
    expect(upload.status).toBe(200)
    expect(eligibleSocialJobs(await store.read<SocialJob[]>(SOCIAL_JOBS_KEY) ?? [], now)).toHaveLength(1)
    llm.mockResolvedValue({ text: raw })
    const analyze = () => routeVideoAnalyze(new Headers({ 'x-app-token': 'owner' }), JSON.stringify({ ...source, mode: 'extract' }), { APP_TOKEN: 'owner' }, store)
    expect((await analyze()).status).toBe(200)
    const extract = (await store.read<VideoExtract[]>('video-extracts'))![0]
    expect(extract).toMatchObject({ channelId: source.channelId, publishedAt: now - 86400, coverage: { complete: true, timedSegments: 2 } })
    expect(extract.claims?.[0]).toMatchObject({ sourceMatch: 'matched', identityMatched: true, startSec: 30, horizon: 'next year' })
    await store.write('video-extracts', [])
    expect(await store.read(SOCIAL_LEDGER_KEY)).toMatchObject([{ sym: 'TSLA', publishedAt: now - 86400 }])
    const tracked = (await store.read<{ availableAt: number }[]>(SOCIAL_LEDGER_KEY))![0]
    expect(tracked.availableAt).toBeGreaterThanOrEqual(extract.at)
    expect((await analyze()).status).toBe(200)
    expect(llm).toHaveBeenCalledTimes(1)
    expect(await store.read(SOCIAL_LEDGER_KEY)).toHaveLength(1)
    expect((await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))?.[0].stage).toBe('complete')
  })
  it('does not backdate tracking after a failed publication', async () => {
    const store = memoryStore()
    await store.write('video-transcripts', [{ ...source, text, source: 'local', at: 100 }])
    llm.mockResolvedValue({ text: raw })
    const failing = { ...store, write: async (key: string, value: unknown) => { if (key === 'video-extracts') throw new Error('publication failed'); await store.write(key, value) } }
    const input = JSON.stringify({ ...source, mode: 'extract' })
    expect((await routeVideoAnalyze(new Headers({ 'x-app-token': 'owner' }), input, { APP_TOKEN: 'owner' }, failing)).status).toBe(503)
    expect(await store.read(SOCIAL_LEDGER_KEY)).toBeNull()
    expect((await routeVideoAnalyze(new Headers({ 'x-app-token': 'owner' }), input, { APP_TOKEN: 'owner' }, store)).status).toBe(200)
    expect(await store.read(SOCIAL_LEDGER_KEY)).toHaveLength(1)
  })
  it('checkpoints completed chunks across process restarts without publishing a partial analysis', async () => {
    const store = memoryStore(), long = 'Tesla discussion. '.repeat(3000)
    const call = vi.fn().mockResolvedValue(raw)
    const meta = { ...source, at: 100 }
    const options = { store, checkpointKey: 'chunk-test', maxNewChunks: 1 }
    await expect(extractTranscriptFacts(long, meta, '', call, options)).rejects.toBeInstanceOf(ExtractionPending)
    expect(call).toHaveBeenCalledTimes(1)
    await expect(extractTranscriptFacts(long, meta, '', call, options)).rejects.toBeInstanceOf(ExtractionPending)
    const done = await extractTranscriptFacts(long, meta, '', call, options)
    expect(done?.coverage).toMatchObject({ complete: true, chunks: 3, analysedChunks: 3 })
    expect(call).toHaveBeenCalledTimes(3)
  })
  it('polls a persisted provider job before expiry and cannot start a fresh transcription', async () => {
    const store = memoryStore()
    await enqueueSocialJobs(store, [source], 100)
    const jobs = await store.read<SocialJob[]>(SOCIAL_JOBS_KEY)
    jobs![0].stage = 'waiting-provider'; await store.write(SOCIAL_JOBS_KEY, jobs)
    await store.write('video-capture:abcdefghijk', { providerJobId: 'pending-id', requestedAt: 100 })
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'completed', content: [{ text, offset: 0, duration: 10000 }], lang: 'en' }))
    expect(await pollVideoCaptures(store, 'key', 200, fetch)).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://api.supadata.ai/v1/transcript/pending-id')
    expect((await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))?.[0].stage).toBe('queued')
  })
  it('retains budget waits indefinitely, exposes persistent errors and permits only owner retries', async () => {
    const store = memoryStore()
    await enqueueSocialJobs(store, [source], 100)
    const id = socialJobId(source.url)
    for (let i = 0; i < 10; i++) await finishSocialAttempt(store, id, { ok: false, reason: 'gemini-extract-capped', retryAfterSec: 86400 }, 100 + i * 86400)
    expect((await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))?.[0]).toMatchObject({ attempts: 0, stage: 'queued' })
    for (let i = 0; i < 6; i++) await finishSocialAttempt(store, id, { ok: false, reason: 'provider-unavailable' }, 1000000 + i)
    expect((await videoIngestionHealth(store, [], 2000000)).failed).toBe(1)
    expect((await retryVideoJob(new Headers(), JSON.stringify({ id }), 'owner', store)).status).toBe(401)
    expect((await retryVideoJob(new Headers({ 'x-app-token': 'owner' }), JSON.stringify({ id }), 'owner', store)).status).toBe(200)
    expect((await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))?.[0]).toMatchObject({ stage: 'queued', attempts: 0 })
  })
  it('serialises concurrent D1 producers without losing or duplicating videos', async () => {
    const sqlite = openSqliteD1(':memory:')
    try {
      await ensureD1Schema(sqlite)
      const store = d1AppStore(sqlite)
      await Promise.all([enqueueSocialJobs(store, [source], 100), enqueueSocialJobs(store, [{ ...source, url: 'https://youtu.be/abcdefghijl' }], 100)])
      await enqueueSocialJobs(store, [{ ...source, url: 'https://youtu.be/abcdefghijk' }], 101)
      expect(await store.read(SOCIAL_JOBS_KEY)).toHaveLength(2)
      const jobs = await store.read<SocialJob[]>(SOCIAL_JOBS_KEY) ?? []
      await Promise.all([finishSocialAttempt(store, jobs[0].id, { ok: true }, 200), enqueueSocialJobs(store, [{ ...source, url: 'https://youtu.be/abcdefghijm' }], 200)])
      expect((await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))?.filter(j => j.stage !== 'complete')).toHaveLength(2)
    } finally { sqlite.close() }
  })
  it('reserves billable attempts before success and separately limits video modes', async () => {
    const store = memoryStore(), now = 1780000000
    expect(await reserveSocialBudget(store, 'gemini-extract', now)).toBe(true)
    expect(await reserveSocialBudget(store, 'gemini-extract', now)).toBe(true)
    expect(await reserveSocialBudget(store, 'gemini-extract', now)).toBe(false)
    expect(await reserveSocialBudget(store, 'gemini-watch', now)).toBe(true)
    expect(await reserveSocialBudget(store, 'gemini-watch', now)).toBe(false)
    expect(await reserveSocialBudget(store, 'gemini-extract', now + 86400)).toBe(true)
  })
})
