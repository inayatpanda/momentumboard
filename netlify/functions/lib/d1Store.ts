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

import type { AppStore } from './store'

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
}

/** Extras beyond the AppStore contract — the cron sweep and the import both
 * need them, and no live call site does, so they stay off the interface. */
export interface D1Store extends AppStore {
  readStrong<T>(key: string): Promise<T | null>
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
  const evict = opts.evictOnRead !== false

  // Expiry is enforced in the SQL predicate, not after the fact: a stale row
  // cannot be handed back even if the eviction below fails or is disabled.
  const SELECT = `SELECT value FROM blobs WHERE store = ?1 AND key = ?2 AND (expires_at IS NULL OR expires_at >= ?3)`
  const SELECT_ANY = `SELECT value, expires_at FROM blobs WHERE store = ?1 AND key = ?2`
  const UPSERT = `INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`
  const DELETE = `DELETE FROM blobs WHERE store = ?1 AND key = ?2`

  async function evictIfStale(key: string, at: number): Promise<void> {
    if (!evict) return
    try {
      const row = await db.prepare(SELECT_ANY).bind(store, key).first<{ expires_at: number | null }>()
      if (row && row.expires_at != null && row.expires_at < at) await db.prepare(DELETE).bind(store, key).run()
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
      } catch {
        // Blobs' `{ type: 'json' }` read threw here too; a corrupt row is a
        // miss, not an outage — the callers all treat null as "go and fetch it".
        return null
      }
    },

    // D1 is single-primary: this IS the strong read. See the header.
    async readStrong<T>(key: string): Promise<T | null> {
      return self.read<T>(key)
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
  return d1AppStore(db, { ...opts, store: 'cache', expiresAt: envelopeExpiry })
}
