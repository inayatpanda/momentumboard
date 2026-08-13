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
// THE DATABASE IS LIVE NOW (I-2). "Idempotent" meant "into an empty database":
// re-running this against the same rescue folder after the cutover would revert
// every licence, ledger row and board written since. So a row whose
// `updated_at` is NEWER than the backup file that would replace it is REFUSED
// and counted `protected` — the import reports it and exits non-zero rather
// than quietly restoring a week-old copy. `--overwrite-newer` is the deliberate
// restore, and has to be typed.
//
// Usage:
//   npx tsx scripts/migrate-blobs-to-d1.ts --dry-run
//   npx tsx scripts/migrate-blobs-to-d1.ts --sqlite .d1/streetsignal.sqlite
//   npx tsx scripts/migrate-blobs-to-d1.ts --dir /path/to/backup --json
//   npx tsx scripts/migrate-blobs-to-d1.ts --remote --overwrite-newer   # a real restore

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
  /** Rows the import REFUSED to overwrite because D1's copy is newer than the
   * backup file that would have replaced it. See `overwriteNewer`. */
  protected: number
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
  /** Rows held back because D1's copy is newer than the backup's. */
  protected: number
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
  /** The backup FILE's own mtime (epoch ms) — "when this value was true". The
   * newer-row guard compares it against the D1 row's `updated_at`. */
  mtimeMs: number
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
      const path = join(backupDir, src.dir, file)
      // The file's own mtime IS the age of the value it holds — the exporter
      // wrote each file once, when it read the blob. Cheaper and more precise
      // than a manifest timestamp for the whole run (which the backup does not
      // carry anyway), and it is per-key, which is what the guard needs.
      const mtimeMs = statSync(path).mtimeMs
      const value = readFileSync(path, 'utf8')
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
      target.set(key, { key, value, expiresAt, dir: src.dir, mtimeMs })
    }
  }

  return { byStore, skippedByStore, conflicts, duplicates, unparseable, perSource, ignoredDirs, slashKeys }
}

/* ────────────────────────────── the import ────────────────────────────── */

interface ExistingRow {
  value: string
  expires_at: number | null
  updated_at: number
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
  /** Overwrite a D1 row even when it is NEWER than the backup file that would
   * replace it. Off by default — see the guard in `migrateBlobsToD1`. */
  overwriteNewer?: boolean
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
  let protectedRows = 0
  const total = [...scan.byStore.values()].reduce((n, m) => n + m.size, 0)
  let done = 0

  for (const [store, planned] of [...scan.byStore.entries()].sort()) {
    let inserted = 0
    let updated = 0
    let unchanged = 0
    let protectedHere = 0
    let expiredOnArrival = 0
    const writes: { key: string; value: string; expiresAt: number | null }[] = []
    const at = now()

    for (const p of [...planned.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (p.expiresAt != null && p.expiresAt <= at) expiredOnArrival++
      const existing = live
        ? await db.prepare(`SELECT value, expires_at, updated_at FROM blobs WHERE store = ?1 AND key = ?2`).bind(store, p.key).first<ExistingRow>()
        : null
      if (existing && existing.value === p.value && (existing.expires_at ?? null) === p.expiresAt) {
        unchanged++
      } else if (existing && !opts.overwriteNewer && existing.updated_at > p.mtimeMs) {
        // THE ROW IS NEWER THAN THE BACKUP (I-2). This script was written as a
        // one-shot migration into an empty database, and its idempotence gate
        // ("run it twice and the second run is a byte no-op") holds only while
        // nothing else writes. It does now: the database is LIVE. Re-running it
        // against the same rescue folder a week later would silently revert
        // every licence minted, every ledger entry and every board written
        // since — an import that looks like a success and is a restore.
        //
        // The signal is per-key and needs no new metadata: `updated_at` is
        // written by d1Store on every write (epoch ms) and the backup file's
        // own mtime is when the exporter read that blob. Newer row than the
        // file that would replace it → refuse, and say so. `--overwrite-newer`
        // is the deliberate restore.
        protectedHere++
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
    protectedRows += protectedHere

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
      protected: protectedHere,
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
    protected: protectedRows,
    // A protected row means the table deliberately does NOT match the
    // directory, so the manifest cannot say OK and `ok` cannot be true. That is
    // the honest answer and the right exit code: the operator asked for an
    // import, the import did not fully apply, and the report says which rows
    // and why. `--overwrite-newer` is how they say "yes, restore it".
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
  lines.push('  store   files    new  updated  unchanged  protected  expired  rows in D1  manifest')
  for (const s of r.stores) {
    lines.push(
      `  ${s.store.padEnd(6)} ${pad(s.filesOnDisk, 6)} ${pad(s.inserted, 6)} ${pad(s.updated, 8)} ${pad(s.unchanged, 10)} ${pad(s.protected, 10)} ${pad(s.expiredOnArrival, 8)} ${pad(s.rowsAfter, 11)}  ${s.manifestOk ? 'OK' : 'MISMATCH'}`,
    )
  }
  const t = r.stores.reduce(
    (a, s) => ({ f: a.f + s.filesOnDisk, i: a.i + s.inserted, u: a.u + s.updated, n: a.n + s.unchanged, p: a.p + s.protected, e: a.e + s.expiredOnArrival, r: a.r + s.rowsAfter }),
    { f: 0, i: 0, u: 0, n: 0, p: 0, e: 0, r: 0 },
  )
  lines.push(`  ${'TOTAL'.padEnd(6)} ${pad(t.f, 6)} ${pad(t.i, 6)} ${pad(t.u, 8)} ${pad(t.n, 10)} ${pad(t.p, 10)} ${pad(t.e, 8)} ${pad(t.r, 11)}`)
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
  if (r.protected) {
    lines.push(
      `  PROTECTED: ${r.protected} row(s) in D1 are NEWER than the backup file that would have replaced them\n` +
        `             (row.updated_at > the file's mtime) and were left alone. The database is live: these\n` +
        `             are writes made since the rescue. Pass --overwrite-newer to restore them anyway.`,
    )
    lines.push('')
  }
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

  const report = await migrateBlobsToD1(db, { backupDir, dryRun, overwriteNewer: argv.includes('--overwrite-newer') })
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
