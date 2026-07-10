import { describe, it, expect } from 'vitest'
import {
  parseCallText,
  toExtract,
  ALIASES,
  extractBareTickers,
  fetchRedditPunditPosts,
  fetchPunditTagFeed,
  DEFAULT_PUNDIT_REDDITS,
} from './punditCalls'

// tiny fetch stub: returns whatever ok/json/text the test supplies
const stubFetch = (impl: (url: string) => { ok?: boolean; json?: () => Promise<unknown>; text?: () => Promise<string> }) =>
  (async (url: string) => {
    const r = impl(String(url))
    return { ok: r.ok ?? true, json: r.json ?? (async () => ({})), text: r.text ?? (async () => '') }
  }) as unknown as typeof fetch

describe('parseCallText — explicit form', () => {
  it('parses multiple $tickers with per-ticker stances', () => {
    const { name, tickers } = parseCallText('/call obi $TSLA long PLTR short')
    expect(name).toBe('Grandmaster Obi')
    expect(tickers).toEqual([
      { sym: 'TSLA', stance: 'bull' },
      { sym: 'PLTR', stance: 'bear' },
    ])
  })
  it('bare ticker with no stance word defaults to neutral', () => {
    expect(parseCallText('/call obi TSLA').tickers).toEqual([{ sym: 'TSLA', stance: 'neutral' }])
  })
  it('maps buy/sell/bull/bear synonyms', () => {
    expect(parseCallText('/call obi AAPL buy NVDA sell').tickers).toEqual([
      { sym: 'AAPL', stance: 'bull' },
      { sym: 'NVDA', stance: 'bear' },
    ])
  })
})

describe('parseCallText — free-form forwarded text', () => {
  it('extracts $tagged tickers and defaults bull on buy/long/calls/moon', () => {
    const { name, tickers } = parseCallText('/call obi Just alerted $TSLA calls to the discord, $NVDA looks ready')
    expect(name).toBe('Grandmaster Obi')
    expect(tickers).toEqual([
      { sym: 'TSLA', stance: 'bull' },
      { sym: 'NVDA', stance: 'bull' },
    ])
  })
  it('defaults bear when the text is about shorts/puts', () => {
    expect(parseCallText('/call obi shorting $XYZ here, loading puts').tickers).toEqual([{ sym: 'XYZ', stance: 'bear' }])
  })
  it('neutral when no stance words present', () => {
    expect(parseCallText('/call obi keeping an eye on $ABC into earnings').tickers).toEqual([{ sym: 'ABC', stance: 'neutral' }])
  })
  it('ignores untagged capitalised prose words (only $tags count in free-form)', () => {
    // "THE"/"CEO" would match a naive ticker regex; free-form requires the $ tag
    expect(parseCallText('/call obi THE CEO says buy soon watch $GME').tickers).toEqual([{ sym: 'GME', stance: 'bull' }])
  })
})

describe('parseCallText — aliases & junk', () => {
  it('maps every known alias to its exact channel name', () => {
    expect(ALIASES).toEqual({ obi: 'Grandmaster Obi', gareth: 'Gareth Holloway', josh: 'Stocks with Josh' })
    expect(parseCallText('/call gareth $AAPL buy').name).toBe('Gareth Holloway')
    expect(parseCallText('/call josh $AAPL buy').name).toBe('Stocks with Josh')
  })
  it('unknown alias → name null', () => {
    expect(parseCallText('/call bob $AAPL buy').name).toBeNull()
  })
  it('junk after a known alias → no tickers', () => {
    expect(parseCallText('/call obi hello how are you today').tickers).toEqual([])
  })
})

describe('toExtract', () => {
  it('produces a graded-record with a synthetic bridge url and levels/themes', () => {
    const ex = toExtract('Grandmaster Obi', [{ sym: 'TSLA', stance: 'bull' }], 1000, 'telegram-bridge')
    expect(ex.channel).toBe('Grandmaster Obi')
    expect(ex.url).toBe('bridge:telegram:1000')
    expect(ex.at).toBe(1000)
    expect(ex.themes).toEqual([])
    expect(ex.tickers).toEqual([{ sym: 'TSLA', stance: 'bull', levels: [] }])
  })
})

