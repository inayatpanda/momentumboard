import { describe, expect, it } from 'vitest'
import { seedFromHistory } from './backtest'
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

  it('produces non-trivial calibration and bounded weights, marked seeded', () => {
    const { weights, calibration } = seedFromHistory(bySym(), spy)
    const totalN = Object.values(calibration.buckets).reduce((s, b) => s + b.n, 0)
    expect(totalN).toBeGreaterThanOrEqual(5)
    expect(calibration.seeded).toBe(true)
    for (const name of Object.keys(weights.base) as (keyof typeof weights.base)[]) {
      expect(weights.current[name]).toBeGreaterThanOrEqual(0.4 * weights.base[name])
      expect(weights.current[name]).toBeLessThanOrEqual(2 * weights.base[name])
    }
  })
})
