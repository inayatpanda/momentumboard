import { describe, expect, it } from 'vitest'
import { memoryStore } from './store'
import { videoIngestionHealth } from './videoIngestion'

describe('video ingestion health', () => {
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
