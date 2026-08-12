import { describe, it, expect } from 'vitest'
import { sma, rsi, atr, emaLast, swingCapacity } from './indicators'
import type { Candle } from './types'

const bar = (h: number, l: number, c: number): Candle => ({ t: 0, o: c, h, l, c, v: 1000 })

describe('sma', () => {
  it('aligns to input with nulls until period reached', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })
})

describe('rsi (Wilder, period 14)', () => {
  it('is 100 for a strictly rising series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    const out = rsi(closes)
    expect(out[13]).toBeNull()
    expect(out[14]).toBe(100)
    expect(out[19]).toBe(100)
  })
  it('is 0 for a strictly falling series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i)
    expect(rsi(closes)[16]).toBe(0)
  })
  it('stays near 50 for a symmetric alternating series', () => {
    const closes = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 10 : 11))
    expect(rsi(closes)[14]).toBeCloseTo(50, 5) // first RSI bar: gains exactly balance losses
    // Wilder smoothing makes later values oscillate around 50, converging slowly
    expect(rsi(closes)[20]).toBeGreaterThan(47)
    expect(rsi(closes)[20]).toBeLessThan(53)
  })
  it('is 50 for a flat series (0/0 convention)', () => {
    expect(rsi(Array(20).fill(7))[15]).toBe(50)
  })
})

describe('atr (period 2)', () => {
  it('computes Wilder ATR from true ranges', () => {
    const candles = [bar(10, 8, 9), bar(11, 9, 10), bar(12, 10, 11)]
    const out = atr(candles, 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBe(2) // mean of TR [2, 2]
    expect(out[2]).toBe(2) // (2*(2-1) + 2)/2
  })
})

describe('emaLast', () => {
  it('seeds on the SMA of the first `period` values and smooths with k = 2/(period+1)', () => {
    // seed = mean(1,2,3) = 2, k = 0.5 → 2 + .5(4-2) = 3 → 3 + .5(5-3) = 4
    expect(emaLast([1, 2, 3, 4, 5], 3)).toBe(4)
  })

  it('is null when the history is shorter than the period — an unknown never passes a gate', () => {
    expect(emaLast([1, 2], 3)).toBeNull()
    expect(emaLast([], 1)).toBeNull()
  })

  it('equals the level of a flat series', () => {
    expect(emaLast(Array(20).fill(7) as number[], 5)).toBe(7)
  })

  it('returns the seed SMA untouched when the history is exactly `period` long', () => {
    expect(emaLast([2, 4, 6], 3)).toBe(4)
  })

  it('lags a rising series — it sits below the last close and above the first', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i)
    const e = emaLast(rising, 8)!
    expect(e).toBeLessThan(rising[rising.length - 1])
    expect(e).toBeGreaterThan(rising[0])
  })

  // PARITY PIN — this is the velocity lane's own 8-EMA, copied from
  // velocityLane.test.ts:178 (`velocityTrail(bothDoors())` === 109.99, the trail
  // taking the EMA leg). The shared implementation must reproduce the lane's
  // number to the last place, or the move was not a move.
  it('reproduces the velocity lane 8-EMA fixture exactly [parity pin]', () => {
    const bothDoorsCloses = [...Array(55).fill(100) as number[], 105, 110, 115, 112, 120]
    const e = emaLast(bothDoorsCloses, 8)!
    expect(e).toBeCloseTo(109.9871632034412, 10)
    expect(Math.round(e * 100) / 100).toBe(109.99)
  })

  // PARITY PIN — the dip lane's 50-EMA on the same shape of tape.
  it('seeds a 50-period EMA only once 50 closes exist [parity pin]', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 - i * 0.5)
    expect(emaLast(closes.slice(0, 49), 50)).toBeNull()
    expect(emaLast(closes.slice(0, 50), 50)).toBeCloseTo(87.75, 10) // the seed SMA
    expect(emaLast(closes, 50)).toBeLessThan(87.75) // …then it tracks the decline down
  })
})

describe('swingCapacity', () => {
  it('scores volatile series high and sleepy series low', () => {
    // sleepy: ±0.2% daily wiggle → 10-day p80 well under 3%
    const sleepy = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i) * 0.2)
    // volatile: ±1.5% daily trend swings in alternating 10-day waves
    let p = 100
    const wild = Array.from({ length: 300 }, (_, i) => (p *= i % 20 < 10 ? 1.015 : 0.985))
    const s = swingCapacity(sleepy)!
    const w = swingCapacity(wild)!
    expect(s).toBeLessThan(3)
    expect(w).toBeGreaterThan(8)
    expect(swingCapacity([1, 2, 3])).toBeNull() // too little history
  })
})
