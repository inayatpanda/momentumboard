import { describe, expect, it } from 'vitest'
import {
  AGGRESSIVE_GATES,
  DIP_CATALYST_KIND,
  LANE_CATALYST_KINDS,
  MODERATE_GATES,
  VELOCITY_CATALYST_KIND,
  WILDCARD_CATALYST_KIND,
  gatesFor,
  type CatalystTag,
} from './catalyst'

// The LANE FAMILY is the engine's one answer to "is this row's composite a
// structural lane construction rather than a measured factor vote?". Three
// consumers read it and none can see the others (the factor-IC guard in
// gradeOutstanding, the world-tape stamp in publishCall, the "in the news today"
// filter on the desk), so the membership lives here, once, and is pinned by these
// tests.
describe('lane catalyst kinds', () => {
  it('names BOTH structural lanes — dip and velocity — plus the experiment slot, and nothing else', () => {
    expect(DIP_CATALYST_KIND).toBe('dip')
    expect(VELOCITY_CATALYST_KIND).toBe('velocity')
    expect(WILDCARD_CATALYST_KIND).toBe('wildcard')
    // the wildcard joins on the family's own argument: its composite is the
    // gate-free CORE read carried off a near-miss row, so no factor voted on the
    // row that published and no worldMult was ever applied to it
    expect([...LANE_CATALYST_KINDS].sort()).toEqual(['dip', 'velocity', 'wildcard'])
  })

  it('a velocity tag is a legal CatalystTag, and every pre-existing kind survives', () => {
    const tag: CatalystTag = { kind: VELOCITY_CATALYST_KIND, side: 'long', reason: 'breakout · 3.1× volume', strength: 40 }
    expect(LANE_CATALYST_KINDS.has(tag.kind)).toBe(true)
    // the union only ever GROWS: a removed member would break this list at compile time
    const kinds: CatalystTag['kind'][] = ['news', 'event', 'ipo', 'listing', 'earnings', DIP_CATALYST_KIND, VELOCITY_CATALYST_KIND, WILDCARD_CATALYST_KIND]
    expect(new Set(kinds).size).toBe(8)
  })

  it('an ordinary news/ipo catalyst is NOT a lane kind — it casts a measured vote and must keep learning', () => {
    expect(LANE_CATALYST_KINDS.has('news')).toBe(false)
    expect(LANE_CATALYST_KINDS.has('ipo')).toBe(false)
    expect(LANE_CATALYST_KINDS.has('')).toBe(false) // the `?? ''` fallback of an untagged row
  })
})

// Two numbers per appetite, and no third: the flat capacity floors are gone, so
// there is nothing left in Gates that asks what volatility CLASS a name belongs
// to. Eligibility is the move a call expects of the name in front of it.
describe('gates', () => {
  it('moderate asks for 1.5% of expected move, aggressive for 1.0%', () => {
    expect(MODERATE_GATES).toEqual({ deadZone: 25, minExpectedMovePct: 1.5 })
    expect(AGGRESSIVE_GATES).toEqual({ deadZone: 20, minExpectedMovePct: 1.0 })
    expect(AGGRESSIVE_GATES.minExpectedMovePct).toBeLessThan(MODERATE_GATES.minExpectedMovePct)
  })

  it('gatesFor: only the literal "aggressive" widens the funnel', () => {
    expect(gatesFor('aggressive')).toBe(AGGRESSIVE_GATES)
    expect(gatesFor('moderate')).toBe(MODERATE_GATES)
    expect(gatesFor(null)).toBe(MODERATE_GATES)
    expect(gatesFor(undefined)).toBe(MODERATE_GATES)
  })
})
