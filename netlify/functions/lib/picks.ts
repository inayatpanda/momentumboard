// Daily report-pick tracking. Persistence maths is deterministic on purpose:
// a ticker surviving several INDEPENDENT morning analyses is a stronger signal
// than one day's conviction — and the thresholds must apply identically daily.

export interface Pick {
  ticker: string
  side: 'long' | 'short'
  playbook?: string
  conviction?: string
  strength?: 'strong' | 'standard' // 'strong' = multi-factor "I strongly suggest" call — scored separately
  reasons?: string[] // the WHY behind the call, mandatory for strong calls
  priceAtPick?: number // captured server-side when the pick is stored — outcome scoring baseline
  // The PUBLISHED levels, carried so the scorecard can tell a call that was
  // stopped out from one that merely ended lower. Absent when the composer
  // wrote them qualitatively ("reclaim of the 20-day"), which is legitimate.
  entry?: number
  stop?: number
  target?: number
}

export interface DailyPicks {
  date: string // YYYY-MM-DD; one entry per report
  at?: number // unix sec the day was STORED. Set server-side (validatePicks strips
  // unknown fields, so it is stamped after validation like priceAtPick). Without it
  // the Helm export had to date a pick day from `date` alone, and an incremental
  // mirror whose watermark had already passed midnight never saw it again.
  regime?: string
  macro?: { fedStance?: string; notes?: string[] } // structured macro read, archived daily
  picks: Pick[]
}

export interface Persistence {
  ticker: string
  side: 'long' | 'short'
  appearances: number // in the last 7 reports
  streak: number // consecutive most-recent reports
  latestConviction?: string
  persistent: boolean // streak ≥3 OR ≥4 of last 7
}

const num = (field: 'entry' | 'stop' | 'target', v: unknown): Record<string, number> =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? { [field]: v } : {}

export function validatePicks(raw: unknown): DailyPicks | null {
  const d = raw as DailyPicks
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date ?? '') || !Array.isArray(d.picks)) return null
  const picks = d.picks
    .filter(p => typeof p?.ticker === 'string' && (p.side === 'long' || p.side === 'short'))
    .slice(0, 8)
    .map(p => ({
      ticker: p.ticker.toUpperCase().slice(0, 12),
      side: p.side,
      playbook: p.playbook,
      conviction: p.conviction,
      strength: p.strength === 'strong' ? ('strong' as const) : undefined,
      reasons: Array.isArray(p.reasons) ? p.reasons.filter(r => typeof r === 'string').slice(0, 6).map(r => r.slice(0, 220)) : undefined,
      // published levels ride along when numeric, so the scorecard can tell a
      // stop-out from a call that merely drifted; qualitative levels are dropped
      ...num('entry', p.entry),
      ...num('stop', p.stop),
      ...num('target', p.target),
    }))
  const macro =
    d.macro && typeof d.macro === 'object'
      ? {
          fedStance: typeof d.macro.fedStance === 'string' ? d.macro.fedStance.slice(0, 40) : undefined,
          notes: Array.isArray(d.macro.notes) ? d.macro.notes.filter(n => typeof n === 'string').slice(0, 5).map(n => n.slice(0, 220)) : undefined,
        }
      : undefined
  return { date: d.date, regime: typeof d.regime === 'string' ? d.regime : undefined, macro, picks }
}

export function computePersistence(history: DailyPicks[]): Persistence[] {
  const recent = [...history].sort((a, b) => a.date.localeCompare(b.date)).slice(-7)
  if (!recent.length) return []
  const key = (p: Pick) => `${p.ticker}|${p.side}`
  const all = new Map<string, Persistence>()

  for (const day of recent) {
    for (const p of day.picks) {
      const k = key(p)
      const cur = all.get(k) ?? { ticker: p.ticker, side: p.side, appearances: 0, streak: 0, persistent: false }
      cur.appearances++
      cur.latestConviction = p.conviction ?? cur.latestConviction
      all.set(k, cur)
    }
  }
  // streak: walk back from the most recent report
  for (const cur of all.values()) {
    let streak = 0
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].picks.some(p => p.ticker === cur.ticker && p.side === cur.side)) streak++
      else break
    }
    cur.streak = streak
    cur.persistent = streak >= 3 || cur.appearances >= 4
  }
  return [...all.values()].sort((a, b) => b.streak - a.streak || b.appearances - a.appearances)
}

import type { Candle } from '../../../shared/types'

export interface PickScore {
  bucket: string // 'ALL' | conviction grade | playbook
  n: number
  scored: number
  win5: number | null
  avg5: number | null
  withStop: number // how many scored calls carried a stop at all
  stopped5: number | null // share of THOSE whose stop was traded through inside 5 bars; null when none carried one
  scored10: number // how many calls were old enough for a 10-day move — NOT the same set as `scored`
  avg10: number | null
}

/** Scores the REPORT itself: what did price do after each recommendation?
 * Shorts are scored inverted (price falling = the call working). */
