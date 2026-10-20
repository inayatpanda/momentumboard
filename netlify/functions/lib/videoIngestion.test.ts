import { describe, expect, it } from 'vitest'
import { memoryStore } from './store'
import { videoIngestionHealth } from './videoIngestion'

describe('video ingestion health', () => {
  it('counts unique recent videos per channel and retains capture backlog beyond the inbox window', async () => {
    const store = memoryStore()
    await store.write('config', { ytChannels: [{ id: 'UCtest', name: 'A creator' }], secret: 'must-not-leak' })
    await store.write('video-inbox', [
      { url: 'https://youtu.be/abcdefghijk', channelId: 'UCtest', channel: 'Old name', at: 20, publishedAt: 10 },
      { url: 'https://www.youtube.com/watch?v=abcdefghijk', channelId: 'UCtest', channel: 'A creator', at: 20, publishedAt: 10 },
      { url: 'https://youtu.be/abcdefghijl', channel: 'A creator', at: 30, publishedAt: 25 },
    ])
    await store.write('video-transcript-index:v2', [{ url: 'https://youtu.be/abcdefghijk', at: 40, characters: 1000 }])
    await store.write('social-jobs:v1', [{ url: 'https://youtu.be/abcdefghijm', mode: 'extract', stage: 'queued', at: 5, nextAttemptAt: 0 }])
    const health = await videoIngestionHealth(store, [{ url: 'https://youtu.be/abcdefghijk', at: 50 }], 100)
    expect(health.channels.find(c => c.id === 'UCtest')).toEqual({ id: 'UCtest', name: 'A creator', discovered: 2, captured: 1, analysed: 1, awaitingCapture: 1, latestPublishedAt: 25 })
    expect(health.pendingTranscripts).toBe(2)
    expect(health.discoveryWindow).toEqual({ videos: 2, since: 20 })
    expect(health.channels.some(c => c.discovered === 0)).toBe(true)
    expect(JSON.stringify(health)).not.toContain('must-not-leak')
  })

  it('does not report an already analysed video as a missing transcript after indexes roll over', async () => {
    const store = memoryStore()
    await store.write('video-inbox', [{ url: 'https://youtu.be/abcdefghijk', at: 20 }])
    expect((await videoIngestionHealth(store, [{ url: 'https://youtu.be/abcdefghijk', at: 30 }], 100)).pendingTranscripts).toBe(0)
  })
  it('distinguishes awaiting words, deferred jobs and failures without exposing provider data', async () => {
    const store = memoryStore()
    await store.write('video-inbox', [{ url: 'https://youtu.be/abcdefghijk' }, { url: 'https://youtu.be/abcdefghijl' }])
    await store.write('video-transcripts', [{ url: 'https://www.youtube.com/watch?v=abcdefghijk', at: 100 }])
    await store.write('work-queue', [{ id: 'pending', kind: 'video', body: { url: 'https://youtu.be/abcdefghijk', title: 'Ready' }, at: 100, attempts: 0, nextAttemptAt: 2000, lastError: 'gemini-extract-capped' }])
    await store.write('work-queue-deadletter', [{ id: 'failed', kind: 'video', body: { url: 'https://youtu.be/abcdefghijl', title: 'Failed' }, at: 50, attempts: 3, lastError: 'https://provider?key=secret' }])
    const health = await videoIngestionHealth(store, [], 1000)
    expect(health).toMatchObject({ pendingTranscripts: 1, queued: 1, deferred: 1, failed: 1, lastTranscriptAt: 100, lastExtractAt: null, nextRetryAt: 2000 })
    expect(health.recentFailures[0].reason).toBe('gemini-extract-capped')
    expect(JSON.stringify(health)).not.toContain('secret')
    expect((await store.read<unknown[]>('work-queue'))).toHaveLength(1)
  })
})
