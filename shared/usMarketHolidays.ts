// NYSE full-closure calendar, computed rather than hardcoded — a year list
// goes stale the day nobody remembers to extend it. Early closes (half days)
// are deliberately out of scope: the engine only cares about daily closes,
// and a half day still produces one.

interface Ymd { y: number; m: number; d: number } // m is 0-indexed (JS Date convention)

const pad2 = (n: number) => String(n).padStart(2, '0')
const toIso = ({ y, m, d }: Ymd) => `${y}-${pad2(m + 1)}-${pad2(d)}`

// Route every date through UTC Date arithmetic so month/day overflow (e.g. day
// 32) normalizes instead of producing an invalid calendar date.
const normalize = (y: number, m: number, d: number): Ymd => {
  const dt = new Date(Date.UTC(y, m, d))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() }
}
const addDays = ({ y, m, d }: Ymd, delta: number): Ymd => normalize(y, m, d + delta)
const weekdayOf = ({ y, m, d }: Ymd): number => new Date(Date.UTC(y, m, d)).getUTCDay() // 0=Sun..6=Sat

// nth (1-based) occurrence of `weekday` in month `m` of year `y`.
const nthWeekday = (y: number, m: number, weekday: number, n: number): Ymd => {
  const firstWeekday = weekdayOf({ y, m, d: 1 })
  const offset = (weekday - firstWeekday + 7) % 7
  return normalize(y, m, 1 + offset + (n - 1) * 7)
}

const lastWeekday = (y: number, m: number, weekday: number): Ymd => {
  const lastDay = normalize(y, m + 1, 0) // day 0 of next month = last day of this one
  const offset = (weekdayOf(lastDay) - weekday + 7) % 7
  return normalize(y, m, lastDay.d - offset)
}

// NYSE observed-date rule for FIXED-date holidays only: Saturday shifts back
// to Friday, Sunday shifts forward to Monday. Floating holidays (always
// defined as "nth Monday" etc.) never land on a weekend, so they never need this.
const observed = (y: number, m: number, d: number): Ymd => {
  const nominal = normalize(y, m, d)
  const dow = weekdayOf(nominal)
  if (dow === 6) return addDays(nominal, -1)
  if (dow === 0) return addDays(nominal, 1)
  return nominal
}

// Meeus/Jones/Butcher Gregorian computus — the standard closed-form Easter
// Sunday algorithm, valid for any Gregorian year.
const easterSunday = (y: number): Ymd => {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const mm = Math.floor((a + 11 * h + 22 * l) / 451)
  const monthDay = h + l - 7 * mm + 114
  const month = Math.floor(monthDay / 31) // 3=March, 4=April
  const day = (monthDay % 31) + 1
  return normalize(y, month - 1, day)
}

// All NYSE full closures whose NOMINAL date falls in year `y`. Observed-shift
// can push a result into the adjacent year (a Jan 1 that falls on Saturday is
// observed the preceding Dec 31), which is why callers scan y-1..y+1 rather
// than trusting a single year's list to be self-contained.
const holidaysForYear = (y: number): Ymd[] => [
  observed(y, 0, 1), // New Year's Day
  nthWeekday(y, 0, 1, 3), // MLK Day — 3rd Monday of January
  nthWeekday(y, 1, 1, 3), // Washington's Birthday — 3rd Monday of February
  addDays(easterSunday(y), -2), // Good Friday
  lastWeekday(y, 4, 1), // Memorial Day — last Monday of May
  observed(y, 5, 19), // Juneteenth
  observed(y, 6, 4), // Independence Day
  nthWeekday(y, 8, 1, 1), // Labor Day — 1st Monday of September
  nthWeekday(y, 10, 4, 4), // Thanksgiving — 4th Thursday of November
  observed(y, 11, 25), // Christmas
]

/** Is `isoDate` (YYYY-MM-DD) an NYSE full-closure day? Weekends are the
 * caller's own concern — this only answers the holiday question. */
export function isUsMarketHoliday(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4))
  if (!Number.isFinite(year)) return false
  // ±1 year covers the only cross-year case (New Year's Day observed on the
  // preceding Dec 31) without hardcoding which holiday can do it.
  const dates = [year - 1, year, year + 1].flatMap(holidaysForYear).map(toIso)
  return dates.includes(isoDate)
}
