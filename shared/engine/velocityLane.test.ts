import { describe, expect, it } from 'vitest'
import { VELOCITY_DOOR_CAP, classifyVelocity, velocityCall, velocityTrail } from './velocityLane'
import type { Candle } from '../types'

const mk = (c: number, v = 1_000_000, o = c, h = c, l = c): Candle => ({ t: 0, o, h, l, c, v })
const flat = (n: number, c = 100) => Array.from({ length: n }, () => mk(c))

// ---- the fixtures, each one a row of the truth table ----

/** Nothing happening: 60 flat sessions on flat volume. */
const calm = () => flat(60)

/** The early door: a first break of the 20-session high, paid for 3×. */
const breakout = (vol: number) => [...flat(59), mk(105, vol)]

/** The confirmation door: +16% over five sessions, then a PAUSE that holds the 8-EMA. */
const pauseAfterRun = () => [...flat(56), mk(104), mk(108), mk(112), mk(117), mk(116)]

/** 3-of-5 up-days — but the loud session is the DOWN day [C7]. `loudDown` false
 * moves the identical 2.5× print onto the 103 UP day, which must open the door. */
const threeOfFive = (loudDown: boolean) => [
  ...flat(56),
  mk(101),
  mk(99, loudDown ? 2_500_000 : 1_000_000),
  mk(101),
  mk(103, loudDown ? 1_000_000 : 2_500_000),
  mk(102),
]

/** The fifth consecutive green day, on a 5× breakout print. Every leg but the
 * entry-timing rule passes — for BOTH doors. */
const fifthGreenDay = () => [...flat(56), mk(102), mk(104), mk(106), mk(108), mk(110, 5_000_000)]

/** Both doors open at once: a 20% five-session move, a one-day pause, then a
 * 4× break of the 20-session high. */
const bothDoors = () => [...flat(55), mk(105), mk(110), mk(115), mk(112), mk(120, 4_000_000)]

/** A gap-up shelf whose five prior lows all sit ABOVE the 8-EMA — the only shape
 * in which the low leg of the trail actually binds — and a today that washes out
 * to 120 before closing at 158 [C3]. */
const washout = () => [...flat(50), mk(150), mk(151), mk(152), mk(151), mk(153), mk(158, 4_000_000, 153, 159, 120)]

describe('classifyVelocity', () => {
  it('null when under 30 candles', () => expect(classifyVelocity(flat(29))).toBeNull())

  it('calm tape: no door', () => {
    const read = classifyVelocity(calm())!
    expect(read.door).toBeNull()
    expect(read.earlyTriggered).toBe(false)
    expect(read.confirmationTriggered).toBe(false)
    expect(read.greenStreak).toBe(0)
  })

  it('a 20-session breakout on 3× volume opens the EARLY door', () => {
    const read = classifyVelocity(breakout(3_000_000))!
    expect(read.earlyTriggered).toBe(true)
    expect(read.confirmationTriggered).toBe(false)
    expect(read.door).toBe('early')
    expect(read.greenStreak).toBe(1)
  })

  it('the same breakout on 2× volume opens NOTHING — the early threshold is 3×', () => {
    const read = classifyVelocity(breakout(2_000_000))!
    expect(read.earlyTriggered).toBe(false)
    expect(read.door).toBeNull()
    expect(read.detail).toContain('under 3×')
  })

  it('the breakout level EXCLUDES today: a bar cannot break a high it set itself', () => {
    // 105 is the highest close in the last 20 sessions ONLY because today printed
    // it. Measured against the prior 20 (all 100) it is a real break; measured
    // including today it never is, and the early door could never fire [gpt-oss #7].
    const read = classifyVelocity(breakout(3_000_000))!
    expect(read.detail).toContain('100')
    expect(read.earlyTriggered).toBe(true)
  })

  it('+16% over five sessions with a pause holding the 8-EMA opens the CONFIRMATION door', () => {
    const read = classifyVelocity(pauseAfterRun())!
    expect(read.confirmationTriggered).toBe(true)
    expect(read.earlyTriggered).toBe(false) // 116 is under yesterday's 117 high
    expect(read.door).toBe('confirmation')
    expect(read.greenStreak).toBe(0)
  })

  it('3-of-5 up-days where the ONLY 2× print was the DOWN day opens nothing [C7]', () => {
    const read = classifyVelocity(threeOfFive(true))!
    expect(read.door).toBeNull()
    expect(read.confirmationTriggered).toBe(false)
    // every OTHER confirmation leg passes — the refusal is the volume's location
    expect(read.greenStreak).toBe(0)
    expect(read.detail).toContain('3/5 up')
    expect(read.detail).toContain('no 2× up-day')
  })

  it('…and the identical print moved ONTO the up-day opens the confirmation door', () => {
    const read = classifyVelocity(threeOfFive(false))!
    expect(read.confirmationTriggered).toBe(true)
    expect(read.door).toBe('confirmation')
  })

  it('the fifth consecutive green day is never bought — by either door', () => {
    const read = classifyVelocity(fifthGreenDay())!
    expect(read.greenStreak).toBe(5)
    expect(read.earlyTriggered).toBe(false) // breakout + 5× volume both pass; the streak does not
    expect(read.confirmationTriggered).toBe(false)
    expect(read.door).toBeNull()
    expect(read.detail).toContain('5 green days')
  })

  it('both doors open: the diagnostics are independent and EARLY wins', () => {
    const read = classifyVelocity(bothDoors())!
    expect(read.earlyTriggered).toBe(true)
    expect(read.confirmationTriggered).toBe(true)
    expect(read.door).toBe('early')
  })
})

