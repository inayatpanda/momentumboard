// Load the rescued Netlify Blobs backup into D1 — idempotently.
//
// M1's gate (DeepSeek H1): run it twice and the second run is a byte no-op. That
// is not a hope, it is the mechanism — every file is compared against the row
// already in D1 (exact string, exact expiry) and only genuine differences are
// written. A run that changes nothing reports `changes: 0` and touches no
// `updated_at`, so "nothing happened" is verifiable from the table itself.
//
// The backup (2,023 blobs, 45MB) is a directory per store, a file per key, the
// file's bytes being the value exactly as Blobs served it:
//
//   site__app/    → store 'app'    — the vital one: licences, ledger, bulletins
//   site__cache/  → store 'cache'  — the getCached envelope `{ value, expires }`
//   cache/        → store 'cache'  — a single deploy-scoped fossil, see CONFLICTS
//
// The exporter encoded '/' in a key as '__' (no key in this backup actually
// contains one — the count is reported so a future backup cannot slip past).
//
// Usage:
//   npx tsx scripts/migrate-blobs-to-d1.ts --dry-run
//   npx tsx scripts/migrate-blobs-to-d1.ts --sqlite .d1/streetsignal.sqlite
//   npx tsx scripts/migrate-blobs-to-d1.ts --dir /path/to/backup --json

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureD1Schema, envelopeExpiry, type D1Database } from '../netlify/functions/lib/d1Store'

/* ─────────────────────────────── the map ─────────────────────────────── */

export interface Source {
  /** Directory name inside the backup. */
  dir: string
  /** Blobs store name as the CODE knows it (getStore('app') / getStore('cache')). */
  store: string
  /** Lower wins a same-key collision. The site-scoped export is the live truth. */
  precedence: number
}

export const DEFAULT_SOURCES: readonly Source[] = [
  { dir: 'site__app', store: 'app', precedence: 0 },
  { dir: 'site__cache', store: 'cache', precedence: 0 },
  // A deploy-scoped leftover holding one already-dead key ('pick-stats',
  // `{"value":null,"expires":0}`). It loses to site__cache by precedence, which
  // is why the rule is explicit rather than whatever readdir happens to return.
  { dir: 'cache', store: 'cache', precedence: 1 },
]

/** Stores whose values carry the lib/cache.ts envelope, so `expires_at` can be
 * lifted out of the JSON at import time instead of re-derived later. */
const TTL_STORES = new Set(['cache'])

export const DEFAULT_BACKUP_DIR = join(homedir(), 'Documents', 'streetsignal-blob-backup-2026-08-12')

/* ────────────────────────────── the report ────────────────────────────── */

export interface StoreTally {
  store: string
  filesOnDisk: number
  inserted: number
  updated: number
  unchanged: number
  skipped: number
  expiredOnArrival: number
  rowsAfter: number
  diskDigest: string
  d1Digest: string
  manifestOk: boolean
}

