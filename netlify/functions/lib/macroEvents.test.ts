import { describe, it, expect } from 'vitest'
import { MACRO_ASSETS, detectShock, detectStretch, shockAnalogues } from './macroEvents'
import type { Candle } from '../../../shared/types'

const oil = MACRO_ASSETS[0]
const mk = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: i * 86_400, o: c, h: c, l: c, c, v: 1 }))

describe('detectShock', () => {
  it('fires on a one-day move beyond the asset threshold, with direction', () => {
    expect(detectShock(oil, mk([80, 86]))).toMatchObject({ kind: 'shock', dir: 'up', movePct: 7.5 })
    expect(detectShock(oil, mk([80, 75]))).toMatchObject({ dir: 'down' })
    expect(detectShock(oil, mk([80, 82]))).toBeNull() // +2.5% < 4%
  })
})

describe('detectStretch', () => {
  it('flags a parabolic extension above 2.5 sigma with hot RSI', () => {
    // 90 flat sessions then a relentless ramp
    const closes = [...Array(100).fill(80) as number[], ...Array.from({ length: 15 }, (_, i) => 82 + i * 3)]
    const s = detectStretch(oil, mk(closes))
    expect(s).toMatchObject({ kind: 'stretch', dir: 'up' })
    expect(s!.zScore).toBeGreaterThan(2.5)
    expect(detectStretch(oil, mk(Array(120).fill(80) as number[]))).toBeNull()
  })
})

describe('shockAnalogues', () => {
  it('measures what followed similar historical days', () => {
    // craft history: three +8% shock days, each followed by +5% over next 5 sessions
    const closes: number[] = [100]
    for (let k = 0; k < 3; k++) {
      closes.push(closes[closes.length - 1] * 1.08) // the shock day
      for (let d = 0; d < 5; d++) closes.push(closes[closes.length - 1] * 1.0098) // ≈ +5% over 5
      for (let d = 0; d < 20; d++) closes.push(closes[closes.length - 1]) // flat filler
    }
    const a = shockAnalogues(mk(closes), 8, 'up')
    expect(a.n).toBe(3)
    expect(a.median5).toBeGreaterThan(4)
    expect(a.median5).toBeLessThan(6)
  })
})
