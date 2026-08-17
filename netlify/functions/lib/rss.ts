export interface FeedItem {
  title: string
  url: string
  publishedSec: number
  /** the publisher, when the feed names one — Google News items carry a
   * `<source>` tag (the outlet behind the aggregated link) */
  source?: string
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim()

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return m ? decode(m[1]) : null
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) ?? []
  for (const block of blocks) {
    const title = tag(block, 'title')
    // RSS2: <link>url</link>; Atom: <link rel="alternate" href="url"/>
    const url =
      tag(block, 'link') ||
      block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] ||
      block.match(/<link[^>]*href="([^"]+)"/)?.[1] ||
      null
    const dateStr = tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated')
    if (!title || !url) continue
    const parsed = dateStr ? Date.parse(dateStr) : NaN
    const source = tag(block, 'source')
    items.push({ title, url, publishedSec: Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000), ...(source ? { source } : {}) })
  }
  return items
}
