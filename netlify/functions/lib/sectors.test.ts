import { describe, it, expect } from 'vitest'
import { computeSectorRows, returnOver } from './sectors'
import type { Candle } from '../../../shared/types'

const series = (dailyPct: number, n = 80): Candle[] => {
  let p = 100
  return Array.from({ length: n }, (_, i) => {
    p *= 1 + dailyPct / 100
    return { t: i * 86_400, o: p, h: p, l: p, c: p, v: 1 }
  })
}

describe('returnOver', () => {
  it('computes trailing window returns', () => {
    expect(returnOver(series(1), 5)).toBeCloseTo((1.01 ** 5 - 1) * 100, 4)
    expect(returnOver(series(1, 3), 5)).toBeNull()
  })
})

describe('computeSectorRows', () => {
  it('ranks by 1-month relative strength and detects rotation direction', () => {
    const spy = series(0.1)
    const candles = new Map<string, Candle[]>([
      ['XLK', series(0.3)], // strong vs SPY
      ['XLE', series(-0.2)], // weak vs SPY
    ])
    const rows = computeSectorRows(candles, spy)
    expect(rows[0].sym).toBe('XLK')
    expect(rows[0].rs21).toBeGreaterThan(0)
    expect(rows[1].sym).toBe('XLE')
    expect(rows[1].rs21).toBeLessThan(0)
    // constant-rate series: rs5 ≈ rs21/4 → flat rotation
    expect(rows[0].trend).toBe('flat')
  })
})