describe('extractBareTickers', () => {
  it('picks BARE uppercase tickers and skips names/stopwords', () => {
    // OBI is inside "Grandmaster-OBI" (not a standalone token) and is a stopword;
    // STOCK/AFTER are prose, 577% is not a ticker.
    expect(extractBareTickers('Grandmaster-OBI JLHL Stock Soars 577% as GMM Spikes After-Hours')).toEqual(['JLHL', 'GMM'])
  })
})

describe('fetchRedditPunditPosts', () => {
  const listing = (children: unknown[]) => ({ json: async () => ({ data: { children } }) })
  it('parses a stubbed listing, respects sinceSec, uses the permalink as url', async () => {
    const since = 10_000
    const fetchFn = stubFetch(() =>
      listing([
        { data: { title: 'Loading up $ABCD calls', selftext: '', created_utc: since + 100, permalink: '/r/x/1' } },
        { data: { title: 'old $ZZZZ short', selftext: '', created_utc: since - 100, permalink: '/r/x/2' } },
        { data: { title: 'no ticker here', selftext: 'buying random things', created_utc: since + 200, permalink: '/r/x/3' } },
      ]),
    )
    const out = await fetchRedditPunditPosts([{ user: 'someone', name: 'Grandmaster Obi' }], since, fetchFn)
    expect(out).toHaveLength(1)
    expect(out[0].channel).toBe('Grandmaster Obi')
    expect(out[0].url).toBe('https://www.reddit.com/r/x/1')
    expect(out[0].tickers).toEqual([{ sym: 'ABCD', stance: 'bull', levels: [] }])
    expect(out[0].at).toBe(since + 100)
  })
  it('fail-softs to [] on bad JSON', async () => {
    const fetchFn = stubFetch(() => ({ json: async () => { throw new Error('bad json') } }))
    expect(await fetchRedditPunditPosts([{ user: 'x', name: 'Grandmaster Obi' }], 0, fetchFn)).toEqual([])
  })
  it('ships with an empty default reddit list (no guessed username)', () => {
    expect(DEFAULT_PUNDIT_REDDITS).toEqual([])
  })
})

describe('fetchPunditTagFeed', () => {
  const rss = (items: string) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`
  const item = (title: string, link: string, date: string) => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate></item>`
  it('extracts bare tickers from titles, defaults bull, respects sinceSec, url = item link', async () => {
    const since = Math.floor(Date.parse('2026-07-05T00:00:00Z') / 1000)
    const xml = rss(
      item('Grandmaster-OBI JLHL Stock Soars 577% as GMM Spikes After-Hours', 'https://stockmarketloop.com/a', 'Thu, 09 Jul 2026 10:00:00 GMT') +
        item('OBI ALERT: XYZ Runs', 'https://stockmarketloop.com/b', 'Wed, 01 Jan 2020 10:00:00 GMT'),
    )
    const out = await fetchPunditTagFeed('https://feed', 'Grandmaster Obi', since, stubFetch(() => ({ text: async () => xml })))
    expect(out).toHaveLength(1) // 2020 item excluded by sinceSec
    expect(out[0].channel).toBe('Grandmaster Obi')
    expect(out[0].url).toBe('https://stockmarketloop.com/a')
    expect(out[0].tickers).toEqual([
      { sym: 'JLHL', stance: 'bull', levels: [] },
      { sym: 'GMM', stance: 'bull', levels: [] },
    ])
  })
  it('dedupe key is the item link (distinct records get distinct urls)', async () => {
    const xml = rss(
      item('AAAA runs', 'https://stockmarketloop.com/a', 'Thu, 09 Jul 2026 10:00:00 GMT') +
        item('BBBB runs', 'https://stockmarketloop.com/b', 'Thu, 09 Jul 2026 11:00:00 GMT'),
    )
    const out = await fetchPunditTagFeed('https://feed', 'Grandmaster Obi', 0, stubFetch(() => ({ text: async () => xml })))
    expect(new Set(out.map(e => e.url)).size).toBe(out.length)
    expect(out.map(e => e.url)).toEqual(['https://stockmarketloop.com/a', 'https://stockmarketloop.com/b'])
  })
  it('fail-softs to [] on non-XML', async () => {
    expect(await fetchPunditTagFeed('https://feed', 'Grandmaster Obi', 0, stubFetch(() => ({ text: async () => 'not xml at all' })))).toEqual([])
  })
})
