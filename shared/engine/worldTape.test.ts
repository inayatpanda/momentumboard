import { describe, expect, it } from 'vitest'
import { newsTone, worldMult, worldTone, WORLD_SYMBOLS, type WorldRead } from './worldTape'

const reads = (pcts: (number | null)[]): WorldRead[] =>
  pcts.map((changePct, i) => ({ sym: `IDX${i}`, name: `Index ${i}`, changePct }))

describe('worldTone', () => {
  it('four-plus red indices with no green → risk-off', () => {
    const t = worldTone(reads([-1.2, -1.5, -0.9, -1.0, 0.1, 0.2]), null)
    expect(t.votes).toEqual({ on: 0, off: 4 })
    expect(t.tone).toBe('risk-off')
    expect(t.detail).toContain('risk-off')
  })

  it('four-plus green indices with no red → risk-on', () => {
    const t = worldTone(reads([1.2, 1.5, 0.9, 1.0, -0.1, -0.2]), null)
    expect(t.votes).toEqual({ on: 4, off: 0 })
    expect(t.tone).toBe('risk-on')
  })

  it('the ±0.75 threshold is inclusive at the boundary and quiet just inside it', () => {
    expect(worldTone(reads([-0.75, -0.75, -0.75, -0.75, 0, 0]), null).votes).toEqual({ on: 0, off: 4 })
    // −0.74 is inside the dead band → no vote
    expect(worldTone(reads([-0.74, -0.74, -0.74, -0.74, 0, 0]), null).votes).toEqual({ on: 0, off: 0 })
    expect(worldTone(reads([0.75, 0.75, 0.75, 0.75, 0, 0]), null).votes).toEqual({ on: 4, off: 0 })
  })

  it('a lone green vote does not stop risk-off (off≥4, on≤1)', () => {
    const t = worldTone(reads([-1, -1, -1, -1, 1, 0]), null)
    expect(t.votes).toEqual({ on: 1, off: 4 })
    expect(t.tone).toBe('risk-off')
  })

  it('two green votes break the risk-off gate → mixed', () => {
    const t = worldTone(reads([-1, -1, -1, -1, 1, 1]), null)
    expect(t.votes).toEqual({ on: 2, off: 4 })
    expect(t.tone).toBe('mixed')
  })

  it('null reads cast no vote', () => {
    const t = worldTone(reads([null, null, -1, -1, -1, null]), null)
    expect(t.votes).toEqual({ on: 0, off: 3 })
    expect(t.tone).toBe('mixed') // only 3 off votes — short of the 4-vote gate
  })

  it('a VIX spike (+5% or more) adds one extra off vote — enough to tip risk-off', () => {
    // 3 red indices (off 3) + VIX +6% (off +1) = off 4, on 0 → risk-off
    const t = worldTone(reads([-1, -1, -1, 0, 0, 0]), 6)
    expect(t.votes).toEqual({ on: 0, off: 4 })
    expect(t.tone).toBe('risk-off')
    expect(t.detail).toContain('VIX')
  })

  it('a VIX collapse (−5% or less) adds one extra on vote', () => {
    const t = worldTone(reads([1, 1, 1, 0, 0, 0]), -7)
    expect(t.votes).toEqual({ on: 4, off: 0 })
    expect(t.tone).toBe('risk-on')
  })

  it('VIX inside ±5% casts no extra vote', () => {
    const t = worldTone(reads([-1, -1, -1, 0, 0, 0]), 4.9)
    expect(t.votes).toEqual({ on: 0, off: 3 })
    expect(t.tone).toBe('mixed')
  })

  it('empty / all-null reads → mixed, zero votes', () => {
    expect(worldTone([], null).tone).toBe('mixed')
    expect(worldTone(reads([null, null]), null).votes).toEqual({ on: 0, off: 0 })
  })

  it('a Nifty 50 read votes under the same ±0.75% rule as the rest of the panel', () => {
    const withNifty: WorldRead[] = [...reads([-1, -1, -1, 0, 0, 0]), { sym: '^NSEI', name: 'Nifty 50', changePct: -1.5 }]
    const t = worldTone(withNifty, null)
    expect(t.votes).toEqual({ on: 0, off: 4 }) // 3 red indices + a red Nifty 50 tips the gate
    expect(t.tone).toBe('risk-off')
    expect(t.detail).toContain('Nifty 50 -1.5%')
  })
})

describe('WORLD_SYMBOLS', () => {
  it("includes Nifty 50 — India's session is live at the engine's 05:20 UTC run", () => {
    expect(WORLD_SYMBOLS).toContainEqual({ sym: '^NSEI', name: 'Nifty 50' })
  })
})

describe('worldMult', () => {
  it('risk-off nudges longs down and shorts up', () => {
    expect(worldMult('risk-off', 'long')).toBe(0.85)
    expect(worldMult('risk-off', 'short')).toBe(1.1)
  })
  it('risk-on nudges longs up and shorts down', () => {
    expect(worldMult('risk-on', 'long')).toBe(1.1)
    expect(worldMult('risk-on', 'short')).toBe(0.85)
  })
  it('mixed is neutral both sides', () => {
    expect(worldMult('mixed', 'long')).toBe(1)
    expect(worldMult('mixed', 'short')).toBe(1)
  })
})

describe('newsTone', () => {
  it('sums polarity across ALL titles and labels sour below −4', () => {
    const t = newsTone([
      'Stocks plunge as banks miss and downgrade fears mount',
      'Chipmaker sinks, cuts outlook; recall probe widens',
    ])
    expect(t.score).toBeLessThanOrEqual(-4)
    expect(t.label).toBe('sour')
    expect(t.hits).toBeGreaterThan(0)
  })

  it('labels upbeat at or above +4', () => {
    const t = newsTone([
      'Markets surge as earnings beat and upgrades pour in',
      'Index soars to record; rally tops estimates, jumps on wins',
    ])
    expect(t.score).toBeGreaterThanOrEqual(4)
    expect(t.label).toBe('upbeat')
  })

  it('a quiet tape between the thresholds is neutral', () => {
    expect(newsTone(['Fed holds rates steady as officials weigh data']).label).toBe('neutral')
    expect(newsTone([]).label).toBe('neutral')
    expect(newsTone([]).score).toBe(0)
  })

  it('the ±4 boundary is inclusive', () => {
    expect(newsTone(['beat beats surge soar']).score).toBe(4) // 4 positives
    expect(newsTone(['beat beats surge soar']).label).toBe('upbeat')
    expect(newsTone(['miss misses plunge sink']).score).toBe(-4)
    expect(newsTone(['miss misses plunge sink']).label).toBe('sour')
  })
})
