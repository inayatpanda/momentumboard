// /api/market?type=street — THE WIRE (owner request: "the summary of youtube
// video input deserve a section of their own, and there should be a system
// where the youtube suggestions are also evaluated by our engine").
//
// Three blobs the engine has written since the video lane shipped and no
// screen has ever rendered: every analysed video (`video-extracts`), the deep
// watch-tier narrative reads (`video-analyses`), and the deterministic
// cross-channel consensus computed off the first. Driven against a REAL
// sqlite-backed D1 — the app store AND the cache both hang off it, so each
// test gets its own store and its own 300s cache entry, and the caching
// behaviour is observable rather than assumed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { routeRequest, STREET_READS, STREET_VIDEOS } from '../market-data.mts'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { ensureD1Schema } from './d1Store'
import { useBlobStore, useD1Store } from './storeProvider'

const env = { APP_TOKEN: 'secret', FINNHUB_API_KEY: 'fk' }
const deps = { yahoo: async () => ({ candles: [], quote: null }), finnhub: async () => null }

const NOW = () => Math.floor(Date.now() / 1000)
const hoursAgo = (h: number) => NOW() - h * 3600

interface StreetVideo {
  url: string
  title: string
  channel: string
  at: number
  tickers: { sym: string; stance: string; levels?: number[] }[]
  themes: string[]
  via?: string
}

const mkVideo = (o: Partial<StreetVideo> & { url: string }): StreetVideo => ({
  title: `Title ${o.url}`,
  channel: 'Josh',
  at: hoursAgo(4),
  tickers: [{ sym: 'NVDA', stance: 'bull', levels: [180.5, 195] }],
  themes: ['ai-capex'],
  ...o,
})

