import { describe, expect, it, vi } from 'vitest'
import { fetchScreen, parseScreen } from './screener'

const yahooJson = {
  finance: {
    result: [
      {
        quotes: [
          { symbol: 'ABCD', regularMarketPrice: 12.5, marketCap: 1_500_000_000, regularMarketChangePercent: 4.26, shortName: 'ABCD Corp' },
          { symbol: 'bad symbol!!', regularMarketPrice: 1 },
          { symbol: 'NOCAP', regularMarketPrice: 3 },
        ],
      },
    ],
  },
}

/** n synthetic quotes, symbols S000…S0nn — deep enough to prove the slice. */
const deepJson = (n: number) => ({
  finance: {
    result: [
      {
        quotes: Array.from({ length: n }, (_, i) => ({
          symbol: `S${String(i).padStart(3, '0')}`,
          regularMarketPrice: 10,
          marketCap: 2_000_000_000,
          regularMarketChangePercent: 1,
          shortName: `Sym ${i}`,
        })),
      },
    ],
  },
})

describe('parseScreen', () => {
  it('extracts rows, converts cap to $M, filters junk symbols', () => {
    expect(parseScreen(yahooJson)).toEqual([
      { sym: 'ABCD', price: 12.5, capUsdM: 1500, changePct: 4.3, name: 'ABCD Corp' },
      { sym: 'NOCAP', price: 3, capUsdM: null, changePct: null, name: null },
    ])
  })
  it('garbage in → [] out', () => {
    expect(parseScreen(null)).toEqual([])
    expect(parseScreen({ finance: {} })).toEqual([])
    expect(parseScreen('nope')).toEqual([])
  })
  it('keeps 25 by default and the full 50 when the caller asked for depth', () => {
    const shallow = parseScreen(deepJson(60))
    expect(shallow).toHaveLength(25)
    expect(shallow.at(-1)!.sym).toBe('S024')
    const deep = parseScreen(deepJson(60), 50)
    expect(deep).toHaveLength(50)
    expect(deep.at(-1)!.sym).toBe('S049')
  })
  it('a short response is never padded past what Yahoo sent', () => {
    expect(parseScreen(deepJson(7), 50)).toHaveLength(7)
  })
})

describe('fetchScreen', () => {
  it('returns [] on http failure or throw — a dead screener never kills the run', async () => {
    const dead = vi.fn(async () => new Response('nope', { status: 401 }))
    expect(await fetchScreen('day_gainers', dead as unknown as typeof fetch)).toEqual([])
    const thrower = vi.fn(async () => {
      throw new Error('net')
    })
    expect(await fetchScreen('day_gainers', thrower as unknown as typeof fetch)).toEqual([])
  })
  it('parses a healthy response', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(yahooJson)))
    const rows = await fetchScreen('most_actives', ok as unknown as typeof fetch)
    expect(rows[0]).toEqual({ sym: 'ABCD', price: 12.5, capUsdM: 1500, changePct: 4.3, name: 'ABCD Corp' })
  })
  it('asks Yahoo for 25 by default and for whatever depth the caller names', async () => {
    const ok = vi.fn(async (_url: string) => new Response(JSON.stringify(yahooJson)))
    await fetchScreen('most_actives', ok as unknown as typeof fetch)
    expect(ok.mock.calls[0][0]).toContain('count=25')
    await fetchScreen('day_gainers', ok as unknown as typeof fetch, 50)
    expect(ok.mock.calls[1][0]).toContain('count=50')
  })
  it('the requested depth survives the round trip — 60 rows in, 50 out', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(deepJson(60))))
    expect(await fetchScreen('day_gainers', ok as unknown as typeof fetch, 50)).toHaveLength(50)
    expect(await fetchScreen('day_gainers', ok as unknown as typeof fetch)).toHaveLength(25)
  })
})
