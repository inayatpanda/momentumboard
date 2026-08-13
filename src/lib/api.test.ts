import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiGet, setToken, type EngineData } from './api'

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

// A COMPILE-TIME pin wearing a test's clothes [spec §4.3(d), stage 3c]: the
// engine has written `scorecard.bySetup` since the setup families existed, and
// the client type simply never named it — so no screen could read "does this
// SHAPE of call work?" without an `any`. If the field leaves the type again, this
// file stops compiling, which is the only way a types-only guarantee can fail
// loudly in a test suite.
describe('the EngineData scorecard type', () => {
  it('exposes bySetup — the per-family honesty pane the engine has always written', () => {
    const card: NonNullable<EngineData['scorecard']> = {
      byGrade: {},
      byRegime: {},
      bySetup: { continuation: { n: 3, hits: 2, sumExcess: 4.5 } },
      overlays: {},
      brierTail: [],
      totalGraded: 3,
    }
    expect(card.bySetup!.continuation.hits).toBe(2)
  })
})
