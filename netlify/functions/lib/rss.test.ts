import { describe, it, expect } from 'vitest'
import { parseFeed } from './rss'

const rss2 = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>Stockmarketloop.com</title>
<item>
  <title><![CDATA[Fed holds rates & markets rally]]></title>
  <link>https://stockmarketloop.com/fed-holds</link>
  <pubDate>Wed, 01 Jul 2026 19:16:15 +0000</pubDate>
</item>
<item>
  <title>NVDA earnings preview</title>
  <link>https://stockmarketloop.com/nvda-preview</link>
  <pubDate>Wed, 01 Jul 2026 15:00:00 +0000</pubDate>
</item>
</channel></rss>`

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <title>Stocks with Josh</title>
 <entry>
  <id>yt:video:abc123</id>
  <title>Why I&#39;m buying TSLA now</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
  <published>2026-07-01T18:00:00+00:00</published>
 </entry>
</feed>`

describe('parseFeed', () => {
  it('parses RSS2 items with CDATA and entities', () => {
    const items = parseFeed(rss2)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Fed holds rates & markets rally')
    expect(items[0].url).toBe('https://stockmarketloop.com/fed-holds')
    expect(items[0].publishedSec).toBe(Math.floor(Date.parse('Wed, 01 Jul 2026 19:16:15 +0000') / 1000))
  })
  it('parses Atom entries with href links', () => {
    const items = parseFeed(atom)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Why I'm buying TSLA now")
    expect(items[0].url).toBe('https://www.youtube.com/watch?v=abc123')
  })
  it('returns [] on garbage', () => {
    expect(parseFeed('<html>nope</html>')).toEqual([])
  })

  // seen live 2026-08-17: MarketWatch/WSJ feeds use HEX entities, and the desk
  // rendered "&#x2019;" raw in every affected headline
  it('decodes numeric entities — hex and decimal — and never double-decodes &amp;', () => {
    const xml =
      '<rss><channel><item><title>It&#x2019;s the Fed &#8212; markets &amp; rates, &amp;#x2019; literal</title><link>https://x/a</link><pubDate>Wed, 01 Jul 2026 19:16:15 +0000</pubDate></item></channel></rss>'
    const items = parseFeed(xml)
    expect(items[0].title).toBe('It’s the Fed — markets & rates, &#x2019; literal')
  })
})
