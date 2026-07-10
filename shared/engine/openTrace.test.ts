import { describe, expect, it } from 'vitest'
import { traceOpenCall, verdictFor } from './openTrace'
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
    expect(e.gradesInSessions).toBe(4)
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
