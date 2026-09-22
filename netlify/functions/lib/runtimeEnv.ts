// ONE place that knows where the environment lives.
//
// M2 of the Cloudflare migration (docs/superpowers/specs/2026-08-12-cloudflare-migration-design.md).
//
// Netlify functions and the GitHub Actions runners read `process.env`. Cloudflare
// Workers hand the handler an `env` OBJECT instead — vars, secrets and bindings
// (D1) together. Twenty-three handler files read `process.env.X` directly and
// the parallel-run requirement is that they keep working on Netlify UNCHANGED,
// so this module does not ask them to change: it MIRRORS the Worker's env bag
// onto `process.env` at the top of every request, creating the `process.env`
// object itself if the runtime has none.
//
// That direction is deliberate. Rewriting 60+ `process.env.X` reads across the
// handlers would be the largest and riskiest diff in the migration for zero
// behavioural gain, and it would have to be un-written again at M4. Mirroring
// costs one loop over a small object per request and leaves the handlers'
// existing reads correct on BOTH hosts. New code (the router, the cron
// dispatcher, the store provider) reads through `readEnv` instead.
//
// A real value already in `process.env` is never clobbered: on Netlify the
// platform's own variables win, and on Workers with `nodejs_compat` (which
// populates `process.env` from the same bindings) the mirror is a no-op.
//
// NON-STRING bindings — D1, KV, R2 — cannot live in `process.env`. They are
// reachable through `runtimeBinding(name)`, which is how the store provider
// finds the database.

export type RuntimeEnvBag = Record<string, unknown>

let bag: RuntimeEnvBag | null = null

/** Best-effort handle on a writable `process.env`, or null if the runtime has
 * no `process` at all and one cannot be fabricated.
 *
 * WHAT THE FABRICATED `process` IS NOT. When the runtime has no `process` we
 * create `{ env: {} }` — an env bag and nothing else. It has no `versions`, no
 * `nextTick`, no `platform`, no `cwd`, no `argv`, no `on`. That is deliberate:
 * the only thing this module owes the handlers is `process.env.X`, and a
 * half-built `process` that answers `versions.node` would tell every library
 * that does `if (process.versions?.node)` that it is running on Node and send
 * it down a filesystem path that does not exist. A missing property throws or
 * reads undefined at the point of use, which is legible; a lying one is not.
 * If a dependency ever genuinely needs `process.nextTick`, the answer is
 * `nodejs_compat` (which supplies a real `process`), not another field here. */
function processEnv(): Record<string, string | undefined> | null {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  try {
    if (!g.process) g.process = { env: {} }
    if (!g.process.env) g.process.env = {}
    return g.process.env
  } catch {
    return null
  }
}

/** Install the host's env object for this invocation.
 *
 * Called by every Cloudflare entry point (the Pages router, the cron Worker)
 * before any handler runs. Under Netlify nobody calls it and `readEnv` falls
 * straight through to `process.env` — the unchanged path. */
export function installRuntimeEnv(env: RuntimeEnvBag | null | undefined): void {
  bag = env ?? null
  if (!env) return
  const pe = processEnv()
  if (!pe) return
  for (const [k, v] of Object.entries(env)) {
    // Only strings, and never over the top of a value the platform already set.
    if (typeof v !== 'string') continue
    if (pe[k] !== undefined && pe[k] !== '') continue
    try {
      pe[k] = v
    } catch (e) {
      // A frozen process.env is SURVIVABLE — new code reads through readEnv,
      // which finds the bag regardless. It is not silent, though: the 23
      // handler files still read `process.env.X` directly, so a frozen env
      // means they see undefined for every secret and the site 401s everything
      // (M3 verification item 2). Say it once — once per isolate, not once per
      // key per request, or the log becomes the outage.
      warnMirrorFailed(k, e)
    }
  }
}

let mirrorWarned = false

function warnMirrorFailed(key: string, e: unknown): void {
  if (mirrorWarned) return
  mirrorWarned = true
  console.error(
    `runtimeEnv: could not mirror '${key}' onto process.env — it is frozen or read-only. ` +
      'Code using readEnv() is unaffected; handler code reading the process env directly will see undefined ' +
      'for every var the host supplies. Further mirror failures in this isolate are not logged.',
    e,
  )
}

/** Forget the installed bag. Tests use it; nothing in production does. Also
 * re-arms the one-time mirror-failure warning, so a test can drive it twice. */
