import { describe, expect, it } from 'vitest'
import { DIP_CATALYST_KIND, LANE_CATALYST_KINDS, VELOCITY_CATALYST_KIND, type CatalystTag } from './catalyst'

// The LANE FAMILY is the engine's one answer to "is this row's composite a
// structural lane construction rather than a measured factor vote?". Two
// consumers read it and neither can see the other (the factor-IC guard in
// gradeOutstanding, the world-tape stamp in publishCall), so the membership
// lives here, once, and is pinned by these tests.
describe('lane catalyst kinds', () => {
  it('names BOTH structural lanes — dip and velocity — and nothing else', () => {
    expect(DIP_CATALYST_KIND).toBe('dip')
    expect(VELOCITY_CATALYST_KIND).toBe('velocity')
    expect([...LANE_CATALYST_KINDS].sort()).toEqual(['dip', 'velocity'])
  })

  it('a velocity tag is a legal CatalystTag, and every pre-existing kind survives', () => {
    const tag: CatalystTag = { kind: VELOCITY_CATALYST_KIND, side: 'long', reason: 'breakout · 3.1× volume', strength: 40 }
    expect(LANE_CATALYST_KINDS.has(tag.kind)).toBe(true)
    // the union only ever GROWS: a removed member would break this list at compile time
    const kinds: CatalystTag['kind'][] = ['news', 'event', 'ipo', 'listing', 'earnings', DIP_CATALYST_KIND, VELOCITY_CATALYST_KIND]
    expect(new Set(kinds).size).toBe(7)
  })

  it('an ordinary news/ipo catalyst is NOT a lane kind — it casts a measured vote and must keep learning', () => {
    expect(LANE_CATALYST_KINDS.has('news')).toBe(false)
    expect(LANE_CATALYST_KINDS.has('ipo')).toBe(false)
    expect(LANE_CATALYST_KINDS.has('')).toBe(false) // the `?? ''` fallback of an untagged row
  })
})
