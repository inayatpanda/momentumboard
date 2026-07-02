import { describe, expect, it, vi } from 'vitest'
import { fetchScreen, parseScreen } from './screener'

const yahooJson = {
  finance: {
    result: [
      {
        quotes: [
          { symbol: 'ABCD', regularMarketPrice: 12.5, marketCap: 1_500_000_000 },
          { symbol: 'bad symbol!!', regularMarketPrice: 1 },
          { symbol: 'NOCAP', regularMarketPrice: 3 },
        ],
      },
    ],
  },
}

describe('parseScreen', () => {
  it('extracts rows, converts cap to $M, filters junk symbols', () => {
    expect(parseScreen(yahooJson)).toEqual([
      { sym: 'ABCD', price: 12.5, capUsdM: 1500 },
      { sym: 'NOCAP', price: 3, capUsdM: null },
    ])
  })
  it('garbage in → [] out', () => {
    expect(parseScreen(null)).toEqual([])
    expect(parseScreen({ finance: {} })).toEqual([])
    expect(parseScreen('nope')).toEqual([])
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
    expect(rows[0]).toEqual({ sym: 'ABCD', price: 12.5, capUsdM: 1500 })
  })
})
