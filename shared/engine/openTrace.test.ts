import { describe, expect, it } from 'vitest'
import { traceOpenCall, verdictFor } from './openTrace'
import { velocityTrail } from './velocityLane'
import type { Candle } from '../types'

const T0 = Date.parse('2026-07-01') / 1000
const DAY = 86_400
const series = (closes: number[], startIdx = 0): Candle[] =>
  closes.map((c, i) => ({ t: T0 + (startIdx + i) * DAY, o: c, h: c + 0.5, l: c - 0.5, c, v: 1_000_000 }))

const call = (over: Partial<Parameters<typeof traceOpenCall>[0]> = {}) => ({
  id: '2026-07-01:AAA:long',
  sym: 'AAA',
  side: 'long' as const,
  date: '2026-07-01',
  grade: 'B' as const,
  entry: 100,
  stop: 95,
  target: 110,
  ...over,
})

const none = new Set<string>()

describe('traceOpenCall — the walk', () => {
  it('a close through the stop ends the trace: stopped, dated, no verdict', () => {
    const e = traceOpenCall(call(), series([100, 98, 94.5, 102]), none)!
    expect(e.status).toBe('stopped')
    expect(e.crossedDate).toBe('2026-07-03')
    expect(e.verdict).toBeNull()
    expect(e.note).toContain('stop')
  })

  it('a close at/through the target ends the trace as target', () => {
    const e = traceOpenCall(call(), series([100, 105, 111]), none)!
    expect(e.status).toBe('target')
    expect(e.crossedDate).toBe('2026-07-03')
  })

  it('in play: move from the published entry, progress toward target, day clock', () => {
    const e = traceOpenCall(call(), series([100, 103]), none)!
    expect(e.status).toBe('in-play')
    expect(e.movePct).toBe(3)
    expect(e.progressPct).toBe(30) // 3 of the 10-point entry→target span
    expect(e.day).toBe(2) // entry session + one more close
    expect(e.gradesInSessions).toBe(9) // 10-session calibrated grade, minus the 1 session already elapsed past entry
    expect(e.verdict).toBe('intact') // <30 candles → no stage read, moving with the call
  })

  it('shorts are side-adjusted: falling price = positive move and progress', () => {
    const e = traceOpenCall(call({ side: 'short', stop: 105, target: 90 }), series([100, 96]), none)!
    expect(e.status).toBe('in-play')
    expect(e.movePct).toBe(4)
    expect(e.progressPct).toBe(40) // −4 of the −10 span
  })

  it('a short is stopped by a close ABOVE its stop', () => {
    const e = traceOpenCall(call({ side: 'short', stop: 105, target: 90 }), series([100, 106]), none)!
    expect(e.status).toBe('stopped')
  })

  it('re-qualifying on today’s board (same side) earns still-on', () => {
    const e = traceOpenCall(call(), series([100, 103]), new Set(['AAA:long']))!
    expect(e.requalified).toBe(true)
    expect(e.verdict).toBe('still-on')
  })

  it('the wrong side on today’s board does not count', () => {
    const e = traceOpenCall(call(), series([100, 103]), new Set(['AAA:short']))!
    expect(e.requalified).toBe(false)
  })

  it('drifting against the call inside the stop reads weakening', () => {
    const e = traceOpenCall(call(), series([100, 97]), none)!
    expect(e.status).toBe('in-play')
    expect(e.verdict).toBe('weakening')
  })

  it('the walk starts at the entry session even with prior history', () => {
    // 5 sessions of pre-call closes at 94 — below the stop, but before the call
    const before = series([94, 94, 94, 94, 94], -5)
    const after = series([100, 103])
    const e = traceOpenCall(call(), [...before, ...after], none)!
    expect(e.status).toBe('in-play')
    expect(e.day).toBe(2)
  })

  it('candles that never reach the call date → null (nothing to walk)', () => {
    expect(traceOpenCall(call({ date: '2026-08-01' }), series([100, 101]), none)).toBeNull()
    expect(traceOpenCall(call(), [], none)).toBeNull()
  })
})

// ---- the LIVE velocity trail (Task 6) ----
// Two tapes, both walked from a call dated 2026-07-01 with eight (or ten) sessions
// of prior history, because the trail needs the 8-EMA and the prior-five low.

/** A run that keeps running: the trail climbs from the published 96.5 to 100.56,
 *  then the tape closes 99 — six-and-a-half points ABOVE the published stop and
 *  1.21 BELOW the trail. Only a live trail can fire here. */
const runningTape = () => series([92, 93, 94, 95, 96, 97, 98, 99, 100, 103, 104, 105, 99], -8)

/** The mirror: a shelf whose five prior lows set the published stop at 98.5 and
 *  hold the trail flat AT it for the whole hold — no ratchet, nothing raised —
 *  then a fade that drags BOTH legs under it (98.4 by the last bar). The 98.45
 *  close is above the live trail and below the published stop. */
const fadingTape = () => series([80, 80, 80, 80, 80, 99, 99, 99, 99, 99, 100, 99.5, 99.2, 99, 99.3, 98.9, 98.45], -10)

/** RISE THEN FALL, the shape the ratchet exists for. Entry on 07-01 at 113 with the
 *  trail published at 96.56; the run carries it to 110 by day 3 and 110.5 on day 4
 *  (a wide bar that closes 111 but wicks to 100), and then the 8-EMA rolls the live
 *  trail back to 105.68 by day 5. The 107 close on day 5 is BELOW the 110.5 the tape
 *  earned and ABOVE where the trail happens to sit that morning. */
