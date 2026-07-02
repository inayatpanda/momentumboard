import type { NewsItem } from '../../shared/alerts'
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

/** Finnhub per-symbol company news (US symbols only) + stockmarketloop + Google News market RSS. */
export async function fetchNews(
  watchlist: string[],
  finnhubKey: string,
  nowSec: number,
  fetchFn: typeof fetch = fetch,
): Promise<NewsItem[]> {
  const out: NewsItem[] = []
  const usSymbols = watchlist.filter(s => !s.includes('.')).slice(0, 15)

  await Promise.all([
    ...usSymbols.map(async sym => {
      const j = (await safeJson(
        `https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${iso(nowSec - DAY)}&to=${iso(nowSec)}&token=${finnhubKey}`,
        fetchFn,
      )) as { headline?: string; url?: string; datetime?: number }[] | null
      for (const n of (j ?? []).slice(0, 5)) {
        if (n.headline && n.url) out.push({ title: n.headline, url: n.url, symbols: [sym] })
      }
    }),
    (async () => {
      const xml = await safeText('https://stockmarketloop.com/feed/', fetchFn)
      for (const item of parseFeed(xml).slice(0, 10)) {
        if (nowSec - item.publishedSec < DAY) out.push({ title: item.title, url: item.url, symbols: [] })
      }
    })(),
    (async () => {
      const xml = await safeText('https://news.google.com/rss/search?q=stock%20market&hl=en-GB&gl=GB&ceid=GB:en', fetchFn)
      for (const item of parseFeed(xml).slice(0, 10)) {
        if (nowSec - item.publishedSec < DAY) out.push({ title: item.title, url: item.url, symbols: [] })
      }
    })(),
  ])
  return out
}