describe('velocityTrail', () => {
  it('reads the PRIOR five sessions: today’s washout low never drags the trail down [C3]', () => {
    const cs = washout()
    // prior five lows are 150/151/152/151/153 → 150; the 8-EMA is ~141.65. A trail
    // that counted today's 120 low would print 141.65 and could never fire.
    expect(velocityTrail(cs)).toBe(150)
    expect(velocityTrail(cs)).toBeGreaterThan(cs[cs.length - 1].l)
  })

  it('takes the 8-EMA when it sits above the prior-five low', () => {
    expect(velocityTrail(bothDoors())).toBe(109.99)
  })

  it('null on a history too short to seed the 8-EMA', () => expect(velocityTrail(flat(5))).toBeNull())
})

describe('velocityCall', () => {
  it('null when no door is open', () => {
    const cs = calm()
    expect(velocityCall('NVDA', cs, classifyVelocity(cs)!, 35_000)).toBeNull()
  })

  it('builds a LONG velocity call: trail stop, 2R target, composite inside 25-55', () => {
    const cs = bothDoors()
    const call = velocityCall('NVDA', cs, classifyVelocity(cs)!, 35_000)!
    expect(call.side).toBe('long')
    expect(call.setup).toBe('velocity')
    expect(call.stage).toBe('trending')
    expect(call.entry).toBe(120)
    expect(call.stop).toBe(109.99) // max(8-EMA 109.99, prior-five low 100)
    expect(call.target).toBe(140.02) // entry + 2 × (120 − 109.99)
    expect(call.target - call.entry).toBeCloseTo(2 * (call.entry - call.stop), 8)
    expect(call.composite).toBe(45) // 25 + |+20% over five sessions|
    expect(call.expectedMovePct).toBe(16.7)
    expect(call.evidence.contract).toBe(true)
    expect(call.factors.technical.weight).toBe(0) // the composite is NOT a weighted sum
    expect(call.factors.technical.score).toBe(40)
    expect(call.factors.momentum.score).toBeNull()
    expect('catalyst' in call).toBe(false) // the tag is buildBoard's, not the lane's
  })

  it('the washout tape stops under the shelf, not under today’s spike low', () => {
    const cs = washout()
    const call = velocityCall('NVDA', cs, classifyVelocity(cs)!, 35_000)!
    expect(call.entry).toBe(158)
    expect(call.stop).toBe(150)
    expect(call.target).toBe(174)
    expect(call.composite).toBe(30.3) // 25 + |158/150 − 1| = 25 + 5.33%
  })

  it('the composite clamps at 55 on a violent move', () => {
    const cs = [...flat(55), mk(120), mk(140), mk(160), mk(150), mk(190, 4_000_000)]
    const read = classifyVelocity(cs)!
    expect(read.door).toBe('early')
    expect(velocityCall('NVDA', cs, read, 35_000)!.composite).toBe(55) // 25 + 90% clamped
  })

  it('null when the trail sits at or above entry — no risk distance to size against', () => {
    // A 5000 shelf collapses to 100 and bases there for 25 sessions. Today breaks
    // the 20-session high on 4× volume, but the 8-EMA is still carrying the old
    // shelf's weight (~108) and sits ABOVE the 105 entry.
    const cs = [...flat(30, 5000), ...flat(25, 100), mk(105, 4_000_000)]
    const read = classifyVelocity(cs)!
    expect(read.door).toBe('early')
    expect(velocityTrail(cs)!).toBeGreaterThan(105)
    expect(velocityCall('NVDA', cs, read, 35_000)).toBeNull()
  })
})

describe('VELOCITY_DOOR_CAP', () => {
  it('sizes the younger read smaller', () => {
    expect(VELOCITY_DOOR_CAP.early).toBe(0.25)
    expect(VELOCITY_DOOR_CAP.confirmation).toBe(0.5)
    expect(VELOCITY_DOOR_CAP.early).toBeLessThan(VELOCITY_DOOR_CAP.confirmation)
  })
})
