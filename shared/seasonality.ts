import type { Candle } from './types'

// Seasonality from raw history: day-of-week and calendar-month tendencies.
// These edges are small and honesty-gated: below minN, say "insufficient".

export interface DowStat {
  day: number // 0=Sun..6=Sat (UTC)
  name: string
  n: number
  winRate: number | null
  avgPct: number | null
}

export interface MonthStat {
  month: number // 1..12
  name: string
  n: number
  winRate: number | null
  avgPct: number | null
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const winRate = (xs: number[]) => (xs.length ? xs.filter(x => x > 0).length / xs.length : null)

/** Close-to-close daily returns bucketed by the weekday of the CLOSE. */
export function dayOfWeekStats(candles: Candle[]): DowStat[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => [])
  for (let i = 1; i < candles.length; i++) {
    const ret = ((candles[i].c - candles[i - 1].c) / candles[i - 1].c) * 100
    buckets[new Date(candles[i].t * 1000).getUTCDay()].push(ret)
  }
  return buckets
    .map((xs, day) => ({ day, name: DAYS[day], n: xs.length, winRate: winRate(xs), avgPct: mean(xs) }))
    .filter(s => s.n > 0)
}

/** Calendar-month returns: last close of each month vs the prior month's last close. */
export function monthlyStats(candles: Candle[]): MonthStat[] {
  const lastCloseByMonth = new Map<string, number>() // 'YYYY-MM' → close
  for (const c of candles) {
    lastCloseByMonth.set(new Date(c.t * 1000).toISOString().slice(0, 7), c.c) // candles are chronological
  }
  const keys = [...lastCloseByMonth.keys()].sort()
  const buckets: number[][] = Array.from({ length: 12 }, () => [])
  for (let i = 1; i < keys.length; i++) {
    const prev = lastCloseByMonth.get(keys[i - 1])!
    const cur = lastCloseByMonth.get(keys[i])!
    const month = Number(keys[i].slice(5, 7)) - 1
    buckets[month].push(((cur - prev) / prev) * 100)
  }
  return buckets.map((xs, m) => ({ month: m + 1, name: MONTHS[m], n: xs.length, winRate: winRate(xs), avgPct: mean(xs) }))
}

export interface SeasonalitySummary {
  dow: DowStat[]
  months: MonthStat[]
  bestMonth: MonthStat | null
  worstMonth: MonthStat | null
  weakestDay: DowStat | null
  strongestDay: DowStat | null
  reliable: boolean // enough history to take any of it seriously
}

export function seasonalitySummary(candles: Candle[]): SeasonalitySummary {
  const dow = dayOfWeekStats(candles)
  const months = monthlyStats(candles).filter(m => m.n > 0)
  const byAvg = <T extends { avgPct: number | null }>(xs: T[]) => xs.filter(x => x.avgPct != null).sort((a, b) => a.avgPct! - b.avgPct!)
  const mSorted = byAvg(months)
  const dSorted = byAvg(dow)
  return {
    dow,
    months,
    bestMonth: mSorted[mSorted.length - 1] ?? null,
    worstMonth: mSorted[0] ?? null,
    strongestDay: dSorted[dSorted.length - 1] ?? null,
    weakestDay: dSorted[0] ?? null,
    reliable: candles.length >= 500, // ~2 years of trading days minimum
  }
}
