// Durable JSON store on Netlify Blobs (store 'app'), in-memory fallback for tests.
const mem = new Map<string, unknown>()

async function blobStore() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore('app')
  } catch {
    return null
  }
}

export interface AppStore {
  read<T>(key: string): Promise<T | null>
  write(key: string, value: unknown): Promise<void>
  // Strong-consistency read — slower, so reach for it only where a stale miss
  // has a real cost (licence checks: a just-minted key 401ing bounces a brand
  // new reader off their unlock link). Absent on test stores → callers fall
  // back to read().
  readStrong?<T>(key: string): Promise<T | null>
}

interface LeaseRecord {
  token: string
  expiresAt: number
}

/** Best-effort distributed lease over the blob store. The write-then-verify
 * handshake means that when two functions race, only the token left in the
 * store proceeds. Leases expire so a crashed invocation cannot wedge the job. */
export async function acquireLease(store: AppStore, key: string, nowSec: number, ttlSec: number): Promise<string | null> {
  const current = await store.read<LeaseRecord>(key)
  if (current && current.expiresAt > nowSec) return null
  const token = crypto.randomUUID()
  await store.write(key, { token, expiresAt: nowSec + ttlSec } satisfies LeaseRecord)
  const verified = await store.read<LeaseRecord>(key)
  return verified?.token === token ? token : null
}

export async function releaseLease(store: AppStore, key: string, token: string): Promise<void> {
  const current = await store.read<LeaseRecord>(key)
  if (current?.token === token) await store.write(key, { token: '', expiresAt: 0 } satisfies LeaseRecord)
}

export const blobAppStore: AppStore = {
  async read<T>(key: string): Promise<T | null> {
    const store = await blobStore()
    if (store) return ((await store.get(key, { type: 'json' })) as T | null) ?? null
    return (mem.get(key) as T | undefined) ?? null
  },
  async write(key: string, value: unknown): Promise<void> {
    const store = await blobStore()
    if (store) await store.setJSON(key, value)
    else mem.set(key, value)
  },
  async readStrong<T>(key: string): Promise<T | null> {
    try {
      const { getStore } = await import('@netlify/blobs')
      const store = getStore({ name: 'app', consistency: 'strong' })
      return ((await store.get(key, { type: 'json' })) as T | null) ?? null
    } catch {
      return blobAppStore.read<T>(key)
    }
  },
}

export const memoryStore = (): AppStore => {
  const m = new Map<string, unknown>()
  return {
    async read<T>(key: string) {
      return (m.get(key) as T | undefined) ?? null
    },
    async write(key, value) {
      m.set(key, value)
    },
  }
}
