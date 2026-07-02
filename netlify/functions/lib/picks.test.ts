import { describe, it, expect } from 'vitest'
import { computePersistence, newlyPersistent, validatePicks, type DailyPicks } from './picks'

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

describe('validatePicks', () => {
  it('normalizes and rejects junk', () => {
    const v = validatePicks({ date: '2026-07-03', regime: 'amber', picks: [{ ticker: 'nvda', side: 'long' }, { ticker: 5, side: 'up' }] })!
    expect(v.picks).toEqual([{ ticker: 'NVDA', side: 'long', playbook: undefined, conviction: undefined }])
    expect(validatePicks({ date: 'yesterday', picks: [] })).toBeNull()
  })
})
