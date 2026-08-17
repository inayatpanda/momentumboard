// The same AppStore seam, over Cloudflare D1 instead of Netlify Blobs.
//
// M1 of the Cloudflare migration (docs/superpowers/specs/2026-08-12-cloudflare-migration-design.md).
// NOTHING in the live app imports this yet: it is a parallel implementation that
// the M2 Pages Functions port will swap in behind the identical interface. It
// lives beside lib/store.ts on purpose — the seam's neighbours (auth, engine,
// bulletins) already import from here, so the port is a one-line change of
// which factory they are handed, not a rewrite.
//
// WHAT THIS RETIRES
// -----------------
// Netlify Blobs is eventually consistent, and the codebase carries two pieces of
// machinery to survive that: `readStrong` (a slower, strongly-consistent read
// reached for where a stale miss has a real cost — a just-minted licence key
// 401ing bounces a brand new reader off their unlock link) and the token grace
// windows layered on top of it. D1 is SINGLE-PRIMARY: every read sees every
// committed write, immediately. So `readStrong` here is deliberately a plain
// read — the method stays only because callers already branch on its presence.
// It is not a weaker implementation; it is the same guarantee, for free.
//
// UNITS: `expires_at` is epoch MILLISECONDS, matching the `expires` field of the
// cache envelope in lib/cache.ts (`{ value, expires }`). Not seconds. The import
// copies the envelope's own number across, so the two can never disagree.

import type { AppStore, LeaseRecord } from './store'

/* ────────────────────────── minimal D1 surface ──────────────────────────
 * Structurally compatible with @cloudflare/workers-types' D1Database, declared
 * locally so M1 adds no production dependency and no Cloudflare types to a repo
 * that still deploys to Netlify. At M2, `import type { D1Database } from
 * '@cloudflare/workers-types'` can replace these and nothing else changes.
 */

export interface D1Meta {
  changes?: number
  last_row_id?: number
  [k: string]: unknown
}

export interface D1Result<T = unknown> {
  results?: T[]
  success: boolean
  meta?: D1Meta
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch?<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec?(query: string): Promise<unknown>
}

/* ────────────────────────────── the schema ────────────────────────────── */

/** One table for every store. `store` is the Blobs store name as the code knows
 * it — 'app' or 'cache' — so a call site never has to learn a new vocabulary. */
