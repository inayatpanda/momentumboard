import { describe, it, expect } from 'vitest'
import { scoreSignals } from './signalStats'
import type { Candle } from '../../../shared/types'

const DAY = 86_400
const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({ t: i * DAY, o: 100, h: 101, l: 99, c: 100 + i, v: 1000 }))

describe('scoreSignals', () => {
  it('scores forward returns from the signal bar', () => {
    // signal fired during day 10 (t between bar 10 and 11): entry bar 10 (close 110)
    const log = [{ symbol: 'X', setup: 'reclaim' as const, price: 110, at: 10 * DAY + 3600 }]
    const [row] = scoreSignals(log, new Map([['X', candles]]))
    expect(row.n).toBe(1)
    expect(row.scored).toBe(1)
    expect(row.avg5).toBeCloseTo(((115 - 110) / 110) * 100, 5)
    expect(row.win5).toBe(1)
  })
  it('counts unscoreable signals without failing', () => {
    const log = [{ symbol: 'Y', setup: 'basing' as const, price: 50, at: 29 * DAY }]
    const [row] = scoreSignals(log, new Map([['Y', candles]]))
    expect(row.n).toBe(1)
    expect(row.scored).toBe(0)
    expect(row.win5).toBeNull()
  })
})
