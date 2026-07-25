import { describe, it, expect } from 'vitest'
import { computePersistence, newlyPersistent, validatePicks, scorePicks, type DailyPicks } from './picks'
import type { Candle } from '../../../shared/types'

const day = (date: string, tickers: string[], side: 'long' | 'short' = 'long'): DailyPicks => ({
  date,
  picks: tickers.map(t => ({ ticker: t, side, conviction: 'B' })),
})

describe('computePersistence', () => {
  it('tracks streaks and appearances over the last 7 reports', () => {
    const history = [
      day('2026-07-01', ['NVDA', 'AAPL']),
      day('2026-07-02', ['NVDA']),
      day('2026-07-03', ['NVDA', 'TSLA']),
    ]
    const p = computePersistence(history)
    const nvda = p.find(x => x.ticker === 'NVDA')!
    expect(nvda.streak).toBe(3)
    expect(nvda.appearances).toBe(3)
    expect(nvda.persistent).toBe(true) // 3-day streak
    expect(p.find(x => x.ticker === 'AAPL')!.streak).toBe(0) // broken streak
    expect(p.find(x => x.ticker === 'TSLA')!.persistent).toBe(false)
  })

  it('treats long and short as separate tracks and flags 4-of-7 without a streak', () => {
    const history = [
      day('01', ['X']), day('02', ['Y']), day('03', ['X']), day('04', ['Y']),
      day('05', ['X']), day('06', ['Y']), day('07', ['X']),
    ].map((d, i) => ({ ...d, date: `2026-07-0${i + 1}` }))
    const x = computePersistence(history).find(p => p.ticker === 'X')!
    expect(x.appearances).toBe(4)
    expect(x.persistent).toBe(true) // 4 of 7 despite alternating
    const shortSide = computePersistence([...history, day('2026-07-08', ['X'], 'short')])
    expect(shortSide.find(p => p.ticker === 'X' && p.side === 'short')!.appearances).toBe(1)
  })
})

describe('newlyPersistent', () => {
  it('fires only when the latest report crosses the threshold', () => {
    const h2 = [day('2026-07-01', ['NVDA']), day('2026-07-02', ['NVDA'])]
    expect(newlyPersistent(h2)).toHaveLength(0)
    const h3 = [...h2, day('2026-07-03', ['NVDA'])]
    expect(newlyPersistent(h3).map(p => p.ticker)).toEqual(['NVDA'])
    const h4 = [...h3, day('2026-07-04', ['NVDA'])]
    expect(newlyPersistent(h4)).toHaveLength(0) // already persistent yesterday
  })
})

describe('scorePicks', () => {
  const DAY = 86_400
  const base = Date.parse('2026-06-01') / 1000
  const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({ t: base + i * DAY, o: 100, h: 101, l: 99, c: 100 + i, v: 1000 }))

  it('scores longs on rises and shorts inverted', () => {
    const history: DailyPicks[] = [
      { date: '2026-06-01', picks: [
        { ticker: 'UP', side: 'long', conviction: 'A', priceAtPick: 100 },
        { ticker: 'UP', side: 'short', conviction: 'C', priceAtPick: 100 },
      ] },
    ]
    const scores = scorePicks(history, new Map([['UP', candles]]))
    const all = scores.find(s => s.bucket === 'ALL')!
    expect(all.n).toBe(2)
    expect(all.scored).toBe(2)
    expect(all.win5).toBe(0.5) // the long won (+5%), the short lost (−5%)
    const gradeA = scores.find(s => s.bucket === 'grade A')!
    expect(gradeA.avg5).toBeCloseTo(5, 4)
    expect(scores.find(s => s.bucket === 'grade C')!.avg5).toBeCloseTo(-5, 4)
  })

  it('counts unscoreable picks (no price or too recent) without failing', () => {
    const history: DailyPicks[] = [{ date: '2026-06-18', picks: [{ ticker: 'UP', side: 'long', priceAtPick: 117 }] }]
    const all = scorePicks(history, new Map([['UP', candles]])).find(s => s.bucket === 'ALL')!
    expect(all.n).toBe(1)
    expect(all.scored).toBe(0)
  })
})

describe('validatePicks', () => {
  it('normalizes and rejects junk', () => {
    const v = validatePicks({ date: '2026-07-03', regime: 'amber', picks: [{ ticker: 'nvda', side: 'long' }, { ticker: 5, side: 'up' }] })!
    expect(v.picks).toEqual([{ ticker: 'NVDA', side: 'long', playbook: undefined, conviction: undefined }])
    expect(validatePicks({ date: 'yesterday', picks: [] })).toBeNull()
  })
})

// Reviewing the first 26 live calls (2026-07-25) surfaced two ways the scorecard
// flattered itself. Both are about HONESTY of the number, not the maths.
describe('scorePicks reports an honest number', () => {
  const DAY = 86_400
  const base = Date.parse('2026-06-01') / 1000
  // priceAtPick is captured pre-open, so it is the PREVIOUS session's close: the
  // paper says "entry 100" but the market opens at 110 and you can never get 100.
  const gapped: Candle[] = Array.from({ length: 20 }, (_, i) => ({ t: base + i * DAY, o: 110, h: 112, l: 108, c: 110, v: 1000 }))

  it('scores from a price you could actually pay, not the stale quote', () => {
    const history: DailyPicks[] = [{ date: '2026-06-01', picks: [{ ticker: 'GAP', side: 'long', priceAtPick: 100 }] }]
    const all = scorePicks(history, new Map([['GAP', gapped]])).find(s => s.bucket === 'ALL')!
    expect(all.avg5).toBeCloseTo(0, 4) // opened 110, still 110 → flat. From the stale 100 it would read +10%.
  })

  it('reports the 10-day sample size separately from the 5-day one', () => {
    // 8 bars: enough for a 5-day forward move, not for a 10-day one.
    const short: Candle[] = Array.from({ length: 8 }, (_, i) => ({ t: base + i * DAY, o: 100, h: 101, l: 99, c: 100 + i, v: 1000 }))
    const history: DailyPicks[] = [{ date: '2026-06-01', picks: [{ ticker: 'YOUNG', side: 'long', priceAtPick: 100 }] }]
    const all = scorePicks(history, new Map([['YOUNG', short]])).find(s => s.bucket === 'ALL')!
    expect(all.scored).toBe(1)
    expect(all.scored10).toBe(0) // avg10 is null and its sample is VISIBLY zero
    expect(all.avg10).toBeNull()
  })
})
