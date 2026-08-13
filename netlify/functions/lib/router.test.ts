import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXACT_ROUTES, FN_PREFIX, HANDLERS, HANDLER_NAMES, PREFIX_ROUTES, dispatch, isHandlerName, resolveRoute } from './router'
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
    expect(HANDLER_NAMES.length).toBe(23)
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
    expect(at('/api/t212?view=key')).toBe('t212')
    expect(at('/report?list')).toBe('report')
    expect(at('/api/export')).toBe('helm-export')
  })

  it('tolerates a trailing slash', () => {
    expect(resolveRoute(new URL('https://x.test/api/engine/'))?.name).toBe('engine')
  })

  it('lifts the /download/ splat into ?platform=, exactly as the netlify.toml rewrite does', () => {
    const hit = resolveRoute(new URL('https://x.test/download/mac'))
    expect(hit?.name).toBe('download')
    expect(hit?.url.searchParams.get('platform')).toBe('mac')
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
