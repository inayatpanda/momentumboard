// THE DESKTOP SHELL'S ONLY DOOR IN.
//
// The Tauri wrap loads this site's own dist from `tauri://localhost`, so every
// call it makes to the API is, to the browser engine, cross-origin — and a
// cross-origin call with an `x-app-token` header is a PREFLIGHTED one. Without
// an answer to that preflight the desktop app has no API at all.
//
// The whole risk of the file under test is over-opening: an `Access-Control-
// Allow-Origin: *` here would hand every website on the internet the ability to
// read a licensed reader's engine data from their browser, using their token.
// So these tests care much more about what is REFUSED than about what is
// allowed — the two Tauri origins are matched EXACTLY, and everything else,
// including near-misses that merely contain the string, leaves with no CORS
// header at all and therefore stays same-origin-only.

import { describe, expect, it, vi } from 'vitest'
import { onRequest, TAURI_ORIGINS } from './cors'
import type { PagesContext } from '../netlify/functions/lib/router'

/** A Pages context, hand-built: `onRequest` is a plain function, so nothing
 * about the Cloudflare runtime is needed to exercise it. */
const contextFor = (req: Request, next: () => Promise<Response> = async () => new Response('downstream')) =>
  ({ request: req, env: {}, next: vi.fn(next) } as unknown as PagesContext & { next: ReturnType<typeof vi.fn> })

const requestFrom = (origin: string | null, init: RequestInit = {}) =>
  new Request('https://thestreetsignal.rqai.co.uk/api/engine?view=board', {
    ...init,
    headers: origin ? { Origin: origin } : {},
  })

describe('the preflight, for the desktop shell only', () => {
  // macOS is the first origin and the one this wave ships; the second is the
  // Windows/Linux form, kept so a later wrap needs no server change.
  it.each(TAURI_ORIGINS)('answers OPTIONS from %s with 204 and that exact origin echoed back', async origin => {
    const ctx = contextFor(requestFrom(origin, { method: 'OPTIONS' }))
    const res = await onRequest(ctx)

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('content-type, x-app-token, x-report-token')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400')
    // The preflight is answered HERE. Letting it fall through would run the
    // router — and hand an unauthenticated OPTIONS to a real handler.
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('never answers with a wildcard', async () => {
    const res = await onRequest(contextFor(requestFrom(TAURI_ORIGINS[0], { method: 'OPTIONS' })))
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*')
  })

  // The token headers are the entire reason a preflight happens at all: a bare
  // GET with no custom header is a simple request. Losing one of these names
  // silently kills whichever call needs it — /report is the token that is easy
  // to forget, because the paper is the one screen fed by a non-/api path.
  it('permits the two custom auth headers the client actually sends', async () => {
    const res = await onRequest(contextFor(requestFrom(TAURI_ORIGINS[0], { method: 'OPTIONS' })))
    const allowed = res.headers.get('Access-Control-Allow-Headers')!.split(',').map(h => h.trim())
    expect(allowed).toContain('x-app-token')
    expect(allowed).toContain('x-report-token')
    expect(allowed).toContain('content-type')
  })
})

describe('the real request, for the desktop shell only', () => {
  it.each(TAURI_ORIGINS)('passes %s through to the handler and appends the CORS headers', async origin => {
    const downstream = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'X-Frame-Options': 'DENY' },
    })
    const ctx = contextFor(requestFrom(origin), async () => downstream)
    const res = await onRequest(ctx)

    expect(ctx.next).toHaveBeenCalledOnce()
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(res.headers.get('Vary')).toBe('Origin')
    // the handler's own answer survives the re-wrap, headers and body alike
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('keeps a Vary the handler set itself instead of replacing it', async () => {
    const ctx = contextFor(requestFrom(TAURI_ORIGINS[0]), async () => new Response('x', { headers: { Vary: 'Accept-Encoding' } }))
    const res = await onRequest(ctx)
    const vary = res.headers.get('Vary')!.split(',').map(v => v.trim())
    expect(vary).toContain('Accept-Encoding')
    expect(vary).toContain('Origin')
  })

  it('does not repeat Origin when the handler already varied on it', async () => {
    const ctx = contextFor(requestFrom(TAURI_ORIGINS[0]), async () => new Response('x', { headers: { Vary: 'Origin' } }))
    const res = await onRequest(ctx)
    expect(res.headers.get('Vary')!.toLowerCase().match(/origin/g)).toHaveLength(1)
  })

  it('survives a body-less status without throwing', async () => {
    const ctx = contextFor(requestFrom(TAURI_ORIGINS[0]), async () => new Response(null, { status: 304 }))
    const res = await onRequest(ctx)
    expect(res.status).toBe(304)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(TAURI_ORIGINS[0])
  })
})

/* ─────────────────── the part that matters: everyone else ─────────────────── */

describe('every other origin is left exactly as it was', () => {
  const STRANGERS = [
    'https://evil.test',
    // near-misses. A `startsWith`/`includes` match would let all of these in,
    // and each one is a real site somebody could register or serve.
    'tauri://localhost.evil.test',
    'https://tauri.localhost',
    'http://tauri.localhost.evil.test',
    'http://tauri.localhost:1420',
    'http://localhost:5173',
    'null',
    '*',
  ]

  it.each(STRANGERS)('gives %s no CORS header on a normal request', async origin => {
    const ctx = contextFor(requestFrom(origin))
    const res = await onRequest(ctx)
    expect(ctx.next).toHaveBeenCalledOnce()
    expect(res.headers.has('Access-Control-Allow-Origin')).toBe(false)
    expect(await res.text()).toBe('downstream')
  })

  it.each(STRANGERS)('does not answer a preflight from %s either', async origin => {
    const ctx = contextFor(requestFrom(origin, { method: 'OPTIONS' }))
    const res = await onRequest(ctx)
    // Falls through to the existing behaviour — this middleware invents no
    // policy for origins it does not recognise.
    expect(ctx.next).toHaveBeenCalledOnce()
    expect(res.headers.has('Access-Control-Allow-Origin')).toBe(false)
  })

  // The overwhelmingly common case: the website itself, and every crawler and
  // curl. A same-origin browser fetch sends no Origin on GET at all.
  it('leaves a request with no Origin header untouched', async () => {
    const ctx = contextFor(requestFrom(null))
    const res = await onRequest(ctx)
    expect(ctx.next).toHaveBeenCalledOnce()
    expect(res.headers.has('Access-Control-Allow-Origin')).toBe(false)
    expect(res.headers.has('Vary')).toBe(false)
  })

  // The middleware sits at the ROOT of functions/, so it is on the path of
  // every request the project serves, assets included. For all but the desktop
  // shell it must be a pure `next()` — the same Response object, not a copy.
  it('returns the downstream response itself, unwrapped, for ordinary traffic', async () => {
    const downstream = new Response('asset')
    const res = await onRequest(contextFor(requestFrom(null), async () => downstream))
    expect(res).toBe(downstream)
  })
})

describe('the allow-list itself', () => {
  it('is the two Tauri v2 webview origins and nothing more', () => {
    expect([...TAURI_ORIGINS]).toEqual(['tauri://localhost', 'http://tauri.localhost'])
  })
})
