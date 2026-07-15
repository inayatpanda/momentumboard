import { describe, expect, it } from 'vitest'
import { recordSightings, gradeSightings, patternScorecard, type PatternSighting } from './patternScore'
import type { PatternHit } from '../patterns'
import type { Candle } from '../types'

const DAY = 86_400
const T0 = Date.parse('2026-07-01') / 1000
const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: T0 + i * DAY, o: c, h: c, l: c, c, v: 1 }))
const iso = (daysFromT0: number) => new Date((T0 + daysFromT0 * DAY) * 1000).toISOString().slice(0, 10)

const hit = (kind: PatternHit['kind'], status: PatternHit['status'], direction: PatternHit['direction']): PatternHit => ({
  kind,
  status,
  direction,
  label: kind,
  level: 100,
  pivots: [],
})

describe('recordSightings', () => {
  it('books a sighting once — the same badge tomorrow is the same sighting', () => {
    const day1 = recordSightings([], [{ date: iso(0), sym: 'NNE', price: 18, hits: [hit('double-top', 'forming', 'bearish')] }])
    expect(day1).toHaveLength(1)
    const day2 = recordSightings(day1, [{ date: iso(1), sym: 'NNE', price: 17.5, hits: [hit('double-top', 'forming', 'bearish')] }])
    expect(day2).toHaveLength(1)
    expect(day2[0].firstSeen).toBe(iso(0)) // clock starts at FIRST sight
  })

  it('forming → confirmed is a NEW sighting: the break is its own event', () => {
    const day1 = recordSightings([], [{ date: iso(0), sym: 'NNE', price: 18, hits: [hit('double-top', 'forming', 'bearish')] }])
    const day2 = recordSightings(day1, [{ date: iso(3), sym: 'NNE', price: 16, hits: [hit('double-top', 'confirmed', 'bearish')] }])
    expect(day2).toHaveLength(2)
    expect(day2.map(s => s.status).sort()).toEqual(['confirmed', 'forming'])
  })
})

describe('gradeSightings + patternScorecard', () => {
  it('grades direction-adjusted excess vs SPY at both horizons', () => {
    // bearish sighting at 100; stock falls to 90 by +5 (raw −10%), SPY flat →
    // direction-adjusted excess +10pp = a hit
    const sighting: PatternSighting = {
      id: 'x',
      firstSeen: iso(0),
      sym: 'NNE',
      kind: 'double-top',
      status: 'confirmed',
      direction: 'bearish',
      level: 100,
      priceAt: 100,
    }
    const stock = mk([100, 98, 96, 94, 92, 90, 89, 88, 87, 86, 85, 84])
    const spy = mk(Array(12).fill(500))
    const graded = gradeSightings([sighting], new Map([['NNE', stock]]), spy)
    expect(graded[0].outcome5).toMatchObject({ excessPct: 10, hit: true })
    expect(graded[0].outcome10).toMatchObject({ excessPct: 15, hit: true })

    const rows = patternScorecard(graded)
    expect(rows[0]).toMatchObject({ kind: 'double-top', status: 'confirmed', n: 1, graded5: 1, hitRate5: 1 })
  })

  it('not-yet-matured sightings wait; thin groups read null, not zero', () => {
    const sighting: PatternSighting = {
      id: 'y',
      firstSeen: iso(0),
      sym: 'MX',
      kind: 'asc-triangle',
      status: 'forming',
      direction: 'bullish',
      level: 4,
      priceAt: 4,
    }
    const graded = gradeSightings([sighting], new Map([['MX', mk([4, 4.1, 4.2])]]), mk([500, 501, 502]))
    expect(graded[0].outcome5).toBeUndefined()
    const rows = patternScorecard(graded)
    expect(rows[0].hitRate5).toBeNull()
    expect(rows[0].n).toBe(1)
  })

  it('a bullish sighting that lags SPY grades as a miss', () => {
    const sighting: PatternSighting = {
      id: 'z',
      firstSeen: iso(0),
      sym: 'UP',
      kind: 'range-break',
      status: 'confirmed',
      direction: 'bullish',
      level: 100,
      priceAt: 100,
    }
    const stock = mk([100, 100.5, 101, 101, 101, 101]) // +1% raw
    const spy = mk([500, 510, 515, 520, 525, 530]) // +6% — the tide, not the swimmer
    const graded = gradeSightings([sighting], new Map([['UP', stock]]), spy)
    expect(graded[0].outcome5!.hit).toBe(false)
    expect(graded[0].outcome5!.excessPct).toBeLessThan(0)
  })
})
