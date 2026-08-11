import { describe, expect, it } from 'vitest'
import { classifyDip, dipCall } from './dipLane'
import type { Candle } from '../types'

const mk = (c: number, v = 1_000_000, o = c, h = c, l = c): Candle => ({ t: 0, o, h, l, c, v })
const flat = (n: number, c = 100) => Array.from({ length: n }, () => mk(c))
const base = () => flat(60)
/** The dip bars every holding fixture shares: slide to 85, stabilise, reclaim on 1.6× volume. */
const slide = () => [mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5)]

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
    // slide to 85 over days, stabilise at 85, then close 88 — (88 − 84.5)/84.5 = +4.14%
    // off the dip low — on 1.6x volume. The 50-EMA is ~97.5, so that leg is genuinely false.
    const cs = [...base(), ...slide(), mk(88, 1_600_000)]
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
  })
  it('thin-volume reclaim is not holding', () => {
    const cs = [...base(), ...slide(), mk(88, 1_100_000)]
    expect(classifyDip(cs)!.holding).toBe(false)
  })
  it('holds on the 3% reclaim alone when the 50-EMA does not exist yet (40 candles)', () => {
    // emaLast returns null below EMA_PERIOD closes, so `aboveEma` cannot be the
    // reason: with 40 candles only the 3%-off-the-dip-low leg can carry holding.
    const cs = [...flat(34), ...slide(), mk(88, 1_600_000)]
    expect(cs.length).toBe(40)
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
    // the detail names the reclaim path that actually fired — the dip low, not the EMA
    expect(read.detail).toContain('dip low')
    expect(read.detail).not.toContain('50-EMA')
  })
})

describe('dipCall', () => {
  const holdingTape = [...base(), ...slide(), mk(88, 1_600_000)]
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

  it('washout bar: the stop is TODAY’s low when it undercuts the dip-window low', () => {
    // Same holding tape, but today washes out to 83 before closing at 88. The
    // dip-window low (which excludes today) is 84.5 — a stop there would sit
    // INSIDE today's range. Ratified: stop = min(dip-window low, today's low).
    const washout = [...base(), ...slide(), mk(88, 1_600_000, 86, 88.5, 83)]
    const read = classifyDip(washout)!
    expect(read.holding).toBe(true)
    const call = dipCall('GLW', washout, read, 35_000)!
    expect(call.stop).toBe(83)
    expect(call.entry).toBe(88)
    expect(call.target).toBe(94) // risk 5 vs reward 6 — clears the 1:1 gate
  })

  it('returns null when reward is smaller than risk (the depth-blind gap degenerate)', () => {
    // 55 flat bars at 90, a five-bar ramp to 100, then a bar that gaps to 93
    // (an 7% down-gap: trigger B fires) and closes at 99 on 2× volume. The dip
    // is real by the letter of the rules, but the half-retrace target sits 0.5
    // above entry while the stop hides under the whole dip at 90: risk 9,
    // reward 0.5. Structurally sound, financially insane.
    const gapTape = [...flat(55, 90), mk(96), mk(97), mk(98), mk(99), mk(100), mk(99, 2_000_000, 93, 101, 92)]
    const read = classifyDip(gapTape)!
    // the gate lives in dipCall, not classifyDip — the price signature IS a holding dip
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
    expect(dipCall('GLW', gapTape, read, 35_000)).toBeNull()
  })

  it('returns null when the stop would land on entry (close on the low of the day)', () => {
    // A spike to 120, a crash bar that closes ON its low at 88, eight flat bars,
    // then today closes at 88.004 — its own low, and above a dip-window low of
    // 88. Both round to 88.00, so stop >= entry: there is no risk distance to
    // size against. (The 50-EMA is still down near 62 after the long 50-base,
    // so the reclaim leg passes and the read is genuinely holding.)
    const closeOnLow = [
      ...flat(45, 50),
      mk(120),
      mk(88, 1_000_000, 120, 120, 88),
      ...flat(8, 88),
      mk(88.004, 2_000_000, 88.004, 88.01, 88.004),
    ]
    const read = classifyDip(closeOnLow)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
    expect(dipCall('GLW', closeOnLow, read, 35_000)).toBeNull()
  })

  it('returns null when the target would land on entry (shock closed at the 20-session high)', () => {
    // Gaps down 8% (trigger B) and closes at 100.5 — the highest close of the
    // last 20 sessions. A half-retrace toward a high you are already standing on
    // is a target equal to entry: nothing to aim at, no call.
    const closedAtHigh = [...base(), mk(100.5, 2_000_000, 92, 101, 92)]
    const read = classifyDip(closedAtHigh)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
    expect(dipCall('GLW', closedAtHigh, read, 35_000)).toBeNull()
  })
})
