import { describe, expect, it } from 'vitest'
import { DEFAULT_WEIGHTS, composeCall, type ComposeInput } from './composite'
import { AGGRESSIVE_GATES, MODERATE_GATES } from './catalyst'
import { catalystFactor } from './factors'
import type { FactorName, FactorScore } from './types'

const nullFactors = (): Record<FactorName, FactorScore> => ({
  technical: { score: null, detail: '' },
  momentum: { score: null, detail: '' },
  sector: { score: null, detail: '' },
  social: { score: null, detail: '' },
  channels: { score: null, detail: '' },
  insiders: { score: null, detail: '' },
  news: { score: null, detail: '' },
  seasonality: { score: null, detail: '' },
  smartMoney: { score: null, detail: '' },
  catalyst: { score: null, detail: '' },
})

const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  sym: 'TEST',
  factors: nullFactors(),
  weights: DEFAULT_WEIGHTS,
  regime: 'green',
  capacityPct: 10,
  atr: 2,
  lastClose: 100,
  entryQuality: 'early',
  stage: 'early-reversal',
  earningsWithinHorizon: false,
  capUsdM: 50_000,
  ...over,
})

const longFactors = (): Record<FactorName, FactorScore> => ({
  ...nullFactors(),
  technical: { score: 84, detail: 'early-reversal volume-confirmed' },
  momentum: { score: 40, detail: '+10pp' },
})

