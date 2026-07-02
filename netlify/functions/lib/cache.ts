type Entry = { value: unknown; expires: number }
const mem = new Map<string, Entry>()

async function blobStore() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore('cache')
  } catch {
    return null
  }
}

export async function getCached<T>(key: string): Promise<T | null> {
  const store = await blobStore()
  const entry = store ? ((await store.get(key, { type: 'json' })) as Entry | null) : (mem.get(key) ?? null)
  if (!entry || entry.expires < Date.now()) return null
  return entry.value as T
}

export async function setCached(key: string, value: unknown, ttlSec: number): Promise<void> {
  const entry: Entry = { value, expires: Date.now() + ttlSec * 1000 }
  const store = await blobStore()
  if (store) await store.setJSON(key, entry)
  else mem.set(key, entry)
}
