import { runtimeHost } from './runtimeEnv'

// The paper's ONE public address. Every link a reader can see or tap —
// licence unlock links, Telegram replies, report emails, OG tags, the Helm
// dashboard — uses this constant, NOT process.env.URL: Netlify's URL var is
// whatever the dashboard considers the primary domain (it silently reverts to
// *.netlify.app if the custom domain is ever unset or demoted), and outward
// links must never depend on that setting. Internal self-invocations
// (function → function fetches) keep env.URL so deploy previews still work.
export const CANONICAL_SITE = 'https://thestreetsignal.rqai.co.uk'

/** THE ONE PLACE that knows how a function addresses another function.
 *
 * The two hosts spell it differently and neither spelling works on both:
 *
 *   Netlify  `/.netlify/functions/<name>`  native; every function has one.
 *   Pages    `/api/fn/<name>`              lib/router.ts's by-name door. Pages
 *                                          cannot serve a dot-segment directory,
 *                                          so the Netlify spelling 404s there.
 *
 * netlify.toml declares no `/api/fn/*` redirect, so the Pages spelling 404s on
 * Netlify too — which is why this cannot be a constant. A self-invocation that
 * hardcodes either one is broken on exactly one host, silently, in a `.catch()`.
 *
 * SAFE BY DEFAULT: only an explicitly installed Worker env bag makes
 * `runtimeHost()` say 'workers' (see runtimeEnv.ts), and only the Cloudflare
 * entry points install one. Netlify, GitHub Actions and vitest all fall to the
 * Netlify spelling — today's behaviour, unchanged. */
export function internalFunctionPath(name: string): string {
  return runtimeHost() === 'workers' ? `/api/fn/${name}` : `/.netlify/functions/${name}`
}

/** The same, absolute. `base` is the self-origin — `process.env.URL` on both
 * hosts (Cloudflare does not inject it; it is on the M3 secret checklist), NOT
 * CANONICAL_SITE, so deploy previews call themselves and not production. */
export function internalFunctionUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}${internalFunctionPath(name)}`
}
