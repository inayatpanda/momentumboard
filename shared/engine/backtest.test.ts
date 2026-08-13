import { describe, expect, it } from 'vitest'
import { seedFromHistory } from './backtest'
import { CALIB_DEF_VERSION } from './calibration'
import type { Candle } from '../types'

// Synthetic but market-shaped: trending closes with sinusoidal pullbacks give
// the stage detector real basing/pullback/extension patterns to chew on.
const mk = (fn: (i: number) => number, days = 320): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: Date.parse('2025-01-02') / 1000 + i * 86_400, o: c, h: c * 1.02, l: c * 0.98, c, v: 1_000_000 + (i % 7) * 300_000 }
  })

const bySym = () =>
  new Map([
    ['UP', mk(i => 100 + i * 0.5 + 8 * Math.sin(i / 6))],
    ['DOWN', mk(i => 300 - i * 0.4 + 6 * Math.sin(i / 5))],
  ])

const spy = mk(i => 500 + i * 0.1)

describe('seedFromHistory', () => {
  it('is deterministic: same candles in → identical seed out', () => {
    const a = seedFromHistory(bySym(), spy)
    const b = seedFromHistory(bySym(), spy)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces non-trivial calibration and bounded weights, marked seeded with the current outcome definition', () => {
    const { weights, calibration } = seedFromHistory(bySym(), spy)
    const totalN = Object.values(calibration.buckets).reduce((s, b) => s + b.n, 0)
    expect(totalN).toBeGreaterThanOrEqual(5)
    expect(calibration.seeded).toBe(true)
    expect(calibration.defVersion).toBe(CALIB_DEF_VERSION)
    // a single closing nudge can move a weight at most ±15% of itself
    for (const name of Object.keys(weights.base) as (keyof typeof weights.base)[]) {
      expect(weights.current[name]).toBeGreaterThanOrEqual(0.4 * weights.base[name])
      expect(weights.current[name]).toBeLessThanOrEqual(2 * weights.base[name])
    }
  })

  it('accepts real QQQ and VIX series and stays deterministic; a panic VIX shifts calibration buckets toward red', () => {
    const qqq = mk(i => 400 + i * 0.08)
    const calmVix = mk(() => 14)
    const panicVix = mk(() => 40)
    const a = seedFromHistory(bySym(), spy, qqq, panicVix)
    const b = seedFromHistory(bySym(), spy, qqq, panicVix)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const calm = seedFromHistory(bySym(), spy, qqq, calmVix)
    const calmKeys = Object.keys(calm.calibration.buckets)
    const panicKeys = Object.keys(a.calibration.buckets)
    expect(panicKeys.every(k => k.includes(':red:'))).toBe(true)
    expect(JSON.stringify(calmKeys)).not.toBe(JSON.stringify(panicKeys))
  })

  // `fromISO` exists for the stage-2b reference sweep (spec §9): the reference a
  // grade is anchored to must be measured over the SAME window as the walk that
  // emitted the buckets, or it is a reading from another market epoch wearing this
  // one's clothes. Everything else about the sweep — the step, the warmup, the
  // gates, the hit rule — must stay the seeder's, which is why this is a bound on
  // the existing loop rather than a second implementation of it.
  describe('fromISO — the sweep can be bounded to the walk’s own window', () => {
    const rowsIn = (fromISO?: string) =>
      Object.values(seedFromHistory(bySym(), spy, undefined, undefined, fromISO ? { fromISO } : undefined).calibration.buckets).reduce(
        (s, b) => s + b.n,
        0,
      )

    it('samples strictly fewer sessions than the unbounded sweep, and none at all past the end', () => {
      const all = rowsIn()
      expect(all).toBeGreaterThan(0)
      // the tape runs 320 calendar days from 2025-01-02; a bound two-thirds in must bite
      expect(rowsIn('2025-08-01')).toBeGreaterThan(0)
      expect(rowsIn('2025-08-01')).toBeLessThan(all)
      expect(rowsIn('2099-01-01')).toBe(0) // a window after the tape measures nothing rather than everything
    })

    it('a bound at or before the first ENTRY session changes nothing — the window is a filter, not a re-slice', () => {
      // WARMUP still applies, and the bound is read on the entry session (bar i+1),
      // so a date under the tape's own start must leave the unbounded result intact.
      expect(rowsIn('2024-01-01')).toBe(rowsIn())
    })

    it('stays deterministic under the bound', () => {
      const a = seedFromHistory(bySym(), spy, undefined, undefined, { fromISO: '2025-06-01' })
      const b = seedFromHistory(bySym(), spy, undefined, undefined, { fromISO: '2025-06-01' })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    })
  })
})