describe('composeCall', () => {
  it('all-null factors → no call', () => {
    expect(composeCall(base())).toBeNull()
  })

  it('strong long in green regime: side, sane levels, expected move', () => {
    const call = composeCall(base({ factors: longFactors() }))!
    expect(call.side).toBe('long')
    // (84·1 + 40·0.8) / 1.8 = 64.4, ×1.0 green
    expect(call.composite).toBeCloseTo(64.4, 1)
    expect(call.stop).toBeLessThan(call.entry)
    expect(call.target).toBeGreaterThan(call.entry)
    expect(call.stop).toBe(97) // 100 − 1.5×2 (large cap)
    expect(call.expectedMovePct).toBeCloseTo(6.4, 1) // 0.644 × 10
  })

  it('regime multiplier can push a modest long into the dead zone', () => {
    const modest = { ...nullFactors(), technical: { score: 40, detail: 'pullback' } }
    expect(composeCall(base({ factors: modest, entryQuality: 'early', stage: 'pullback' }))!.composite).toBeCloseTo(40, 1)
    expect(composeCall(base({ factors: modest, entryQuality: 'early', stage: 'pullback', regime: 'red' }))).toBeNull() // 40×0.55 = 22 < 25
  })

  it('dead zone: |composite| < 25 → null; boundary 25 passes', () => {
    const weak = { ...nullFactors(), technical: { score: 20, detail: 'basing' } }
    expect(composeCall(base({ factors: weak, stage: 'basing', entryQuality: 'neutral' }))).toBeNull()
    const boundary = { ...nullFactors(), technical: { score: 25, detail: 'basing' } }
    expect(composeCall(base({ factors: boundary, stage: 'basing', entryQuality: 'neutral' }))).not.toBeNull()
  })

  it('short from exhaustion in red regime: mirrored levels', () => {
    const shortF = { ...nullFactors(), technical: { score: -84, detail: 'exhausted' }, momentum: { score: -40, detail: '' } }
    const call = composeCall(base({ factors: shortF, regime: 'red', entryQuality: 'chase', stage: 'exhausted' }))!
    expect(call.side).toBe('short')
    expect(call.composite).toBeCloseTo(-70.9, 1) // −64.44 × 1.1
    expect(call.stop).toBeGreaterThan(call.entry)
    expect(call.target).toBeLessThan(call.entry)
  })

  it('side-aware gates: no chased longs, no shorts into fresh strength, knives wait', () => {
    expect(composeCall(base({ factors: longFactors(), entryQuality: 'chase', stage: 'extended' }))).toBeNull()
    const shortF = { ...nullFactors(), technical: { score: -60, detail: '' }, momentum: { score: -60, detail: '' } }
    expect(composeCall(base({ factors: shortF, stage: 'pullback', entryQuality: 'early' }))).toBeNull()
    expect(composeCall(base({ factors: longFactors(), entryQuality: 'wait', stage: 'falling-knife' }))).toBeNull()
  })

  it('capacity gate: can-not-move names never make calls', () => {
    expect(composeCall(base({ factors: longFactors(), capacityPct: 4 }))).toBeNull()
    expect(composeCall(base({ factors: longFactors(), capacityPct: null }))).toBeNull()
  })

  it('small caps get the wider stop', () => {
    const small = composeCall(base({ factors: longFactors(), capUsdM: 800 }))!
    expect(small.smallCap).toBe(true)
    expect(small.stop).toBe(96) // 100 − 2×2
  })

  it('missing atr or close → null; note names top factors', () => {
    expect(composeCall(base({ factors: longFactors(), atr: null }))).toBeNull()
    expect(composeCall(base({ factors: longFactors(), lastClose: null }))).toBeNull()
    expect(composeCall(base({ factors: longFactors() }))!.note).toContain('technical')
  })

  it('worldMult 0.85 pushes a marginal long under the dead zone → suppressed', () => {
    // single technical factor → composite == score; green regime ×1.0. Score 28
    // clears the 25 dead zone on its own, but the risk-off long nudge kills it.
    const marginal = { ...nullFactors(), technical: { score: 28, detail: 'basing' } }
    const bull = base({ factors: marginal, stage: 'basing', entryQuality: 'neutral' })
    expect(composeCall(bull)!.composite).toBeCloseTo(28, 1) // passes with no nudge
    expect(composeCall({ ...bull, worldMult: 0.85 })).toBeNull() // 28 × 0.85 = 23.8 < 25
  })

  it('worldMult 1.1 lifts a sub-threshold call over the dead zone → passes', () => {
    const under = { ...nullFactors(), technical: { score: 23, detail: 'basing' } }
    const bull = base({ factors: under, stage: 'basing', entryQuality: 'neutral' })
    expect(composeCall(bull)).toBeNull() // 23 < 25 with no nudge
    const lifted = composeCall({ ...bull, worldMult: 1.1 })! // 23 × 1.1 = 25.3 ≥ 25
    expect(lifted).not.toBeNull()
    expect(lifted.composite).toBeCloseTo(25.3, 1)
    expect(lifted.side).toBe('long') // a positive mult never flips the side
  })

  it('the world nudge scales conviction but leaves the side sign intact', () => {
    const shortF = { ...nullFactors(), technical: { score: -60, detail: 'exhausted' } }
    const bear = base({ factors: shortF, stage: 'exhausted', entryQuality: 'chase' })
    const plain = composeCall(bear)!
    const boosted = composeCall({ ...bear, worldMult: 1.1 })!
    expect(boosted.side).toBe('short')
    expect(Math.abs(boosted.composite)).toBeGreaterThan(Math.abs(plain.composite))
  })

  it('catalyst relaxes the capacity floor: a low-vol big name in the news gets a look', () => {
    // capacity 4 fails the ordinary floor (6) but clears the catalyst floor (4).
    const f = longFactors()
    const noCat = base({ factors: f, capacityPct: 4 })
    expect(composeCall(noCat)).toBeNull() // ordinary name, can't move → suppressed
    const withCat = base({
      factors: f,
      capacityPct: 4,
      catalyst: { kind: 'news', side: 'long', reason: 'oil spike', strength: 80 },
    })
    expect(composeCall(withCat)).not.toBeNull() // same chart, live catalyst → gets a look
  })

  it('catalyst is still gated: below the catalyst floor it is suppressed', () => {
    expect(
      composeCall(base({ factors: longFactors(), capacityPct: 2, catalyst: { kind: 'news', side: 'long', reason: 'x', strength: 90 } })),
    ).toBeNull() // capacity 2 < catalystCapacityFloor 4
  })

  it('catalyst factor casts a directional vote that can carry a marginal name over the dead zone', () => {
    // a quiet chart on its own makes no call; a strong long catalyst lifts it.
    const quiet = { ...nullFactors(), technical: { score: 15, detail: 'trending' } }
    expect(composeCall(base({ factors: quiet, stage: 'trending', entryQuality: 'neutral' }))).toBeNull() // 15 < 25
    const withVote = { ...quiet, catalyst: catalystFactor({ kind: 'news', side: 'long', reason: 'beneficiary', strength: 80 }) }
    const call = composeCall(base({ factors: withVote, stage: 'trending', entryQuality: 'neutral', catalyst: { kind: 'news', side: 'long', reason: 'beneficiary', strength: 80 } }))!
    expect(call).not.toBeNull()
    expect(call.side).toBe('long')
  })

  it('a short-side catalyst votes down and never flips a clearly-long name', () => {
    const vote = catalystFactor({ kind: 'news', side: 'short', reason: 'sanctioned', strength: 70 })
    expect(vote.score).toBeLessThan(0)
    const bull = { ...longFactors(), catalyst: vote }
    // catalyst drags conviction but the dominant technical keeps it long
    expect(composeCall(base({ factors: bull, catalyst: { kind: 'news', side: 'short', reason: 'sanctioned', strength: 70 } }))!.side).toBe('long')
  })

  it('aggressive gates lower the dead zone and capacity floors vs moderate', () => {
    const marginal = { ...nullFactors(), technical: { score: 22, detail: 'basing' } }
    const b = { factors: marginal, stage: 'basing' as const, entryQuality: 'neutral' as const, capacityPct: 5 }
    expect(composeCall(base({ ...b, gates: MODERATE_GATES }))).toBeNull() // 22 < 25 and cap 5 < 6
    expect(composeCall(base({ ...b, gates: AGGRESSIVE_GATES }))).not.toBeNull() // 22 ≥ 20 and cap 5 ≥ 5
  })
})
