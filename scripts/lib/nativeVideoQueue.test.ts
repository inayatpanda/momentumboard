import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from '../../netlify/functions/lib/store'
import { NATIVE_VIDEO_MODEL, type NativeVideoDraft } from '../../netlify/functions/lib/nativeVideo'
import { nativeBudgetKey, readNativeBudget, reserveNativeRead } from '../../netlify/functions/lib/nativeVideoBudget'
import { nativeQuotaDay, nativeQuotaReset, NATIVE_DAILY_SECONDS } from '../../shared/nativeVideoPolicy'
import { collectNativeVideos, nextNativeWork, NATIVE_PROGRESS_KEY, type NativeVideoWork } from './nativeVideoQueue'

const video = (id = 'abcdefghijk', channelId = 'UCtest') => ({ url: `https://www.youtube.com/watch?v=${id}`, channel: channelId, channelId, title: 'Business discussion', at: 100, publishedAt: 100 })
const speech = 'NVIDIA faces weaker demand and I remain cautious about NVIDIA. This is a conditional discussion of business prospects rather than a promise about returns.'
const result = { canAccessAudio: true, complete: false, transcript: speech, tickers: [{ sym: 'NVDA', company: 'NVIDIA', stance: 'bear', evidenceQuote: 'NVIDIA faces weaker demand', thesis: 'Weaker demand' }], themes: [] }
async function setup(duration = 1860) {
  const store = memoryStore()
  await store.write('config', { ytChannels: [{ id: 'UCtest', name: 'UCtest' }, { id: 'UCother', name: 'UCother' }] })
  await store.write('video-inbox', [video()])
  let time = Date.parse('2026-10-21T10:00:00Z') / 1000
  const readSection = vi.fn(async (url, _key, _fetch, _duration, section): Promise<NativeVideoDraft> => ({ url, at: time, model: NATIVE_VIDEO_MODEL, finishReason: 'STOP', limitSeconds: section.endSeconds, section, result }))
  const deps = { key: 'test-key', freeTierConfirmed: true, scheduled: true, now: () => time, wait: async (seconds: number) => { time += seconds },
    availability: vi.fn(async () => ({ state: 'ready' as const, durationSeconds: duration })), readSection, maxCalls: 2 }
  return { store, deps, advance: (seconds: number) => { time += seconds } }
}

