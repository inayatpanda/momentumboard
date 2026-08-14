// Cloudflare Pages Functions — the root middleware.
//
// It exists for ONE reason: the macOS desktop build. The Tauri wrap ships this
// project's own `dist` inside the app bundle and serves it from the webview's
// local protocol — `tauri://localhost` on macOS, `http://tauri.localhost` on
// Windows and Linux. The bundle is byte-for-byte the site's, but its origin is
// not the site's, so every API call it makes is cross-origin; and because those
// calls carry `x-app-token`, they are PREFLIGHTED cross-origin calls. Answer the
// preflight or the desktop app has no server at all.
//
// THE RULE IS AN EXACT-MATCH ALLOW-LIST, and it is deliberately narrow:
//
//   * Never `*`. The API is authenticated by a header the reader's browser will
//     happily attach on their behalf; a wildcard would let any page on the
//     internet read a licensed reader's engine data out of their own browser.
//   * Never a prefix/suffix/`includes` test. `tauri://localhost.evil.test` and
//     `https://tauri.localhost` are registrable, serveable strings that all
//     pass a sloppy match. `_middleware.test.ts` pins each of them as REFUSED.
//   * Everything unrecognised — the website itself, crawlers, curl, and any
//     other site — falls straight through to `next()` with no header added and
//     no response re-wrap, so the browser's default same-origin rule stands
//     exactly as it did before this file existed.
//
// A note on placement: at the root of `functions/` this runs ahead of BOTH
// entry points (`api/[[route]].ts` and `report.ts`) and ahead of static assets.
// That breadth is the point — `/report` is a server path too, which is why
// `x-report-token` is in the allowed header set — and the cost is bounded,
// because the non-Tauri path returns the downstream response untouched.
//
// The security headers on the responses themselves are NOT this file's job:
// lib/router.ts attaches `FUNCTION_RESPONSE_HEADERS` to every function answer,
// and public/_headers covers the assets. This file only ever ADDS the two CORS
// names, so `hosting.test.ts`'s pins on that set are unaffected.

import type { PagesContext } from '../netlify/functions/lib/router'

/** The two origins a Tauri v2 webview serves bundled assets from. macOS uses
 * the first; the second is Windows/Linux, kept so a later wrap on either needs
 * no server change. Nothing else is ever matched. */
export const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const

/** The custom request headers the client sends: the licence token on /api/*,
 * the report token on /report, and content-type on every write. A header
 * missing here fails the preflight for whichever call needs it, and nothing
 * else — which is exactly the kind of partial breakage that is hard to read
 * from the app, so keep it in step with src/lib/api.ts. */
const ALLOW_HEADERS = 'content-type, x-app-token, x-report-token'

/** Everything the API answers to. `dispatch` handles method policy per route;
 * this only says which methods a preflight may ask about. */
const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS'

/** 24h — the browser's cap on Chromium; the policy is static, so re-asking is
 * pure latency on every write the desktop app makes. */
const MAX_AGE = '86400'

const allowedOrigin = (req: Request): string | null => {
  const origin = req.headers.get('Origin')
  return origin && (TAURI_ORIGINS as readonly string[]).includes(origin) ? origin : null
}

/** Add `Origin` to Vary without duplicating one the handler already set — the
 * response differs by origin now, and a shared cache must not serve the
 * desktop app's CORS-headed copy to a website visitor or the reverse. */
const varyOnOrigin = (headers: Headers): void => {
  const current = headers.get('Vary')
  if (!current) return headers.set('Vary', 'Origin')
  if (current.split(',').some(v => v.trim().toLowerCase() === 'origin')) return
  headers.append('Vary', 'Origin')
}

export const onRequest = async (ctx: PagesContext): Promise<Response> => {
  const origin = allowedOrigin(ctx.request)

  // Not the desktop shell: this file is not here. Note the response is returned
  // AS IS, not copied — a root middleware is on the path of every asset.
  if (!origin) return ctx.next!()

  // The preflight is answered here rather than passed down: it carries no
  // token and no body, and a handler has nothing useful to say about it.
  if (ctx.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Max-Age': MAX_AGE,
        Vary: 'Origin',
      },
    })
  }

  const res = await ctx.next!()
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  varyOnOrigin(headers)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
