import { describe, it, expect } from 'vitest'
import { runBacktest } from './backtest'
import type { Candle } from './types'

const mk = (closes: number[], vols?: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i * 86_400, o: c, h: c * 1.01, l: c * 0.99, c, v: vols?.[i] ?? 1000 }))

const falling = (n: number, start: number, step: number) => Array.from({ length: n }, (_, i) => start - i * step)

describe('runBacktest', () => {
  it('finds a reclaim signal in a decline→base→pop history and measures forward returns', () => {
    // decline, drifting base, volume pop above the 20-day, then a clean +1/day run-up
    const decline = falling(30, 100, 1.2)
    const base = Array.from({ length: 25 }, (_, i) => 64 + (i % 3) + i * 0.03) // ends on a low bar, below the 20-day
    const after = Array.from({ length: 25 }, (_, i) => 68 + i)
    const closes = [...decline, ...base, ...after]
    const vols = closes.map(() => 1000)
    vols[decline.length + base.length] = 2600 // the pop bar
    const { signals, summary } = runBacktest(mk(closes, vols))
    const reclaim = signals.find(s => s.setup === 'reclaim')
    expect(reclaim).toBeDefined()
    expect(reclaim!.fwd.d5).toBeGreaterThan(0) // +1/day follow-through
    const row = summary.find(r => r.setup === 'reclaim')!
    expect(row.n).toBeGreaterThanOrEqual(1)
    expect(row.win5).toBeGreaterThan(0)
  })

  it('computes forward returns exactly and leaves the tail null', () => {
    // force a single deterministic signal near the end and verify null horizon handling
    const closes = [...falling(30, 100, 1.5), ...Array.from({ length: 20 }, (_, i) => 55 + (i % 3) + i * 0.03)]
    const { signals } = runBacktest(mk(closes))
    for (const s of signals) {
      if (s.index + 20 >= closes.length) expect(s.fwd.d20).toBeNull()
      if (s.fwd.d5 != null) expect(s.fwd.d5).toBeCloseTo(((closes[s.index + 5] - s.price) / s.price) * 100, 6)
    }
  })
})
