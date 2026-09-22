// Walk-forward evaluation primitives for the discovery engine.
//
// Everything here is PURE: bars in, numbers out. The only reason it is a module
// of its own rather than living inside scripts/discovery-walk-forward.ts is that
// the forward-outcome rule and the no-look-ahead slicing are the two things a
// backtest can get silently wrong, so they are the two things that get a test.
//
// The outcome rule is the execution book's, not a convenient one:
//   • a signal printed on the close of session t is ACTED ON at the next
//     session's OPEN (you cannot buy the close you are reading),
//   • the exit is the close 10 sessions after that entry bar,
//   • the number that matters is EXCESS over SPY measured across the SAME
//     calendar window, in percentage points,
//   • a "hit" is excess >= +1pp, which is the engine's own definition.

import type { Candle } from '../../shared/types'
import { computeFeatures } from '../../shared/engine/discovery/features'
import type { Features } from '../../shared/engine/discovery/types'

export const DAY_SEC = 86_400
export const utcDay = (t: number): number => Math.floor(t / DAY_SEC)

/** The engine's hit definition: beat SPY by a point over the window. */
export const HIT_THRESHOLD_PP = 1
export const isHit = (excessPp: number): boolean => excessPp >= HIT_THRESHOLD_PP

/** Default holding horizon, in sessions after the entry bar. */
export const HORIZON = 10

/* ───────────────────────────── calendar ───────────────────────────── */

/** Index of the last bar whose UTC DAY is <= `day`, or -1. Bars must be
 * ascending by time (every producer in this repo emits them that way).
 *
 * BY DAY, not by stamp: Yahoo stamps a daily bar at the session's open in UTC
 * (13:30 for a US line, 07:00 for a London one), so comparing raw stamps puts an
 * LSE bar "before" a US bar of the same session and an exact match never fires. */
export function lastIndexAtOrBefore(bars: readonly Candle[], day: number): number {
  let lo = 0
  let hi = bars.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (utcDay(bars[mid].t) <= day) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/** Index of the first bar whose UTC DAY is >= `day`, or -1. */
export function firstIndexAtOrAfter(bars: readonly Candle[], day: number): number {
  let lo = 0
  let hi = bars.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (utcDay(bars[mid].t) >= day) {
      best = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return best
}

/* ─────────────────────────── forward outcome ─────────────────────────── */

export interface Outcome {
  /** index of the ENTRY bar (signal index + 1) */
  entryIdx: number
  entryDay: number
  exitDay: number
  entry: number
  exit: number
  /** (exit / entry − 1) × 100 */
  retPct: number
  /** worst (low / entry − 1) × 100 across the holding window, <= 0 unless the
   * entry bar's own low is above the open (which cannot happen) */
  maePct: number
}

/**
 * The trade a signal at bar `idx` would actually have produced.
 *
 * `null` when the tape does not carry the whole window — never a partial trade,
 * because a truncated holding period is a silently optimistic one (you only get
 * truncated at the end of the sample, which is where the survivors are).
 */
export function forwardOutcome(bars: readonly Candle[], idx: number, horizon = HORIZON): Outcome | null {
  const entryIdx = idx + 1
  const exitIdx = entryIdx + horizon
  if (entryIdx < 1 || exitIdx >= bars.length) return null
  const entry = bars[entryIdx].o
  const exit = bars[exitIdx].c
  if (!(entry > 0) || !Number.isFinite(exit)) return null
  let low = bars[entryIdx].l
  for (let i = entryIdx; i <= exitIdx; i++) if (bars[i].l < low) low = bars[i].l
  return {
    entryIdx,
    entryDay: utcDay(bars[entryIdx].t),
    exitDay: utcDay(bars[exitIdx].t),
    entry,
    exit,
    retPct: (exit / entry - 1) * 100,
    maePct: (low / entry - 1) * 100,
  }
}

/**
 * SPY's return over the SAME CALENDAR WINDOW the name was held.
 *
 * Not "SPY's next 10 bars": an LSE name trades on days Wall Street is shut and
 * vice versa, so counting bars on each tape independently would compare a 10-
 * session UK window against a 10-session US window that ended two days later.
 * Entry is SPY's first bar on or after the name's entry day; exit is SPY's last
 * bar on or before the name's exit day. For a US name that is exactly the same
 * pair of bars, so nothing changes for 1,516 of the 1,866 seed rows.
 */
export function benchReturnPct(spy: readonly Candle[], entryDay: number, exitDay: number): number | null {
  const e = firstIndexAtOrAfter(spy, entryDay)
  const x = lastIndexAtOrBefore(spy, exitDay)
  if (e < 0 || x < 0 || x <= e) return null
  const entry = spy[e].o
  const exit = spy[x].c
  if (!(entry > 0) || !Number.isFinite(exit)) return null
  return (exit / entry - 1) * 100
}

/** Excess in percentage points. A SHORT lens's excess is the negation. */
export const excessPp = (nameRetPct: number, benchRetPct: number): number => nameRetPct - benchRetPct

/* ─────────────────────── no-look-ahead feature read ─────────────────────── */

/**
 * Features as they would have been computable on the close of `day` — and
 * NOTHING later.
 *
 * The one job here is the slice. `computeFeatures` reads the END of the array
 * for every window it takes, so handing it a tape that still carries future bars
 * silently measures "the last 20 sessions" from the wrong end of history. The
 * SPY tape is cut the same way, by UTC day, for the same reason.
 *
 * Returns null when there is no bar at or before the day, when fewer than
 * `minBars` sit behind it, or when the newest bar is `maxStaleDays` calendar
 * days old (a delisted or suspended name still has bars; it does not still have
 * a tape).
 */
export function featuresAtDay(
  sym: string,
  bars: readonly Candle[],
  spy: readonly Candle[] | null,
  day: number,
  minBars = 100,
): { idx: number; features: Features | null } | null {
  const idx = lastIndexAtOrBefore(bars, day)
  if (idx < minBars - 1) return null
  const prefix = bars.slice(0, idx + 1)
  const spyIdx = spy ? lastIndexAtOrBefore(spy, day) : -1
  const spyPrefix = spy && spyIdx >= 0 ? spy.slice(0, spyIdx + 1) : null
  return { idx, features: computeFeatures(sym, prefix, spyPrefix) }
}

/* ───────────────────────────── statistics ───────────────────────────── */

export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN)

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Sample standard deviation (n−1). */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  let acc = 0
  for (const x of xs) acc += (x - m) * (x - m)
  return Math.sqrt(acc / (xs.length - 1))
}

