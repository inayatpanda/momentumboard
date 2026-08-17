import type { NewsItem } from '../../../shared/alerts'
import { exchangeFor } from '../../../shared/symbols'
import { parseFeed } from './rss'

const DAY = 24 * 3600

async function safeJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function safeText(url: string, fetchFn: typeof fetch): Promise<string> {
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  }
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

export interface SymbolNewsItem {
  title: string
  url: string
  publishedSec: number
}

/** "GraniteShares 3x Long Tesla Daily ETP" → "Tesla"; "Bitcoin USD" → "Bitcoin". */
export function cleanInstrumentName(name: string): string {
  const NOISE = /\b(graniteshares|wisdomtree|leverage shares|ishares|3x|2x|-1x|1x|long|short|daily|etp|etc|etn|usd|plc)\b/gi
  const cleaned = name.replace(NOISE, '').replace(/\s+/g, ' ').trim()
  return cleaned || name
}

/** News for ONE symbol: Finnhub company-news for US equities, Google News RSS otherwise. */
export async function fetchSymbolNews(
  symbol: string,
  finnhubKey: string,
  nowSec: number,
  fetchFn: typeof fetch = fetch,
  instrumentName?: string,
): Promise<SymbolNewsItem[]> {
  if (exchangeFor(symbol) === 'US') {
    const j = (await safeJson(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${iso(nowSec - 3 * DAY)}&to=${iso(nowSec)}&token=${finnhubKey}`,
      fetchFn,
    )) as { headline?: string; url?: string; datetime?: number }[] | null
    return (j ?? [])
      .filter(n => n.headline && n.url)
      .slice(0, 10)
      .map(n => ({ title: n.headline!, url: n.url!, publishedSec: n.datetime ?? 0 }))
  }
  const isCrypto = exchangeFor(symbol) === 'CRYPTO'
  const base = instrumentName ? cleanInstrumentName(instrumentName) : symbol.replace('-USD', '').replace('.L', '')
  const q = encodeURIComponent(isCrypto ? base : `${base} stock`)
  const xml = await safeText(`https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`, fetchFn)
  return parseFeed(xml)
    .slice(0, 10)
    .map(i => ({ title: i.title, url: i.url, publishedSec: i.publishedSec }))
}

/** The curated outlet sweep (owner 2026-08-17: "barrons, bloombergs, financial
 * times, etc — even if its just the headlines"). Headlines-and-links are what
 * the public feeds give away free. `source: null` means the feed names the
 * publisher per item (Google News `<source>`); a string hard-tags the whole
 * feed. Every lane fails soft like the rest of this file — a feed that stops
 * answering just contributes nothing that run. */
const OUTLET_FEEDS: { url: string; source: string | null }[] = [
  { url: 'https://www.ft.com/markets?format=rss', source: 'Financial Times' },
  { url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', source: 'Wall Street Journal' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', source: 'MarketWatch' },
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC' },
  { url: 'https://www.economist.com/finance-and-economics/rss.xml', source: 'The Economist' },
  // no public feed of their own — Google News' per-publisher lane carries the
  // headline, the link and a `<source>` naming the outlet
  { url: 'https://news.google.com/rss/search?q=site:bloomberg.com%20markets&hl=en-GB&gl=GB&ceid=GB:en', source: null },
  { url: 'https://news.google.com/rss/search?q=site:barrons.com&hl=en-GB&gl=GB&ceid=GB:en', source: null },
  { url: 'https://news.google.com/rss/search?q=site:reuters.com%20markets&hl=en-GB&gl=GB&ceid=GB:en', source: null },
]
const OUTLET_ITEMS_PER_FEED = 4

/** Finnhub per-symbol company news (US symbols only) + the outlet sweep +
 * stockmarketloop + Google News market RSS. */
export async function fetchNews(
  watchlist: string[],
  finnhubKey: string,
  nowSec: number,
  fetchFn: typeof fetch = fetch,
): Promise<NewsItem[]> {
  const out: NewsItem[] = []
  const usSymbols = watchlist.filter(s => exchangeFor(s) === 'US').slice(0, 15)
  const hasCrypto = watchlist.some(s => exchangeFor(s) === 'CRYPTO')

  await Promise.all([
    ...usSymbols.map(async sym => {
      const j = (await safeJson(
        `https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${iso(nowSec - DAY)}&to=${iso(nowSec)}&token=${finnhubKey}`,
        fetchFn,
      )) as { headline?: string; url?: string; datetime?: number; source?: string }[] | null
      for (const n of (j ?? []).slice(0, 5)) {
        // finnhub's `source` names the real outlet — the url is often a
        // finnhub.io redirect, so without it the desk reads as one wire
        if (n.headline && n.url) out.push({ title: n.headline, url: n.url, symbols: [sym], ...(n.source ? { source: n.source } : {}) })
      }
    }),
    ...OUTLET_FEEDS.map(async feed => {
      const xml = await safeText(feed.url, fetchFn)
      for (const item of parseFeed(xml).slice(0, OUTLET_ITEMS_PER_FEED)) {
        if (nowSec - item.publishedSec >= DAY) continue
        const source = feed.source ?? item.source
        out.push({ title: item.title, url: item.url, symbols: [], ...(source ? { source } : {}) })
      }
    }),
    (async () => {
      const xml = await safeText('https://stockmarketloop.com/feed/', fetchFn)
      for (const item of parseFeed(xml).slice(0, 10)) {
        if (nowSec - item.publishedSec < DAY) out.push({ title: item.title, url: item.url, symbols: [], source: 'Stockmarketloop' })
      }
    })(),
    (async () => {
      const xml = await safeText('https://news.google.com/rss/search?q=stock%20market&hl=en-GB&gl=GB&ceid=GB:en', fetchFn)
      for (const item of parseFeed(xml).slice(0, 10)) {
        if (nowSec - item.publishedSec < DAY) out.push({ title: item.title, url: item.url, symbols: [], ...(item.source ? { source: item.source } : {}) })
      }
    })(),
    (async () => {
      if (!hasCrypto) return
      const xml = await safeText('https://news.google.com/rss/search?q=bitcoin%20OR%20ethereum%20OR%20crypto&hl=en-GB&gl=GB&ceid=GB:en', fetchFn)
      for (const item of parseFeed(xml).slice(0, 8)) {
        if (nowSec - item.publishedSec < DAY) out.push({ title: item.title, url: item.url, symbols: [] })
      }
    })(),
  ])
  return out
}
