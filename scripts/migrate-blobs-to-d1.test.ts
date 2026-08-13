import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureD1Schema, type D1Database } from '../netlify/functions/lib/d1Store'
import { openSqliteD1 } from './lib/sqliteD1'
import { DEFAULT_BACKUP_DIR, formatReport, migrateBlobsToD1, scanBackup } from './migrate-blobs-to-d1'
import samples from '../netlify/functions/lib/__fixtures__/blobSamples.json'

const RAW = samples as Record<string, string>
const temps: string[] = []

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
})

/** A miniature of the real backup, built from bytes actually rescued from
 * Netlify — including the pick-stats key that exists in two source dirs. */
function fixtureBackup(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'blob-backup-'))
  temps.push(dir)
  for (const [name, body] of Object.entries({ ...RAW, ...extra })) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
  return dir
}

async function fresh() {
  const db = openSqliteD1(':memory:')
  await ensureD1Schema(db)
  return db
}

/** Every column of every row — the only honest way to say "nothing changed". */
async function snapshot(db: D1Database): Promise<string> {
  const res = await db.prepare('SELECT store, key, value, updated_at, expires_at FROM blobs ORDER BY store, key').all()
  return JSON.stringify(res.results ?? [])
}

describe('migrate-blobs-to-d1', () => {
  it('imports the rescued directory into the stores the code names', async () => {
    const db = await fresh()
    const r = await migrateBlobsToD1(db, { backupDir: fixtureBackup() })

    expect(r.ok).toBe(true)
    expect(r.stores.map(s => s.store)).toEqual(['app', 'cache'])
    const app = r.stores.find(s => s.store === 'app')!
    const cache = r.stores.find(s => s.store === 'cache')!
    expect(app).toMatchObject({ filesOnDisk: 2, inserted: 2, updated: 0, unchanged: 0, rowsAfter: 2, manifestOk: true })
    expect(cache).toMatchObject({ filesOnDisk: 3, inserted: 3, updated: 0, unchanged: 0, rowsAfter: 3, manifestOk: true })
    expect(r.changes).toBe(5)

    // the bytes land verbatim
    const row = await db.prepare('SELECT value FROM blobs WHERE store = ?1 AND key = ?2').bind('app', 'intraday-flags').first<{ value: string }>()
    expect(row?.value).toBe(RAW['site__app/intraday-flags'])
    db.close()
  })

  // THE M1 GATE (DeepSeek H1). Not "reports zero" — proves zero, by comparing
  // every column including updated_at either side of the second run.
  it('run it twice and the second run is a byte no-op', async () => {
    const db = await fresh()
    const backupDir = fixtureBackup()
    const first = await migrateBlobsToD1(db, { backupDir, now: () => 1_000 })
    expect(first.changes).toBe(5)

    const before = await snapshot(db)
    const second = await migrateBlobsToD1(db, { backupDir, now: () => 2_000_000 })

    expect(second.changes).toBe(0)
    expect(second.stores.every(s => s.inserted === 0 && s.updated === 0)).toBe(true)
    expect(second.stores.reduce((n, s) => n + s.unchanged, 0)).toBe(5)
    expect(await snapshot(db)).toBe(before) // updated_at did not move
    expect(second.ok).toBe(true)
    db.close()
  })

  it('rewrites only the rows whose bytes actually differ', async () => {
    const db = await fresh()
    const backupDir = fixtureBackup()
    await migrateBlobsToD1(db, { backupDir, now: () => 1_000 })
    await db.prepare('UPDATE blobs SET value = ?1 WHERE store = ?2 AND key = ?3').bind('{"drifted":true}', 'app', 'intraday-flags').run()

    const r = await migrateBlobsToD1(db, { backupDir, now: () => 2_000 })
    expect(r.changes).toBe(1)
    expect(r.stores.find(s => s.store === 'app')).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 })
    db.close()
  })

  /* ─────────────────────────────── I-2 ───────────────────────────────
   * This script was safe because the target was empty. It is not empty any
   * more — it is production. A re-run against the same rescue folder would
   * revert every licence minted, ledger row written and board produced since
   * the cutover, and report it as a clean import. The per-key signal is the
   * backup FILE's mtime against the ROW's updated_at.
   */
  describe('a live database is not overwritten by a week-old backup', () => {
    /** Drift a row the way the app does: a new value, written NOW. */
    const drift = (db: D1Database, key: string, at: number) =>
      db.prepare('UPDATE blobs SET value = ?1, updated_at = ?2 WHERE store = ?3 AND key = ?4').bind('{"licences":["minted-since-the-rescue"]}', at, 'app', key).run()

    it('refuses a row whose D1 copy is newer than the backup file, and counts it', async () => {
      const db = await fresh()
      const backupDir = fixtureBackup()
      await migrateBlobsToD1(db, { backupDir, now: () => 1_000 })
      const fileMtime = statSync(join(backupDir, 'site__app', 'intraday-flags')).mtimeMs
      await drift(db, 'intraday-flags', fileMtime + 60_000) // a minute after the export

      const r = await migrateBlobsToD1(db, { backupDir, now: () => 2_000 })
      expect(r.protected).toBe(1)
      expect(r.stores.find(s => s.store === 'app')).toMatchObject({ protected: 1, updated: 0, inserted: 0, unchanged: 1 })
      expect(r.changes).toBe(0)
      // The live value is still there — that is the whole point.
      const row = await db.prepare('SELECT value FROM blobs WHERE store = ?1 AND key = ?2').bind('app', 'intraday-flags').first<{ value: string }>()
      expect(row?.value).toBe('{"licences":["minted-since-the-rescue"]}')
      // …and the run does NOT claim success: the table deliberately differs
      // from the directory, so the manifest says so and the exit code is 1.
      expect(r.ok).toBe(false)
      expect(formatReport(r)).toMatch(/PROTECTED: 1 row\(s\) in D1 are NEWER/)
      db.close()
    })

    it('overwrites a row whose D1 copy is OLDER — an ordinary drifted row still gets fixed', async () => {
      const db = await fresh()
      const backupDir = fixtureBackup()
      await migrateBlobsToD1(db, { backupDir, now: () => 1_000 })
      const fileMtime = statSync(join(backupDir, 'site__app', 'intraday-flags')).mtimeMs
      await drift(db, 'intraday-flags', fileMtime - 60_000) // written BEFORE the export

      const r = await migrateBlobsToD1(db, { backupDir, now: () => 2_000 })
      expect(r.protected).toBe(0)
      expect(r.stores.find(s => s.store === 'app')).toMatchObject({ updated: 1, protected: 0 })
      expect(r.ok).toBe(true)
      const row = await db.prepare('SELECT value FROM blobs WHERE store = ?1 AND key = ?2').bind('app', 'intraday-flags').first<{ value: string }>()
      expect(row?.value).toBe(RAW['site__app/intraday-flags'])
      db.close()
    })

    it('--overwrite-newer restores it anyway, because that is sometimes the job', async () => {
      const db = await fresh()
      const backupDir = fixtureBackup()
      await migrateBlobsToD1(db, { backupDir, now: () => 1_000 })
      await drift(db, 'intraday-flags', statSync(join(backupDir, 'site__app', 'intraday-flags')).mtimeMs + 60_000)

      const r = await migrateBlobsToD1(db, { backupDir, now: () => 2_000, overwriteNewer: true })
      expect(r.protected).toBe(0)
      expect(r.changes).toBe(1)
      expect(r.ok).toBe(true)
      const row = await db.prepare('SELECT value FROM blobs WHERE store = ?1 AND key = ?2').bind('app', 'intraday-flags').first<{ value: string }>()
      expect(row?.value).toBe(RAW['site__app/intraday-flags'])
      db.close()
    })

    // The guard must not cost the idempotence gate. Rows the importer wrote
    // itself are newer than every file by construction, so if the comparison
    // ran before the byte comparison, the second run would "protect" all 2,022
    // rows instead of reporting a no-op. Identical bytes are `unchanged`, full
    // stop — the guard only ever sees rows that genuinely differ.
    it('leaves the byte no-op a byte no-op, even though every row is newer than its file', async () => {
      const db = await fresh()
      const backupDir = fixtureBackup()
      await migrateBlobsToD1(db, { backupDir, now: () => Date.now() + 86_400_000 }) // stamped a day in the future
      const second = await migrateBlobsToD1(db, { backupDir, now: () => Date.now() + 86_400_000 })
      expect(second.protected).toBe(0)
      expect(second.changes).toBe(0)
      expect(second.ok).toBe(true)
      db.close()
    })
  })

  it('lifts the cache envelope expiry into the column, and leaves app rows immortal', async () => {
    const db = await fresh()
    await migrateBlobsToD1(db, { backupDir: fixtureBackup() })
    const quote = await db.prepare('SELECT expires_at FROM blobs WHERE store = ?1 AND key = ?2').bind('cache', 'quote:RMS.PA').first<{ expires_at: number }>()
    expect(quote?.expires_at).toBe(JSON.parse(RAW['site__cache/quote:RMS.PA']).expires)
    const flags = await db.prepare('SELECT expires_at FROM blobs WHERE store = ?1 AND key = ?2').bind('app', 'intraday-flags').first<{ expires_at: number | null }>()
    expect(flags?.expires_at).toBeNull()
    db.close()
  })

  it('resolves the two-directory collision by precedence, not by readdir order', async () => {
    const db = await fresh()
    const r = await migrateBlobsToD1(db, { backupDir: fixtureBackup() })
    expect(r.conflicts).toEqual([{ store: 'cache', key: 'pick-stats', winner: 'site__cache', loser: 'cache' }])
    const row = await db.prepare('SELECT value FROM blobs WHERE store = ?1 AND key = ?2').bind('cache', 'pick-stats').first<{ value: string }>()
    expect(row?.value).toBe(RAW['site__cache/pick-stats']) // the live one, not the deploy-scoped fossil
    db.close()
  })

  it('counts an identical duplicate as a duplicate, not a conflict', async () => {
    const db = await fresh()
    const twin = RAW['site__cache/pick-stats']
    const r = await migrateBlobsToD1(db, { backupDir: fixtureBackup({ 'cache/pick-stats': twin }) })
    expect(r.conflicts).toEqual([])
    expect(r.duplicates).toEqual([{ store: 'cache', key: 'pick-stats', dirs: ['site__cache', 'cache'] }])
    db.close()
  })

  it('--dry-run writes nothing but still reports the manifest it would leave', async () => {
    const db = await fresh()
    const backupDir = fixtureBackup()
    const r = await migrateBlobsToD1(db, { backupDir, dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.changes).toBe(5)
    expect(r.ok).toBe(true)
    expect(r.stores.every(s => s.manifestOk)).toBe(true)
    expect(await snapshot(db)).toBe('[]') // nothing was written
    db.close()
  })

  it('a dry run against a database with no table at all still plans the whole import', async () => {
    const db = openSqliteD1(':memory:') // no ensureD1Schema
    const r = await migrateBlobsToD1(db, { backupDir: fixtureBackup(), dryRun: true })
    expect(r.changes).toBe(5)
    expect(r.ok).toBe(true)
    db.close()
  })

  it('fails the manifest when D1 holds rows the directory does not', async () => {
    const db = await fresh()
    await db.prepare('INSERT INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1,?2,?3,?4,NULL)').bind('app', 'stowaway', '1', 1).run()
    const r = await migrateBlobsToD1(db, { backupDir: fixtureBackup() })
    expect(r.ok).toBe(false)
    expect(r.stores.find(s => s.store === 'app')).toMatchObject({ filesOnDisk: 2, rowsAfter: 3, manifestOk: false })
    db.close()
  })

  it('refuses to silently drop an unmapped directory that holds data', async () => {
    const dir = fixtureBackup({ 'site__secrets/token': '"nope"' })
    expect(() => scanBackup(dir)).toThrow(/site__secrets.*maps to no store/)
  })

  it('skips a file that is not JSON, names it, and fails the run', async () => {
    const db = await fresh()
    const r = await migrateBlobsToD1(db, { backupDir: fixtureBackup({ 'site__app/truncated': '{"a":' }) })
    expect(r.unparseable).toEqual([{ dir: 'site__app', key: 'truncated', reason: expect.any(String) }])
    expect(r.stores.find(s => s.store === 'app')?.skipped).toBe(1)
    expect(r.ok).toBe(false)
    db.close()
  })

  // M1 review, booked for M2. macOS drops a `.DS_Store` into every directory
  // it has ever displayed, and the unmapped-directory check counted it as a
  // blob: one Finder visit to the rescue folder and the whole import aborted
  // with "site%3Aapp holds 1 blobs but maps to no store".
  it('ignores dotfile furniture everywhere, not only inside the mapped sources', async () => {
    const dir = fixtureBackup({
      '.DS_Store': 'macos junk',
      'site%3Aapp/.DS_Store': 'macos junk',
      'site__app/.DS_Store': 'macos junk',
    })
    const scan = scanBackup(dir)
    expect(scan.ignoredDirs).toContain('site%3Aapp')
    expect(scan.perSource.find(s => s.dir === 'site__app')?.files).toBe(2)

    const db = await fresh()
    const r = await migrateBlobsToD1(db, { backupDir: dir })
    expect(r.ok).toBe(true)
    expect(await db.prepare(`SELECT count(*) AS n FROM blobs WHERE key LIKE '.%'`).first()).toEqual({ n: 0 })
    db.close()
  })

  it("decodes the exporter's '__' back into a slash", async () => {
    const db = await fresh()
    const r = await migrateBlobsToD1(db, { backupDir: fixtureBackup({ 'site__app/nested__key': '{"ok":true}' }) })
    expect(r.slashKeys).toBe(1)
    expect(await db.prepare('SELECT 1 AS hit FROM blobs WHERE store = ?1 AND key = ?2').bind('app', 'nested/key').first()).toEqual({ hit: 1 })
    db.close()
  })
})

