import { describe, it, expect } from 'vitest'
import { toCandleSeries, toVolumeSeries, toLineSeries } from './chartData'
import type { Candle } from '../../shared/types'

const candles: Candle[] = [
  { t: 100, o: 10, h: 12, l: 9, c: 11, v: 500 }, // up bar
  { t: 200, o: 11, h: 11.5, l: 10, c: 10.5, v: 800 }, // down bar
]

describe('toCandleSeries', () => {
  it('maps ohlc with unix times', () => {
    expect(toCandleSeries(candles)[0]).toEqual({ time: 100, open: 10, high: 12, low: 9, close: 11 })
  })
})

describe('toVolumeSeries', () => {
  it('colors up bars green and down bars red', () => {
    const v = toVolumeSeries(candles)
    expect(v[0]).toMatchObject({ time: 100, value: 500 })
    expect(v[0].color).not.toBe(v[1].color)
  })
})

describe('toLineSeries', () => {
  it('drops null values while keeping alignment', () => {
    const line = toLineSeries(candles, [null, 10.75])
    expect(line).toEqual([{ time: 200, value: 10.75 }])
  })
})