describe('expanded free video queue', () => {
  it('resumes consecutive sections past twenty minutes and publishes full coverage only at the known ending', async () => {
    const { store, deps, advance } = await setup()
    expect(await collectNativeVideos(store, deps)).toMatchObject({ attempted: 2, partial: 1, completed: 0 })
    expect(await store.read('video-extract:v1:abcdefghijk')).toMatchObject({ nativeTranscript: { progress: { processedSeconds: 1200, sourceDurationSeconds: 1860, completion: 'partial' } }, coverage: { complete: false } })
    advance(3600)
    expect(await collectNativeVideos(store, deps)).toMatchObject({ attempted: 2, completed: 1 })
    expect(deps.readSection.mock.calls.map(c => c[4])).toEqual([
      { startSeconds: 0, endSeconds: 600 }, { startSeconds: 600, endSeconds: 1200 },
      { startSeconds: 1200, endSeconds: 1800 }, { startSeconds: 1800, endSeconds: 1860 },
    ])
    expect(await store.read('video-extract:v1:abcdefghijk')).toMatchObject({ nativeTranscript: { progress: { sections: 4, processedSeconds: 1860, completion: 'complete' } }, coverage: { complete: false } })
    expect(await collectNativeVideos(store, deps)).toMatchObject({ attempted: 0 })
    expect(deps.readSection).toHaveBeenCalledTimes(4)
  })
  it('uses all saved caption chunks without reserving any YouTube minutes', async () => {
    const { store, deps, advance } = await setup()
    await store.write('video-transcript:abcdefghijk', { ...video(), text: speech.repeat(350), source: 'github', method: 'captions' })
    const readText = vi.fn(async () => JSON.stringify({ tickers: result.tickers, themes: [] }))
    await collectNativeVideos(store, { ...deps, readText, maxCalls: 1 })
    expect(await store.read('video-extract:v1:abcdefghijk')).toBeNull()
    advance(3600)
    const status = await collectNativeVideos(store, { ...deps, readText, maxCalls: 6 })
    expect(status.completed).toBe(1)
    expect(status.dailyMinutes).toBe(0)
    expect(deps.readSection).not.toHaveBeenCalled()
    expect(readText.mock.calls.length).toBeGreaterThan(1)
    expect(await store.read('video-extract:v1:abcdefghijk')).toMatchObject({ via: 'github', coverage: { complete: true }, claims: [{ sourceMatch: 'matched' }] })
  })
  it('rotates channels and resumes an unfinished video ahead of another upload from that channel', () => {
    const work = (v: ReturnType<typeof video>, time: number, partial = false): NativeVideoWork => ({ video: v, parts: [], stage: partial ? 'partial' : 'pending', nextOffset: 0, attempts: 0, failures: 0, lastAttemptAt: time, nextAttemptAt: 0, updatedAt: 0 })
    const a = work(video(), 100, true), a2 = work(video('abcdefghijl'), 0), b = work(video('abcdefghijm', 'UCother'), 0)
    expect(nextNativeWork([a, a2, b], 200)).toBe(b)
    b.lastAttemptAt = 150
    expect(nextNativeWork([a, a2, b], 200)).toBe(a)
  })
  it('retains a provider cooldown across runs and makes no additional calls after quota refusal', async () => {
    const { store, deps } = await setup()
    deps.readSection.mockRejectedValue(new Error('native-http-429'))
    expect(await collectNativeVideos(store, deps)).toMatchObject({ attempted: 1, capped: true, pauseReason: 'provider-quota' })
    await store.write('video-inbox', [video(), video('abcdefghijl', 'UCother')])
    expect(await collectNativeVideos(store, deps)).toMatchObject({ attempted: 0, capped: true })
    expect(deps.readSection).toHaveBeenCalledTimes(1)
  })
  it('does not treat a model claiming the ending as independently confirmed duration', async () => {
    const { store, deps } = await setup()
    deps.availability.mockResolvedValue({ state: 'unknown' as 'ready', durationSeconds: undefined as unknown as number })
    deps.readSection.mockImplementation(async (url, _key, _fetch, _duration, section) => ({ url, at: deps.now(), model: NATIVE_VIDEO_MODEL, finishReason: 'STOP', section, result: { ...result, complete: true } }))
    expect(await collectNativeVideos(store, deps)).toMatchObject({ completed: 0, endReported: 1 })
    expect(await store.read('video-extract:v1:abcdefghijk')).toMatchObject({ nativeTranscript: { progress: { completion: 'end-reported', sourceDurationSeconds: null } }, coverage: { complete: false } })
  })
  it('repairs publication of saved completed sections without a Google call', async () => {
    const { store, deps } = await setup(600)
    const key = 'video-native-part:v2:abcdefghijk:0'
    await store.write(key, { url: video().url, at: 100, model: NATIVE_VIDEO_MODEL, finishReason: 'STOP', section: { startSeconds: 0, endSeconds: 600 }, result })
    await store.write(NATIVE_PROGRESS_KEY, [{ video: video(), nextOffset: 600, sourceDurationSeconds: 600, parts: [{ startSeconds: 0, endSeconds: 600, key }], stage: 'complete', attempts: 1, failures: 0, nextAttemptAt: 0, lastAttemptAt: 100, updatedAt: 100 }])
    expect(await collectNativeVideos(store, { ...deps, cachedOnly: true, key: '' })).toMatchObject({ published: 1, reused: 1, attempted: 0 })
    expect(deps.readSection).not.toHaveBeenCalled()
  })
  it('requires the free key and excludes a different channel reusing a followed name', async () => {
    const { store, deps } = await setup()
    await expect(collectNativeVideos(store, { ...deps, freeTierConfirmed: false })).rejects.toThrow('free-tier')
    await store.write('video-inbox', [{ ...video(), channelId: 'UCunfollowed' }])
    expect(await collectNativeVideos(store, deps)).toMatchObject({ attempted: 0 })
  })
  it('can verify the direct video path for a selected source without relying on its saved captions', async () => {
    const { store, deps } = await setup(600)
    await store.write('video-transcript:abcdefghijk', { ...video(), text: speech, source: 'local' })
    expect(await collectNativeVideos(store, { ...deps, target: 'abcdefghijk', forceVideo: true })).toMatchObject({ attempted: 1, completed: 1 })
    expect(deps.readSection).toHaveBeenCalledTimes(1)
  })
  it('reconciles older published caption analyses without spending free calls or requiring latest-feed visibility', async () => {
    const { store, deps } = await setup()
    await store.write('video-extracts', [{ ...video(), via: 'transcript', tickers: [] }, { ...video('abcdefghijl'), via: 'local', tickers: [] }])
    await store.write('video-inbox', [video(), video('abcdefghijl')])
    await store.write(NATIVE_PROGRESS_KEY, [{ video: video(), nextOffset: 0, parts: [], stage: 'retry', attempts: 1, failures: 1, nextAttemptAt: deps.now() + 1800, lastAttemptAt: deps.now(), updatedAt: deps.now(), lastError: 'native-publication-not-visible' }])
    const onPublish = vi.fn()
    expect(await collectNativeVideos(store, { ...deps, onPublish })).toMatchObject({ attempted: 0, failed: 0, completed: 1, pending: 0 })
    expect(deps.readSection).not.toHaveBeenCalled()
    expect(onPublish).not.toHaveBeenCalled()
    expect(await store.read<NativeVideoWork[]>(NATIVE_PROGRESS_KEY)).toHaveLength(1)
  })
})

describe('free video allowance', () => {
  it('counts attempts, spaces requests, allows caption-only work and refuses media past its daily allowance', async () => {
    const store = memoryStore(), now = Date.parse('2026-10-21T10:00:00Z') / 1000
    expect(await reserveNativeRead(store, now, 600)).toMatchObject({ allowed: true })
    expect(await reserveNativeRead(store, now + 1, 600)).toMatchObject({ allowed: false, reason: 'pacing' })
    const budget = await readNativeBudget(store, now)
    await store.write(nativeBudgetKey(now), { ...budget, seconds: NATIVE_DAILY_SECONDS })
    expect(await reserveNativeRead(store, now + 65, 600)).toMatchObject({ allowed: false, reason: 'video-allowance' })
    expect(await reserveNativeRead(store, now + 65, 0)).toMatchObject({ allowed: true })
  })
  it('uses Pacific calendar days including daylight saving changes', () => {
    const summer = Date.parse('2026-10-20T06:59:00Z') / 1000, winter = Date.parse('2026-11-03T07:59:00Z') / 1000
    expect(nativeQuotaDay(summer)).toBe('2026-10-19')
    expect(nativeQuotaReset(summer)).toBe(Date.parse('2026-10-20T07:00:00Z') / 1000)
    expect(nativeQuotaDay(winter)).toBe('2026-11-02')
    expect(nativeQuotaReset(winter)).toBe(Date.parse('2026-11-03T08:00:00Z') / 1000)
  })
})