export interface MigrationReport {
  dryRun: boolean
  backupDir: string
  sources: { dir: string; store: string; files: number }[]
  ignoredDirs: string[]
  stores: StoreTally[]
  conflicts: { store: string; key: string; winner: string; loser: string }[]
  duplicates: { store: string; key: string; dirs: string[] }[]
  unparseable: { dir: string; key: string; reason: string }[]
  slashKeys: number
  /** inserted + updated across every store. The idempotence gate reads this. */
  changes: number
  ok: boolean
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** A store's fingerprint: sorted `key\0sha256(value)` lines, hashed. Two sides
 * agreeing on this agree byte-for-byte on every value, not merely on the count. */
function digest(entries: Iterable<[string, string]>): string {
  const lines = [...entries].map(([k, v]) => `${k}\0${sha(v)}`).sort()
  return sha(lines.join('\n'))
}

const decodeKey = (filename: string) => filename.split('__').join('/')

/* ─────────────────────────────── the scan ─────────────────────────────── */

interface Planned {
  key: string
  value: string
  expiresAt: number | null
  dir: string
}

export function scanBackup(backupDir: string, sources: readonly Source[] = DEFAULT_SOURCES) {
  // Dotfiles are macOS/git furniture, never blob data — and the M1 review booked
  // this: a single `.DS_Store` inside an otherwise-empty directory made it look
  // like unmapped DATA and aborted the whole import with "holds 1 blobs". The
  // per-source read at the bottom of this function already filtered them; these
  // two did not. Same predicate everywhere now.
  const notDotfile = (n: string) => !n.startsWith('.')

  const present = readdirSync(backupDir)
    .filter(notDotfile)
    .filter(n => {
      try {
        return statSync(join(backupDir, n)).isDirectory()
      } catch {
        return false
      }
    })

  const known = new Map(sources.map(s => [s.dir, s]))
  const ignoredDirs: string[] = []
  for (const name of present) {
    if (known.has(name)) continue
    const count = readdirSync(join(backupDir, name)).filter(notDotfile).length
    // An unmapped directory WITH files is data we would silently drop. Refuse.
    if (count > 0) throw new Error(`backup directory '${name}' holds ${count} blobs but maps to no store — add it to DEFAULT_SOURCES`)
    ignoredDirs.push(name)
  }

  const byStore = new Map<string, Map<string, Planned>>()
  const skippedByStore = new Map<string, number>()
  const skip = (store: string) => skippedByStore.set(store, (skippedByStore.get(store) ?? 0) + 1)
  const conflicts: MigrationReport['conflicts'] = []
  const duplicates: MigrationReport['duplicates'] = []
  const unparseable: MigrationReport['unparseable'] = []
  const perSource: MigrationReport['sources'] = []
  let slashKeys = 0

  for (const src of [...sources].sort((a, b) => a.precedence - b.precedence)) {
    if (!present.includes(src.dir)) {
      perSource.push({ dir: src.dir, store: src.store, files: 0 })
      continue
    }
    const files = readdirSync(join(backupDir, src.dir)).filter(notDotfile).sort()
    perSource.push({ dir: src.dir, store: src.store, files: files.length })
    const target = byStore.get(src.store) ?? new Map<string, Planned>()
    byStore.set(src.store, target)

    for (const file of files) {
      const key = decodeKey(file)
      if (key !== file) slashKeys++
      const value = readFileSync(join(backupDir, src.dir, file), 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch (e) {
        // Blobs served these as JSON; something that will not parse would only
        // ever read back as null, so importing it buys nothing but noise.
        unparseable.push({ dir: src.dir, key, reason: String((e as Error).message).slice(0, 80) })
        skip(src.store)
        continue
      }
      const expiresAt = TTL_STORES.has(src.store) ? envelopeExpiry(parsed) : null
      const existing = target.get(key)
      if (existing) {
        if (existing.value === value) duplicates.push({ store: src.store, key, dirs: [existing.dir, src.dir] })
        else {
          conflicts.push({ store: src.store, key, winner: existing.dir, loser: src.dir })
          skip(src.store)
        }
        continue // precedence order means the incumbent already won
      }
      target.set(key, { key, value, expiresAt, dir: src.dir })
    }
  }

  return { byStore, skippedByStore, conflicts, duplicates, unparseable, perSource, ignoredDirs, slashKeys }
}

/* ────────────────────────────── the import ────────────────────────────── */

interface ExistingRow {
  value: string
  expires_at: number | null
}

async function tableExists(db: D1Database): Promise<boolean> {
  try {
    await db.prepare(`SELECT 1 FROM blobs LIMIT 1`).first()
    return true
  } catch {
    return false
  }
}

export interface MigrateOptions {
  backupDir?: string
  sources?: readonly Source[]
  dryRun?: boolean
  now?: () => number
  batchSize?: number
  onProgress?: (done: number, total: number) => void
}

export async function migrateBlobsToD1(db: D1Database, opts: MigrateOptions = {}): Promise<MigrationReport> {
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR
  const dryRun = opts.dryRun === true
  const now = opts.now ?? (() => Date.now())
  const batchSize = opts.batchSize ?? 50

  const scan = scanBackup(backupDir, opts.sources)
  if (!dryRun) await ensureD1Schema(db)
  const live = dryRun ? await tableExists(db) : true

  const stores: StoreTally[] = []
  let changes = 0
  const total = [...scan.byStore.values()].reduce((n, m) => n + m.size, 0)
  let done = 0

  for (const [store, planned] of [...scan.byStore.entries()].sort()) {
    let inserted = 0
    let updated = 0
    let unchanged = 0
    let expiredOnArrival = 0
    const writes: { key: string; value: string; expiresAt: number | null }[] = []
    const at = now()

    for (const p of [...planned.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (p.expiresAt != null && p.expiresAt <= at) expiredOnArrival++
      const existing = live
        ? await db.prepare(`SELECT value, expires_at FROM blobs WHERE store = ?1 AND key = ?2`).bind(store, p.key).first<ExistingRow>()
        : null
      if (existing && existing.value === p.value && (existing.expires_at ?? null) === p.expiresAt) {
        unchanged++
      } else {
        if (existing) updated++
        else inserted++
        writes.push({ key: p.key, value: p.value, expiresAt: p.expiresAt })
      }
      opts.onProgress?.(++done, total)
    }

    if (!dryRun && writes.length) {
      const upsert = `INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`
      for (let i = 0; i < writes.length; i += batchSize) {
        const chunk = writes.slice(i, i + batchSize)
        const stmts = chunk.map(w => db.prepare(upsert).bind(store, w.key, w.value, at, w.expiresAt))
        if (db.batch) await db.batch(stmts)
        else for (const s of stmts) await s.run()
      }
    }
    changes += inserted + updated

    // The manifest check. Not a row count — a fingerprint of every value, from
    // the directory and from the table, computed independently and compared.
    const diskDigest = digest([...planned.values()].map(p => [p.key, p.value] as [string, string]))
    const rows: Map<string, string> = new Map()
    if (live) {
      // Keyset-paged: one store's values run to tens of MB, and the remote
      // client (httpD1) answers over HTTP where a response that size won't fly.
      const PAGE = 25
      let after = ''
      for (;;) {
        const res = await db
          .prepare(`SELECT key, value FROM blobs WHERE store = ?1 AND key > ?2 ORDER BY key LIMIT ${PAGE}`)
          .bind(store, after)
          .all<{ key: string; value: string }>()
        const page = res.results ?? []
        for (const r of page) rows.set(r.key, r.value)
        if (page.length < PAGE) break
        after = page[page.length - 1].key
      }
    }
    // A dry run reports the state the import WOULD leave behind, so the manifest
    // line means the same thing whether or not anything was written.
    if (dryRun) for (const w of writes) rows.set(w.key, w.value)

    stores.push({
      store,
      filesOnDisk: planned.size,
      inserted,
      updated,
      unchanged,
      skipped: scan.skippedByStore.get(store) ?? 0,
      expiredOnArrival,
      rowsAfter: rows.size,
      diskDigest,
      d1Digest: digest(rows.entries()),
      manifestOk: rows.size === planned.size && digest(rows.entries()) === diskDigest,
    })
  }

  return {
    dryRun,
    backupDir,
    sources: scan.perSource,
    ignoredDirs: scan.ignoredDirs,
    stores,
    conflicts: scan.conflicts,
    duplicates: scan.duplicates,
    unparseable: scan.unparseable,
    slashKeys: scan.slashKeys,
    changes,
    ok: stores.every(s => s.manifestOk) && scan.unparseable.length === 0,
  }
}

/* ─────────────────────────────── the CLI ─────────────────────────────── */

export function formatReport(r: MigrationReport): string {
  const pad = (s: string | number, n: number) => String(s).padStart(n)
  const lines: string[] = []
  lines.push('')
  lines.push(`${r.dryRun ? 'DRY RUN' : 'IMPORT'} — ${r.backupDir}`)
  lines.push('')
  lines.push('  store   files    new  updated  unchanged  expired  rows in D1  manifest')
  for (const s of r.stores) {
    lines.push(
      `  ${s.store.padEnd(6)} ${pad(s.filesOnDisk, 6)} ${pad(s.inserted, 6)} ${pad(s.updated, 8)} ${pad(s.unchanged, 10)} ${pad(s.expiredOnArrival, 8)} ${pad(s.rowsAfter, 11)}  ${s.manifestOk ? 'OK' : 'MISMATCH'}`,
    )
  }
  const t = r.stores.reduce(
    (a, s) => ({ f: a.f + s.filesOnDisk, i: a.i + s.inserted, u: a.u + s.updated, n: a.n + s.unchanged, e: a.e + s.expiredOnArrival, r: a.r + s.rowsAfter }),
    { f: 0, i: 0, u: 0, n: 0, e: 0, r: 0 },
  )
  lines.push(`  ${'TOTAL'.padEnd(6)} ${pad(t.f, 6)} ${pad(t.i, 6)} ${pad(t.u, 8)} ${pad(t.n, 10)} ${pad(t.e, 8)} ${pad(t.r, 11)}`)
  lines.push('')
  for (const s of r.stores) lines.push(`  digest ${s.store}: disk ${s.diskDigest.slice(0, 16)} · d1 ${s.d1Digest.slice(0, 16)}`)
  lines.push('')
  lines.push(`  sources:   ${r.sources.map(s => `${s.dir}→${s.store} (${s.files})`).join(', ')}`)
  if (r.ignoredDirs.length) lines.push(`  ignored:   ${r.ignoredDirs.join(', ')} (empty)`)
  lines.push(`  keys with '/':  ${r.slashKeys}`)
  if (r.duplicates.length) lines.push(`  duplicates:     ${r.duplicates.map(d => `${d.store}/${d.key} in ${d.dirs.join(' & ')}`).join(', ')}`)
  if (r.conflicts.length) lines.push(`  conflicts:      ${r.conflicts.map(c => `${c.store}/${c.key} — kept ${c.winner}, dropped ${c.loser}`).join(', ')}`)
  if (r.unparseable.length) lines.push(`  unparseable:    ${r.unparseable.map(u => `${u.dir}/${u.key}`).join(', ')}`)
  lines.push('')
  lines.push(`  changes: ${r.changes}${r.changes === 0 ? '  (byte no-op — the idempotence gate)' : ''}`)
  lines.push(`  ${r.ok ? 'MANIFEST OK — every store matches the directory, value for value' : 'MANIFEST FAILED'}`)
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const dryRun = argv.includes('--dry-run')
  const backupDir = flag('dir') ?? DEFAULT_BACKUP_DIR
  const sqlitePath = flag('sqlite') ?? join(process.cwd(), '.d1', 'streetsignal.sqlite')

  // --remote targets the real D1 over the REST API (scripts/lib/httpD1.ts).
  // The database id comes from wrangler.toml — the single place M3 wrote it —
  // and the account id from CLOUDFLARE_ACCOUNT_ID or --account.
  let db: (D1Database & { close(): void })
  if (argv.includes('--remote')) {
    const toml = readFileSync(join(process.cwd(), 'wrangler.toml'), 'utf8')
    const databaseId = flag('database') ?? toml.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1]
    const accountId = flag('account') ?? process.env.CLOUDFLARE_ACCOUNT_ID
    if (!databaseId) throw new Error('--remote: no database_id in wrangler.toml and no --database given')
    if (!accountId) throw new Error('--remote: set CLOUDFLARE_ACCOUNT_ID or pass --account')
    const { openHttpD1 } = await import('./lib/httpD1')
    db = openHttpD1({ accountId, databaseId })
  } else {
    // A dry run against a database that does not exist yet must not conjure one:
    // it reports what a first import would do, from an empty in-memory stand-in.
    const target = dryRun && !safeExists(sqlitePath) ? ':memory:' : sqlitePath
    if (target !== ':memory:') mkdirSync(dirname(sqlitePath), { recursive: true })
    const { openSqliteD1 } = await import('./lib/sqliteD1')
    db = openSqliteD1(target)
  }

  const report = await migrateBlobsToD1(db, { backupDir, dryRun })
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
  db.close()
  process.exit(report.ok ? 0 : 1)
}

function safeExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

const invokedDirectly = process.argv[1] && /migrate-blobs-to-d1\.[cm]?ts$/.test(process.argv[1])
if (invokedDirectly) await main()
