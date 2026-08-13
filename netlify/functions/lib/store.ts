// Durable JSON store on Netlify Blobs (store 'app'), in-memory fallback for tests.
// Runs in TWO homes: inside Netlify functions (ambient context) and inside
// GitHub Actions runners (the heavy scheduled jobs moved there when the plan
// dropped background functions) — the runner supplies NETLIFY_SITE_ID +
// NETLIFY_AUTH_TOKEN and reads/writes the very same store over the Blobs API.
const mem = new Map<string, unknown>()

const remoteCreds = () =>
  process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN
    ? { siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN }
    : null

async function blobStore() {
  try {
    const { getStore } = await import('@netlify/blobs')
    const remote = remoteCreds()
    return remote ? getStore({ name: 'app', ...remote }) : getStore('app')
  } catch {
    return null
  }
}

// Blobs talks over the network, and a connect timeout is weather, not a failure.
// One 10s blip killed the 01:11 queue-worker run on 2026-07-26 and emailed the
// owner "all jobs have failed" — and the same blip during the 06:35 run would
// have cost that morning's paper outright. Retry a few times; a genuine outage
// still fails, loudly, after the retries are spent.
const TRANSIENT = /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|UND_ERR|ConnectTimeout|other side closed|network/i

/** Is this error worth another go? Walks the cause chain — undici buries the
 * real reason ("ConnectTimeoutError") under a bland "fetch failed". */
export function isTransientNetworkError(e: unknown): boolean {
  const seen: string[] = []
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur; depth++) {
    const o = cur as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown }
    seen.push(String(o.message ?? ''), String(o.code ?? ''), String(o.name ?? ''))
    cur = o.cause
  }
  return TRANSIENT.test(seen.join(' '))
}

const BACKOFF_MS = [200, 600]

export async function withBlobRetry<T>(op: () => Promise<T>, what: string, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (e) {
      if (attempt >= BACKOFF_MS.length || !isTransientNetworkError(e)) throw e
      console.warn(`blob ${what}: transient failure (attempt ${attempt + 1}), retrying — ${String((e as Error)?.message ?? e).slice(0, 120)}`)
      await sleep(BACKOFF_MS[attempt])
    }
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
  /** OPTIONAL CAPABILITY: take the lease in ONE round trip, atomically.
   *
   * A backend that can compare-and-set implements this and `acquireLease` uses
   * it. A backend that cannot (Netlify Blobs, the in-memory test store) leaves
   * it undefined and gets the read-check-write-verify handshake below, exactly
   * as before. Returns the token on success, null when someone else holds it. */
  tryAcquireLeaseAtomic?(key: string, nowSec: number, ttlSec: number): Promise<string | null>
}

export interface LeaseRecord {
  token: string
  expiresAt: number
}

/** Take a distributed lease, atomically where the backend can and by handshake
 * where it cannot. Leases expire so a crashed invocation cannot wedge the job.
 *
 * WHY THE ATOMIC PATH MATTERS (I-4). The handshake below is
 * read → check → write → read: four round trips, and between the check and the
 * write there is a window in which a second caller reads the same "free" lease.
 * Under Netlify Blobs, in a Netlify function, that window was sub-millisecond
 * local latency. Over D1's HTTP API from a GitHub Actions runner — which is
 * exactly where drain-queue.mts takes `lease:queue-worker` — each hop is ~200ms
 * and the window is closer to 780ms: two runners started by the same 15-minute
 * cron can both come away believing they own the queue, and drain it twice.
 * The verify read narrows it (last writer wins the token) but does not close
 * it: both writes can land, and the loser can still read back its own token if
 * the reads interleave the other way. */
export async function acquireLease(store: AppStore, key: string, nowSec: number, ttlSec: number): Promise<string | null> {
  if (store.tryAcquireLeaseAtomic) return await store.tryAcquireLeaseAtomic(key, nowSec, ttlSec)
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
    if (store) return await withBlobRetry(async () => ((await store.get(key, { type: 'json' })) as T | null) ?? null, `read ${key}`)
    return (mem.get(key) as T | undefined) ?? null
  },
  async write(key: string, value: unknown): Promise<void> {
    const store = await blobStore()
    if (store) await withBlobRetry(() => store.setJSON(key, value), `write ${key}`)
    else mem.set(key, value)
  },
  async readStrong<T>(key: string): Promise<T | null> {
    try {
      const { getStore } = await import('@netlify/blobs')
      const remote = remoteCreds()
      const store = getStore({ name: 'app', consistency: 'strong', ...(remote ?? {}) })
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