export const D1_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS blobs (
    store TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (store, key)
  )`,
  // The sweep reads this; every other query is a primary-key hit.
  `CREATE INDEX IF NOT EXISTS blobs_expires_at ON blobs (expires_at)`,
]

export async function ensureD1Schema(db: D1Database): Promise<void> {
  for (const stmt of D1_SCHEMA) await db.prepare(stmt).run()
}

/* ─────────────────────────────── the store ─────────────────────────────── */

export interface D1StoreOptions {
  /** Blobs store name this instance stands in for. Default 'app'. */
  store?: string
  /** Injectable clock (epoch ms) — the tests pin staleness without sleeping. */
  now?: () => number
  /** Derives `expires_at` (epoch ms) from a value being written; null = durable.
   * The cache store wires `envelopeExpiry`; the app store leaves rows immortal. */
  expiresAt?: (value: unknown) => number | null
  /** Lazily delete a row found expired on read. Best-effort; failures are
   * swallowed because a failed eviction must never fail the read. Default true. */
  evictOnRead?: boolean
  /** What `read()` does when a row's JSON will not parse. Default 'throw'.
   *
   * M1 shipped 'null' everywhere, mirroring Netlify Blobs' `{ type: 'json' }`
   * read, and the M1 review booked this reversal. The reason is the app store's
   * read-modify-WRITE pattern: `licences`, `runlog`, `alert-history` are all
   * read, appended to, and written back. Swallowing a corrupt row turns that
   * into `[] → push → write`, which OVERWRITES the corruption with a
   * near-empty list — the licence table silently emptied, every key dead, and
   * no error anywhere to say so. Throwing turns a corrupt row into a 500 that
   * leaves the bytes on disk to be recovered.
   *
   * The cache is the opposite case and keeps 'null': every cache caller already
   * treats a miss as "go and fetch it", so a corrupt cache row should be a miss
   * (M1's H2 audit, 40 call sites, uniform fail-soft). */
  onCorrupt?: 'throw' | 'null'
}

/** Extras beyond the AppStore contract — the cron sweep and the import both
 * need them, and no live call site does, so they stay off the interface. */
export interface D1Store extends AppStore {
  readStrong<T>(key: string): Promise<T | null>
  /** MANY KEYS, ONE STATEMENT. Every D1 binding call spends one of an
   * invocation's fifty subrequests, and the hot loops ask for a quote and a
   * candle series per symbol — eighty reads before any work is done, which is
   * how 33 of 50 production alert-check runs ended on 'Too many subrequests'.
   *
   * Missing keys are ABSENT from the map (never a null entry), expiry is the
   * same SQL predicate `read()` uses, and duplicates are asked for once. */
  readMany<T>(keys: string[]): Promise<Map<string, T>>
  /** The raw stored string, expiry-filtered exactly as read() is. */
  readRaw(key: string): Promise<string | null>
  /** Write a pre-serialised string with an explicit expiry (epoch ms or null).
   * The importer uses this to land the rescued bytes verbatim. */
  writeRaw(key: string, json: string, expiresAt?: number | null): Promise<void>
  /** Cache writes with a TTL in SECONDS, mirroring setCached's signature. */
  writeWithTtl(key: string, value: unknown, ttlSec: number): Promise<void>
  remove(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
  /** Deletes rows already past their expiry. For the cron Worker. Returns the
   * number removed. `limit` keeps a single invocation inside its CPU budget. */
  sweepExpired(limit?: number): Promise<number>
  /** The AppStore capability, present here: one statement, a true CAS. */
  tryAcquireLeaseAtomic(key: string, nowSec: number, ttlSec: number): Promise<string | null>
}

/** The cache store's envelope IS its TTL: lib/cache.ts stores `{ value, expires }`
 * with `expires` in epoch ms. Lifting it into a column lets the sweeper find
 * dead rows without parsing 40MB of JSON. */
export function envelopeExpiry(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const e = (value as { expires?: unknown }).expires
  return typeof e === 'number' && Number.isFinite(e) ? e : null
}

export function d1AppStore(db: D1Database, opts: D1StoreOptions = {}): D1Store {
  const store = opts.store ?? 'app'
  const now = opts.now ?? (() => Date.now())
  const expiresAtOf = opts.expiresAt ?? (() => null)
  // …AND ONLY WHERE THERE IS SOMETHING TO EVICT (2026-08-17). The eviction is
  // speculative: a SELECT that returns nothing cannot say whether the row was
  // expired or was never there, so the DELETE goes out on every miss. On a store
  // whose rows never expire — the app store, whose `expiresAt` is the default
  // `() => null` — that DELETE can never match anything, and it was spending a
  // second subrequest on every optional key a handler reads. alert-check reads a
  // dozen of them; eleven of its twenty-seven statements were these. The cache
  // store, where a miss really can be an expired row, is untouched.
  const evict = opts.evictOnRead !== false && opts.expiresAt != null
  const onCorrupt = opts.onCorrupt ?? 'throw'

  // Expiry is enforced in the SQL predicate, not after the fact: a stale row
  // cannot be handed back even if the eviction below fails or is disabled.
  const SELECT = `SELECT value FROM blobs WHERE store = ?1 AND key = ?2 AND (expires_at IS NULL OR expires_at >= ?3)`
  const UPSERT = `INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`
  const DELETE = `DELETE FROM blobs WHERE store = ?1 AND key = ?2`
  // ONE statement, not a SELECT then a DELETE (M1 review). The predicate is the
  // exact complement of SELECT's, so this can only ever remove a row the read
  // just refused to serve — and it costs one round trip to a remote D1 instead
  // of two, on a path taken by every miss.
  const DELETE_IF_STALE = `DELETE FROM blobs WHERE store = ?1 AND key = ?2 AND expires_at IS NOT NULL AND expires_at < ?3`

  async function evictIfStale(key: string, at: number): Promise<void> {
    if (!evict) return
    try {
      await db.prepare(DELETE_IF_STALE).bind(store, key, at).run()
    } catch {
      /* eviction is housekeeping — never let it fail a read */
    }
  }

  const self: D1Store = {
    async readRaw(key: string): Promise<string | null> {
      const at = now()
      const row = await db.prepare(SELECT).bind(store, key, at).first<{ value: string }>()
      if (row) return row.value
      await evictIfStale(key, at)
      return null
    },

    async read<T>(key: string): Promise<T | null> {
      const raw = await self.readRaw(key)
      if (raw == null) return null
      try {
        return JSON.parse(raw) as T
      } catch (e) {
        // See D1StoreOptions.onCorrupt. The app store THROWS: a miss here would
        // be appended to and written back, overwriting the corruption.
        if (onCorrupt === 'throw') throw new Error(`d1 store '${store}': corrupt JSON at key '${key}' (${String((e as Error)?.message ?? e).slice(0, 120)})`)
        return null
      }
    },

    // D1 is single-primary: this IS the strong read. See the header.
    async readStrong<T>(key: string): Promise<T | null> {
      return self.read<T>(key)
    },

    // ONE `key IN (…)` SELECT per chunk. Deliberately NOT `evictIfStale`: a
    // batch read is a hot path, eviction is housekeeping the quarter-hour sweep
    // already owns, and a second statement per stale key would give back the
    // subrequests this exists to save. Corruption follows the store's own rule
    // (see D1StoreOptions.onCorrupt) — a cache row is dropped so the caller
    // re-fetches it, an app row still throws rather than being written back over.
    async readMany<T>(keys: string[]): Promise<Map<string, T>> {
      const out = new Map<string, T>()
      const wanted = [...new Set(keys.filter(k => typeof k === 'string' && k.length > 0))]
      if (!wanted.length) return out
      const at = now()
      // SQLite's default bound-variable ceiling is 999 and D1's is the same
      // order; chunk rather than hand it a statement it will refuse.
      const CHUNK = 90
      for (let i = 0; i < wanted.length; i += CHUNK) {
        const slice = wanted.slice(i, i + CHUNK)
        const placeholders = slice.map((_, j) => `?${j + 3}`).join(', ')
        const res = await db
          .prepare(`SELECT key, value FROM blobs WHERE store = ?1 AND (expires_at IS NULL OR expires_at >= ?2) AND key IN (${placeholders})`)
          .bind(store, at, ...slice)
          .all<{ key: string; value: string }>()
        for (const row of res.results ?? []) {
          try {
            out.set(row.key, JSON.parse(row.value) as T)
          } catch (e) {
            if (onCorrupt === 'throw') throw new Error(`d1 store '${store}': corrupt JSON at key '${row.key}' (${String((e as Error)?.message ?? e).slice(0, 120)})`)
            // else: a miss, which every cache caller already handles as "go and fetch it"
          }
        }
      }
      return out
    },

    async writeRaw(key: string, json: string, expiresAt: number | null = null): Promise<void> {
      await db.prepare(UPSERT).bind(store, key, json, now(), expiresAt).run()
    },

    async write(key: string, value: unknown): Promise<void> {
      await self.writeRaw(key, JSON.stringify(value), expiresAtOf(value))
    },

    async writeWithTtl(key: string, value: unknown, ttlSec: number): Promise<void> {
      const envelope = { value, expires: now() + ttlSec * 1000 }
      await self.writeRaw(key, JSON.stringify(envelope), envelope.expires)
    },

    async remove(key: string): Promise<void> {
      await db.prepare(DELETE).bind(store, key).run()
    },

    async keys(prefix?: string): Promise<string[]> {
      const at = now()
      const res = prefix
        ? await db
            .prepare(`SELECT key FROM blobs WHERE store = ?1 AND key LIKE ?2 ESCAPE '\\' AND (expires_at IS NULL OR expires_at >= ?3) ORDER BY key`)
            .bind(store, `${prefix.replace(/([\\%_])/g, '\\$1')}%`, at)
            .all<{ key: string }>()
        : await db
            .prepare(`SELECT key FROM blobs WHERE store = ?1 AND (expires_at IS NULL OR expires_at >= ?2) ORDER BY key`)
            .bind(store, at)
            .all<{ key: string }>()
      return (res.results ?? []).map(r => r.key)
    },

    // I-4: THE LEASE, IN ONE STATEMENT.
    //
    // lib/store.ts's handshake is read → check → write → read. Over D1's HTTP
    // API from a GitHub Actions runner that is four ~200ms hops with a ~780ms
    // window in the middle, and two runners started by the same cron can both
    // decide the lease is free. This is the same decision as one SQL statement:
    // insert if the key is absent, overwrite ONLY if the lease sitting there has
    // already expired. SQLite evaluates the predicate against the existing row
    // inside the write, so there is no window to lose.
    //
    // `json_valid` first: a row that is not a lease record at all (corruption,
    // or a key reused for something else) must be takeable rather than a
    // permanent wedge, and json_extract on malformed JSON raises instead of
    // returning null. IFNULL covers valid JSON with no `expiresAt` — also not a
    // live lease.
    //
    // FAILS CLOSED, DELIBERATELY. httpD1.run() reports `meta.changes ?? 0`, so
    // a write that succeeded on the server but whose reply was lost — retried
    // by the client and reported as 0 — reads here as "someone else has it".
    // The caller then does nothing this tick and tries again next tick, which
    // is the right way round: the alternative is two engine runs.
    async tryAcquireLeaseAtomic(key: string, nowSec: number, ttlSec: number): Promise<string | null> {
      const record: LeaseRecord = { token: crypto.randomUUID(), expiresAt: nowSec + ttlSec }
      const json = JSON.stringify(record)
      const res = await db
        .prepare(
          `INSERT INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at
             WHERE json_valid(blobs.value) = 0 OR IFNULL(json_extract(blobs.value, '$.expiresAt'), 0) <= ?6`,
        )
        .bind(store, key, json, now(), expiresAtOf(record), nowSec)
        .run()
      return (res.meta?.changes ?? 0) === 1 ? record.token : null
    },

    async sweepExpired(limit = 1000): Promise<number> {
      const res = await db
        .prepare(
          // Keyed subquery rather than `DELETE ... LIMIT` (a compile-time option
          // SQLite does not always carry) and rather than rowid (which a
          // WITHOUT ROWID table would not have).
          `DELETE FROM blobs WHERE store = ?1 AND key IN (
             SELECT key FROM blobs WHERE store = ?1 AND expires_at IS NOT NULL AND expires_at < ?2 LIMIT ?3
           )`,
        )
        .bind(store, now(), limit)
        .run()
      return res.meta?.changes ?? 0
    },
  }

  return self
}

/** The 'cache' store: same seam, TTL-aware. Writes made through the plain
 * `write()` still get an expiry when the value carries the getCached envelope,
 * so a ported cache.ts needs no special casing. */
export function d1CacheStore(db: D1Database, opts: Omit<D1StoreOptions, 'store' | 'expiresAt'> = {}): D1Store {
  // onCorrupt 'null' — and ONLY here. Every cache caller treats null as "go and
  // fetch it" (M1's H2 audit), so a corrupt cache row should read as a miss;
  // the app store throws instead, because its callers write back what they read.
  return d1AppStore(db, { onCorrupt: 'null', ...opts, store: 'cache', expiresAt: envelopeExpiry })
}
