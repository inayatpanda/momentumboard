// THE ROUTE TABLE — one copy, two hosts.
//
// M2 of the Cloudflare migration (docs/superpowers/specs/2026-08-12-cloudflare-migration-design.md).
//
// On Netlify the mapping from a public path to a function lives in netlify.toml's
// `[[redirects]]` block, and the platform does the dispatch. Cloudflare Pages has
// no equivalent for functions, so the mapping becomes code — and once it is code
// it can be TESTED for completeness, which netlify.toml never could be.
//
// The table below is the netlify.toml redirect list, transcribed. `routes.test.ts`
// parses netlify.toml and fails if the two ever disagree, so this file cannot rot
// while the live site still runs on Netlify.
//
// PARITY, NOT A NEW SURFACE. Every function is reachable on Netlify today at
// `/.netlify/functions/<name>` whether or not it has a pretty redirect — that is
// exactly why alert-check, the bulletins and the watchdog carry their own
// body-marker + slot-claim gates (lib/schedule.ts). `/api/fn/<name>` is the same
// door with a different sign on it, and it exists because the Telegram webhook
// and the scheduled functions have no pretty path and must stay reachable. It
// does not widen anything: no handler's auth changes, and the escape hatch is
// listed in the M2 report so M4 can re-register the webhook URL.

import { installRuntimeEnv, type RuntimeEnvBag } from './runtimeEnv'
import { configureStoreFromEnv } from './storeProvider'

/** The shape every `netlify/functions/*.mts` already exports.
 *
 * The second parameter is typed `never` on purpose. The handlers spell it
 * `_context: Context` (Netlify's own type) and never read it; `never` is
 * assignable to every one of those spellings under `strictFunctionTypes`, so
 * this constraint accepts all 23 files unchanged AND still fails the build if
 * one of them ever stops exporting a default. `any` would accept anything at
 * all, including a module with no handler in it. */
export type HandlerModule = { default: (req: Request, ctx: never) => Response | Promise<Response> }

/** Every `netlify/functions/*.mts`, by filename. The thunks are literal so a
 * bundler can see through them: nothing is loaded until it is asked for, which
 * keeps a `/api/market` request from paying to parse the engine. */
export const HANDLERS = {
  'ai-insights': () => import('../ai-insights.mts'),
  'alert-check': () => import('../alert-check.mts'),
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
  portfolio: () => import('../portfolio.mts'),
  'predict-background': () => import('../predict-background.mts'),
  push: () => import('../push.mts'),
  report: () => import('../report.mts'),
  'report-compose-background': () => import('../report-compose-background.mts'),
  t212: () => import('../t212.mts'),
  'telegram-webhook': () => import('../telegram-webhook.mts'),
  'video-analyze-background': () => import('../video-analyze-background.mts'),
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
  '/api/t212': 't212',
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

  for (const r of PREFIX_ROUTES) {
    if (url.pathname.startsWith(r.prefix)) {
      const splat = url.pathname.slice(r.prefix.length)
      const next = new URL(url.toString())
      if (r.param && splat) next.searchParams.set(r.param, splat)
      return { name: r.name, url: next }
    }
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

/** THE ENTRY POINT both Pages Functions use.
 *
 * Installs the host env, picks the store backend, resolves the path and runs the
 * handler. A handler that throws becomes a 500 with the message — Netlify's own
 * behaviour, and losing the message would make M3's parallel run unreadable. */
export async function dispatch(req: Request, opts: DispatchOptions = {}): Promise<Response | null> {
  installRuntimeEnv(opts.env)
  configureStoreFromEnv(opts.env)

  const url = new URL(req.url)
  const hit = resolveRoute(url)
  if (!hit) return opts.passThrough ? null : notFound(url.pathname)

  // The splat rewrite means the handler may need a Request with a different URL.
  // Re-wrapping preserves method, headers and body (streams are passed through).
  const request = hit.url.toString() === req.url ? req : new Request(hit.url.toString(), req)

  try {
    return await invokeHandler(hit.name, request, opts.ctx)
  } catch (e) {
    console.error(`ROUTER ${hit.name} failed:`, e)
    return new Response(JSON.stringify({ ok: false, error: 'handler-failed', fn: hit.name, detail: String((e as Error)?.message ?? e).slice(0, 300) }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
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
