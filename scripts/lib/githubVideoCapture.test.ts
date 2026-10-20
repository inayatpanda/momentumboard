import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from '../../netlify/functions/lib/store'
import { enqueueSocialJobs, SOCIAL_JOBS_KEY, type SocialJob } from '../../netlify/functions/lib/socialJobs'
import { readStoredTranscript, saveTranscript, type InboxVideo } from '../../netlify/functions/lib/videoTranscriptStore'
import { captureCandidates, collectGithubVideos, GITHUB_ATTEMPTS_KEY, GITHUB_CAPTURE_KEY, type CaptureAttempt } from './githubVideoCapture'

const video = (id = 'abcdefghijk', at = 100): InboxVideo => ({ url: `https://www.youtube.com/watch?v=${id}`, title: 'An earnings discussion', channel: 'Example', channelId: 'UCexample', at })
const words = 'A company earnings discussion is a source claim that requires independent verification. '.repeat(3).trim()
const captions = () => Promise.resolve({ text: words, segments: [{ text: words, startSec: 0, endSec: 40 }], language: 'en', method: 'captions' as const })
const unavailable = () => Promise.resolve({ fail: 'IpBlocked' })
const deps = () => ({ captions: vi.fn(captions), library: vi.fn(unavailable), audio: vi.fn(unavailable), now: () => 1000 })

