// The committed discovery universe, as a typed array.
//
// WHY A JSON IMPORT RATHER THAN A GENERATED `.ts` MODULE: `tsconfig.json`
// already sets `"resolveJsonModule": true`, and the repo already imports
// `shared/engine/seed.json` this way (see `shared/engine/calibration.test.ts`
// and `scripts/replay-window.ts`), so `tsc -b` and Vite both resolve it with
// no extra wiring. Keeping the seed as data also means a regeneration produces
// a data-only diff that no one can mistake for a code change.
//
// The import is widened through `unknown` deliberately: TypeScript infers a
// literal type for a JSON module, and structurally comparing ~1,800 inferred
// row literals against `UniverseSeedRow` on every typecheck is work with no
// payoff — the SHAPE is guarded by `universeSeed.test.ts`, which asserts it on
// the real file at test time.
import raw from './universe.seed.json'
import type { CapBand, Exchange, IndexTag, UniverseSeedRow } from './universeSeedBuild'

export type { CapBand, Exchange, IndexTag, UniverseSeedRow }

/** The header the build script stamps on the file, plus the rows. */
export interface UniverseSeedFile {
  /** ISO timestamp of the build run that produced this file. */
  generatedAt: string
  /** Per-source fetch outcome and row count, for auditing a stale seed. */
  sources: Record<string, { status: string; rows: number; url: string; note?: string }>
  /** How many symbols the Yahoo validation pass removed. */
  droppedByYahoo: number
  /** `rows.length`, stamped so a truncated file is obvious. */
  count: number
  rows: UniverseSeedRow[]
}

const seed = raw as unknown as UniverseSeedFile

/** The whole file, header included — for "when was this built / what died". */
export function loadUniverseSeedFile(): UniverseSeedFile {
  return seed
}

/** How much of the committed count the file must still carry to be usable.
 * 15% missing is a truncated write or a half-finished regeneration; a handful
 * of rows short is a hand edit and nobody's emergency. */
export const SEED_MIN_SHARE = 0.85

/**
 * Is this file big enough to scan with? `null` = yes, else the sentence to
 * throw.
 *
 * WHY A FLOOR AT ALL. `count` is stamped by the build script at the moment it
 * wrote the rows, so the two disagreeing means the file on disk is not the file
 * that was built — a truncated write, an aborted regeneration, a bad merge. The
 * failure mode without this check is the quiet one: the scan runs, the universe
 * is a third of its size, every missing name is simply never seen, and the only
 * trace is a `universe 620` in a log line nobody reads. A refusal costs one
 * legacy-path run and says exactly what happened.
 *
 * Kept pure and separate from the loader so a test can exercise it without
 * corrupting the committed seed. */
export function seedSizeShortfall(rowCount: number, committed: number | undefined | null, minShare = SEED_MIN_SHARE): string | null {
  if (!Number.isFinite(committed as number) || (committed as number) <= 0) return null // no header count: nothing to check against
  const floor = (committed as number) * minShare
  if (rowCount >= floor) return null
  return `universe seed is truncated: ${rowCount} rows against a committed count of ${committed} (floor ${Math.ceil(floor)}) — regenerate with scripts/build-universe-seed.ts`
}

/** The universe itself, sorted by symbol (the build script writes it sorted;
 * nothing here re-sorts, so callers get the committed order verbatim).
 *
 * THROWS on a truncated file. The caller in engine.ts already treats any throw
 * out of the discovery stage as "no scan today, run the legacy path", which is
 * the right answer: a third of a universe silently scanned is worse than no
 * scan at all, because it looks like a scan. */
export function loadUniverseSeed(): UniverseSeedRow[] {
  const rows = seed.rows ?? []
  const bad = seedSizeShortfall(rows.length, seed.count)
  if (bad) throw new Error(bad)
  return rows
}
