// THE v2 SLICE STORE (plan Task 8; amendments CX-4/5, DS-1/4/10/12/19/22).
//
// One read-through cache for everything the app shows: API view slices,
// candle series, quote batches. Dexie owns the bytes; this module owns the
// discipline — read and revalidate are SEPARATE operations (a Promise cannot
// resolve twice), concurrent fetches for one key collapse to one, freshness is
// per-key TTL, and the ONLY notification channel is `sliceEvents`. There are
// no polls anywhere in this layer, by test-enforced rule: refreshes happen on
// mount, on visibility/focus, on explicit user pull, or on invalidation.

import { db, type SliceRow } from './db'

/** Slice keys are namespaced strings; the unions the screens use: */
export type SliceKey =
  | 'board'
  | 'learning'
  | 'movers'
  | 'sectors'
  | 'intel'
  | 'reports'
  | `journey:${string}`
  | `stock-contexts:${string}`
  | `funnel:${string}`
  | `ledger:${number}`
  | `verdict:${string}`
  | `candles:${string}`
  | `quotes:${string}`
  | (string & {})

/** Freshness windows, ms. Prefix keys (journey:*) resolve via ttlFor. */
export const SLICE_TTL: Record<string, number> = {
  board: 120_000,
  quotes: 120_000,
  'stock-contexts': 120_000,
  journey: 120_000, // the open-trace verdict must not sit stale (DS-12)
  verdict: 900_000,
  movers: 300_000,
  sectors: 900_000,
  ledger: 900_000,
  learning: 900_000,
  candles: 900_000,
  intel: 300_000,
  'street:wire': 60_000, // cloud sections can publish while this screen is open
  default: 900_000,
}

/** The chart's intraday ranges age faster than the daily ones — a 1D chart
 * fifteen minutes stale has missed three whole bars. Keyed by the range suffix
 * of `candles:SYM:RANGE`, and deliberately the same numbers the server caches
 * those ranges for (netlify/functions/lib/yahoo.ts, CANDLE_RANGES): a client
 * that revalidates sooner than the server refreshes only buys a round trip. */
const CANDLE_RANGE_TTL: Record<string, number> = { '1d': 300_000, '5d': 600_000 }

export const ttlFor = (key: string): number => {
  const parts = key.split(':')
  if (parts[0] === 'candles' && CANDLE_RANGE_TTL[parts[2]]) return CANDLE_RANGE_TTL[parts[2]]
  return SLICE_TTL[key] ?? SLICE_TTL[parts[0]] ?? SLICE_TTL.default
}

/** candles:/quotes: live in their own tables; everything else in `slices`. */
const tableFor = (key: string) => (key.startsWith('candles:') ? db.candles : key.startsWith('quotes:') ? db.quotes : db.slices)

export interface SliceRecord<T = unknown> {
  key: string
  data: T
  fetchedAt: number
}

export async function readSlice<T>(key: SliceKey): Promise<SliceRecord<T> | null> {
  const row = (await tableFor(key).get(key)) as SliceRow | undefined
  return row ? { key: row.key, data: row.data as T, fetchedAt: row.fetchedAt } : null
}

/** The one notification channel. Every write and every invalidation announces
 * as CustomEvent('slice', { detail: { key, kind } }). The kinds are the
 * loop-guard: a 'write' tells other mounted hooks to RE-READ Dexie (cheap, no
 * network); an 'invalidate' forces a refetch. A hook that refetched on its own
 * write announcement would spin forever. */
export type SliceEventKind = 'write' | 'invalidate'
export const sliceEvents = new EventTarget()

const announce = (key: string, kind: SliceEventKind) => sliceEvents.dispatchEvent(new CustomEvent('slice', { detail: { key, kind } }))

export async function writeSlice<T>(key: SliceKey, data: T): Promise<void> {
  await tableFor(key).put({ key, data, fetchedAt: Date.now() })
  announce(key, 'write')
}

export const isFresh = (rec: { fetchedAt: number } | null, key: string): boolean =>
  rec != null && Date.now() - rec.fetchedAt < ttlFor(key)

/** In-flight dedupe: two screens asking for one key share one network trip. */
const inflight = new Map<string, Promise<unknown>>()

/** Fetch-if-stale. Resolves with the freshest data (cached when fresh, fetched
 * otherwise); rejects when the fetch fails AND there is no cache — a caller
 * with cache in hand treats rejection as "offline", not as "no data". */
export async function revalidate<T>(key: SliceKey, fetcher: () => Promise<T>, opts?: { force?: boolean }): Promise<T> {
  // force REPLACES a stuck in-flight fetch — a hung request must never block
  // an explicit pull-to-refresh.
  const existing = inflight.get(key)
  if (existing && !opts?.force) return existing as Promise<T>
  // Only the newest request owns this key. A replaced request may settle,
  // but must neither overwrite fresh bytes nor remove its replacement.
  const p: Promise<T> = Promise.resolve().then(async () => {
    if (!opts?.force) {
      const cached = await readSlice<T>(key)
      if (isFresh(cached, key)) return cached!.data
    }
    const data = await fetcher()
    if (inflight.get(key) === p) await writeSlice(key, data)
    return data
  }).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key)
  })
  inflight.set(key, p)
  return p
}

/** Cross-cutting invalidation (DS-10): config sync, licence changes, manual
 * refresh-all. Mounted useSlice hooks matching a key refetch, unmounted ones
 * do nothing. */
export function invalidateSlices(keys: string[]): void {
  for (const key of keys) announce(key, 'invalidate')
}

/** Boot GC (DS-22): anything unfetched for 7 days is dead weight. Fire and
 * forget from the shell; three tables, one sweep. */
export async function gcSlices(now = Date.now()): Promise<void> {
  const cutoff = now - 7 * 86_400_000
  await Promise.all([db.slices, db.candles, db.quotes].map(t => t.where('fetchedAt').below(cutoff).delete()))
}
