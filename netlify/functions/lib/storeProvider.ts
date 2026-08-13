// THE ONE SEAM the handlers import instead of picking a store themselves.
//
// M2 of the Cloudflare migration (docs/superpowers/specs/2026-08-12-cloudflare-migration-design.md).
//
// M1 built `d1AppStore` behind the existing `AppStore` interface but wired it to
// nothing. This is the wire. Every handler that used to say
//
//     import { blobAppStore } from './lib/store'
//
// now says
//
//     import { appStore as blobAppStore } from './lib/storeProvider'
//
// — one line per file, the local name unchanged so no call site moves. On
// Netlify `appStore` IS `blobAppStore`, byte for byte the same object graph and
// the same behaviour; that is the parallel-run requirement. On Pages/Workers the
// entry point calls `configureStoreFromEnv(env)` first, a D1 binding is found,
// and the very same handler code runs against D1.
//
// SELECTION IS BINDING-DRIVEN, NOT SNIFFED. We do not guess the host from a
// user-agent or an env var and then reach for a database: we use D1 if and only
// if we were HANDED a D1 binding (or explicitly told to by STORE_BACKEND=d1,
// which then requires the binding to exist and throws if it does not). A sniff
// that guessed wrong would silently point the live site at an empty store.
//
// THE GLOBAL, HONESTLY. `current` is module state, and a Workers isolate serves
// concurrent requests from one module instance — so in principle request B can
// re-install the backend while request A is mid-flight. It is safe here for a
// specific reason: within one deployment every request carries the SAME binding
// to the SAME database, so a re-install is a no-op in effect. `configureStoreFromEnv`
// makes that literal by returning early when the identical binding is already
// installed. What this must never become is per-request or per-tenant state; if
// that day comes, the answer is AsyncLocalStorage (node:async_hooks under
// nodejs_compat), not a bigger global.

import { blobAppStore, type AppStore } from './store'
import { d1AppStore, d1CacheStore, type D1Database, type D1Store } from './d1Store'
import { readEnv, runtimeBinding, type RuntimeEnvBag } from './runtimeEnv'

export type StoreBackendKind = 'blobs' | 'd1'

interface Installed {
  kind: StoreBackendKind
  app: AppStore
  /** Only D1 has one: lib/cache.ts falls back to Netlify Blobs when it is null. */
  cache: D1Store | null
  db: D1Database | null
}

const BLOBS: Installed = { kind: 'blobs', app: blobAppStore, cache: null, db: null }

let current: Installed = BLOBS

/** Binding names we accept for the D1 database, in order. `DB` is the
 * Cloudflare convention; the explicit name is what wrangler.toml declares. */
export const D1_BINDING_NAMES = ['STREETSIGNAL_DB', 'DB'] as const

/** Duck-type: a D1Database is anything that can `prepare`. Keeps this module
 * free of `@cloudflare/workers-types` exactly as M1's d1Store.ts is. */
export function looksLikeD1(v: unknown): v is D1Database {
  return !!v && typeof (v as { prepare?: unknown }).prepare === 'function'
}

/** Point every subsequent store read/write at this D1 database. */
export function useD1Store(db: D1Database): void {
  if (current.db === db) return
  current = { kind: 'd1', app: d1AppStore(db), cache: d1CacheStore(db), db }
}

/** Back to Netlify Blobs. The default; tests use it to undo themselves. */
export function useBlobStore(): void {
  current = BLOBS
}

export function storeBackend(): StoreBackendKind {
  return current.kind
}

/** The live app store. Prefer the `appStore` proxy below — this is for code
 * that needs the concrete object (the cron sweep wants `sweepExpired`). */
export function currentAppStore(): AppStore {
  return current.app
}

/** The live cache store, or null when Netlify Blobs owns the cache.
 * lib/cache.ts branches on exactly this. */
export function currentCacheStore(): D1Store | null {
  return current.cache
}

/** The installed D1 database, or null under Blobs. */
export function currentD1(): D1Database | null {
  return current.db
}

/** Choose the backend from a host env object. Idempotent; returns what it chose.
 *
 * @throws when STORE_BACKEND=d1 is set but no binding is present — a deployment
 * that MEANT to use D1 and silently fell back to Blobs would write the day's
 * ledger into the wrong store, and that failure has to be loud.
 */
