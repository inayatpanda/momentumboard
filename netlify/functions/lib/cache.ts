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