export function clearRuntimeEnv(): void {
  bag = null
  mirrorWarned = false
}

/** The installed Worker env bag, or null under Netlify/Node. */
export function runtimeEnvBag(): RuntimeEnvBag | null {
  return bag
}

/** A string variable, wherever it lives. Worker bag first (it is the most
 * specific thing we were handed), then `process.env`. */
export function readEnv(name: string): string | undefined {
  const fromBag = bag?.[name]
  if (typeof fromBag === 'string' && fromBag !== '') return fromBag
  const pe = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const fromProc = pe?.[name]
  return fromProc === '' ? undefined : fromProc
}

/** A NON-string binding (D1, KV, R2, service). Only Workers have these. */
export function runtimeBinding<T = unknown>(name: string): T | null {
  const v = bag?.[name]
  return v != null && typeof v !== 'string' ? (v as T) : null
}

export type RuntimeHost = 'workers' | 'netlify' | 'node'

/** Where are we? Advisory only — LOGGING and reporting, never control flow that
 * matters. The store backend is chosen by whether a D1 binding was handed over
 * (see storeProvider), not by sniffing the host, because a sniff that guesses
 * wrong would silently point the live site at the wrong database. */
export function runtimeHost(): RuntimeHost {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator
  if (nav?.userAgent === 'Cloudflare-Workers') return 'workers'
  if (bag !== null) return 'workers'
  const pe = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  if (pe?.NETLIFY || pe?.NETLIFY_DEV || pe?.AWS_LAMBDA_FUNCTION_NAME) return 'netlify'
  return 'node'
}

/** Every environment variable the functions consume, as one list.
 *
 * This IS the wrangler-secret checklist for M3: `wrangler pages secret put` /
 * `wrangler secret put` for each of these that is set on Netlify today. Kept
 * beside the mapping deliberately — a var added to a handler and not added here
 * is a var nobody remembers to move on cutover day. `runtimeEnv.test.ts` greps
 * the handler tree and fails when the two drift. */
export const FUNCTION_ENV_VARS = [
  // auth / tokens
  'APP_TOKEN',
  'REPORT_TOKEN',
  'REPORT_PUBLISH_TOKEN',
  'HELM_EXPORT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  // market data
  'FINNHUB_API_KEY',
  'FMP_API_KEY',
  'QUIVER_API_KEY',
  // LLM providers. The *_MODEL / *_BASE_URL / LLM_PROVIDER names are NOT
  // visible to a `process.env.X` grep: lib/llm.ts spreads the whole of
  // `process.env` into its LlmEnv (llm.ts:155,160,190) and reads them off the
  // resulting object, and `modelFor` indexes `process.env[key]` with a computed
  // key. They are live overrides — GROQ_MODEL exists precisely so a Groq model
  // retirement is an env change and not a deploy (watchdog.mts:49) — so they
  // belong on the cutover checklist like any secret.
  'GROQ_API_KEY',
  'GROQ_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GOOGLE_GEMINI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'LLM_PROVIDER',
  'SUPADATA_API_KEY',
  'YOUTUBE_API_KEY', // optional comment sampling for creator/audience separation
  'SEC_USER_AGENT', // optional contact-identifying User-Agent for SEC EDGAR
  'TRANSCRIPT_TOKEN', // the Mac transcript runner's dedicated door (video-transcripts.mts)
  'NEWSLETTER_TOKEN', // the Gmail Apps Script's dedicated door (newsletters.mts)
  // delivery
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'RESEND_API_KEY',
  'REPORT_EMAIL_TO',
  'REPORT_EMAIL_FROM',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  // broker
  'T212_API_KEY',
  'T212_SECRET_KEY',
  'T212_HOST',
  // platform
  'URL',
  'NETLIFY_SITE_ID',
  'NETLIFY_AUTH_TOKEN',
  // behaviour switches
  'SKIP_COMPOSE_CHAIN',
  'FORCE_RUN',
  'REPLAY_CACHE_DIR',
  // M2 additions — the host seam itself
  'STORE_BACKEND',
  'WORKER_OWNS_PREDICT',
  // Preview-only. `=1` puts the exception message back into the router's 500
  // body (lib/router.ts). Never set on the production project.
  'DEBUG_ERRORS',
] as const

export type FunctionEnvVar = (typeof FUNCTION_ENV_VARS)[number]
