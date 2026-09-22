import { describe, expect, it } from 'vitest'
import { buildSocialMemory } from './socialMemory'

describe('buildSocialMemory', () => {
  it('groups durable social observations and YouTube theses by stock and date', () => {
    const days = buildSocialMemory('ABC', [
      { observedAt: 1_777_507_200, rows: [{ sym: 'ABC', sources: 2, redditRank: 5, redditMentions: 40, surgeMultiple: 2.5, stocktwits: true, channelNet: 1 }] },
    ], [
      { at: 1_777_510_000, title: 'ABC setup', channel: 'Analyst One', url: 'https://youtube.test/a', themes: [], tickers: [{ sym: 'ABC', stance: 'bull', thesis: 'A launch could expand revenue.', levels: [12], hype: false }] },
      { at: 1_777_510_001, title: 'Other', channel: 'Analyst Two', url: 'https://youtube.test/b', themes: [], tickers: [{ sym: 'XYZ', stance: 'bear', levels: [] }] },
    ])

    expect(days).toHaveLength(1)
    expect(days[0].metrics).toMatchObject({ redditMentions: 40, stocktwits: true })
    expect(days[0].youtube).toHaveLength(1)
    expect(days[0].summary).toContain('Reddit recorded 40 mentions')
    expect(days[0].summary).toContain('A launch could expand revenue')
  })

  it('keeps older sparse observations readable', () => {
    const [day] = buildSocialMemory('OLD', [{ observedAt: 100, rows: [{ sym: 'OLD', redditMentions: null, sources: 2 }] }], [])
    expect(day.summary).toContain('older snapshot')
    expect(day.metrics.evidenceScore).toBeNull()
  })
})
