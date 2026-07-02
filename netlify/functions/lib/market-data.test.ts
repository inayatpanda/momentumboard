import { describe, it, expect, vi } from 'vitest'
import { routeRequest } from '../market-data.mts'
import type { Quote } from '../../../shared/types'

const q = (symbol: string): Quote => ({ symbol, price: 1, prevClose: 1, changePct: 0, currency: 'USD', todayVolume: null, asOf: 0, source: 'finnhub' })
const env = { APP_TOKEN: 'secret', FINNHUB_API_KEY: 'fk' }
const deps = {
  yahoo: vi.fn(async (s: string) => ({ candles: [], quote: { ...q(s), source: 'yahoo' as const } })),
  finnhub: vi.fn(async (s: string) => q(s)),
}
const call = (qs: string, token?: string) =>
  routeRequest(new URL(`http://x/api/market?${qs}`), new Headers(token ? { 'x-app-token': token } : {}), env, deps as never)

describe('market-data routing', () => {
  it('rejects a missing/wrong token', async () => {
    const res = await call('type=quote&symbols=AAPL')
    expect(res.status).toBe(401)
  })
  it('routes US to finnhub and .L to yahoo in one batch', async () => {
    const res = await call('type=quote&symbols=AAPL,3LTS.L', 'secret')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.quotes.map((x: Quote | null) => x?.source)).toEqual(['finnhub', 'yahoo'])
  })
  it('nulls a failing symbol without failing the batch', async () => {
    deps.finnhub.mockRejectedValueOnce(new Error('boom'))
    const body = await (await call('type=quote&symbols=MSFT,3LTS.L', 'secret')).json()
    expect(body.data.quotes[0]).toBeNull()
    expect(body.data.quotes[1]).not.toBeNull()
  })
  it('400s unknown type', async () => {
    expect((await call('type=wat', 'secret')).status).toBe(400)
  })
})
