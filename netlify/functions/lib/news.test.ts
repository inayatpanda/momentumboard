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

// THE OUTLETS (owner 2026-08-17, with a screenshot of a desk that was 100%
// finnhub.io): "i was hoping for barrons, bloombergs, financial times, etc —
// even if its just the headlines." Headlines-and-links is exactly what the
// public feeds give away free, so the desk gains a curated outlet sweep, and
// every item — outlet or finnhub — now carries WHO published it.
describe('fetchNews — the outlet sweep and the source field', () => {
  it('sweeps the big outlets: FT, WSJ, MarketWatch, CNBC, Economist, plus the Google News lanes for Bloomberg, Barron’s and Reuters', async () => {
    const { urls, fetchFn } = recordingFetch()
    await fetchNews([], 'key', NOW, fetchFn)
    const hit = (frag: string) => urls.some(u => u.includes(frag))
    expect(hit('ft.com')).toBe(true)
    expect(hit('dowjones.io')).toBe(true) // WSJ + MarketWatch public feeds
    expect(hit('cnbc.com')).toBe(true)
    expect(hit('economist.com')).toBe(true)
    expect(hit('bloomberg.com')).toBe(true)
    expect(hit('barrons.com')).toBe(true)
    expect(hit('reuters.com')).toBe(true)
  })

  it('a single-outlet feed hard-tags its items with the outlet name', async () => {
    const rss = (title: string) =>
      `<rss><channel><item><title>${title}</title><link>https://example.org/a</link><pubDate>Wed, 12 Aug 2026 08:00:00 GMT</pubDate></item></channel></rss>`
    const fetchFn = (async (url: string) => {
      const u = String(url)
      return {
        ok: true,
        json: async () => [],
        text: async () => (u.includes('ft.com') ? rss('FT headline') : '<rss><channel></channel></rss>'),
      } as unknown as Response
    }) as unknown as typeof fetch
    const items = await fetchNews([], 'key', NOW, fetchFn)
    const ft = items.find(i => i.title === 'FT headline')
    expect(ft?.source).toBe('Financial Times')
  })

  it('finnhub company-news items carry finnhub’s own source field — the real outlet, not finnhub.io', async () => {
    const fetchFn = (async (url: string) => {
      const u = String(url)
      return {
        ok: true,
        json: async () =>
          u.includes('finnhub.io') ? [{ headline: 'NVDA pops', url: 'https://finnhub.io/api/news?id=1', datetime: NOW - 60, source: 'MarketWatch' }] : [],
        text: async () => '<rss><channel></channel></rss>',
      } as unknown as Response
    }) as unknown as typeof fetch
    const items = await fetchNews(['NVDA'], 'key', NOW, fetchFn)
    const row = items.find(i => i.title === 'NVDA pops')
    expect(row?.source).toBe('MarketWatch')
  })

  it('a Google News lane reads the item’s <source> tag for the publisher', async () => {
    const gnews =
      '<rss><channel><item><title>Big move - Bloomberg</title><link>https://news.google.com/rss/articles/x</link><pubDate>Wed, 12 Aug 2026 08:00:00 GMT</pubDate><source url="https://www.bloomberg.com">Bloomberg</source></item></channel></rss>'
    const fetchFn = (async (url: string) => {
      const u = String(url)
      return {
        ok: true,
        json: async () => [],
        text: async () => (u.includes('bloomberg.com') ? gnews : '<rss><channel></channel></rss>'),
      } as unknown as Response
    }) as unknown as typeof fetch
    const items = await fetchNews([], 'key', NOW, fetchFn)
    const row = items.find(i => i.title.startsWith('Big move'))
    expect(row?.source).toBe('Bloomberg')
  })
})
