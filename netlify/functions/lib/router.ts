// THE ROUTE TABLE — one copy, two hosts.
//
// M2 of the Cloudflare migration (docs/superpowers/specs/2026-08-12-cloudflare-migration-design.md).
//
// On Netlify the mapping from a public path to a function lives in netlify.toml's
// `[[redirects]]` block, and the platform does the dispatch. Cloudflare Pages has
// no equivalent for functions, so the mapping becomes code — and once it is code
// it can be TESTED for completeness, which netlify.toml never could be.
//
// The table below is the netlify.toml redirect list, transcribed. `router.test.ts`
// parses netlify.toml and fails if the two ever disagree, so this file cannot rot
// while the live site still runs on Netlify.
//
// THE TWO SPA REDIRECTS ARE NOT HERE, AND MUST NOT BE. netlify.toml's last two
// rules (`/app/*` and `/*` -> /index.html 200) are the client router's fallback,
// and on Pages that is the platform's own default rather than a route: with no
// top-level 404.html in dist/, "Pages' default single-page application behavior
// matches all incoming paths to the root (`/`)". This table therefore covers
// FUNCTIONS only, `resolveRoute` returns null for /engine, /ledger and friends,
// and the asset server serves index.html for them. See wrangler.toml's header
// and `hosting.test.ts`, which pins the no-404.html precondition.
//
// PARITY, NOT A NEW SURFACE. Every function is reachable on Netlify today at
// `/.netlify/functions/<name>` whether or not it has a pretty redirect — that is
// exactly why alert-check, the bulletins and the watchdog carry their own
// body-marker + slot-claim gates (lib/schedule.ts). `/api/fn/<name>` is the same
// door with a different sign on it, and it exists because the Telegram webhook
// and the scheduled functions have no pretty path and must stay reachable. It
// does not widen anything: no handler's auth changes, and the escape hatch is
// listed in the M2 report so M4 can re-register the webhook URL.

import { installRuntimeEnv, readEnv, type RuntimeEnvBag } from './runtimeEnv'
import { configureStoreFromEnv } from './storeProvider'

/** The shape every `netlify/functions/*.mts` already exports.
 *
 * The second parameter is typed `never` on purpose. The handlers spell it
 * `_context: Context` (Netlify's own type) and never read it; `never` is
 * assignable to every one of those spellings under `strictFunctionTypes`, so
 * this constraint accepts all 22 files unchanged AND still fails the build if
 * one of them ever stops exporting a default. `any` would accept anything at
 * all, including a module with no handler in it. */
export type HandlerModule = { default: (req: Request, ctx: never) => Response | Promise<Response> }

/** Every `netlify/functions/*.mts`, by filename. The thunks are literal so a
 * bundler can see through them: nothing is loaded until it is asked for, which
 * keeps a `/api/market` request from paying to parse the engine. */
export const HANDLERS = {
  'ai-insights': () => import('../ai-insights.mts'),
  'alert-check': () => import('../alert-check.mts'),
  'alert-tail': () => import('../alert-tail.mts'),
  backup: () => import('../backup.mts'),
  'bulletin-evening': () => import('../bulletin-evening.mts'),
  'bulletin-premarket': () => import('../bulletin-premarket.mts'),
  'config-sync': () => import('../config-sync.mts'),
  'congress-warm': () => import('../congress-warm.mts'),
  download: () => import('../download.mts'),
  engine: () => import('../engine.mts'),
  'event-dossier-background': () => import('../event-dossier-background.mts'),
  'helm-export': () => import('../helm-export.mts'),
  'ledger-snapshot': () => import('../ledger-snapshot.mts'),
  licences: () => import('../licences.mts'),
  'market-data': () => import('../market-data.mts'),
  newsletters: () => import('../newsletters.mts'),
  portfolio: () => import('../portfolio.mts'),
  'predict-background': () => import('../predict-background.mts'),
  push: () => import('../push.mts'),
  report: () => import('../report.mts'),
  'report-compose-background': () => import('../report-compose-background.mts'),
  'telegram-webhook': () => import('../telegram-webhook.mts'),
  'video-analyze-background': () => import('../video-analyze-background.mts'),
  'video-transcripts': () => import('../video-transcripts.mts'),
  'video-capture-poll': () => import('../video-capture-poll.mts'),
  'video-jobs': () => import('../video-jobs.mts'),
  watchdog: () => import('../watchdog.mts'),
} satisfies Record<string, () => Promise<HandlerModule>>

