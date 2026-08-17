import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXACT_ROUTES, FN_PREFIX, FUNCTION_RESPONSE_HEADERS, HANDLERS, HANDLER_NAMES, PREFIX_ROUTES, dispatch, isHandlerName, resolveRoute, type HandlerModule } from './router'
import { useBlobStore, storeBackend } from './storeProvider'
import { clearRuntimeEnv } from './runtimeEnv'

const FUNCTIONS_DIR = join(__dirname, '..')
const REPO_ROOT = join(__dirname, '..', '..', '..')

const onDisk = () =>
  readdirSync(FUNCTIONS_DIR)
    .filter(f => f.endsWith('.mts'))
    .map(f => f.replace(/\.mts$/, ''))
    .sort()

/** netlify.toml's redirect table, parsed — the thing the router replaces. */
function netlifyRedirects(): { from: string; to: string }[] {
  const toml = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8')
  const out: { from: string; to: string }[] = []
  const re = /\[\[redirects\]\]\s*\n\s*from\s*=\s*"([^"]+)"\s*\n\s*to\s*=\s*"([^"]+)"/g
  for (let m = re.exec(toml); m; m = re.exec(toml)) out.push({ from: m[1], to: m[2] })
  return out
}

const fnRedirects = () =>
  netlifyRedirects()
    .map(r => ({ from: r.from, fn: /^\/\.netlify\/functions\/([a-z0-9-]+)/.exec(r.to)?.[1] }))
    .filter((r): r is { from: string; fn: string } => !!r.fn)

describe('the route table is complete', () => {
  it('registers EVERY netlify/functions/*.mts, and nothing that does not exist', () => {
    expect(HANDLER_NAMES).toEqual(onDisk())
    expect(HANDLER_NAMES.length).toBe(25)
  })

  // The point of the whole file: a function with no pretty path is still
  // reachable on Netlify at /.netlify/functions/<name>, so it must stay
  // reachable on Pages too or the Telegram webhook and the composer chain die.
  it('makes every handler reachable by name', () => {
    for (const name of HANDLER_NAMES) {
      const hit = resolveRoute(new URL(`https://x.test${FN_PREFIX}${name}`))
      expect(hit, name).not.toBeNull()
      expect(hit!.name).toBe(name)
    }
  })

  it('reproduces netlify.toml redirect for redirect — the two cannot silently diverge', () => {
    for (const { from, fn } of fnRedirects()) {
      if (from.endsWith('/*')) {
        const prefix = from.slice(0, -1) // '/download/*' -> '/download/'
        expect(PREFIX_ROUTES.some(p => p.prefix === prefix && p.name === fn), from).toBe(true)
        continue
      }
      expect(EXACT_ROUTES[from], from).toBe(fn)
    }
  })

  it('claims no path netlify.toml does not', () => {
    const declared = new Set(fnRedirects().map(r => r.from))
    for (const path of Object.keys(EXACT_ROUTES)) expect(declared.has(path), path).toBe(true)
    // Both directions, prefixes included — the test above walks netlify.toml to
    // the router; this walks the router back. A prefix route invented here and
    // absent from netlify.toml would be a path Pages serves and Netlify does
    // not, which is precisely what the parallel run must not have.
    for (const r of PREFIX_ROUTES) {
      expect(declared.has(`${r.prefix}*`), r.prefix).toBe(true)
      expect(fnRedirects().find(d => d.from === `${r.prefix}*`)!.fn, r.prefix).toBe(r.name)
    }
  })

  it('every routed name is a real handler', () => {
    for (const name of Object.values(EXACT_ROUTES)) expect(isHandlerName(name)).toBe(true)
    for (const r of PREFIX_ROUTES) expect(isHandlerName(r.name)).toBe(true)
    for (const name of HANDLER_NAMES) expect(typeof HANDLERS[name]).toBe('function')
  })
})

describe('resolveRoute', () => {
  it('maps the public paths the app actually calls', () => {
    const at = (p: string) => resolveRoute(new URL(`https://thestreetsignal.rqai.co.uk${p}`))?.name ?? null
    expect(at('/api/market?type=quote&symbols=AAPL')).toBe('market-data')
    expect(at('/api/engine')).toBe('engine')
    expect(at('/api/config?view=runlog')).toBe('config-sync')
    expect(at('/api/licences?check=1')).toBe('licences')
    expect(at('/report?list')).toBe('report')
    expect(at('/api/export')).toBe('helm-export')
  })

  // The broker endpoint was retired at cutover (CX-21). The two parity tests
  // above only walk whichever side you edited, so neither would notice a
  // half-revert; this one fails outright if /api/t212 is ever routed again.
  it('does not route the retired /api/t212 endpoint', () => {
    const at = (p: string) => resolveRoute(new URL(`https://thestreetsignal.rqai.co.uk${p}`))?.name ?? null
    expect(at('/api/t212')).toBe(null)
    expect(at('/api/t212?view=key')).toBe(null)
  })

  it('tolerates a trailing slash', () => {
    expect(resolveRoute(new URL('https://x.test/api/engine/'))?.name).toBe('engine')
  })

  it('lifts the /download/ splat into ?platform=, exactly as the netlify.toml rewrite does', () => {
    const hit = resolveRoute(new URL('https://x.test/download/mac'))
    expect(hit?.name).toBe('download')
    expect(hit?.url.searchParams.get('platform')).toBe('mac')
  })

  // M-3: the exact and by-name branches matched the trailing-slash-stripped
  // path while the prefix branch matched the raw one, so `/api/engine/` was the
  // same door as `/api/engine` but `/download/mac/` became `?platform=mac%2F`
  // — an unknown platform, a 404, and a reader who cannot download the app.
  it('strips the trailing slash for prefix routes too', () => {
    const at = (p: string) => {
      const hit = resolveRoute(new URL(`https://x.test${p}`))
      return hit && { name: hit.name, platform: hit.url.searchParams.get('platform') }
    }
    expect(at('/download/mac/')).toEqual({ name: 'download', platform: 'mac' })
    expect(at('/download/win//')).toEqual({ name: 'download', platform: 'win' })
    // The bare prefix, with and without its slash: both mean "no platform" and
    // both reach the handler, which answers "unknown platform — use
    // /download/mac". Previously `/download` fell through to a JSON 404 while
    // `/download/` reached the handler, purely by accident of the raw match.
    expect(at('/download')).toEqual({ name: 'download', platform: null })
    expect(at('/download/')).toEqual({ name: 'download', platform: null })
    // Not a prefix match — the segment has to end.
    expect(at('/downloads')).toBeNull()
    expect(at('/download-now')).toBeNull()
  })

  it('returns null for anything unrouted — the SPA paths included', () => {
    for (const p of ['/', '/app/', '/ledger', '/api/', '/api/nope', '/api/fn/not-a-function', '/reports']) {
      expect(resolveRoute(new URL(`https://x.test${p}`)), p).toBeNull()
    }
  })

  it('does not let /api/fn/ reach outside the registry', () => {
    expect(resolveRoute(new URL('https://x.test/api/fn/../../etc/passwd'))).toBeNull()
    expect(resolveRoute(new URL('https://x.test/api/fn/lib/store'))).toBeNull()
  })
})

describe('dispatch', () => {
  beforeEach(() => {
    clearRuntimeEnv()
    useBlobStore()
  })
  afterEach(() => {
    clearRuntimeEnv()
    useBlobStore()
  })

  it('404s an unknown path as JSON, rather than falling through to index.html', async () => {
    const res = await dispatch(new Request('https://x.test/api/nope'))
    expect(res!.status).toBe(404)
    expect(await res!.json()).toEqual({ ok: false, error: 'not-found', path: '/api/nope' })
  })

  it('passes through instead when asked, so a Pages entry point can call next()', async () => {
    expect(await dispatch(new Request('https://x.test/api/nope'), { passThrough: true })).toBeNull()
  })

  // The real handler, the real auth: engine.mts calls authenticate(), which
  // finds no token and refuses. Proves the mount point reaches live code and
  // that the port did not accidentally open an authenticated endpoint.
  it('runs the REAL engine handler and gets its real 401', async () => {
    const res = await dispatch(new Request('https://x.test/api/engine'))
    expect(res!.status).toBe(401)
    expect(await res!.json()).toEqual({ ok: false, error: 'unauthorised' })
  })

  it('leaves the store on Blobs when no D1 binding is handed over', async () => {
    await dispatch(new Request('https://x.test/api/nope'), { env: { APP_TOKEN: 'x' } })
    expect(storeBackend()).toBe('blobs')
  })
})

/* ─────────────────────────────── I-5 ───────────────────────────────
 * public/_headers is not applied to function responses on Pages, and
 * netlify.toml's [[headers]] were not applied to them on Netlify either — so
 * /report served a whole HTML edition with no X-Frame-Options, no nosniff and
 * no CSP. hosting.test.ts pins the SET against public/_headers; these pin that
 * dispatch actually attaches it, on every door out.
 */
describe('every function response carries the security set', () => {
  const registry = HANDLERS as unknown as Record<string, () => Promise<HandlerModule>>
  let original: () => Promise<HandlerModule>

  beforeEach(() => {
    clearRuntimeEnv()
    useBlobStore()
    original = registry.watchdog
  })
  afterEach(() => {
    registry.watchdog = original
    clearRuntimeEnv()
    useBlobStore()
  })

  const assertSet = (res: Response) => {
    for (const [name, value] of Object.entries(FUNCTION_RESPONSE_HEADERS)) expect(res.headers.get(name), name).toBe(value)
  }

  it('adds them to a real handler answer', async () => {
    const res = await dispatch(new Request('https://x.test/api/engine'))
    expect(res!.status).toBe(401) // the real auth refusal, still
    assertSet(res!)
    expect(await res!.json()).toEqual({ ok: false, error: 'unauthorised' }) // …and the body survived the re-wrap
  })

  it('adds them to the router 404 and to the opaque 500', async () => {
    assertSet((await dispatch(new Request('https://x.test/api/nope')))!)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registry.watchdog = () =>
      Promise.resolve({
        default: () => {
          throw new Error('nope')
        },
      })
    assertSet((await dispatch(new Request(`https://x.test${FN_PREFIX}watchdog`)))!)
    logged.mockRestore()
  })

  it('keeps the handler’s own content-type and cache-control', async () => {
    const res = await dispatch(new Request('https://x.test/api/nope'))
    expect(res!.headers.get('content-type')).toBe('application/json')
    expect(res!.headers.get('cache-control')).toBe('no-store')
  })

  // A handler that sets one of these knows something this layer does not.
  // /report is the live case: an edition that ever needs to be framed, or a
  // download that wants a looser policy, must be able to say so.
  it('never overwrites a header the handler set itself', async () => {
    registry.watchdog = () =>
      Promise.resolve({
        default: () => new Response('ok', { headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" } }),
      })
    const res = await dispatch(new Request(`https://x.test${FN_PREFIX}watchdog`))
    expect(res!.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res!.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
    expect(res!.headers.get('Referrer-Policy')).toBe('no-referrer') // the rest still land
    expect(await res!.text()).toBe('ok')
  })

  // passThrough means "the asset server answers this one", and the asset server
  // applies public/_headers itself. Manufacturing a headered empty response
  // here would turn a pass-through into a response.
  it('stays out of the way of a pass-through', async () => {
    expect(await dispatch(new Request('https://x.test/ledger'), { passThrough: true })).toBeNull()
  })
})

/* ─────────────────────────────── I-4 ───────────────────────────────
 * A thrown Error's message is an internal one. On this codebase that is a D1
 * error naming a table, an upstream URL that may carry a key in its query, a
 * runner path, or whatever string a dependency chose. `dispatch` used to put
 * 300 characters of it straight into a public 500 body. The log keeps all of
 * it; the response says nothing unless a preview asks.
 */
describe('a handler that throws', () => {
  const registry = HANDLERS as unknown as Record<string, () => Promise<HandlerModule>>
  const SECRET = 'D1_ERROR: no such table: blobs — /home/runner/work/.netlify/creds'
  let original: () => Promise<HandlerModule>
  let logged: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearRuntimeEnv()
    useBlobStore()
    delete process.env.DEBUG_ERRORS
    original = registry.watchdog
    registry.watchdog = () =>
      Promise.resolve({
        default: () => {
          throw new Error(SECRET)
        },
      })
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    registry.watchdog = original
    delete process.env.DEBUG_ERRORS
    logged.mockRestore()
    clearRuntimeEnv()
  })

  it('answers opaquely by default, and keeps the real reason in the log', async () => {
    const res = await dispatch(new Request(`https://x.test${FN_PREFIX}watchdog`))
    expect(res!.status).toBe(500)
    const body = await res!.text()
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'internal' })
    expect(body).not.toContain('D1_ERROR')
    expect(body).not.toContain('/home/runner')
    expect(logged).toHaveBeenCalled()
    expect(String(logged.mock.calls[0]?.[1])).toContain(SECRET)
  })

  it('puts the message back when DEBUG_ERRORS=1 — the M3 preview switch', async () => {
    process.env.DEBUG_ERRORS = '1'
    const res = await dispatch(new Request(`https://x.test${FN_PREFIX}watchdog`))
    expect(res!.status).toBe(500)
    expect(await res!.json()).toEqual({ ok: false, error: 'handler-failed', fn: 'watchdog', detail: SECRET })
  })

  it('reads the switch off the Worker env bag too, not just process.env', async () => {
    const res = await dispatch(new Request(`https://x.test${FN_PREFIX}watchdog`), { env: { DEBUG_ERRORS: '1' } })
    expect((await res!.json()).detail).toBe(SECRET)
  })

  // Anything other than exactly '1' is off. A leftover `DEBUG_ERRORS=false`
  // must not read as truthy.
  it('is off for every value that is not 1', async () => {
    for (const v of ['0', 'false', 'true', 'yes', '']) {
      process.env.DEBUG_ERRORS = v
      const res = await dispatch(new Request(`https://x.test${FN_PREFIX}watchdog`))
      expect(await res!.json(), v).toEqual({ ok: false, error: 'internal' })
    }
  })
})
