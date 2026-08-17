// THE READER'S DAY (dynamism wave).
//
// Every calendar date the engine stamps — a board's `date`, an event radar
// entry's print date — is a LONDON calendar day (netlify/functions/engine.mts's
// own `londonToday`, the same `en-CA` + `Europe/London` one-liner mirrored
// here). A screen that compares those against `new Date()` in the reader's own
// zone gets the answer wrong by a day for anyone west of Greenwich, and gets it
// wrong for a London reader too between midnight and 01:00 BST.
//
// Two helpers, both pure and both clock-injectable, because "is this board
// today's?" and "how far off is that print?" are the questions the app kept
// answering from server-baked numbers that go stale the moment the file is
// cached.

/** The London calendar day for an instant, as YYYY-MM-DD. */
export const londonToday = (nowMs: number = Date.now()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(nowMs))

/** Whole calendar days from `fromIso` to `toIso`, signed; null on a malformed
 * date. Manual parse through `Date.UTC`, never `new Date(iso)` — the rule
 * src/lib/format.ts states: a bare YYYY-MM-DD handed to the Date constructor is
 * UTC midnight and walks a day west of Greenwich. */
export function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const parse = (s: string): number | null => {
    const [y, m, d] = (s ?? '').split('-').map(Number)
    return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? Date.UTC(y, m - 1, d) : null
  }
  const a = parse(fromIso)
  const b = parse(toIso)
  if (a == null || b == null) return null
  return Math.round((b - a) / 86_400_000)
}
