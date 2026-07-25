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
  avg10: number | null
}

/** Scores the REPORT itself: what did price do after each recommendation?
 * Shorts are scored inverted (price falling = the call working). */
export function scorePicks(history: DailyPicks[], candlesBySymbol: Map<string, Candle[]>): PickScore[] {
  const buckets = new Map<string, { f5: number[]; f10: number[]; total: number }>()
  const add = (bucket: string, f5: number | null, f10: number | null) => {
    const b = buckets.get(bucket) ?? { f5: [], f10: [], total: 0 }
    b.total++
    if (f5 != null) b.f5.push(f5)
    if (f10 != null) b.f10.push(f10)
    buckets.set(bucket, b)
  }
  for (const day of history) {
    const dayEpoch = Date.parse(day.date) / 1000
    for (const p of day.picks) {
      if (p.priceAtPick == null) continue
      const candles = candlesBySymbol.get(p.ticker)
      let f5: number | null = null
      let f10: number | null = null
      if (candles) {
        let idx = candles.findIndex(c => c.t >= dayEpoch)
        if (idx === -1) idx = candles.length
        const sign = p.side === 'short' ? -1 : 1
        if (idx + 5 < candles.length) f5 = (sign * (candles[idx + 5].c - p.priceAtPick) * 100) / p.priceAtPick
        if (idx + 10 < candles.length) f10 = (sign * (candles[idx + 10].c - p.priceAtPick) * 100) / p.priceAtPick
      }
      add('ALL', f5, f10)
      if (p.strength === 'strong') add('STRONG calls', f5, f10)
      if (p.conviction) add(`grade ${p.conviction}`, f5, f10)
      if (p.playbook) add(`playbook ${p.playbook}`, f5, f10)
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
