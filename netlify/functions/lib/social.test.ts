import { describe, it, expect, vi } from 'vitest'
import { fetchRedditTrends, combineSocialPulse } from './social'

describe('fetchRedditTrends', () => {
  it('parses the apewisdom shape', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      results: [{ ticker: 'mu', name: 'Micron', rank: 1, mentions: '1098', mentions_24h_ago: '564' }],
    })))
    const t = await fetchRedditTrends(fetchFn as unknown as typeof fetch)
    expect(t[0]).toEqual({ ticker: 'MU', name: 'Micron', rank: 1, mentions: 1098, mentions24hAgo: 564 })
  })
})

describe('combineSocialPulse', () => {
  const reddit = [
    { ticker: 'MU', name: 'Micron', rank: 1, mentions: 1098, mentions24hAgo: 500 },
    { ticker: 'META', name: 'Meta', rank: 2, mentions: 512, mentions24hAgo: 100 },
  ]
  it('merges platforms, flags surges and cross-platform names, ranks by source count', () => {
    const rows = combineSocialPulse(reddit, ['MU', 'NVDA'], [{ sym: 'MU', net: 3 }], ['META'])
    const mu = rows.find(r => r.sym === 'MU')!
    expect(mu.sources).toBe(3) // reddit + stocktwits + channels
    expect(mu.surging).toBe(true) // 1098 vs 500 ≥ 2x
    expect(mu.channelNet).toBe(3)
    expect(rows[0].sym).toBe('MU') // most sources first
    const meta = rows.find(r => r.sym === 'META')!
    expect(meta.onWatchlist).toBe(true)
    expect(meta.surging).toBe(true)
    const nvda = rows.find(r => r.sym === 'NVDA')!
    expect(nvda.stocktwits).toBe(true)
    expect(nvda.redditMentions).toBeNull()
  })
})
