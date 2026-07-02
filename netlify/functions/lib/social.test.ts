import { describe, it, expect, vi } from 'vitest'
import { fetchRedditTrends, combineSocialPulse, pickDiscoveries } from './social'

describe('fetchRedditTrends', () => {
  it('parses the apewisdom shape', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      results: [{ ticker: 'mu', name: 'Micron', rank: 1, mentions: '1098', mentions_24h_ago: '564' }],
    })))
    const t = await fetchRedditTrends(fetchFn as unknown as typeof fetch)
    expect(t[0]).toEqual({ ticker: 'MU', name: 'Micron', rank: 1, mentions: 1098, mentions24hAgo: 564 })
  })
})

describe('pickDiscoveries', () => {
  const row = (sym: string, over: object = {}) => ({
    sym, redditRank: 5, redditMentions: 100, surging: true, surgeMultiple: null as number | null,
    stocktwits: true, channelNet: null, sources: 2, onWatchlist: false, ...over,
  })
  it('excludes mega-caps and oversized names, keeps surging small caps, ranks by surge', () => {
    const d = pickDiscoveries([
      row('NVDA', { surgeMultiple: 5 }), // mega: out, however loud
      row('BIGCO', { capUsdM: 80_000, surgeMultiple: 4 }), // too big: out
      row('NBIS', { capUsdM: 8_000, surgeMultiple: 2.2 }),
      row('TINY', { capUsdM: null, surgeMultiple: 3.1 }), // unknown cap allowed
      row('QUIET', { capUsdM: 500, surging: false, sources: 1 }), // no momentum: out
    ])
    expect(d.map(x => x.sym)).toEqual(['TINY', 'NBIS'])
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