/** t-statistic of the mean against zero, assuming independent observations.
 * That assumption is FALSE for overlapping 10-session windows and for names
 * moving together on the same day — see `neweyWestT` for the honest number. */
export function tStat(xs: readonly number[]): number {
  if (xs.length < 2) return NaN
  const sd = stdev(xs)
  if (!(sd > 0)) return NaN
  return mean(xs) / (sd / Math.sqrt(xs.length))
}

/**
 * t-statistic of a per-date mean series with a Newey–West correction.
 *
 * Every observation in this study holds for 10 sessions, so consecutive daily
 * means share 9/10 of their tape. Ignoring that inflates t by roughly √10. The
 * Bartlett kernel at `lag` (10 by default: the horizon) is the standard, cheap
 * fix and it is the number the verdict is allowed to lean on.
 */
export function neweyWestT(series: readonly number[], lag = HORIZON): number {
  const n = series.length
  if (n < lag + 2) return NaN
  const m = mean(series)
  const d = series.map(x => x - m)
  let v = d.reduce((s, x) => s + x * x, 0) / n
  for (let l = 1; l <= lag; l++) {
    let g = 0
    for (let i = l; i < n; i++) g += d[i] * d[i - l]
    g /= n
    v += 2 * (1 - l / (lag + 1)) * g
  }
  if (!(v > 0)) return NaN
  return m / Math.sqrt(v / n)
}

/** Fractional ranks 1..n with ties averaged. NaN inputs must be filtered first. */
export function rankAvgTies(xs: readonly number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[order[k][1]] = r
    i = j + 1
  }
  return out
}

/** Spearman rank correlation. NaN when fewer than 3 usable pairs or no variance. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i])
      ys.push(b[i])
    }
  }
  if (xs.length < 3) return NaN
  const rx = rankAvgTies(xs)
  const ry = rankAvgTies(ys)
  const mx = mean(rx)
  const my = mean(ry)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < rx.length; i++) {
    const a1 = rx[i] - mx
    const b1 = ry[i] - my
    num += a1 * b1
    dx += a1 * a1
    dy += b1 * b1
  }
  if (!(dx > 0) || !(dy > 0)) return NaN
  return num / Math.sqrt(dx * dy)
}

/** 1-based decile (1 = lowest) for each entry, assigned by rank within the array
 * given. Ties land wherever the average rank puts them, which is the only
 * defensible answer for a feature like `upDays10` that takes eleven values. */
export function decilesOf(xs: readonly number[]): number[] {
  const r = rankAvgTies(xs)
  const n = xs.length
  return r.map(rank => Math.min(10, Math.max(1, Math.ceil((rank / n) * 10))))
}