export type HandlerName = keyof typeof HANDLERS

export const HANDLER_NAMES = Object.keys(HANDLERS).sort() as HandlerName[]

export function isHandlerName(name: string): name is HandlerName {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name)
}

/** Exact-path routes — netlify.toml's `[[redirects]]`, transcribed. */
export const EXACT_ROUTES: Readonly<Record<string, HandlerName>> = {
  '/api/market': 'market-data',
  '/api/engine': 'engine',
  '/api/config': 'config-sync',
  '/api/export': 'helm-export',
  '/report': 'report',
  '/api/portfolio': 'portfolio',
  '/api/ai': 'ai-insights',
  '/api/backup': 'backup',
  '/api/push': 'push',
  '/api/licences': 'licences',
  '/api/video-transcripts': 'video-transcripts',
  '/api/newsletters': 'newsletters',
}

/** Prefix routes. netlify.toml's `/download/*` carries the splat into a query
 * parameter (`?platform=:splat`); download.mts reads `platform` first and falls
 * back to the last path segment, so both spellings work — we set the parameter
 * anyway so the two hosts hand the handler an identical Request. */
export const PREFIX_ROUTES: readonly { prefix: string; name: HandlerName; param?: string }[] = [
  { prefix: '/download/', name: 'download', param: 'platform' },
]

/** The by-name escape hatch: `/api/fn/<function-file-name>`. */
export const FN_PREFIX = '/api/fn/'

export interface Resolved {
  name: HandlerName
  /** The URL the handler should see — identical to the incoming one except for
   * a splat lifted into a query parameter. */
  url: URL
}

/** Public path → handler, or null when nothing matches (the caller 404s). */
export function resolveRoute(url: URL): Resolved | null {
  // Trailing slashes: `/api/engine/` is the same door as `/api/engine`.
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname

  const exact = EXACT_ROUTES[path]
  if (exact) return { name: exact, url }

  // Prefix routes match the STRIPPED path too, or `/api/engine/` would be the
  // same door as `/api/engine` while `/download/mac/` quietly became
  // `?platform=mac%2F`. `/download` and `/download/` both mean "no platform" and
  // reach the handler's own "unknown platform — use /download/mac" 404.
  for (const r of PREFIX_ROUTES) {
    const bare = r.prefix.replace(/\/$/, '')
    if (path !== bare && !path.startsWith(r.prefix)) continue
    const splat = path === bare ? '' : path.slice(r.prefix.length)
    const next = new URL(url.toString())
    if (r.param && splat) next.searchParams.set(r.param, splat)
    return { name: r.name, url: next }
  }

  if (path.startsWith(FN_PREFIX)) {
    const name = path.slice(FN_PREFIX.length)
    if (isHandlerName(name)) return { name, url }
  }

  return null
}

/** Load and run one handler by name. */
export async function invokeHandler(name: HandlerName, req: Request, ctx?: unknown): Promise<Response> {
  const mod: HandlerModule = await HANDLERS[name]()
  return await mod.default(req, ctx as never)
}

/* ──────────────── I-5: the security headers, on function responses ────────────────
 *
 * `public/_headers` and netlify.toml's `[[headers]]` both cover `/*`, and
 * NEITHER reaches a function response — that is documented platform behaviour on
 * both hosts ("Custom headers defined in the _headers file are not applied to
 * responses generated by Pages Functions"), and it left /report and every
 * /api/* answer with no X-Frame-Options, no nosniff, no referrer policy and no
 * CSP. /report in particular serves a full HTML edition.
 *
 * M2 booked it as an M4 item purely to avoid diverging from Netlify mid-parallel
 * run. That reason expired with the cutover: the Netlify site is disabled and
 * Pages is production, so the only thing left is the gap.
 *
 * The values are RESTATED here rather than read, because a Worker has no file
 * system — but `hosting.test.ts` parses public/_headers and fails if one
 * character of this object drifts from it, which is the same anti-drift rule
 * that file already applies to netlify.toml.
 */
