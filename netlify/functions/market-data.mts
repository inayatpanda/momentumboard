import type { Context } from '@netlify/functions'
import { fetchYahooChart } from './lib/yahoo'
import { fetchFinnhubQuote } from './lib/finnhub'
import { getCached, setCached } from './lib/cache'
import type { Quote } from '../../shared/types'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const isYahooSymbol = (s: string) => s.includes('.')

export async function routeRequest(
  url: URL,
  headers: Headers,
  env: { APP_TOKEN?: string; FINNHUB_API_KEY?: string },
  deps: { yahoo: typeof fetchYahooChart; finnhub: typeof fetchFinnhubQuote },
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

  return json(400, { ok: false, error: 'bad-type' })
}

export default async (req: Request, _context: Context) =>
  routeRequest(
    new URL(req.url),
    req.headers,
    { APP_TOKEN: process.env.APP_TOKEN, FINNHUB_API_KEY: process.env.FINNHUB_API_KEY },
    { yahoo: fetchYahooChart, finnhub: fetchFinnhubQuote },
  )
