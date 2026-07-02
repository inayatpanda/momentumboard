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
