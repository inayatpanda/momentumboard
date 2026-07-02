import { describe, it, expect } from 'vitest'
import { sma, rsi, atr, swingCapacity } from './indicators'
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
