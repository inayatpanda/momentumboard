import { describe, it, expect } from 'vitest'
import { breadthAbove50, refineRegime, regimeFromCandles, hasBullishDivergence, detectSetups } from './setups'
import type { Candle } from './types'

// Builder: candles from closes; h/l hug close; volume overridable per-bar.
const mk = (closes: number[], vols?: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i, o: c, h: c * 1.01, l: c * 0.99, c, v: vols?.[i] ?? 1000 }))

const rising = (n: number, start = 100, step = 0.5) => Array.from({ length: n }, (_, i) => start + i * step)
const falling = (n: number, start = 100, step = 0.5) => Array.from({ length: n }, (_, i) => start - i * step)

describe('regimeFromCandles', () => {
  it('green when both indices rise above their 20/50 SMAs', () => {
    const up = mk(rising(60))
    expect(regimeFromCandles(up, up)).toBe('green')
  })
  it('red when an index trades below its falling 50-SMA', () => {
    const down = mk(falling(60))
    expect(regimeFromCandles(down, down)).toBe('red')
  })
  it('amber when mixed', () => {
    expect(regimeFromCandles(mk(rising(60)), mk(falling(60)))).toBe('amber')
  })
})

describe('hasBullishDivergence', () => {
  it('detects equal/lower price low with higher RSI low', () => {
    const closes = Array(40).fill(50)
    closes[10] = 40; closes[30] = 39.9
    const rsiVals: (number | null)[] = Array(40).fill(50)
    rsiVals[10] = 22; rsiVals[30] = 31
    expect(hasBullishDivergence(closes, rsiVals, 40)).toBe(true)
  })
  it('rejects when RSI also makes a lower low', () => {
    const closes = Array(40).fill(50)
    closes[10] = 40; closes[30] = 39.9
    const rsiVals: (number | null)[] = Array(40).fill(50)
    rsiVals[10] = 30; rsiVals[30] = 24
    expect(hasBullishDivergence(closes, rsiVals, 40)).toBe(false)
  })
})

describe('detectSetups', () => {
  // Decline 100→66.75 over 20 bars, then 25 range-bound bars 64–66 (base).
  const declineCloses = falling(20, 100, 1.75)
  // 64–66 range with a tiny upward drift so later lows sit above earlier lows
  const baseCloses = Array.from({ length: 25 }, (_, i) => 64 + (i % 3) + i * 0.03)

  it('flags basing after a long base below a big decline', () => {
    const setups = detectSetups(mk([...declineCloses, ...baseCloses]), 1)
    expect(setups).toContain('basing')
    expect(setups).not.toContain('fallingKnife')
  })

  it('flags reclaim when price crosses over SMA20 on volume from a base', () => {
    const closes = [...declineCloses, ...baseCloses, 68] // pops above the ~65 SMA20
    const vols = closes.map(() => 1000); vols[vols.length - 1] = 2500
    const setups = detectSetups(mk(closes, vols), 1.8)
    expect(setups).toContain('reclaim')
  })

  it('flags fallingKnife on a fresh heavy-volume low with weak RSI', () => {
    const closes = falling(40, 100, 1.5)
    const vols = closes.map(() => 1000); vols[closes.length - 1] = 2000
    const setups = detectSetups(mk(closes, vols), 2)
    expect(setups).toContain('fallingKnife')
    expect(setups).not.toContain('basing')
  })

  it('flags breakoutLive on a fresh all-series high with rvol ≥ 2', () => {
    const closes = [...rising(50, 100, 0.2), 111.5]
    expect(detectSetups(mk(closes), 2.4)).toContain('breakoutLive')
    expect(detectSetups(mk(closes), 1.1)).not.toContain('breakoutLive')
  })

  it('flags pullbackZone on a modest dip in an uptrend', () => {
    const up = rising(60, 100, 1) // ends 159
    const dip = [157.5, 156, 154.5, 153, 151.5, 150] // ~5.7% off 159 over 6 bars → RSI ~54
    const setups = detectSetups(mk([...up, ...dip]), 0.8)
    expect(setups).toContain('pullbackZone')
  })

  it('flags overextended when stretched >2 ATR above SMA20 with hot RSI', () => {
    const closes = [...rising(40, 100, 0.3), 115, 119, 124, 130, 137]
    const setups = detectSetups(mk(closes), 1)
    expect(setups).toContain('overextended')
  })
})

describe('refineRegime', () => {
  it('null inputs leave the base read untouched', () => {
    expect(refineRegime('green', null, null)).toBe('green')
    expect(refineRegime('amber', null, null)).toBe('amber')
    expect(refineRegime('red', null, null)).toBe('red')
  })
  it('thin breadth demotes green to amber; broad breadth lifts red to amber', () => {
    expect(refineRegime('green', 0.3, null)).toBe('amber')
    expect(refineRegime('green', 0.5, null)).toBe('green')
    expect(refineRegime('red', 0.7, null)).toBe('amber')
    expect(refineRegime('red', 0.5, null)).toBe('red')
    expect(refineRegime('amber', 0.3, null)).toBe('amber') // breadth never demotes amber
  })
  it('VIX ≥32 forces red; VIX ≥25 caps green at amber; calm VIX changes nothing', () => {
    expect(refineRegime('green', null, 33)).toBe('red')
    expect(refineRegime('amber', null, 35)).toBe('red')
    expect(refineRegime('green', null, 26)).toBe('amber')
    expect(refineRegime('amber', null, 26)).toBe('amber')
    expect(refineRegime('green', null, 18)).toBe('green')
  })
  it('VIX panic overrides a breadth upgrade', () => {
    expect(refineRegime('red', 0.7, 33)).toBe('red') // breadth said amber, VIX says no
  })
})

describe('breadthAbove50', () => {
  const risingCloses = Array.from({ length: 60 }, (_, i) => 100 + i) // close > SMA50
  const fallingCloses = Array.from({ length: 60 }, (_, i) => 160 - i) // close < SMA50
  it('computes the share of series above their 50-SMA', () => {
    const series = [...Array.from({ length: 7 }, () => risingCloses), ...Array.from({ length: 3 }, () => fallingCloses)]
    expect(breadthAbove50(series)).toBeCloseTo(0.7, 5)
  })
  it('returns null below the minimum sample and skips short series', () => {
    expect(breadthAbove50([risingCloses, fallingCloses])).toBeNull()
    const short = Array.from({ length: 20 }, (_, i) => 100 + i)
    const series = [...Array.from({ length: 10 }, () => risingCloses), short] // short one doesn't count
    expect(breadthAbove50(series)).toBe(1)
  })
})
