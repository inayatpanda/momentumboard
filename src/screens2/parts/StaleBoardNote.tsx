// THE STALE-BOARD BANNER (dynamism wave, feature 2).
//
// The engine publishes on weekday mornings. Every other hour of the week the
// app served the last board it had, unlabelled — so a Saturday reader saw
// Friday's calls presented exactly as if they had been struck that morning,
// and a Monday reader before the run saw the same. The cards were never wrong;
// the silence about WHICH DAY they belonged to was.
//
// One line above the cards, dim: this is context, not an alarm — the board is
// still the engine's latest word, and the reader is entitled to read it.
//
// The comparison is on LONDON calendar days (src/lib/londonDay.ts), because
// that is the calendar the engine stamps `board.date` with.

import { londonToday } from '../../lib/londonDay'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The sentence, or null when the board IS today's (and when there is no
 * board, or its date is unreadable, or it somehow post-dates the reader —
 * three cases where saying anything would be worse than saying nothing). */
export function staleBoardLine(boardDate: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!boardDate) return null
  const [y, m, d] = boardDate.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  const today = londonToday(nowMs)
  // ISO dates compare correctly as strings — same width, most significant first.
  if (boardDate >= today) return null
  // Manual UTC parse for the weekday, the timezone-proofing rule format.ts
  // states: `new Date('2026-08-14')` is UTC midnight and walks a day west.
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  const sameYear = today.slice(0, 4) === String(y)
  const stamp = `${d} ${MONTHS[m - 1] ?? ''}${sameYear ? '' : ` ${y}`}`
  return `${weekday}'s board (${stamp}) — the engine publishes on weekday mornings.`
}

export function StaleBoardNote({ date, now }: { date?: string | null; now?: number }) {
  const line = staleBoardLine(date, now)
  if (!line) return null
  return <p className="cc-reason stale-board">{line}</p>
}
