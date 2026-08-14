import { describe, it, expect, vi } from 'vitest'
import { boardEvidenceLine, routeRequest } from '../market-data.mts'
import type { Candle, Quote } from '../../../shared/types'

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
  it('routes crypto symbols to yahoo', async () => {
    const body = await (await call('type=quote&symbols=BTC-USD', 'secret')).json()
    expect(body.data.quotes[0]?.source).toBe('yahoo')
  })
  it('serves per-symbol news via the injected fetcher', async () => {
    const news = vi.fn(async () => [{ title: 'Apple thing', url: 'https://n/1', publishedSec: 5 }])
    const res = await routeRequest(
      new URL('http://x/api/market?type=news&symbol=AAPL'),
      new Headers({ 'x-app-token': 'secret' }),
      env,
      { ...deps, news } as never,
    )
    const body = await res.json()
    expect(body.data.items[0].title).toBe('Apple thing')
    expect(news).toHaveBeenCalledWith('AAPL', 'fk', expect.any(Number), expect.anything(), undefined)
  })
})

// CX-24: the sectors payload must additively carry each row's REAL constituent
// symbols (from lib/sectors.ts's SECTOR_MEMBERS) so the Sectors see-all page can
// expand a tile to actual tickers instead of inventing any. Every SECTORS
// symbol + SPY is seeded straight into the module-level candle cache so
// `cachedCandles` never falls through to a live Yahoo/Stooq fetch — existing
// fields (rs5/rs21/rs63/trend/sym/name) must ride unchanged, since the legacy
// app reads this same endpoint.
describe('market-data — sectors carries real member symbols (CX-24)', () => {
  it('extends each row with its members from SECTOR_MEMBERS, existing fields untouched', async () => {
    const { setCached } = await import('./cache')
    const { SECTORS, SECTOR_MEMBERS } = await import('./sectors')
    const mkCandles = (growth: number): Candle[] =>
      Array.from({ length: 70 }, (_, i) => ({ t: i, o: 100 + i * growth, h: 100 + i * growth, l: 100 + i * growth, c: 100 + i * growth, v: 0 }))
    await setCached('candles:SPY:1y', { candles: mkCandles(0.2) }, 900)
    await Promise.all(SECTORS.map((s, i) => setCached(`candles:${s.sym}:1y`, { candles: mkCandles(0.1 + i * 0.05) }, 900)))

    const res = await call('type=sectors', 'secret')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)

    const rows = body.data.rows as { sym: string; name: string; rs5: number | null; rs21: number | null; rs63: number | null; trend: string; members: string[] }[]
    expect(rows).toHaveLength(SECTORS.length)
    for (const row of rows) {
      expect(row.members).toEqual(SECTOR_MEMBERS[row.sym])
      expect(row).toHaveProperty('rs5')
      expect(row).toHaveProperty('rs21')
      expect(row).toHaveProperty('rs63')
      expect(row).toHaveProperty('trend')
    }
    const xlk = rows.find(r => r.sym === 'XLK')!
    expect(xlk.members).toEqual(['AAPL', 'MSFT', 'NVDA', 'AVGO', 'CRM'])
  })
})

// Ask-AI grounds its answer in this evidence block. Describing every board row
// as "a live call" hands the model a falsehood to reason from — and a near-miss
// row is the engine's explicit NO, dressed as its yes.
describe('boardEvidenceLine — what Ask-AI is told the board said', () => {
  const row = {
    side: 'short', grade: 'C', probability: 0.5, entry: 10, stop: 11.5, target: 8.6,
    note: 'nearest miss — the engine looked and said no',
  }

  it('a NEAR MISS is reported as declined — no call, no grade, no probability, no levels', () => {
    const s = boardEvidenceLine('2026-08-11', { ...row, watchOnly: true, nearMiss: true })
    expect(s).toContain('NEAR MISS')
    expect(s).toContain('DECLINED')
    expect(s).not.toContain('live call')
    expect(s).not.toContain('grade C')
    expect(s).not.toContain('50%')
    expect(s).not.toContain('11.5') // no stop it never set
  })

  it('a watch row is described as watch-only, not as a live call', () => {
    const s = boardEvidenceLine('2026-08-11', { ...row, watchOnly: true })
    expect(s).toContain('watch-only observation (no size)')
    expect(s).not.toContain('live call')
    expect(s).toContain('grade C')
  })

  it('a sized call is still a live call, levels and all', () => {
    const s = boardEvidenceLine('2026-08-11', { ...row, grade: 'A', probability: 0.67 })
    expect(s).toContain('live call')
    expect(s).toContain('grade A')
    expect(s).toContain('67%')
    expect(s).toContain('entry 10 / stop 11.5 / target 8.6')
  })

  it('no row at all says so', () => {
    expect(boardEvidenceLine('2026-08-11', undefined)).toBe('Engine board: no live call on this name today.')
  })
})
