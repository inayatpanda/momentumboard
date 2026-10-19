import { describe, expect, it } from 'vitest'
import { applyWorkResults, workResultFromResponse, type WorkItem } from './videoQueue'

const item: WorkItem = { id: 'video-1', kind: 'video', body: { url: 'https://youtu.be/abcdefghijk' }, at: 1000, attempts: 0 }

describe('video queue retry policy', () => {
  it('keeps capped work until its retry time without using an error attempt', () => {
    const result = workResultFromResponse(429, 'gemini-extract-capped', '86400')
    const { next, deadlettered } = applyWorkResults([item], new Map([[item.id, result]]), 2000)
    expect(next[0]).toMatchObject({ attempts: 0, nextAttemptAt: 88400, lastError: 'gemini-extract-capped' })
    expect(deadlettered).toEqual([])
  })
  it('does not treat legacy successful-HTTP failure bodies as extracted', () => {
    expect(workResultFromResponse(200, 'unparseable', null).ok).toBe(false)
    expect(workResultFromResponse(200, 'gemini-extract-capped', null).ok).toBe(false)
    expect(workResultFromResponse(200, 'extracted:local', null).ok).toBe(true)
  })
  it('retains failure diagnostics after retries and preserves newly enqueued jobs', () => {
    const result = workResultFromResponse(502, 'sensitive upstream response: api-key=secret', null)
    const { next, deadlettered } = applyWorkResults([{ ...item, attempts: 2 }, { ...item, id: 'new' }], new Map([[item.id, result]]), 2000)
    expect(next.map(i => i.id)).toEqual(['new'])
    expect(deadlettered[0]).toMatchObject({ attempts: 3, lastError: 'provider-unavailable', lastAttemptAt: 2000 })
    expect(JSON.stringify(deadlettered)).not.toContain('secret')
  })
})
