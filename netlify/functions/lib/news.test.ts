import { describe, expect, it } from 'vitest'
import { fetchNews, fetchSymbolNews } from './news'

/** A fetch that records every URL it is asked for and answers with an empty
 * body of the right shape — the news paths all fail soft, so an empty answer
 * exercises the routing without needing feed fixtures. */
function recordingFetch() {
  const urls: string[] = []
  const fetchFn = (async (url: string) => {
    urls.push(String(url))
    return {
      ok: true,
      json: async () => [],
      text: async () => '<rss><channel></channel></rss>',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { urls, fetchFn }
}

const NOW = Date.parse('2026-08-12T09:00:00Z') / 1000

describe('fetchSymbolNews — the venue the symbol actually lists on picks the query', () => {
  it('BT-A.L is an LSE equity: Google News for the STOCK, not the bare crypto query', async () => {
    const { urls, fetchFn } = recordingFetch()
    await fetchSymbolNews('BT-A.L', 'key', NOW, fetchFn)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('news.google.com') // not Finnhub company-news: it is not US
    expect(urls[0]).toContain(encodeURIComponent('BT-A stock')) // the crypto branch asked for bare "BT-A"
    expect(urls[0]).not.toContain('finnhub.io')
  })

  it('a real pair still gets the bare-name crypto query', async () => {
    const { urls, fetchFn } = recordingFetch()
    await fetchSymbolNews('ETH-USD', 'key', NOW, fetchFn)
    expect(urls[0]).toContain('q=ETH&')
    expect(urls[0]).not.toContain(encodeURIComponent('ETH stock'))
  })

  it('a dashed US share class reads the US endpoint', async () => {
    const { urls, fetchFn } = recordingFetch()
    await fetchSymbolNews('BRK-B', 'key', NOW, fetchFn)
    expect(urls[0]).toContain('finnhub.io/api/v1/company-news?symbol=BRK-B')
  })
})

describe('fetchNews — the crypto RSS fires only when the watchlist really holds a pair', () => {
  const cryptoFeed = (urls: string[]) => urls.filter(u => u.includes('bitcoin'))

  it('BT-A.L alone does NOT trigger the bitcoin/ethereum fetch', async () => {
    const { urls, fetchFn } = recordingFetch()
    await fetchNews(['BT-A.L'], 'key', NOW, fetchFn)
    expect(cryptoFeed(urls)).toHaveLength(0)
    expect(urls.filter(u => u.includes('company-news'))).toHaveLength(0) // still not a US read
  })

  it('a genuine pair still triggers it', async () => {
    const { urls, fetchFn } = recordingFetch()
    await fetchNews(['ETH-USD'], 'key', NOW, fetchFn)
    expect(cryptoFeed(urls)).toHaveLength(1)
  })

  it('BRK-B joins the US company-news set and triggers no crypto fetch', async () => {
    const { urls, fetchFn } = recordingFetch()
    await fetchNews(['BRK-B', 'RR.L'], 'key', NOW, fetchFn)
    expect(cryptoFeed(urls)).toHaveLength(0)
    expect(urls.filter(u => u.includes('company-news?symbol=BRK-B'))).toHaveLength(1)
    expect(urls.filter(u => u.includes('company-news?symbol=RR.L'))).toHaveLength(0)
  })
})
