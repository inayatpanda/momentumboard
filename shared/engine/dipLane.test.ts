import { describe, expect, it } from 'vitest'
import { classifyDip, dipCall } from './dipLane'
import type { Candle } from '../types'

const mk = (c: number, v = 1_000_000, o = c, h = c, l = c): Candle => ({ t: 0, o, h, l, c, v })
const flat = (n: number, c = 100) => Array.from({ length: n }, () => mk(c))
const base = () => flat(60)
/** The dip bars every holding fixture shares: slide to 85, stabilise, reclaim on 1.6× volume. */
const slide = () => [mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5)]

/** A GRINDING recovery — the shape the turn-scoped volume rule exists for. A deeper
 * slide to a 79 low, ONE volume-paid turn bar at 83, then `quiet` ordinary sessions
 * grinding higher on average volume. `quiet` is how many sessions ago the turn was
 * paid for: 0 = today, 3 = three sessions back, 5 = out of the 5-session window. */
const grindingRecovery = (quiet: number, turnVol = 1_600_000) => {
  const bars = [...base(), mk(94), mk(90), mk(87), mk(80, 1_000_000, 81, 81, 79), mk(80.5), mk(83, turnVol)]
  for (let i = 1; i <= quiet; i++) bars.push(mk(83 + i * 0.5))
  return bars
}

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
  // ---- the volume leg is TURN-SCOPED (ratified 2026-08-12) ----
  // GLW rallied +28% off its low across nine sessions and `holding` was false on
  // all 21 replay days, because the rule demanded the 1.5× print TODAY. What the
  // leg accepts is real participation printed inside the turn window — on GLW the
  // 3.6× bar was the −12% capitulation day and the +9% reversal printed only 1.34×,
  // so "the session that pays is the one that reverses" was never true here.
  it('a turn paid for THREE sessions ago still holds while the recovery grinds quietly', () => {
    const cs = grindingRecovery(3)
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
    // today itself printed nothing special — the old rule failed exactly here
    expect(cs[cs.length - 1].v).toBe(1_000_000)
    expect(read.detail).toContain('3 sessions ago')
  })

  it('the same tape with NO paid session anywhere in the last five is still not holding', () => {
    // identical bars, the turn bar printed on ORDINARY volume: nothing confirmed
    // the turn, so the always-false rule must not have quietly become always-true
    const read = classifyDip(grindingRecovery(3, 1_000_000))!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(false)
    expect(read.detail).toContain('no 1.5× session in the last 5')
  })

  it('a turn paid for SIX sessions ago has aged out of the window', () => {
    const read = classifyDip(grindingRecovery(5))! // today + 5 quiet = the turn is the 6th session back
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(false)
  })

  // ---- the read names the NEAREST paid session, not the loudest ----
  // A capitulation bar is usually the biggest print of the whole turn, so quoting
  // the window's maximum kept citing evidence that was days older than the real
  // confirmation. GLW again: 3.6× on the −12% day, 1.34× on the +9% day that turned it.
  it('with two paid sessions in the window the detail cites the nearer one', () => {
    // −11% capitulation on 4× volume, then the quieter 1.7× session that followed it
    const cs = [...base(), mk(94), mk(90), mk(80, 4_000_000, 87, 87, 79), mk(82, 2_000_000), mk(83)]
    const read = classifyDip(cs)!
    expect(read.holding).toBe(true)
    expect(read.detail).toContain('on 1.7× volume 1 session ago')
    expect(read.detail).not.toContain('4×') // the loudest print is not the nearest evidence
    expect(read.detail).not.toContain('2 sessions ago')
  })

  it('the paid session printing TODAY reads exactly as it always did', () => {
    const read = classifyDip(grindingRecovery(0))!
    expect(read.holding).toBe(true)
    expect(read.detail).toContain('1.6× volume')
    expect(read.detail).not.toContain('sessions ago')
  })

  // ---- the knife guard is not negotiable by volume ----
  // The turn-scoped leg loosened ONE gate. This tape proves it loosened only that
  // one: a 3× session four days back and a reclaim 23% above the flush low — both
  // other legs genuinely passing — and today still prints a new 5-session closing
  // low. A name still making lows is still falling, whatever the crowd paid.
  it('knife guard alone refuses a paid, reclaimed tape that makes a new 5-session low today', () => {
    // the flush prints 3× volume and an intraday low of 70, then closes drift down
    const cs = [...base(), mk(88, 3_000_000, 95, 95, 70), mk(89), mk(88), mk(87), mk(86)]
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(false)
    // …and the ONLY reason named is the knife guard: the other two legs passed
    expect(read.detail).toContain('not holding: new 5-session closing low')
    expect(read.detail).not.toContain('no 1.5× session')
    expect(read.detail).not.toContain('no reclaim')
    expect(dipCall('GLW', cs, read, 35_000)).toBeNull()
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
  it('builds the grinding recovery GLW never got: stop under the dip low, target half-way back', () => {
    const cs = grindingRecovery(3)
    const call = dipCall('GLW', cs, classifyDip(cs)!, 35_000)!
    expect(call).not.toBeNull()
    expect(call.side).toBe('long')
    expect(call.entry).toBe(84.5)
    expect(call.stop).toBe(79) // the dip-window low, under the whole slide
    expect(call.target).toBe(92.25) // half of the way back to the 100 high
    expect(call.target - call.entry).toBeGreaterThan(call.entry - call.stop) // clears the 1:1 gate
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
