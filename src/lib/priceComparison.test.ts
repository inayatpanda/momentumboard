import { describe, expect, it } from 'vitest'
import { compareDailyPrices } from './priceComparison'
import type { Candle } from '../../shared/types'
const bar = (day: number, c: number): Candle => ({ t: Date.UTC(2025, 0, day, 15) / 1000, c, o:c, h:c, l:c, v:1 })
const input = (symbol: string, candles: Candle[]) => ({ symbol, label:symbol, candles })
describe('same-date price comparisons', () => {
  it('rebases all lines to the first shared date, not each series’ own start', () => {
    const result = compareDailyPrices([input('A', [bar(1, 10),bar(2, 100),bar(3,110)]), input('SPY',[bar(2,200),bar(3,210),bar(4,220)])])!
    expect(result.dates).toEqual(['2025-01-02','2025-01-03'])
    expect(result.series[0].values[1]).toBeCloseTo(10)
    expect(result.series[1].values[1]).toBeCloseTo(5)
    expect(result.series.every(s => s.values[0] === 0)).toBe(true)
  })
  it('does not interpolate gaps, accept zero prices, or include future bars', () => {
    const result = compareDailyPrices([input('A',[bar(1,100),bar(2,0),bar(3,120),bar(4,900)]),input('SPY',[bar(1,100),bar(2,110),bar(3,115),bar(4,120)])],bar(3,1).t)!
    expect(result.dates).toEqual(['2025-01-01','2025-01-03'])
  })
  it('needs at least two matching dates across every selected line', () => {
    expect(compareDailyPrices([input('A',[bar(1,100),bar(2,110)]),input('X',[bar(2,100),bar(3,110)])])).toBeNull()
    expect(compareDailyPrices([])).toBeNull()
  })
  it('orders observations and takes the last observed price for duplicate dates', () => {
    const result = compareDailyPrices([input('A',[bar(2,110),bar(1,100),{...bar(2,120),t:bar(2,1).t+100}])])!
    expect(result.series[0].values[1]).toBeCloseTo(20)
  })
})