const riseThenFallTape = (): Candle[] => {
  const cs = series([70, 70, 70, 70, 70, 70, 70, 70, 110.5, 111, 112, 113, 114, 115, 111, 107], -11)
  cs[14] = { ...cs[14], l: 100 } // day 4's washout wick, which drops the low leg
  return cs
}

describe('traceOpenCall — the velocity trail is enforced daily', () => {
  it('a close under the RISEN trail (but above the published stop) reads as a trail hit', () => {
    const cs = runningTape()
    // the scenario, stated rather than assumed: the trail rose to 100.56 by 07-04…
    expect(velocityTrail(cs.slice(0, 12))).toBe(100.56)
    const e = traceOpenCall(call({ stop: 96.5, trail: 'velocity' }), cs, none)!
    expect(e.status).toBe('stopped')
    expect(e.crossedDate).toBe('2026-07-05')
    expect(e.note).toContain('trail hit')
    // …and 100.56 is the level that fired, not the published 96.5 and not the 100.21
    // the trail had already sagged to by the closing bar: the falsifier ratchets.
    expect(velocityTrail(cs)).toBe(100.21)
    expect(e.trailStop).toBe(100.56)
    expect(e.stop).toBe(96.5) // …and the published stop is reported unchanged: grading reads THAT
  })

  it('the trail RATCHETS: a falsifier that rose then rolled over still fires', () => {
    const cs = riseThenFallTape()
    // the scenario: 110 drawn on day 3, 110.5 on day 4, and by day 5 the live trail
    // has rolled back to 105.68 — BELOW the 107 close. Read as of today alone, this
    // position is comfortably alive; read against what the tape earned, it is dead.
    expect(velocityTrail(cs.slice(0, 14))).toBe(110)
    expect(velocityTrail(cs.slice(0, 15))).toBe(110.5)
    expect(velocityTrail(cs)).toBe(105.68)
    const e = traceOpenCall(call({ entry: 113, stop: 96.56, target: 130, trail: 'velocity' }), cs, none)!
    expect(e.status).toBe('stopped')
    expect(e.crossedDate).toBe('2026-07-05')
    expect(e.trailStop).toBe(110.5) // the high-water mark, not the 105.68 of the day
    expect(e.note).toContain('trail hit')
  })

  it('…and the identical tape without the marker is untouched — the ratchet is velocity-only', () => {
    const e = traceOpenCall(call({ entry: 113, stop: 96.56, target: 130 }), riseThenFallTape(), none)!
    expect(e.status).toBe('in-play') // a fixed stop is a fixed stop; 96.56 was never near
    expect(e.trailStop).toBeUndefined()
    expect(e.note).not.toContain('trail')
  })

  it('the SAME tape without the marker is untouched — one byte of difference on a dip row is a regression', () => {
    const e = traceOpenCall(call({ stop: 96.5 }), runningTape(), none)!
    expect(e.status).toBe('in-play')
    expect(e.crossedDate).toBeNull()
    expect(e.trailStop).toBeUndefined()
    expect(e.note).not.toContain('trail')
  })

  it('the trail never lowers the exit below the published stop', () => {
    const cs = fadingTape()
    expect(velocityTrail(cs)!).toBe(98.4) // the live trail has slid UNDER the published stop…
    const e = traceOpenCall(call({ stop: 98.5, target: 104, trail: 'velocity' }), cs, none)!
    expect(e.status).toBe('stopped') // …and 98.45 still closes through it
    expect(e.crossedDate).toBe('2026-07-07')
    expect(e.trailStop).toBe(98.5) // the published stop, never the 98.4 the tape would have allowed
    expect(e.note).not.toContain('trail hit') // nothing was raised — this is the ordinary stop
  })

  it('an open velocity row carries the level it is now judged against', () => {
    const e = traceOpenCall(call({ stop: 96.5, trail: 'velocity' }), runningTape().slice(0, 12), none)!
    expect(e.status).toBe('in-play')
    expect(e.trailStop).toBe(100.56)
    expect(e.note).toContain('trail at 100.56')
  })
})

describe('verdictFor — the opinion layer', () => {
  it('still-on is earned only by a re-qualification, never inferred', () => {
    expect(verdictFor('long', 'early-reversal', 5, false).verdict).toBe('intact')
    expect(verdictFor('long', 'falling-knife', 5, true).verdict).toBe('still-on')
  })

  it('hostile stages beat a positive move', () => {
    expect(verdictFor('long', 'falling-knife', 2, false).verdict).toBe('weakening')
    expect(verdictFor('long', 'exhausted', 8, false).verdict).toBe('weakening')
    expect(verdictFor('short', 'early-reversal', 2, false).verdict).toBe('weakening')
  })

  it('hostility is side-relative: trending is fine for a long, hostile for a short', () => {
    expect(verdictFor('long', 'trending', 1, false).verdict).toBe('intact')
    expect(verdictFor('short', 'trending', 1, false).verdict).toBe('weakening')
  })

  it('no stage read → judged on drift alone', () => {
    expect(verdictFor('long', null, -1, false).verdict).toBe('weakening')
    expect(verdictFor('long', null, 1, false).verdict).toBe('intact')
  })
})
