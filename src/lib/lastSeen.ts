// WHAT CHANGED SINCE YOU LAST LOOKED (dynamism wave, feature 7).
//
// Two marks, kept between visits: the `generatedAt` of the board the reader
// last saw, and the stamp of the newest headline they last saw. On the next
// visit the app diffs against them and says so — a dot beside Today's heading
// when the board itself has turned over, "N new" beside the headlines.
//
// CONTENT IDENTITY, NEVER FETCH TIME. The mark is the board's own
// `generatedAt` and the desk's own `at`: a re-fetch of the same morning's board
// is not new, and a cache that happened to refresh at 09:15 says nothing about
// whether anything in it changed.
//
// WHERE IT LIVES. The existing `settings` table, under one JSON key — NOT a
// schema bump and NOT `slices`. A bump is the one Dexie operation that can
// cost an installed reader their journal if it is written carelessly (the
// v4→v5 upgrade test exists for exactly that reason), and this is two numbers.
// `slices` was the other option and is wrong for a different reason: the boot
// GC sweeps anything unfetched for seven days, which would silently drop the
// marks rather than keep them. `settings` is read key-by-key by everything that
// touches it (sync.ts, configMirror.ts), so a new key mirrors nothing and
// clobbers nothing.
//
// WHEN IT IS WRITTEN. Once, on `pagehide`, from an in-memory snapshot the
// screens keep up to date as they render. Reading Dexie inside a pagehide
// handler and then writing it is two round trips against a page that is being
// torn down; keeping the snapshot in memory makes it one.

import { useEffect, useState } from 'react'
import { db } from './db'

export interface SeenMarks {
  /** ms — the board blob's own generatedAt */
  boardGeneratedAt: number | null
  /** the newest headline's own `at` (the desk stores seconds) */
  newsTopAt: number | null
}

const SETTINGS_KEY = 'lastSeen'
const EMPTY: SeenMarks = { boardGeneratedAt: null, newsTopAt: null }

/** Seconds or milliseconds, decided by magnitude — the news desk stores
 * seconds and the board stores milliseconds, and comparing one against the
 * other unconverted dates every headline to 1970 (the rule src/lib/format.ts's
 * relativeStamp states). */
const toMs = (v: number): number => (v > 1e12 ? v : v * 1000)

/** What the reader is looking at RIGHT NOW, in memory. Seeded from storage on
 * mount so a screen that never rendered (no headlines today) cannot blank a
 * mark another visit set. */
let current: SeenMarks = { ...EMPTY }

export async function readSeenMarks(): Promise<SeenMarks> {
  try {
    const row = await db.settings.get(SETTINGS_KEY)
    if (!row) return { ...EMPTY }
    const parsed = JSON.parse(row.value) as Partial<SeenMarks>
    return {
      boardGeneratedAt: typeof parsed.boardGeneratedAt === 'number' ? parsed.boardGeneratedAt : null,
      newsTopAt: typeof parsed.newsTopAt === 'number' ? parsed.newsTopAt : null,
    }
  } catch {
    // a corrupt row is a first visit, not a crash
    return { ...EMPTY }
  }
}

export async function writeSeenMarks(marks: SeenMarks): Promise<void> {
  await db.settings.put({ key: SETTINGS_KEY, value: JSON.stringify(marks) }).catch(() => {})
}

/** Record what a screen is showing. Nulls are ignored: "this screen has no
 * board" must never erase the board mark. */
export function noteSeen(patch: Partial<SeenMarks>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v != null) current[k as keyof SeenMarks] = v as number
  }
}

/** Fill in what no screen has recorded yet. Only the still-empty fields: the
 * stored marks are OLDER than anything a mounted screen is showing, and
 * seeding over a live value would write the reader's own visit back to what it
 * was before it (the effect that records a board runs before the async read of
 * the marks resolves — that ordering is not negotiable in React). */
function seedSeen(marks: SeenMarks): void {
  for (const [k, v] of Object.entries(marks)) {
    const key = k as keyof SeenMarks
    if (current[key] == null && v != null) current[key] = v
  }
}

/** Test seam — and the honest place to clear the marks from, should a sign-out
 * ever need to. */
export function resetSeenMarks(): void {
  current = { ...EMPTY }
}

/** Persist the snapshot. Exported so a test can drive it without faking a
 * page teardown. */
export const flushSeenMarks = (): Promise<void> => writeSeenMarks(current)

if (typeof window !== 'undefined') {
  // `pagehide` rather than `unload`: it is the event a bfcache'd page and an
  // installed PWA both actually get.
  window.addEventListener('pagehide', () => void flushSeenMarks())
}

/** Is `value` newer than the mark? A FIRST visit (no mark) makes nothing new —
 * an install that shouts "new" at everything says nothing at all. */
export const isNewSince = (value: number | null | undefined, seen: number | null): boolean =>
  value != null && seen != null && toMs(value) > toMs(seen)

/** How many of these stamps landed after the mark. */
export const countNewSince = (values: (number | null | undefined)[], seen: number | null): number =>
  seen == null ? 0 : values.filter(v => v != null && toMs(v) > toMs(seen)).length

/** The marks as they stood when this mount began — read ONCE, and deliberately
 * frozen: a diff that moved while the reader was looking at it would erase the
 * dot they had not yet acted on. */
export function useSeenBaseline(): SeenMarks | null {
  const [baseline, setBaseline] = useState<SeenMarks | null>(null)
  useEffect(() => {
    let alive = true
    void readSeenMarks().then(m => {
      // seed the snapshot so a flush cannot write nulls over what a previous
      // visit recorded — without stepping on what this visit has already shown
      seedSeen(m)
      if (alive) setBaseline(m)
    })
    return () => {
      alive = false
    }
  }, [])
  return baseline
}

/** Keep the snapshot current while a screen renders. */
export function useNoteSeen(patch: Partial<SeenMarks>): void {
  const board = patch.boardGeneratedAt ?? null
  const news = patch.newsTopAt ?? null
  useEffect(() => {
    noteSeen({ boardGeneratedAt: board, newsTopAt: news })
  }, [board, news])
}