export function configureStoreFromEnv(env?: RuntimeEnvBag | null): StoreBackendKind {
  // The bag we were just handed wins over anything already installed: it is the
  // most specific thing we know, and on Pages it arrives before installRuntimeEnv
  // has had a chance to mirror it anywhere.
  const passed = env?.STORE_BACKEND
  const forced = (typeof passed === 'string' && passed !== '' ? passed : readEnv('STORE_BACKEND'))?.toLowerCase()
  const db = findD1Binding(env)
  if (forced === 'blobs') {
    useBlobStore()
    return 'blobs'
  }
  if (forced === 'd1' && !db) throw new Error('STORE_BACKEND=d1 but no D1 binding found (expected one of: ' + D1_BINDING_NAMES.join(', ') + ')')
  if (db) {
    useD1Store(db)
    return 'd1'
  }
  useBlobStore()
  return 'blobs'
}

/** Choose the backend for a LONG-LIVED NODE PROCESS — the GitHub Actions
 * workers in `scripts/bg/`. Call it once, first thing, before any store use.
 *
 * WHY THIS EXISTS. Those scripts used to `import { blobAppStore } from
 * './lib/store'` directly, which looks harmless and is not: they then
 * dynamic-import the very handlers that read through `appStore`. Once the queue
 * PRODUCER (alert-check on the Worker) writes `work-queue` to D1 while the
 * CONSUMER (drain-queue on Actions) reads `work-queue` from Blobs, the queue is
 * never drained and nothing anywhere says so — both halves report success over
 * an empty list. Same for `engine-board`: daily-run would decide "already ran
 * today" from one store while the handler it invokes writes to the other.
 * Routing them through the seam makes the split a decision instead of an
 * accident, and this function makes the decision explicit and loud.
 *
 * There is no binding in a Node process — bindings only exist inside workerd —
 * so `STORE_BACKEND=d1` cannot be honoured here without a REMOTE D1 client
 * (D1's HTTP API, or an authenticated `/api/store` endpoint on the Worker).
 * That is M3 work; the seam is here so it lands in one place.
 *
 * @throws on `STORE_BACKEND=d1`, and on any value that is neither backend —
 * a typo must not quietly leave the process writing to Blobs.
 */
export function configureStoreForNodeProcess(): StoreBackendKind {
  const forced = readEnv('STORE_BACKEND')?.toLowerCase()
  if (!forced || forced === 'blobs') {
    useBlobStore()
    return 'blobs'
  }
  if (forced === 'd1') {
    throw new Error(
      'STORE_BACKEND=d1 is not supported in a Node process: remote D1 access lands in M3. ' +
        'Bindings exist only inside workerd, so scripts/bg/ needs D1\'s HTTP API or an authenticated store endpoint on the Worker. ' +
        'Until then leave STORE_BACKEND unset on the GitHub Actions runners — they talk to Netlify Blobs via NETLIFY_SITE_ID/NETLIFY_AUTH_TOKEN.',
    )
  }
  throw new Error(`unknown STORE_BACKEND=${forced} (expected 'blobs' or 'd1')`)
}

/** First recognised D1 binding on the env object, else the runtime bag. */
export function findD1Binding(env?: RuntimeEnvBag | null): D1Database | null {
  for (const name of D1_BINDING_NAMES) {
    const direct = env?.[name]
    if (looksLikeD1(direct)) return direct
    const bound = runtimeBinding(name)
    if (looksLikeD1(bound)) return bound
  }
  return null
}

/** THE HANDLER-FACING OBJECT. A thin delegating façade rather than a re-export,
 * because the backend is chosen per-invocation and a re-export would freeze
 * whichever store happened to be installed when the module first loaded.
 *
 * `readStrong` is always present. Under Blobs it is the real strong read that
 * auth.ts's licence-miss retry depends on; under D1 it is a plain read, which
 * is the same guarantee for free (M1). Callers that branch on its presence
 * (auth.ts, readLicencesFresh) therefore take the same path on both hosts. */
export const appStore: AppStore & { readStrong<T>(key: string): Promise<T | null> } = {
  read<T>(key: string): Promise<T | null> {
    return current.app.read<T>(key)
  },
  write(key: string, value: unknown): Promise<void> {
    return current.app.write(key, value)
  },
  readStrong<T>(key: string): Promise<T | null> {
    const s = current.app
    return s.readStrong ? s.readStrong<T>(key) : s.read<T>(key)
  },
}

export type { AppStore } from './store'

/** Re-exported so a handler's ONE changed import line can still bring in the
 * lease handshake beside the store (predict-background). These are pure
 * functions over an `AppStore` — they gained nothing from the migration and
 * lost nothing; M1 already drove them over D1 in `d1Store.test.ts`. */
export { acquireLease, releaseLease } from './store'
