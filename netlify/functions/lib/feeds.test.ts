import { describe, it, expect, vi } from 'vitest'
import { fetchNews } from './news'
import { fetchVideos } from './youtube'

const NOW = 1_800_000_000

const finnhubNews = JSON.stringify([
  { headline: 'Apple ships new thing', url: 'https://n/apple1', datetime: NOW - 100 },
])
const smlFeed = `<rss><channel><item><title>Markets wobble</title><link>https://sml/1</link><pubDate>${new Date((NOW - 3600) * 1000).toUTCString()}</pubDate></item></channel></rss>`
const ytFeed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>TSLA video</title><link rel="alternate" href="https://yt/v1"/><published>${new Date((NOW - 7200) * 1000).toISOString()}</published></entry></feed>`

describe('fetchNews', () => {
  it('merges finnhub symbol news with RSS sources, tagging symbols', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('finnhub')) return new Response(finnhubNews)
      if (url.includes('stockmarketloop')) return new Response(smlFeed)
      return new Response('<rss><channel></channel></rss>') // google news empty
    })
    const items = await fetchNews(['AAPL', '3LTS.L'], 'key', NOW, fetchFn as unknown as typeof fetch)
    const apple = items.find(i => i.url === 'https://n/apple1')
    expect(apple?.symbols).toEqual(['AAPL'])
    expect(items.find(i => i.url === 'https://sml/1')?.symbols).toEqual([])
    // .L symbol must not hit finnhub company-news
    expect(fetchFn.mock.calls.filter(c => String(c[0]).includes('company-news'))).toHaveLength(1)
  })
  it('survives a dead source', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('stockmarketloop')) throw new Error('down')
      return new Response(finnhubNews)
    })
    const items = await fetchNews(['AAPL'], 'key', NOW, fetchFn as unknown as typeof fetch)
    expect(items.length).toBeGreaterThan(0)
  })
})

describe('cleanInstrumentName', () => {
  it('extracts the underlying from ETP boilerplate', async () => {
    const { cleanInstrumentName } = await import('./news')
    expect(cleanInstrumentName('GraniteShares 3x Long Tesla Daily ETP')).toBe('Tesla')
    expect(cleanInstrumentName('Bitcoin USD')).toBe('Bitcoin')
  })
})

describe('fetchVideos', () => {
  it('maps feed entries to videos with channel names, skipping stale ones', async () => {
    const fetchFn = vi.fn(async () => new Response(ytFeed))
    const vids = await fetchVideos([{ id: 'UC1', name: 'Stocks with Josh' }], NOW, fetchFn as unknown as typeof fetch)
    expect(vids).toEqual([{ title: 'TSLA video', url: 'https://yt/v1', channel: 'Stocks with Josh' }])
  })
})
