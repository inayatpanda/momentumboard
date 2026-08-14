import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiGet, apiUrl, setToken, type EngineData } from './api'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

/* ─────────────────────────── the API origin ───────────────────────────
 * The desktop shell (Tauri) serves this same dist from `tauri://localhost`,
 * where a relative `/api/…` resolves against the LOCAL asset protocol and can
 * never reach the server. `apiUrl` is the single seam that absolute-ises those
 * paths, fed by `VITE_API_BASE` at build time.
 *
 * The web build leaves the variable unset, so every call must come out of this
 * helper byte-identical to the string that went in — that is what makes the
 * change a no-op for the site, and it is the property worth pinning.
 */
describe('apiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('is the identity function on the web build — VITE_API_BASE unset', () => {
    expect(apiUrl('/api/market?type=quote&symbols=A')).toBe('/api/market?type=quote&symbols=A')
    expect(apiUrl('/report?list')).toBe('/report?list')
    expect(apiUrl('')).toBe('')
  })

  it('prefixes the configured origin when one is baked in', async () => {
    vi.stubEnv('VITE_API_BASE', 'https://thestreetsignal.rqai.co.uk')
    vi.resetModules()
    const { apiUrl: prefixed } = await import('./api')
    expect(prefixed('/api/x')).toBe('https://thestreetsignal.rqai.co.uk/api/x')
    expect(prefixed('/report?format=json')).toBe('https://thestreetsignal.rqai.co.uk/report?format=json')
  })

  it('tolerates a trailing slash on the base rather than emitting a double one', async () => {
    vi.stubEnv('VITE_API_BASE', 'https://thestreetsignal.rqai.co.uk/')
    vi.resetModules()
    const { apiUrl: prefixed } = await import('./api')
    expect(prefixed('/api/x')).toBe('https://thestreetsignal.rqai.co.uk/api/x')
  })

  // Defensive, and cheap: a caller that already holds an absolute URL (a link
  // the server handed us) must not have an origin stapled to the front of it.
  it('leaves an already-absolute URL alone', async () => {
    vi.stubEnv('VITE_API_BASE', 'https://thestreetsignal.rqai.co.uk')
    vi.resetModules()
    const { apiUrl: prefixed } = await import('./api')
    expect(prefixed('https://elsewhere.test/api/x')).toBe('https://elsewhere.test/api/x')
  })
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

  // The seam has to be USED, not merely exist: every typed getter in this file
  // and in apiViews.ts reaches the network through this one function, so if it
  // stops absolute-ising, the whole desktop build goes offline at once.
  it('sends the absolute URL when an origin is baked in', async () => {
    vi.stubEnv('VITE_API_BASE', 'https://thestreetsignal.rqai.co.uk')
    vi.resetModules()
    const mod = await import('./api')
    mod.setToken('tok')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { x: 1 } })))
    await mod.apiGet('/api/engine?view=board')
    expect(spy.mock.calls[0][0]).toBe('https://thestreetsignal.rqai.co.uk/api/engine?view=board')
    vi.unstubAllEnvs()
    vi.resetModules()
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
