import type { Context } from '@netlify/functions'
import { fetchYahooChart } from './lib/yahoo'
import { fetchFinnhubQuote } from './lib/finnhub'
import { fetchSymbolNews } from './lib/news'
import { getCached, setCached } from './lib/cache'
import type { Quote } from '../../shared/types'
import { isYahooSymbol } from '../../shared/symbols'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function routeRequest(
  url: URL,
  headers: Headers,
  env: { APP_TOKEN?: string; FINNHUB_API_KEY?: string },
  deps: { yahoo: typeof fetchYahooChart; finnhub: typeof fetchFinnhubQuote; news?: typeof fetchSymbolNews },
): Promise<Response> {
  if (!env.APP_TOKEN || headers.get('x-app-token') !== env.APP_TOKEN) return json(401, { ok: false, error: 'unauthorized' })
  const type = url.searchParams.get('type')

  if (type === 'quote') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 30)
    const quotes = await Promise.all(
      symbols.map(async (sym): Promise<Quote | null> => {
        const key = `quote:${sym}`
        const hit = await getCached<Quote>(key)
        if (hit) return hit
        try {
          const quote = isYahooSymbol(sym) ? (await deps.yahoo(sym, '3mo')).quote : await deps.finnhub(sym, env.FINNHUB_API_KEY ?? '')
          await setCached(key, quote, 60)
          return quote
        } catch {
          return null
        }
      }),
    )
    return json(200, { ok: true, data: { quotes } })
  }

  if (type === 'candles') {
    const symbol = url.searchParams.get('symbol')
    const range = (url.searchParams.get('range') ?? '1y') as '3mo' | '6mo' | '1y'
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `candles:${symbol}:${range}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const data = await deps.yahoo(symbol, range)
      await setCached(key, data, 900)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'calendar') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 30)
    if (!symbols.length) return json(200, { ok: true, data: { earnings: [] } })
    const key = `calendar:${symbols.slice().sort().join(',')}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const now = new Date()
      const to = new Date(now.getTime() + 14 * 86_400_000)
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${iso(now)}&to=${iso(to)}&token=${env.FINNHUB_API_KEY}`)
      const j = (await res.json()) as { earningsCalendar?: { symbol: string; date: string; hour: string; epsEstimate: number | null }[] }
      const wanted = new Set(symbols.map(s => s.split('.')[0].split('-')[0]))
      const earnings = (j.earningsCalendar ?? []).filter(e => wanted.has(e.symbol)).map(e => ({ symbol: e.symbol, date: e.date, hour: e.hour, epsEstimate: e.epsEstimate }))
      const data = { earnings }
      await setCached(key, data, 21_600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'feed') {
    const hit = await getCached<unknown>('digest-feed')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { blobAppStore } = await import('./lib/store')
      const { fetchNews } = await import('./lib/news')
      const { fetchVideos } = await import('./lib/youtube')
      const cfg = await blobAppStore.read<{ watchlist: { symbol: string }[]; ytChannels: { id: string; name: string }[] }>('config')
      const nowSec = Math.floor(Date.now() / 1000)
      const [news, videos] = await Promise.all([
        fetchNews((cfg?.watchlist ?? []).map(w => w.symbol), env.FINNHUB_API_KEY ?? '', nowSec),
        fetchVideos(cfg?.ytChannels ?? [], nowSec),
      ])
      const data = { news: news.slice(0, 20), videos: videos.slice(0, 12) }
      await setCached('digest-feed', data, 600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'resolve-channel') {
    const handle = (url.searchParams.get('handle') ?? '').replace(/^@/, '')
    if (!handle) return json(400, { ok: false, error: 'missing-handle' })
    try {
      const res = await fetch(`https://www.youtube.com/@${encodeURIComponent(handle)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
      const page = await res.text()
      const id = page.match(/channel_id=(UC[A-Za-z0-9_-]{10,})/)?.[1]
      const name = page.match(/<title>([^<]+?)\s*- YouTube<\/title>/)?.[1] ?? handle
      if (!id) return json(404, { ok: false, error: 'channel-not-found' })
      return json(200, { ok: true, data: { id, name } })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'insiders') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 30)
    const key = `insiders:${symbols.slice().sort().join(',')}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { fetchInsiderBuys } = await import('./lib/insiders')
      const data = { insiders: await fetchInsiderBuys(symbols, env.FINNHUB_API_KEY ?? '') }
      await setCached(key, data, 21_600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'signal-stats') {
    const hit = await getCached<unknown>('signal-stats')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { blobAppStore } = await import('./lib/store')
      const { scoreSignals } = await import('./lib/signalStats')
      const { cachedCandles } = await import('./lib/marketCache')
      const log = ((await blobAppStore.read<unknown[]>('signal-log')) ?? []) as Parameters<typeof scoreSignals>[0]
      const symbols = [...new Set(log.map(l => l.symbol))].slice(0, 40)
      const candlePairs = await Promise.all(symbols.map(async s => [s, await cachedCandles(s)] as const))
      const candlesBySymbol = new Map(candlePairs.filter((p): p is [string, NonNullable<(typeof candlePairs)[0][1]>] => p[1] !== null))
      const data = { scores: scoreSignals(log, candlesBySymbol), totalSignals: log.length }
      await setCached('signal-stats', data, 3600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'social') {
    const hit = await getCached<unknown>('social-pulse')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { fetchRedditTrends, fetchStocktwitsTrending, combineSocialPulse } = await import('./lib/social')
      const { blobAppStore } = await import('./lib/store')
      const { computeConsensus } = await import('./lib/videoTrends')
      const [reddit, stocktwits, extracts, cfg] = await Promise.all([
        fetchRedditTrends(),
        fetchStocktwitsTrending(),
        blobAppStore.read<unknown[]>('video-extracts'),
        blobAppStore.read<{ watchlist: { symbol: string }[] }>('config'),
      ])
      const consensus = computeConsensus(((extracts ?? []) as Parameters<typeof computeConsensus>[0]), Math.floor(Date.now() / 1000))
      const data = {
        pulse: combineSocialPulse(reddit, stocktwits, consensus.tickers.map(t => ({ sym: t.sym, net: t.net })), (cfg?.watchlist ?? []).map(w => w.symbol)),
        at: Math.floor(Date.now() / 1000),
      }
      await setCached('social-pulse', data, 900)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'econ') {
    const hit = await getCached<unknown>('econ-calendar')
    if (hit) return json(200, { ok: true, data: { events: hit } })
    try {
      const { fetchEconCalendar } = await import('./lib/econCalendar')
      const events = await fetchEconCalendar()
      await setCached('econ-calendar', events, 21_600)
      return json(200, { ok: true, data: { events } })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'pick-stats') {
    const hit = await getCached<unknown>('pick-stats')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { blobAppStore } = await import('./lib/store')
      const { scorePicks } = await import('./lib/picks')
      const { cachedCandles } = await import('./lib/marketCache')
      const history = ((await blobAppStore.read<unknown[]>('report-picks')) ?? []) as Parameters<typeof scorePicks>[0]
      const symbols = [...new Set(history.flatMap(d => d.picks.map(p => p.ticker)))].slice(0, 40)
      const pairs = await Promise.all(symbols.map(async s => [s, await cachedCandles(s)] as const))
      const candlesBySymbol = new Map(pairs.filter((p): p is [string, NonNullable<(typeof pairs)[0][1]>] => p[1] !== null))
      const data = { scores: scorePicks(history, candlesBySymbol), reports: history.length }
      await setCached('pick-stats', data, 3600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'smart-money') {
    const hit = await getCached<unknown>('smart-money:v2') // v2: entity-decoded issuer names
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { FUNDS, fetchFundMoves } = await import('./lib/edgar')
      const funds = (await Promise.all(FUNDS.map(f => fetchFundMoves(f.cik, f.name)))).filter(Boolean)
      const data = { funds, lagNote: '13F holdings are filed up to 45 days after quarter end — context, not timing.' }
      await setCached('smart-money:v2', data, 86_400)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'news') {
    const symbol = url.searchParams.get('symbol')
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `news:${symbol}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      // For LSE ETPs / crypto, resolve the instrument's long name so the query
      // targets the underlying ("Tesla", "Bitcoin") instead of the raw symbol.
      let name: string | undefined
      if (isYahooSymbol(symbol)) {
        const cachedQ = await getCached<Quote>(`quote:${symbol}`)
        name = cachedQ?.name ?? (await deps.yahoo(symbol, '3mo').then(d => d.quote.name).catch(() => undefined))
      }
      const items = await (deps.news ?? fetchSymbolNews)(symbol, env.FINNHUB_API_KEY ?? '', Math.floor(Date.now() / 1000), fetch, name)
      const data = { items }
      await setCached(key, data, 240)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  return json(400, { ok: false, error: 'bad-type' })
}

export default async (req: Request, _context: Context) =>
  routeRequest(
    new URL(req.url),
    req.headers,
    { APP_TOKEN: process.env.APP_TOKEN, FINNHUB_API_KEY: process.env.FINNHUB_API_KEY },
    { yahoo: fetchYahooChart, finnhub: fetchFinnhubQuote },
  )
