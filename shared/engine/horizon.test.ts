import { describe, it, expect } from 'vitest'
import { horizonOf } from './horizon'

describe('horizonOf', () => {
  it('an actionable A/B trade is a this-week call whatever its shape', () => {
    expect(horizonOf({ watchOnly: false, stage: 'basing', setup: 'reversal' })).toBe('week')
    expect(horizonOf({ watchOnly: false, stage: 'trending', setup: 'continuation' })).toBe('week')
    // a shadow/live row has watchOnly falsy too — still 'week'
    expect(horizonOf({})).toBe('week')
  })

  it('a below-base watch row is developing — tracked precisely because it has not earned this-week size', () => {
    expect(horizonOf({ watchOnly: true, belowBase: true, stage: 'trending', setup: 'continuation' })).toBe('developing')
  })

  it('a basing or pullback watch row is a multi-week build', () => {
    expect(horizonOf({ watchOnly: true, stage: 'basing', setup: 'continuation', evidence: { contract: true } })).toBe('developing')
    expect(horizonOf({ watchOnly: true, stage: 'pullback', setup: 'continuation', evidence: { contract: true } })).toBe('developing')
  })

  it('a thin-evidence reversal watch is a turn still forming — developing', () => {
    expect(horizonOf({ watchOnly: true, stage: 'early-reversal', setup: 'reversal', evidence: { contract: false } })).toBe('developing')
  })

  it('a reversal that CLEARED the evidence bar is not the thin-evidence case', () => {
    // fully-evidenced reversal watch on a non-build stage falls through to 'week'
    expect(horizonOf({ watchOnly: true, stage: 'trending', setup: 'reversal', evidence: { contract: true } })).toBe('week')
  })

  it('a plain grade-C continuation watch stays a short-horizon observation', () => {
    expect(horizonOf({ watchOnly: true, stage: 'weak', setup: 'continuation', evidence: { contract: true } })).toBe('week')
    expect(horizonOf({ watchOnly: true, stage: 'extended', setup: 'fade', evidence: { contract: true } })).toBe('week')
  })
})
