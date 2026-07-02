import type { Candle } from '../types'

// The engine's own hunting ground: names with demonstrated capacity to move,
// auto-curated daily. Small caps get reserved slots — that's where the best
// returns (and worst fills) live. Every join and drop carries its reason.

export interface RosterEntry {
  sym: string
  joined: string
  source: string
  capUsdM: number | null
  lastCapacity: number | null
  lastQualified: string
}

export interface RosterCandidate {
  sym: string
  source: string
  capUsdM: number | null
  capacityPct: number | null
  dollarVol20d: number | null
  price: number | null
}

export const ROSTER_MAX = 80
const JOIN_CAPACITY = 8 // must have shown it can travel
const STAY_CAPACITY = 6
const MIN_DOLLAR_VOL = 5e6
const MIN_PRICE = 1
const QUIET_DAYS = 21 // ~15 trading sessions
const SMALL_CAP_USDM = 2000

export function avgDollarVol20(candles: Candle[]): number | null {
  if (candles.length < 20) return null
  const last20 = candles.slice(-20)
  return last20.reduce((s, c) => s + c.c * c.v, 0) / 20
}

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000

export function updateRoster(
  current: RosterEntry[],
  candidates: RosterCandidate[],
  watchlist: string[],
  today: string,
): { roster: RosterEntry[]; joined: string[]; dropped: { sym: string; why: string }[] } {
  const bySym = new Map(current.map(e => [e.sym, { ...e }]))
  const watch = new Set(watchlist)
  const joined: string[] = []
  const dropped: { sym: string; why: string }[] = []

  const qualifies = (c: RosterCandidate) =>
    c.capacityPct != null && c.capacityPct >= JOIN_CAPACITY &&
    c.dollarVol20d != null && c.dollarVol20d >= MIN_DOLLAR_VOL &&
    c.price != null && c.price >= MIN_PRICE

  for (const c of candidates) {
    const existing = bySym.get(c.sym)
    if (existing) {
      if (c.capUsdM != null) existing.capUsdM = c.capUsdM
      existing.lastCapacity = c.capacityPct
      if (c.capacityPct != null && c.capacityPct >= STAY_CAPACITY) existing.lastQualified = today
      if (!watch.has(c.sym) && c.dollarVol20d != null && c.dollarVol20d < MIN_DOLLAR_VOL) {
        bySym.delete(c.sym)
        dropped.push({ sym: c.sym, why: 'illiquid' })
      }
    } else if (qualifies(c)) {
      bySym.set(c.sym, { sym: c.sym, joined: today, source: c.source, capUsdM: c.capUsdM, lastCapacity: c.capacityPct, lastQualified: today })
      joined.push(c.sym)
    }
  }

  // watchlist rides along unconditionally
  for (const sym of watchlist) {
    if (!bySym.has(sym)) bySym.set(sym, { sym, joined: today, source: 'watchlist', capUsdM: null, lastCapacity: null, lastQualified: today })
  }

  // decay: names that stopped moving get cut — the roster is for movers
  for (const e of [...bySym.values()]) {
    if (watch.has(e.sym)) continue
    if (daysBetween(e.lastQualified, today) > QUIET_DAYS) {
      bySym.delete(e.sym)
      dropped.push({ sym: e.sym, why: 'went quiet' })
    }
  }

  // trim to cap: shed the largest caps first — they're covered by everyone
  // anyway — so the small-cap quota survives naturally
  let roster = [...bySym.values()]
  if (roster.length > ROSTER_MAX) {
    const cuttable = roster
      .filter(e => !watch.has(e.sym))
      .sort((a, b) => (b.capUsdM ?? 0) - (a.capUsdM ?? 0)) // largest first
    for (const cut of cuttable) {
      if (roster.length <= ROSTER_MAX) break
      const isSmall = cut.capUsdM != null && cut.capUsdM < SMALL_CAP_USDM
      const smallCount = roster.filter(e => e.capUsdM != null && e.capUsdM < SMALL_CAP_USDM).length
      if (isSmall && smallCount <= Math.ceil(ROSTER_MAX / 3)) continue // quota floor
      roster = roster.filter(e => e.sym !== cut.sym)
      dropped.push({ sym: cut.sym, why: 'roster full — larger caps shed first' })
    }
  }

  return { roster: roster.sort((a, b) => (b.lastCapacity ?? 0) - (a.lastCapacity ?? 0)), joined, dropped }
}
