import { describe, it, expect } from 'vitest'
import { avgDailyVolume, sessionElapsedFraction, relativeVolume, isMarketOpen, sessionUtcHours } from './rvol'
import type { Candle } from './types'

const withVol = (v: number): Candle => ({ t: 0, o: 1, h: 1, l: 1, c: 1, v })

describe('avgDailyVolume', () => {
  it('averages the prior bars, excluding the last (partial today)', () => {
    const candles = [...Array(30).fill(0).map(() => withVol(1000)), withVol(50)]
    expect(avgDailyVolume(candles, 30)).toBe(1000)
  })
  it('returns null with fewer than 5 completed bars', () => {
    expect(avgDailyVolume([withVol(1), withVol(1)], 30)).toBeNull()
  })
})

describe('sessionElapsedFraction', () => {
  const utc = (h: number, m = 0) => Date.UTC(2026, 6, 2, h, m) / 1000
  it('is ~0.54 midway through the US session', () => {
    expect(sessionElapsedFraction('US', utc(17, 0))).toBeCloseTo((17 - 13.5) / 6.5, 2)
  })
  it('is 1 whenever the market is closed (last bar is a complete day)', () => {
    expect(sessionElapsedFraction('US', utc(22, 0))).toBe(1) // after close
    expect(sessionElapsedFraction('US', utc(11, 0))).toBe(1) // before open
    expect(sessionElapsedFraction('LSE', utc(12, 15))).toBeCloseTo(5.25 / 8.5, 2)
  })
  it('floors at 0.05 just after the open to avoid divide-by-tiny spikes', () => {
    expect(sessionElapsedFraction('US', utc(13, 31))).toBe(0.05)
  })
})

describe('isMarketOpen', () => {
  it('uses winter US and summer London hours for polling and alerts', () => {
    const at = (iso: string) => Date.parse(iso) / 1000
    expect(isMarketOpen('US', at('2026-01-05T14:00:00Z'))).toBe(false)
    expect(isMarketOpen('US', at('2026-01-05T20:30:00Z'))).toBe(true)
    expect(isMarketOpen('US', at('2026-01-05T21:00:00Z'))).toBe(false)
    expect(isMarketOpen('LSE', at('2026-07-02T07:30:00Z'))).toBe(true)
    expect(isMarketOpen('LSE', at('2026-07-02T15:30:00Z'))).toBe(false)
    expect(sessionElapsedFraction('US', at('2026-01-05T17:45:00Z'))).toBeCloseTo(0.5)
  })
  it('uses each venue’s own DST transition dates', () => {
    const at = (iso: string) => Date.parse(iso) / 1000
    expect(sessionUtcHours('US', at('2026-03-09T12:00:00Z'))).toEqual({ open: 13.5, close: 20 })
    expect(sessionUtcHours('LSE', at('2026-03-09T12:00:00Z'))).toEqual({ open: 8, close: 16.5 })
    expect(sessionUtcHours('LSE', at('2026-03-30T12:00:00Z'))).toEqual({ open: 7, close: 15.5 })
    expect(sessionUtcHours('US', at('2026-11-02T12:00:00Z'))).toEqual({ open: 14.5, close: 21 })
  })
  it('respects session hours and weekends', () => {
    const thu17 = Date.UTC(2026, 6, 2, 17, 0) / 1000 // Thursday, mid US session
    const sat17 = Date.UTC(2026, 6, 4, 17, 0) / 1000 // Saturday
    expect(isMarketOpen('US', thu17)).toBe(true)
    expect(isMarketOpen('LSE', thu17)).toBe(false) // LSE closed by 17:00 UTC
    expect(isMarketOpen('US', sat17)).toBe(false)
  })
  it('crypto is always open, with a midnight-UTC daily bar fraction', () => {
    const sat17 = Date.UTC(2026, 6, 4, 17, 0) / 1000
    expect(isMarketOpen('CRYPTO', sat17)).toBe(true)
    expect(sessionElapsedFraction('CRYPTO', sat17)).toBeCloseTo(17 / 24, 3)
  })
})

describe('relativeVolume', () => {
  it('time-adjusts: half the average volume at half the session = 1x', () => {
    expect(relativeVolume(500, 1000, 0.5)).toBe(1)
    expect(relativeVolume(2000, 1000, 0.5)).toBe(4)
  })
})
