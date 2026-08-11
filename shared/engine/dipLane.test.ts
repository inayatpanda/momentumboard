import { describe, expect, it } from 'vitest'
import { classifyDip, dipCall } from './dipLane'
import type { Candle } from '../types'

const mk = (c: number, v = 1_000_000, o = c, h = c, l = c): Candle => ({ t: 0, o, h, l, c, v })
const base = () => Array.from({ length: 60 }, () => mk(100))

describe('classifyDip', () => {
  it('null when under 30 candles', () => expect(classifyDip([mk(1)])).toBeNull())
  it('calm tape: not triggered', () => expect(classifyDip(base())!.triggered).toBe(false))
  it('triggers on a >=12% slide from the 20-session high', () => {
    expect(classifyDip([...base(), mk(95), mk(90), mk(87)])!.triggered).toBe(true)
  })
  it('triggers on a one-day open-gap >=7% even when the close recovers', () => {
    // opens at 91 (-9% gap), closes back at 96 — close-to-close is only -4%
    expect(classifyDip([...base(), mk(96, 2_000_000, 91, 97, 90)])!.triggered).toBe(true)
  })
  it('knife guard: a new 5-session closing low today is never holding', () => {
    const read = classifyDip([...base(), mk(92), mk(90), mk(88), mk(86), mk(84)])!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(false)
  })
  it('slide case holds via the 3%-above-dip-low reclaim on volume (no 50-EMA needed)', () => {
    // slide to 85 over days, stabilise at 85, then close 88 (+3.5% off the low) on 1.6x volume
    const cs = [...base(), mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5), mk(88, 1_600_000)]
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
  })
  it('thin-volume reclaim is not holding', () => {
    const cs = [...base(), mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5), mk(88, 1_100_000)]
    expect(classifyDip(cs)!.holding).toBe(false)
  })
})

describe('dipCall', () => {
  const holdingTape = [...base(), mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5), mk(88, 1_600_000)]
  it('builds a LONG reversal call with stop under the dip low and composite in 25-55', () => {
    const read = classifyDip(holdingTape)!
    const call = dipCall('GLW', holdingTape, read, 35_000)!
    expect(call.side).toBe('long')
    expect(call.setup).toBe('reversal')
    expect(call.stop).toBeLessThan(84.6)
    expect(call.entry).toBe(88)
    expect(call.target).toBeGreaterThan(88)
    expect(Math.abs(call.composite)).toBeGreaterThanOrEqual(25)
    expect(Math.abs(call.composite)).toBeLessThanOrEqual(55)
  })
  it('returns null when not holding', () => {
    const notHolding = [...base(), mk(92), mk(90), mk(88), mk(86), mk(84)]
    expect(dipCall('GLW', notHolding, classifyDip(notHolding)!, 35_000)).toBeNull()
  })
})
