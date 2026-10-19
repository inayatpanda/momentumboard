import { parseFeed } from './rss'

export const MEDIA_FEEDS: [string, string][] = [
  ['FT', 'https://www.ft.com/markets?format=rss'],
  ['MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'],
  ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  ["Barron's", 'https://www.barrons.com/xml/rss/3_7510.xml'],
  ['Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss'],
  // International context; inclusion does not imply ISA trading eligibility.
  ['ET India', 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms'],
  ['LiveMint', 'https://www.livemint.com/rss/markets'],
]

export interface MediaHeadline {
  title: string
  url: string
  publishedSec: number
  /** Item-level publisher when named; otherwise the configured feed label. */
  source: string
  feedSource: string
}

const MAX_AGE_SEC = 72 * 3600
const FUTURE_TOLERANCE_SEC = 5 * 60
const DEADLINE_MS = 8_000
const HEADLINE_LIMIT = 40
const clean = (text: string) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const headlineKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

async function fetchOneFeed(source: string, url: string, nowSec: number, fetchFn: typeof fetch): Promise<MediaHeadline[]> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('media-feed-timeout'))
    }, DEADLINE_MS)
  })
  try {
    // Race the entire request AND body read. A server can send headers promptly
    // and then stall its body; an abort-ignoring transport must still not hang.
    const xml = await Promise.race([
      (async () => {
        const response = await fetchFn(url, { headers: { 'user-agent': 'StreetSignal research inayatc2002@gmail.com' }, signal: controller.signal })
        if (!response.ok) throw new Error('media-feed-http-error')
        return response.text()
      })(),
      deadline,
    ])
    if (xml.length > 2_000_000) return []
    return parseFeed(xml)
      .filter(item => Number.isFinite(item.publishedSec) && item.publishedSec > 0
        && item.publishedSec >= nowSec - MAX_AGE_SEC && item.publishedSec <= nowSec + FUTURE_TOLERANCE_SEC)
      .map(item => ({ title: clean(item.title).slice(0, 240), url: item.url, publishedSec: item.publishedSec,
        source: clean(item.source ?? '').slice(0, 80) || source, feedSource: source }))
      .filter(item => item.title.length > 0 && /^https?:\/\//i.test(item.url))
      .sort((a, b) => b.publishedSec - a.publishedSec || a.title.localeCompare(b.title))
  } catch {
    return [] // one unavailable, malformed or undated feed cannot stop research
  } finally {
    clearTimeout(timer)
  }
}

/** Dated headlines only, newest within each source. Round-robin selection is
 * independent of network completion order and preserves international feeds
 * even when the fastest publisher supplies an unusually large edition. */
export async function fetchMediaHeadlines(fetchFn: typeof fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<MediaHeadline[]> {
  if (!Number.isFinite(nowSec)) return []
  const feeds = await Promise.all(MEDIA_FEEDS.map(([source, url]) => fetchOneFeed(source, url, nowSec, fetchFn)))
  const cursors = feeds.map(() => 0)
  const seen = new Set<string>()
  const out: MediaHeadline[] = []
  let added = true
  while (added && out.length < HEADLINE_LIMIT) {
    added = false
    for (let i = 0; i < feeds.length && out.length < HEADLINE_LIMIT; i++) {
      while (cursors[i] < feeds[i].length) {
        const item = feeds[i][cursors[i]++]
        const key = headlineKey(item.title)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(item)
        added = true
        break
      }
    }
  }
  return out
}

/** Existing engine consumers retain their source-labelled string contract. */
export async function fetchMediaTitles(fetchFn: typeof fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<string[]> {
  return (await fetchMediaHeadlines(fetchFn, nowSec)).map(item => `[${item.source}] ${item.title}`)
}
