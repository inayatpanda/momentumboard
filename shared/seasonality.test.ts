import { describe, it, expect } from 'vitest'
import { dayOfWeekStats, monthlyStats, seasonalitySummary } from './seasonality'
import type { Candle } from './types'

// Build weekday candles (Mon-Fri) for n weeks where Fridays always fall 1%, other days rise 0.5%
function weekdaySeries(weeks: number): Candle[] {
  const out: Candle[] = []
  let price = 100
  let t = Date.UTC(2024, 0, 1) / 1000 // Mon 1 Jan 2024
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 5; d++) {
      const day = new Date(t * 1000).getUTCDay()
      price *= day === 5 ? 0.99 : 1.005
      out.push({ t, o: price, h: price, l: price, c: price, v: 1000 })
      t += 86_400
    }
    t += 2 * 86_400 // skip weekend
  }
  return out
}

describe('dayOfWeekStats', () => {
  it('detects the engineered Friday selloff', () => {
    const stats = dayOfWeekStats(weekdaySeries(60))
    const friday = stats.find(s => s.name === 'Fri')!
    const tuesday = stats.find(s => s.name === 'Tue')!
    expect(friday.avgPct).toBeCloseTo(-1, 3)
    expect(friday.winRate).toBe(0)
    expect(tuesday.avgPct).toBeCloseTo(0.5, 3)
  })
})

describe('monthlyStats', () => {
  it('buckets month-over-month returns by calendar month', () => {
    // two years of synthetic months: January always +10%, others flat
    const candles: Candle[] = []
    let price = 100
    for (let y = 2022; y <= 2024; y++) {
      for (let m = 0; m < 12; m++) {
        price *= m === 0 ? 1.1 : 1
        candles.push({ t: Date.UTC(y, m, 25) / 1000, o: price, h: price, l: price, c: price, v: 1 })
      }
    }
    const jan = monthlyStats(candles).find(s => s.name === 'Jan')!
    const jun = monthlyStats(candles).find(s => s.name === 'Jun')!
    expect(jan.avgPct).toBeCloseTo(10, 5)
    expect(jun.avgPct).toBeCloseTo(0, 5)
  })
})

describe('seasonalitySummary', () => {
  it('flags short histories as unreliable and finds extremes', () => {
    const s = seasonalitySummary(weekdaySeries(60))
    expect(s.reliable).toBe(false) // 300 bars < 500
    expect(s.weakestDay!.name).toBe('Fri')
    expect(seasonalitySummary(weekdaySeries(120)).reliable).toBe(true)
  })
})
