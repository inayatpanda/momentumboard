import { currentCacheStore } from './storeProvider'

type Entry = { value: unknown; expires: number }
const mem = new Map<string, Entry>()

// M2: the ONE place `getStore('cache')` is reached for in the whole codebase
// (M1's H2 audit proved that), so it is also the only place the cache needs a
// host seam. `currentCacheStore()` is null on Netlify and under Node — the two
// functions below then behave exactly as they always have, byte for byte — and
// is the D1 cache store once a Cloudflare entry point has installed a binding.
// The envelope is identical on both sides: `{ value, expires }` with `expires`
// in epoch ms, which is what d1Store lifts into its `expires_at` column.

async function blobStore() {
  try {
    const { getStore } = await import('@netlify/blobs')
    // same dual-home rule as lib/store.ts: env creds -> GitHub Actions runner
    return process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN
      ? getStore({ name: 'cache', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN })
      : getStore('cache')
  } catch {
    return null
  }
}

export async function getCached<T>(key: string): Promise<T | null> {
  const d1 = currentCacheStore()
  // The expiry check below is kept even though d1Store already filters on
  // `expires_at` in its SQL predicate: two nets, deliberately (M1 gate H2).
  const entry = d1 ? await d1.read<Entry>(key) : await blobEntry(key)
  if (!entry || entry.expires < Date.now()) return null
  return entry.value as T
}

async function blobEntry(key: string): Promise<Entry | null> {
  const store = await blobStore()
  return store ? ((await store.get(key, { type: 'json' })) as Entry | null) : (mem.get(key) ?? null)
}

/** MANY KEYS, ONE READ (2026-08-17). The per-symbol loops asked for a quote and
 * a candle series a symbol — eighty `getCached` calls before any work was done —
 * and on Cloudflare every one of them spends a subrequest out of an invocation's
 * fifty. Production ended 33 of 50 alert-check runs on 'Too many subrequests'.
 *
 * Missing and expired keys are ABSENT from the map, so a caller loops over what
 * it asked for and fetches whatever is not there — the same shape as a `null`
 * from {@link getCached}, batched. On the Blobs/memory side there is no batch
 * API upstream, so this is the same per-key cost it always was, in parallel; the
 * saving is D1's alone, which is where the ceiling is. */
export async function getCachedMany<T>(keys: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  const wanted = [...new Set(keys.filter(k => typeof k === 'string' && k.length > 0))]
  if (!wanted.length) return out
  const now = Date.now()
  const d1 = currentCacheStore()
  if (d1) {
    // The expiry check is kept on top of the SQL predicate for the same reason
    // getCached keeps it: two nets (M1 gate H2).
    for (const [key, entry] of await d1.readMany<Entry>(wanted)) if (entry && entry.expires >= now) out.set(key, entry.value as T)
    return out
  }
  const entries = await Promise.all(wanted.map(async key => [key, await blobEntry(key)] as const))
  for (const [key, entry] of entries) if (entry && entry.expires >= now) out.set(key, entry.value as T)
  return out
}

export async function setCached(key: string, value: unknown, ttlSec: number): Promise<void> {
  const d1 = currentCacheStore()
  // writeWithTtl builds the very same `{ value, expires }` envelope and copies
  // its `expires` into the column, so the two hosts store identical bytes.
  if (d1) return await d1.writeWithTtl(key, value, ttlSec)
  const entry: Entry = { value, expires: Date.now() + ttlSec * 1000 }
  const store = await blobStore()
  if (store) await store.setJSON(key, entry)
  else mem.set(key, entry)
}
