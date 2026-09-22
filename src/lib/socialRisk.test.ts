import { describe, expect, it } from 'vitest'
import { assessSocialRisk } from './socialRisk'

describe('social risk', () => {
  it('flags a fresh one-platform micro-cap burst as high risk', () => {
    const read = assessSocialRisk({ capUsdM: 120, surgeMultiple: 6, sources: 1, redditMentions: 140, firstSeenAt: 9_000, observedDays: 1 }, 10_000)
    expect(read.level).toBe('high')
    expect(read.stage).toBe('new')
    expect(read.reasons).toContain('single-platform signal')
  })

  it('credits cross-platform confirmation without calling it safe', () => {
    const read = assessSocialRisk({ capUsdM: 8_000, surgeMultiple: 2.4, sources: 3, redditMentions: 90, firstSeenAt: 1_000, observedDays: 3 }, 300_000)
    expect(read.level).toBe('lower')
    expect(read.stage).toBe('accelerating')
    expect(read.reasons).toContain('3-platform confirmation')
  })
})
