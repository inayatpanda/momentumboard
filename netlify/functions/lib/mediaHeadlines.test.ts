import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMediaHeadlines, fetchMediaTitles, MEDIA_FEEDS } from './mediaHeadlines'

const NOW = Date.parse('2026-10-19T10:00:00Z') / 1000
const HOUR = 3600
const item = (title: string, at: number | null, source?: string) => `<item><title><![CDATA[${title}]]></title><link>https://news.example/${encodeURIComponent(title)}</link>${at == null ? '' : `<pubDate>${new Date(at * 1000).toUTCString()}</pubDate>`}${source ? `<source>${source}</source>` : ''}</item>`
const rss = (...items: string[]) => `<rss><channel><title>Channel title is not a headline</title>${items.join('')}</channel></rss>`
const fromFirstFeed = (body: string): typeof fetch => vi.fn(async url => new Response(String(url) === MEDIA_FEEDS[0][1] ? body : rss()))

afterEach(() => vi.useRealTimers())

describe('timely international media headlines', () => {
  it('excludes old, missing and implausibly future dates while retaining a 72-hour boundary and clock tolerance', async () => {
    const got = await fetchMediaTitles(fromFirstFeed(rss(
      item('Fresh market headline', NOW - HOUR), item('At the boundary', NOW - 72 * HOUR),
      item('Old historical story', NOW - 72 * HOUR - 1), item('Undated evergreen article', null),
      item('Bad future story', NOW + 301), item('Small publisher clock skew', NOW + 60),
    )), NOW)
    expect(got).toEqual(['[FT] Small publisher clock skew', '[FT] Fresh market headline', '[FT] At the boundary'])
  })

  it('decodes entities and deduplicates normalized titles across publishers', async () => {
    const fetchFn: typeof fetch = vi.fn(async url => new Response(String(url) === MEDIA_FEEDS[0][1]
      ? rss(item('Fed Holds Rates — Markets Rally', NOW - 60))
      : rss(item('  FED holds rates: markets rally!  ', NOW - 30), item('A different market story', NOW - 60))))
    const got = await fetchMediaHeadlines(fetchFn, NOW)
    expect(got).toHaveLength(2)
    expect(got[0].source).toBe('FT')
    expect(got[1].source).toBe('MarketWatch')
  })

  it('preserves article metadata and explicit source labels for Atom entries', async () => {
    const feed = `<feed><entry><title>Global growth &amp; energy demand</title><link rel="alternate" href="https://news.example/world"/><published>2026-10-19T09:00:00Z</published><source>Reuters</source></entry></feed>`
    expect(await fetchMediaHeadlines(fromFirstFeed(feed), NOW)).toEqual([{ title: 'Global growth & energy demand', url: 'https://news.example/world', publishedSec: NOW - HOUR, source: 'Reuters', feedSource: 'FT' }])
    expect(await fetchMediaTitles(fromFirstFeed(feed), NOW)).toEqual(['[Reuters] Global growth & energy demand'])
  })

  it('rejects HTTP error bodies and continues with healthy feeds', async () => {
    const fetchFn: typeof fetch = vi.fn(async url => {
      if (String(url) === MEDIA_FEEDS[0][1]) return new Response(rss(item('Error body must not become news', NOW)), { status: 503 })
      if (String(url) === MEDIA_FEEDS[1][1]) throw new Error('offline')
      return new Response(rss(item('Healthy feed story', NOW)))
    })
    expect(await fetchMediaTitles(fetchFn, NOW)).toEqual(['[CNBC] Healthy feed story'])
  })

  it('interleaves sources deterministically despite reversed response order, capped at 40', async () => {
    const resolvers = new Map<string, (response: Response) => void>()
    const fetchFn: typeof fetch = vi.fn(url => new Promise<Response>(resolve => resolvers.set(String(url), resolve)))
    const pending = fetchMediaHeadlines(fetchFn, NOW)
    for (const [source, url] of [...MEDIA_FEEDS].reverse()) resolvers.get(url)!(new Response(rss(...Array.from({ length: 10 }, (_, i) => item(`${source} headline ${i}`, NOW - i * 60)))))
    const got = await pending
    expect(got).toHaveLength(40)
    expect(got.slice(0, 7).map(row => row.source)).toEqual(MEDIA_FEEDS.map(([source]) => source))
    for (const [source] of MEDIA_FEEDS) expect(got.filter(row => row.source === source).length).toBeGreaterThanOrEqual(5)
  })

  it('bounds stalled fetches and body reads under one eight-second deadline', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetchFn: typeof fetch = vi.fn(async (url, init) => {
      signals.push(init!.signal as AbortSignal)
      if (String(url) === MEDIA_FEEDS[0][1]) return await new Promise<Response>(() => {})
      if (String(url) === MEDIA_FEEDS[1][1]) return { ok: true, text: () => new Promise<string>(() => {}) } as Response
      return new Response(rss(item('A healthy dated report', NOW)))
    })
    const pending = fetchMediaTitles(fetchFn, NOW)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await pending).toEqual(['[CNBC] A healthy dated report'])
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