// M1 left this script OUTSIDE the compiler's reach: tsconfig's `include` did
// not list `scripts`, so `npm run build` could go green over a type error in
// the one program that touches the rescued data. M2 added it — pinned here so
// nobody trims the include back and quietly loses the coverage again.
describe("this script is inside the build's type checking", () => {
  it('tsconfig include lists scripts, functions and workers', () => {
    const tsconfig = JSON.parse(readFileSync(join(__dirname, '..', 'tsconfig.json'), 'utf8')) as { include: string[] }
    for (const dir of ['src', 'shared', 'netlify', 'scripts', 'functions', 'workers']) expect(tsconfig.include, dir).toContain(dir)
  })
})

// The gate as it will actually be run: against the whole 2,023-blob rescue.
// Skipped where the backup is not on disk (CI, another machine).
describe.skipIf(!existsSync(DEFAULT_BACKUP_DIR))('the real rescued backup', () => {
  it('imports 2,022 unique keys and re-runs as a byte no-op', async () => {
    const db = await fresh()
    const first = await migrateBlobsToD1(db, { backupDir: DEFAULT_BACKUP_DIR, now: () => 1_000 })
    expect(first.ok).toBe(true)
    expect(first.stores.find(s => s.store === 'app')).toMatchObject({ filesOnDisk: 168, inserted: 168, manifestOk: true })
    expect(first.stores.find(s => s.store === 'cache')).toMatchObject({ filesOnDisk: 1854, inserted: 1854, manifestOk: true })
    expect(first.conflicts).toEqual([{ store: 'cache', key: 'pick-stats', winner: 'site__cache', loser: 'cache' }])

    const before = await snapshot(db)
    const second = await migrateBlobsToD1(db, { backupDir: DEFAULT_BACKUP_DIR, now: () => 9_000_000 })
    expect(second.changes).toBe(0)
    expect(await snapshot(db)).toBe(before)
    db.close()
  }, 60_000)
})
