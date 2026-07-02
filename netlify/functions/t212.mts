import type { Context } from '@netlify/functions'
import { blobAppStore } from './lib/store'
import { authenticate } from './lib/auth'
import { getCached, setCached } from './lib/cache'

// Trading 212 read-only integration. The user generates an API key in the T212
// app (Settings → API) with read scopes; it lives ONLY in Netlify env vars.
// We never place orders: portfolio and cash reads only.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export interface T212Position {
  symbol: string // normalized: AAPL_US_EQ → AAPL
  rawTicker: string
  quantity: number
  averagePrice: number
  currentPrice: number
  pplPct: number | null
}

export function normalizeT212Ticker(t: string): string {
  // AAPL_US_EQ → AAPL; 3LTSl_EQ style LSE tickers → 3LTS.L (T212 marks LSE with lowercase l suffix)
  const base = t.split('_')[0]
  return base.endsWith('l') && base.length > 1 && base.slice(0, -1) === base.slice(0, -1).toUpperCase()
    ? `${base.slice(0, -1)}.L`
    : base.toUpperCase()
}

export default async (req: Request, _context: Context) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (auth?.level !== 'admin') return json(401, { ok: false, error: 'admin-only' }) // it is YOUR brokerage account

  const apiKey = process.env.T212_API_KEY
  if (!apiKey) return json(200, { ok: true, data: { unconfigured: true } })

  const hit = await getCached<unknown>('t212-portfolio')
  if (hit) return json(200, { ok: true, data: hit })

  try {
    const host = process.env.T212_HOST ?? 'https://live.trading212.com'
    const res = await fetch(`${host}/api/v0/equity/portfolio`, { headers: { Authorization: apiKey } })
    if (!res.ok) return json(502, { ok: false, error: `t212-http-${res.status}` })
    const raw = (await res.json()) as { ticker: string; quantity: number; averagePrice: number; currentPrice: number; ppl: number }[]
    const positions: T212Position[] = raw.map(p => ({
      symbol: normalizeT212Ticker(p.ticker),
      rawTicker: p.ticker,
      quantity: p.quantity,
      averagePrice: p.averagePrice,
      currentPrice: p.currentPrice,
      pplPct: p.averagePrice > 0 ? Math.round(((p.currentPrice - p.averagePrice) / p.averagePrice) * 1000) / 10 : null,
    }))
    const data = { unconfigured: false, positions, at: Math.floor(Date.now() / 1000) }
    await setCached('t212-portfolio', data, 60)
    return json(200, { ok: true, data })
  } catch (e) {
    return json(502, { ok: false, error: String(e) })
  }
}
