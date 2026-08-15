// THE CUMULATIVE LINE (owner iteration 2): "Track record is basically useless,
// the graph doesnt mean anything."
//
// The one question a track record has to answer is "what would following this
// have done to me", and no surface on the page answered it. This builds that
// series: per-day sum of realised excess over SPY, cumulated forward, one point
// a graded day.
//
// TWO RULES DECIDE WHAT IS IN IT, and both are the page's existing rules rather
// than new ones:
//
//  1. EQUITY ONLY. `outcome10.excessPct` on an equity row is "the call's move
//     minus SPY's"; on a crypto-cohort row it is the side-adjusted RAW move,
//     because that partition grades absolute over fourteen crypto bars and
//     `spyPct` is a structural 0. Cumulating the two produces a line that is
//     neither — so the cohort is excluded here exactly as it is excluded from
//     every other equity aggregate (ledgerStats.isCryptoCohort, stamp OR
//     symbol, so the client and the server's scorecard never disagree about
//     one trade).
//  2. GRADED ONLY. A row with no `outcome10` has not matured; it is counted
//     nowhere and contributes no point. A day on which nothing equity-graded
//     therefore has no point at all rather than a flat carried-forward one —
//     a fake datum on a chart is worse than a gap.

import { isCryptoCohort } from './ledgerStats'
import type { JourneyCall, LedgerDay } from './apiViews'

export interface CumulativePoint {
  date: string
  /** that day's realised excess, summed across its graded equity rows (pp) */
  daily: number
  /** running total from the first graded day (pp) */
  cumulative: number
  /** how many graded equity rows the day contributed */
  n: number
}

/** Oldest first — a cumulative line reads left to right, and the ledger slice
 * arrives newest-first. */
export function cumulativeExcessSeries(days: LedgerDay[]): CumulativePoint[] {
  const perDay = new Map<string, { sum: number; n: number }>()
  for (const day of days) {
    for (const p of day.predictions ?? []) {
      if (isCryptoCohort(p)) continue
      const out = p.outcome10
      if (!out || typeof out.excessPct !== 'number' || !Number.isFinite(out.excessPct)) continue
      // the ROW's own date, not the day bucket's: a slice can carry a row under
      // a differently-keyed day and the x axis must stay honest
      const date = p.date || day.date
      const acc = perDay.get(date) ?? { sum: 0, n: 0 }
      acc.sum += out.excessPct
      acc.n += 1
      perDay.set(date, acc)
    }
  }
  let running = 0
  return [...perDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, acc]) => {
      running += acc.sum
      return { date, daily: acc.sum, cumulative: running, n: acc.n }
    })
}

export interface LedgerExtreme {
  sym: string
  date: string
  excessPct: number
  /** the engine's own sentence about what happened, when it wrote one */
  postMortem: string | null
}

const extremeOf = (p: JourneyCall, date: string): LedgerExtreme => ({
  sym: p.sym,
  date: p.date || date,
  excessPct: p.outcome10!.excessPct,
  postMortem: p.postMortem?.sentence ?? null,
})

/** The window's two ends, over the SAME population the line is drawn from —
 * a "worst call" that quietly included a crypto row would be measured on a
 * different basis from the chart directly above it. */
export function bestAndWorst(days: LedgerDay[]): { best: LedgerExtreme | null; worst: LedgerExtreme | null } {
  let best: LedgerExtreme | null = null
  let worst: LedgerExtreme | null = null
  for (const day of days) {
    for (const p of day.predictions ?? []) {
      if (isCryptoCohort(p)) continue
      const out = p.outcome10
      if (!out || typeof out.excessPct !== 'number' || !Number.isFinite(out.excessPct)) continue
      const row = extremeOf(p, day.date)
      if (!best || row.excessPct > best.excessPct) best = row
      if (!worst || row.excessPct < worst.excessPct) worst = row
    }
  }
  return { best, worst }
}