describe('/api/market?type=street', () => {
  let sqlite: ReturnType<typeof openSqliteD1>

  const seed = (key: string, value: unknown) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind('app', key, JSON.stringify(value), Date.now(), null)
      .run()

  // `null`, not `undefined` — an undefined argument takes the default, which
  // is how a "no token" case can quietly authenticate as the admin one
  const call = (token: string | null = 'secret') =>
    routeRequest(new URL('http://x/api/market?type=street'), new Headers(token ? { 'x-app-token': token } : {}), env, deps as never)

  const street = async (): Promise<{ videos: StreetVideo[]; reads: { url: string; analysis: string }[]; consensus: Record<string, unknown>[]; at: number }> =>
    (await (await call()).json()).data

  beforeEach(async () => {
    sqlite = openSqliteD1(':memory:')
    await ensureD1Schema(sqlite)
    useD1Store(sqlite)
    process.env.APP_TOKEN = 'secret'
  })

  afterEach(() => {
    useBlobStore()
    delete process.env.APP_TOKEN
    sqlite.close()
  })

  it('needs a token, exactly like every neighbouring type', async () => {
    expect((await call(null)).status).toBe(401)
  })

  it('serves an honest empty wire on a cold store — never a 500', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const data = await street()
    expect(data.videos).toEqual([])
    expect(data.reads).toEqual([])
    expect(data.consensus).toEqual([])
  })

  it('serves the newest videos first, capped at STREET_VIDEOS', async () => {
    expect(STREET_VIDEOS).toBe(30)
    // written oldest-first, which is how the blob actually accumulates
    await seed('video-extracts', Array.from({ length: 40 }, (_, i) => mkVideo({ url: `u${i}`, at: hoursAgo(40 - i) })))
    const { videos } = await street()
    expect(videos).toHaveLength(30)
    expect(videos[0].url).toBe('u39') // the newest, not the first row on the blob
    expect(videos[29].url).toBe('u10')
  })

  it('sorts by the stamp rather than trusting the blob’s order', async () => {
    await seed('video-extracts', [
      mkVideo({ url: 'middle', at: hoursAgo(10) }),
      mkVideo({ url: 'oldest', at: hoursAgo(50) }),
      mkVideo({ url: 'newest', at: hoursAgo(1) }),
    ])
    expect((await street()).videos.map(v => v.url)).toEqual(['newest', 'middle', 'oldest'])
  })

  // THE PAYLOAD IS LEAN ON PURPOSE. `levels` is the one field on an extract
  // that is unbounded and that nothing on the page renders — the wire prints
  // what a channel said about a name, not the prices it drew.
  it('carries the fields the wire renders and strips the levels', async () => {
    await seed('video-extracts', [mkVideo({ url: 'u1', channel: 'Gareth', themes: ['ai-capex', 'rate-cuts'], via: 'gemini-video' })])
    const [v] = (await street()).videos
    expect(v).toEqual({
      url: 'u1',
      title: 'Title u1',
      channel: 'Gareth',
      at: expect.any(Number),
      tickers: [{ sym: 'NVDA', stance: 'bull' }],
      themes: ['ai-capex', 'rate-cuts'],
      via: 'gemini-video',
    })
    expect(JSON.stringify(v)).not.toContain('levels')
  })

  it('omits `via` entirely on a row that predates the field, rather than inventing one', async () => {
    await seed('video-extracts', [mkVideo({ url: 'u1' })])
    expect('via' in (await street()).videos[0]).toBe(false)
  })

  it('preserves bounded evidence and promotion flags for a reviewable extraction', async () => {
    await seed('video-extracts', [{ ...mkVideo({ url: 'evidence' }), tickers: [{ sym: 'CRWV', stance: 'bull', levels: [100], company: 'CoreWeave', thesis: 'Demand grew.', evidenceQuote: 'CoreWeave support is 100.', hype: true }] }])
    expect((await street()).videos[0].tickers[0]).toEqual({ sym: 'CRWV', stance: 'bull', company: 'CoreWeave', thesis: 'Demand grew.', evidenceQuote: 'CoreWeave support is 100.', hype: true })
  })

  it('drops a malformed row without losing the wire', async () => {
    await seed('video-extracts', [{ url: 'bad', title: 'v', channel: 'Josh', at: hoursAgo(2) }, mkVideo({ url: 'ok' })])
    const { videos, consensus } = await street()
    expect(videos.map(v => v.url)).toEqual(['ok'])
    expect(consensus.map(c => c.sym)).toEqual(['NVDA'])
  })

  it('serves the newest STREET_READS deep reads, verbatim', async () => {
    expect(STREET_READS).toBe(5)
    await seed(
      'video-analyses',
      Array.from({ length: 8 }, (_, i) => ({ url: `a${i}`, title: `Read ${i}`, channel: 'Nash', analysis: `prose ${i}`, at: hoursAgo(20 - i), via: 'gemini-video' })),
    )
    const { reads } = await street()
    expect(reads).toHaveLength(5)
    expect(reads.map(r => r.url)).toEqual(['a7', 'a6', 'a5', 'a4', 'a3'])
    expect(reads[0].analysis).toBe('prose 7')
  })

  // The consensus is the WHOLE list here — the board slice's channelPicks caps
  // at eight because it rides a home screen; this page is the full board.
  it('serves the whole consensus, uncapped, with the channel names on it', async () => {
    await seed('video-extracts', [
      ...Array.from({ length: 12 }, (_, i) => mkVideo({ url: `u${i}`, channel: `ch${i}`, tickers: [{ sym: `S${i}`, stance: 'bull' }] })),
      mkVideo({ url: 'shared-a', channel: 'Josh', tickers: [{ sym: 'NVDA', stance: 'bull' }] }),
      mkVideo({ url: 'shared-b', channel: 'Gareth', tickers: [{ sym: 'NVDA', stance: 'bear' }] }),
    ])
    const { consensus } = await street()
    expect(consensus.length).toBe(13)
    const nvda = consensus.find(c => c.sym === 'NVDA')!
    expect(nvda).toMatchObject({ bulls: 1, bears: 1, channels: 2, channelNames: ['Josh', 'Gareth'] })
  })

  it('caches the wire for five minutes — a second call serves the same bytes after the blob moves', async () => {
    await seed('video-extracts', [mkVideo({ url: 'first' })])
    expect((await street()).videos.map(v => v.url)).toEqual(['first'])
    await seed('video-extracts', [mkVideo({ url: 'first' }), mkVideo({ url: 'second', at: hoursAgo(1) })])
    expect((await street()).videos.map(v => v.url)).toEqual(['first'])
  })
})