describe('GitHub video capture', () => {
  it('limits free caption capture to the daily selection without reviving the archive', async () => {
    const store=memoryStore(), readers=deps()
    await store.write('video-inbox',[video(),video('abcdefghijl')])
    await enqueueSocialJobs(store,[video('abcdefghijm')],100)
    expect(await collectGithubVideos(store,{...readers,allowedVideoIds:new Set(['abcdefghijl'])})).toMatchObject({attempted:1,saved:1})
    expect(readers.captions).toHaveBeenCalledWith(video('abcdefghijl').url)
  })
  it('captures only followed channels and rejects a different channel using the same display name', async () => {
    const store = memoryStore(), readers = deps()
    await store.write('video-inbox', [video(), { ...video('abcdefghijl'), channelId: 'UCother' }])
    expect(await collectGithubVideos(store, { ...readers, followedChannels: [{ id: 'UCexample', name: 'Example' }] })).toMatchObject({ attempted: 1, saved: 1 })
    expect(readers.captions).toHaveBeenCalledTimes(1)
    expect(readers.captions).toHaveBeenCalledWith(video().url)
  })
  it('stores real words with cloud provenance, admits analysis, and does not recapture on a second run', async () => {
    const store = memoryStore(), readers = deps()
    await store.write('video-inbox', [video()])
    expect(await collectGithubVideos(store, readers)).toMatchObject({ saved: 1, captions: 1, status: 'complete' })
    const saved = await readStoredTranscript(store, video().url)
    expect(saved).toMatchObject({ text: words, source: 'github', channelId: 'UCexample', method: 'captions', segments: [{ startSec: 0, endSec: 40 }] })
    expect(await store.read(SOCIAL_JOBS_KEY)).toMatchObject([{ mode: 'extract', stage: 'queued', url: video().url }])
    await collectGithubVideos(store, readers)
    expect(readers.captions).toHaveBeenCalledTimes(1)
    expect(readers.audio).not.toHaveBeenCalled()
  })

  it('uses audio after both caption paths fail and preserves speech provenance', async () => {
    const store = memoryStore()
    await store.write('video-inbox', [video()])
    const readers = { ...deps(), captions: vi.fn(unavailable), audio: vi.fn(async () => ({ ...(await captions()), method: 'speech' as const })) }
    expect(await collectGithubVideos(store, readers)).toMatchObject({ saved: 1, speech: 1 })
    expect((await readStoredTranscript(store, video().url))?.method).toBe('speech')
  })

  it('keeps blocked videos pending, limits audio work, backs off and logs no source diagnostics', async () => {
    const store = memoryStore(), readers = { ...deps(), captions: vi.fn(unavailable) }
    await store.write('video-inbox', [video(), video('abcdefghijl'), video('abcdefghijm')])
    const report = await collectGithubVideos(store, readers)
    expect(report).toMatchObject({ saved: 0, unavailable: 3, reasons: { 'youtube-blocked': 3 } })
    expect(readers.audio).toHaveBeenCalledTimes(2)
    expect(await store.read(SOCIAL_JOBS_KEY)).toBeNull()
    const attempts = (await store.read<CaptureAttempt[]>(GITHUB_ATTEMPTS_KEY))!
    expect(attempts).toHaveLength(3)
    expect(attempts.every(a => a.nextAt === 11800 && a.attempts === 1)).toBe(true)
    await collectGithubVideos(store, readers)
    expect(readers.captions).toHaveBeenCalledTimes(3)
  })

  it('repairs an interrupted durable save and wakes a previously failed analysis without downloading again', async () => {
    const store = memoryStore(), readers = deps()
    await store.write('video-inbox', [video()])
    await store.write('video-transcript:abcdefghijk', { ...video(), text: words, source: 'github', method: 'captions' })
    await enqueueSocialJobs(store, [video()], 100)
    const jobs = (await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))!
    jobs[0].stage = 'needs-attention'; jobs[0].lastError = 'no-transcript-no-video-read'; jobs[0].nextAttemptAt = 999999
    await store.write(SOCIAL_JOBS_KEY, jobs)
    await collectGithubVideos(store, readers)
    expect(readers.captions).not.toHaveBeenCalled()
    expect(await store.read(SOCIAL_JOBS_KEY)).toMatchObject([{ stage: 'queued', nextAttemptAt: 0 }])
    expect(await store.read('video-transcript-index:v2')).toMatchObject([{ source: 'github', characters: words.length }])
  })

  it('recovers admission after a crash between the completed transcript save and enqueue', async () => {
    const store = memoryStore(), readers = deps()
    await saveTranscript(store, { ...video(), text: words, source: 'github' })
    await collectGithubVideos(store, readers)
    expect(await store.read(SOCIAL_JOBS_KEY)).toMatchObject([{ mode: 'extract', stage: 'queued' }])
    expect(readers.captions).not.toHaveBeenCalled()
  })

  it('wakes a completed video-only read when real words become available', async () => {
    const store = memoryStore(), readers = deps()
    await store.write('video-inbox', [video()])
    await enqueueSocialJobs(store, [video()], 100)
    const jobs = (await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))!
    jobs[0].stage = 'complete'; jobs[0].updatedAt = 100
    await store.write(SOCIAL_JOBS_KEY, jobs)
    await store.write('video-extract:v1:abcdefghijk', { via: 'gemini-video' })
    await collectGithubVideos(store, readers)
    expect(await store.read(SOCIAL_JOBS_KEY)).toMatchObject([{ stage: 'queued' }])
  })

  it('reports a failed save as an error, never as a successful capture, and releases its lease', async () => {
    const backing = memoryStore(), readers = deps()
    await backing.write('video-inbox', [video()])
    const store = { ...backing, write: async (key: string, value: unknown) => {
      if (key.startsWith('video-transcript:')) throw new Error('storage unavailable')
      return backing.write(key, value)
    } }
    await expect(collectGithubVideos(store, readers)).rejects.toThrow('github-capture-failed')
    expect(await backing.read(GITHUB_CAPTURE_KEY)).toMatchObject({ running: false, status: 'error', saved: 0 })
    expect(await backing.read('lease:github-video-capture')).toMatchObject({ expiresAt: 0 })
  })

  it('retains old durable jobs, deduplicates URL variants, and tries unattempted videos first', async () => {
    const store = memoryStore()
    await enqueueSocialJobs(store, [video('abcdefghijm')], 10)
    const attempts: CaptureAttempt[] = [{ id: 'abcdefghijk', at: 50, attempts: 1, nextAt: 100 }]
    const candidates = captureCandidates([video(), { ...video(), url: 'https://youtu.be/abcdefghijk' }, video('abcdefghijl')], (await store.read<SocialJob[]>(SOCIAL_JOBS_KEY))!, new Set(['abcdefghijl']), attempts, 1000)
    expect(candidates.map(v => v.url.slice(-11))).toEqual(['abcdefghijm', 'abcdefghijk'])
  })

  it('does not spend the capture allowance repeatedly on archived words outside the recent index', async () => {
    const store = memoryStore(), readers = deps()
    await store.write('video-inbox', [video('abcdefghijk', 200), video('abcdefghijl', 100)])
    await store.write('video-transcript:abcdefghijk', { ...video(), text: words, source: 'local', at: 1 })
    await store.write('video-transcript-index:v2', Array.from({ length: 200 }, (_, i) => ({ ...video(`k${String(i).padStart(10, '0')}`), at: 10 + i, source: 'local', characters: 200 })))
    const report = await collectGithubVideos(store, { ...readers, maxVideos: 1 })
    expect(report).toMatchObject({ reused: 1, saved: 1 })
    expect(readers.captions).toHaveBeenCalledWith(video('abcdefghijl').url)
    const next = await collectGithubVideos(store, readers)
    expect(next).toMatchObject({ attempted: 0, reused: 0, saved: 0 })
  })
})
