import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from './store'
import { PROVIDER_HEALTH_KEY, refreshTranscriptProviderHealth } from './transcriptProviderHealth'
import { captureTranscript } from './transcriptCapture'

describe('transcript provider account health', () => {
  it('reports exhausted credits, excludes account identifiers and skips paid capture', async () => {
    const store = memoryStore()
    const fetch = vi.fn().mockResolvedValue(Response.json({ organizationId: 'private-id', plan: 'Free (100/mo)', maxCredits: 100, usedCredits: 334 }))
    expect(await refreshTranscriptProviderHealth(store, 'private-key', fetch, 1000)).toMatchObject({ status: 'exhausted', remainingCredits: 0 })
    expect(JSON.stringify(await store.read(PROVIDER_HEALTH_KEY))).not.toContain('private')
    const captureFetch = vi.fn().mockResolvedValue(Response.json({}))
    expect(await captureTranscript(store, 'job', 'https://youtu.be/abcdefghijk', 'private-key', captureFetch, 1100)).toEqual({ status: 'unavailable' })
    expect(captureFetch.mock.calls.some(c => String(c[0]).includes('supadata'))).toBe(false)
  })
  it('does not call an unavailable account response exhausted', async () => {
    const store = memoryStore()
    expect(await refreshTranscriptProviderHealth(store, 'key', vi.fn().mockResolvedValue(new Response('', { status: 503 })), 1000)).toEqual({ checkedAt: 1000, status: 'unavailable' })
  })
})