export function scorePicks(history: DailyPicks[], candlesBySymbol: Map<string, Candle[]>): PickScore[] {
  const buckets = new Map<string, { f5: number[]; f10: number[]; total: number; withStop: number; stopped: number }>()
  const add = (bucket: string, f5: number | null, f10: number | null, stopped: boolean | null) => {
    const b = buckets.get(bucket) ?? { f5: [], f10: [], total: 0, withStop: 0, stopped: 0 }
    b.total++
    if (f5 != null) b.f5.push(f5)
    if (f10 != null) b.f10.push(f10)
    if (stopped != null) {
      b.withStop++
      if (stopped) b.stopped++
    }
    buckets.set(bucket, b)
  }
  for (const day of history) {
    const dayEpoch = Date.parse(day.date) / 1000
    for (const p of day.picks) {
      if (p.priceAtPick == null) continue
      const candles = candlesBySymbol.get(p.ticker)
      let f5: number | null = null
      let f10: number | null = null
      // hoisted: the stop-out check below needs the entry bar too
      let idx = candles ? candles.findIndex(c => c.t >= dayEpoch) : -1
      if (candles && idx === -1) idx = candles.length
      if (candles) {
        const sign = p.side === 'short' ? -1 : 1
        // priceAtPick is captured pre-open, so it is the PREVIOUS session's close —
        // a price no reader could transact at. Score from the first achievable fill
        // instead: the open of the first bar on/after the call, which is when you
        // could act on a 06:35 paper. Measured over the first 26 live calls, the
        // stale basis flattered the average 5-day move by +1.7pp (worse on 13/20).
        // `||` not `??`: a zero open is not a price.
        const basis = candles[idx]?.o || p.priceAtPick
        if (idx + 5 < candles.length) f5 = (sign * (candles[idx + 5].c - basis) * 100) / basis
        if (idx + 10 < candles.length) f10 = (sign * (candles[idx + 10].c - basis) * 100) / basis
      }
      // Did price trade THROUGH the stop inside the window? Uses the bar's low
      // (long) or high (short), not its close: a call that collapsed on day two
      // and limped back is a loss you already took, not a winner.
      let stopped: boolean | null = null
      if (p.stop != null && candles && idx < candles.length) {
        const window = candles.slice(idx, idx + 6) // entry bar + 5 forward
        stopped = p.side === 'short' ? window.some(c => c.h >= p.stop!) : window.some(c => c.l <= p.stop!)
      }
      add('ALL', f5, f10, stopped)
      if (p.strength === 'strong') add('STRONG calls', f5, f10, stopped)
      if (p.conviction) add(`grade ${p.conviction}`, f5, f10, stopped)
      if (p.playbook) add(`playbook ${p.playbook}`, f5, f10, stopped)
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
  return [...buckets.entries()]
    .map(([bucket, b]) => ({
      bucket,
      n: b.total,
      scored: b.f5.length,
      win5: b.f5.length ? b.f5.filter(x => x > 0).length / b.f5.length : null,
      avg5: mean(b.f5),
      // avg10 is averaged over a DIFFERENT, smaller set than avg5 — only calls old
      // enough to have ten bars. Publishing `scored` alone made 6 calls' +0.6% read
      // as a recovery from 20 calls' −1.7%; the same six were flat across horizons.
      withStop: b.withStop,
      stopped5: b.withStop ? b.stopped / b.withStop : null,
      scored10: b.f10.length,
      avg10: mean(b.f10),
    }))
    .sort((a, b) => (a.bucket === 'ALL' ? -1 : b.bucket === 'ALL' ? 1 : b.n - a.n))
}

export interface DayOutcome {
  date: string
  regime?: string
  picks: { ticker: string; side: 'long' | 'short'; strength?: string; conviction?: string; priceAtPick?: number; f5: number | null; f10: number | null }[]
}

/** Per-date research record: each report's picks joined with what price did after. */
export function perDayOutcomes(history: DailyPicks[], candlesBySymbol: Map<string, Candle[]>): DayOutcome[] {
  return [...history]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(day => {
      const dayEpoch = Date.parse(day.date) / 1000
      return {
        date: day.date,
        regime: day.regime,
        picks: day.picks.map(p => {
          let f5: number | null = null
          let f10: number | null = null
          const candles = p.priceAtPick != null ? candlesBySymbol.get(p.ticker) : undefined
          if (candles && p.priceAtPick != null) {
            let idx = candles.findIndex(c => c.t >= dayEpoch)
            if (idx === -1) idx = candles.length
            const sign = p.side === 'short' ? -1 : 1
            if (idx + 5 < candles.length) f5 = (sign * (candles[idx + 5].c - p.priceAtPick) * 100) / p.priceAtPick
            if (idx + 10 < candles.length) f10 = (sign * (candles[idx + 10].c - p.priceAtPick) * 100) / p.priceAtPick
          }
          return { ticker: p.ticker, side: p.side, strength: p.strength, conviction: p.conviction, priceAtPick: p.priceAtPick, f5, f10 }
        }),
      }
    })
}

/** Tickers that became persistent BECAUSE of the latest report — ping-worthy. */
export function newlyPersistent(history: DailyPicks[]): Persistence[] {
  const now = computePersistence(history).filter(p => p.persistent)
  const beforeKeys = new Set(
    computePersistence(history.slice(0, -1))
      .filter(p => p.persistent)
      .map(p => `${p.ticker}|${p.side}`),
  )
  return now.filter(p => !beforeKeys.has(`${p.ticker}|${p.side}`))
}
