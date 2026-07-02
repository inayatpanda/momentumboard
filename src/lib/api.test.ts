import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiGet, setToken } from './api'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('apiGet', () => {
  it('sends the token header and unwraps the envelope', async () => {
    setToken('tok')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { x: 1 } })))
    await expect(apiGet('/api/market?type=quote&symbols=A')).resolves.toEqual({ x: 1 })
    const [, init] = spy.mock.calls[0]
    expect((init!.headers as Record<string, string>)['x-app-token']).toBe('tok')
  })
  it('throws on error envelope', async () => {
    setToken('tok')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }))
    await expect(apiGet('/x')).rejects.toThrow('unauthorized')
  })
})
