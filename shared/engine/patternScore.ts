import type { Candle } from '../types'
import type { PatternHit, PatternKind } from '../patterns'

// The pattern scorecard: every badge the chart wall shows gets logged and
// graded like a call — side-adjusted excess vs SPY at +5 and +10 sessions
// from first sighting. Patterns stay display-only colour; this ledger exists
// so "do the shapes actually pay?" is answered by the reader's own universe,
// not by folklore. Same hit discipline as the engine: beat SPY by ≥1pp in the
// pattern's direction. If the numbers come back flat, the honest move is to
// delete the badges — that verdict is the whole point of accruing this.

export const PATTERN_HIT_PP = 1.0
const CAP = 1000 // bounded log — ~months of sightings at typical volume

export interface SightingOutcome {
  excessPct: number // direction-adjusted, vs SPY over the same window
  rawPct: number
  hit: boolean
}

export interface PatternSighting {
  id: string // `${firstSeen}:${sym}:${kind}:${status}`
  firstSeen: string // ISO date the badge first appeared in this status
  sym: string
  kind: PatternKind
  status: 'forming' | 'confirmed'
  direction: 'bullish' | 'bearish'
  level: number
  priceAt: number // close on firstSeen — outcomes measure from here
  outcome5?: SightingOutcome
  outcome10?: SightingOutcome
}

/** Fold today's detections into the log. Identity = sym+kind+status: a badge
 * visible five days running is ONE sighting, clocked from first sight; the
 * forming→confirmed transition is a NEW sighting (the break is its own
 * event). One live (not-yet-fully-graded) sighting per identity at a time. */
export function recordSightings(
  prev: PatternSighting[],
  today: { date: string; sym: string; price: number; hits: PatternHit[] }[],
): PatternSighting[] {
  const out = [...prev]
  const live = new Set(out.filter(s => !s.outcome10).map(s => `${s.sym}:${s.kind}:${s.status}`))
  for (const t of today) {
    if (!(t.price > 0)) continue
    for (const h of t.hits) {
      const key = `${t.sym}:${h.kind}:${h.status}`
      if (live.has(key)) continue
      live.add(key)
      out.push({
        id: `${t.date}:${key}`,
        firstSeen: t.date,
        sym: t.sym,
        kind: h.kind,
        status: h.status,
        direction: h.direction,
        level: h.level,
        priceAt: t.price,
      })
    }
  }
  return out.slice(-CAP)
}

const idxOnOrAfter = (candles: Candle[], dateISO: string): number => {
  const target = Date.parse(dateISO) / 1000
  return candles.findIndex(c => c.t >= target)
}

function outcomeFrom(
  candles: Candle[],
  spy: Candle[],
  firstSeen: string,
  priceAt: number,
  direction: 'bullish' | 'bearish',
  horizon: number,
): SightingOutcome | null {
  const i = idxOnOrAfter(candles, firstSeen)
  const si = idxOnOrAfter(spy, firstSeen)
  if (i < 0 || si < 0) return null
  if (i + horizon >= candles.length || si + horizon >= spy.length) return null // not matured yet
  const raw = ((candles[i + horizon].c - priceAt) / priceAt) * 100
  const spyPct = ((spy[si + horizon].c - spy[si].c) / spy[si].c) * 100
  const sign = direction === 'bullish' ? 1 : -1
  const excess = sign * (raw - spyPct)
  return { excessPct: Math.round(excess * 10) / 10, rawPct: Math.round(raw * 10) / 10, hit: excess >= PATTERN_HIT_PP }
}

/** Grade matured sightings (pure — returns a new array). A symbol whose
 * candles aren't in the map just waits for a day when they are. */
export function gradeSightings(sightings: PatternSighting[], candlesBySym: Map<string, Candle[]>, spy: Candle[]): PatternSighting[] {
  if (!spy.length) return sightings
  return sightings.map(s => {
    if (s.outcome5 && s.outcome10) return s
    const candles = candlesBySym.get(s.sym)
    if (!candles?.length) return s
    const next = { ...s }
    if (!next.outcome5) next.outcome5 = outcomeFrom(candles, spy, s.firstSeen, s.priceAt, s.direction, 5) ?? undefined
    if (!next.outcome10) next.outcome10 = outcomeFrom(candles, spy, s.firstSeen, s.priceAt, s.direction, 10) ?? undefined
    return next
  })
}

export interface PatternScoreRow {
  kind: PatternKind
  status: 'forming' | 'confirmed'
  n: number
  graded5: number
  hitRate5: number | null // 0..1
  avgExcess5: number | null
  graded10: number
  hitRate10: number | null
  avgExcess10: number | null
}

/** Per kind+status roll-up, biggest sample first. hitRate stays null until
 * something has actually graded — a thin card must read thin, not zero. */
export function patternScorecard(sightings: PatternSighting[]): PatternScoreRow[] {
  const by = new Map<string, PatternSighting[]>()
  for (const s of sightings) {
    const k = `${s.kind}:${s.status}`
    by.set(k, [...(by.get(k) ?? []), s])
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)
  return [...by.values()]
    .map(group => {
      const g5 = group.filter(s => s.outcome5)
      const g10 = group.filter(s => s.outcome10)
      return {
        kind: group[0].kind,
        status: group[0].status,
        n: group.length,
        graded5: g5.length,
        hitRate5: g5.length ? Math.round((g5.filter(s => s.outcome5!.hit).length / g5.length) * 100) / 100 : null,
        avgExcess5: avg(g5.map(s => s.outcome5!.excessPct)),
        graded10: g10.length,
        hitRate10: g10.length ? Math.round((g10.filter(s => s.outcome10!.hit).length / g10.length) * 100) / 100 : null,
        avgExcess10: avg(g10.map(s => s.outcome10!.excessPct)),
      }
    })
    .sort((a, b) => b.n - a.n)
}
