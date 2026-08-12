// A local D1 — real SQLite, zero new dependencies.
//
// M1 has to be buildable without touching a Cloudflare resource (`wrangler login`
// is a later, owner-gated step), so the tests and the import script need a D1 that
// exists on this machine. The options were miniflare/wrangler `unstable_dev`
// (heavy, spins a workerd), better-sqlite3 (a native build to install), or Node's
// own `node:sqlite` — which is stock from Node 22 and typed by @types/node.
// This repo runs Node 26, so `node:sqlite` it is: the same SQLite engine D1 is
// built on, driving the same SQL, with nothing added to package.json.
//
// It implements only the slice of the D1 API that lib/d1Store.ts uses —
// prepare/bind/first/run/all/batch/exec. It is a DEV shim: the import script
// targets it for local runs, the tests target it for the contract, and at M3 the
// same code paths point at the real binding instead.

import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Result } from '../../netlify/functions/lib/d1Store'

// `node:sqlite` is newer than Vite's builtin list, so a static import gets
// rewritten to a bare 'sqlite' specifier and fails to resolve under vitest.
// Loading it through createRequire keeps the module invisible to the bundler
// and leaves vite.config.ts — live build configuration — untouched.
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

type Bindable = string | number | bigint | null | Uint8Array

function coerce(v: unknown): Bindable {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Uint8Array) return v
  return JSON.stringify(v)
}

/** Wraps a node:sqlite handle in the D1Database shape. */
export function sqliteD1(db: DatabaseSyncType): D1Database & { close(): void; handle: DatabaseSyncType } {
  const statement = (sql: string, bound: Bindable[]): D1PreparedStatement => ({
    bind(...values: unknown[]) {
      return statement(sql, values.map(coerce))
    },
    async first<T = unknown>(): Promise<T | null> {
      const row = db.prepare(sql).get(...bound)
      return (row as T | undefined) ?? null
    },
    async run<T = unknown>(): Promise<D1Result<T>> {
      const info = db.prepare(sql).run(...bound)
      return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }
    },
    async all<T = unknown>(): Promise<D1Result<T>> {
      const rows = db.prepare(sql).all(...bound) as T[]
      return { success: true, results: rows, meta: { changes: 0 } }
    },
  })

  return {
    prepare: (sql: string) => statement(sql, []),
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // D1's batch is one implicit transaction; so is this.
      db.exec('BEGIN')
      try {
        const out: D1Result<T>[] = []
        for (const s of statements) out.push((await s.run()) as D1Result<T>)
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    async exec(sql: string) {
      db.exec(sql)
      return { count: 0 }
    },
    close: () => db.close(),
    handle: db,
  }
}

/** Opens a local D1 — ':memory:' for tests, a path for the import script. */
export function openSqliteD1(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  return sqliteD1(db)
}
