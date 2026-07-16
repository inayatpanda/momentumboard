// FEEDS, not static boards. The Intel intel sections used to sort by MAGNITUDE
// (dollar size, trade count), so the same big rows sat for days — the reader saw
// nothing move. These pure helpers re-order by RECENCY (newest disclosure /
// transaction at the top) and flag anything fresh enough to have appeared since
// the reader last looked. Magnitude still shows ON the row; recency just decides
// where the row sits. Undated rows sink rather than jump the feed — we never
// fabricate recency for something the source didn't date.

// within this window of now, a row is "new" — one badge, ~two sessions of grace
export const NEW_WINDOW_MS = 48 * 60 * 60 * 1000

/** ms-since-epoch for the best (most recent) parseable date among the args, or
 * -Infinity when none parse — so an undated row sorts to the bottom. Lets a feed
 * fall back through a date ladder (e.g. filing date, then transaction date). */
export function bestDateMs(...isoDates: (string | null | undefined)[]): number {
  let best = -Infinity
  for (const d of isoDates) {
    if (!d) continue
    const t = Date.parse(d)
    if (Number.isFinite(t) && t > best) best = t
  }
  return best
}

/** True when `iso` names a moment within `windowMs` BEFORE `now`. Day-resolution
 * filing dates parse to their midnight, so "today" and "yesterday" read new under
 * the 48h default; a future-dated typo (t > now) never counts. */
export function isNew(iso: string | null | undefined, now: number = Date.now(), windowMs: number = NEW_WINDOW_MS): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && t <= now && now - t <= windowMs
}

/** Stable newest-first ordering by a caller-supplied date extractor (ms). PURE —
 * returns a new array, never mutates the input; ties keep their original order. */
export function feedOrder<T>(rows: readonly T[], dateOf: (row: T) => number): T[] {
  return rows
    .map((row, i) => ({ row, i, at: dateOf(row) }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .map(x => x.row)
}