export const FUNCTION_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
}

/** Add the set to a response WITHOUT overruling a handler that set one itself:
 * a handler asking for its own CSP or a permissive frame policy knows something
 * this layer does not, and a default that silently wins is a default that will
 * one day break a deliberate choice. */
function withSecurityHeaders(res: Response): Response {
  const missing = Object.entries(FUNCTION_RESPONSE_HEADERS).filter(([name]) => !res.headers.has(name))
  if (!missing.length) return res
  const headers = new Headers(res.headers)
  for (const [name, value] of missing) headers.set(name, value)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

const notFound = (path: string) =>
  new Response(JSON.stringify({ ok: false, error: 'not-found', path }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export interface DispatchOptions {
  /** The Cloudflare env object (vars + secrets + bindings). */
  env?: RuntimeEnvBag | null
  /** Anything the handler's unused second parameter should receive. */
  ctx?: unknown
  /** Return null instead of a 404 so a Pages entry point can call `next()`. */
  passThrough?: boolean
}

/** Should a 500 body carry the exception's message?
 *
 * NO by default. A thrown `Error` here is an internal one — its message is a
 * file path, a SQL fragment, an upstream URL with a key in it, or whatever a
 * dependency chose to put in a string, and none of that is the public's. The
 * real error always goes to `console.error`, so nothing is lost: it is in the
 * Worker log either way.
 *
 * `DEBUG_ERRORS=1` puts the message back in the response, which is what M3's
 * preview deployments want — reading a parallel-run diff through the logs alone
 * is miserable. It is a preview switch, never set on the production project. */
function debugErrors(): boolean {
  return readEnv('DEBUG_ERRORS') === '1'
}

/** THE ENTRY POINT both Pages Functions use.
 *
 * Installs the host env, picks the store backend, resolves the path and runs the
 * handler. A handler that throws becomes an opaque 500; see `debugErrors`. */
export async function dispatch(req: Request, opts: DispatchOptions = {}): Promise<Response | null> {
  installRuntimeEnv(opts.env)
  configureStoreFromEnv(opts.env)

  const url = new URL(req.url)
  const hit = resolveRoute(url)
  // A pass-through is not a response at all — the asset server answers next, and
  // it applies public/_headers itself.
  if (!hit) return opts.passThrough ? null : withSecurityHeaders(notFound(url.pathname))

  // The splat rewrite means the handler may need a Request with a different URL.
  // Re-wrapping preserves method, headers and body (streams are passed through).
  const request = hit.url.toString() === req.url ? req : new Request(hit.url.toString(), req)

  try {
    return withSecurityHeaders(await invokeHandler(hit.name, request, opts.ctx))
  } catch (e) {
    console.error(`ROUTER ${hit.name} failed:`, e)
    const body = debugErrors()
      ? { ok: false, error: 'handler-failed', fn: hit.name, detail: String((e as Error)?.message ?? e).slice(0, 300) }
      : { ok: false, error: 'internal' }
    return withSecurityHeaders(
      new Response(JSON.stringify(body), {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
    )
  }
}

/* ─────────────────────────── the Pages adapter ───────────────────────────
 * Structurally what Cloudflare hands a Pages Function (`EventContext`),
 * declared here rather than imported so M2 adds no `@cloudflare/workers-types`
 * dependency — the same choice M1 made for `D1Database`, and reversible in one
 * import when the package does arrive.
 */
export interface PagesContext {
  request: Request
  env: RuntimeEnvBag
  params?: Record<string, string | string[]>
  waitUntil?(promise: Promise<unknown>): void
  next?(input?: Request): Promise<Response>
  data?: Record<string, unknown>
}

/** The three files under `functions/` are this call and nothing else. */
export function pagesHandler(ctx: PagesContext): Promise<Response> {
  return dispatch(ctx.request, { env: ctx.env, ctx }) as Promise<Response>
}
