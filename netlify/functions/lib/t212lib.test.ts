import { describe, expect, it, vi } from 'vitest'
import { fetchT212Positions, normalizeT212Ticker, t212AuthHeader } from './t212lib'

describe('normalizeT212Ticker', () => {
  it('strips the US_EQ suffix and uppercases', () => {
    expect(normalizeT212Ticker('AAPL_US_EQ')).toBe('AAPL')
  })
  it('maps a T212 lowercase-l LSE ticker to a .L symbol', () => {
    expect(normalizeT212Ticker('3LTSl_EQ')).toBe('3LTS.L')
  })
})

describe('t212AuthHeader', () => {
  it('builds Basic secret:apiKey when a secret is present', () => {
    const header = t212AuthHeader({ T212_API_KEY: 'the-key', T212_SECRET_KEY: 'the-secret' })
    expect(header).toBe(`Basic ${Buffer.from('the-secret:the-key').toString('base64')}`)
  })
  it('sends the key bare for a legacy single-key account', () => {
    expect(t212AuthHeader({ T212_API_KEY: 'bare-key' })).toBe('bare-key')
  })
  it('returns null when no API key is configured', () => {
    expect(t212AuthHeader({})).toBeNull()
  })
})

describe('fetchT212Positions', () => {
  const sample = [
    { ticker: 'AAPL_US_EQ', quantity: 10, averagePrice: 200, currentPrice: 220, ppl: 200 },
    { ticker: '3LTSl_EQ', quantity: 5, averagePrice: 8, currentPrice: 6, ppl: -10 },
    { ticker: 'FREE_US_EQ', quantity: 1, averagePrice: 0, currentPrice: 3, ppl: 3 }, // avg 0 → pplPct null
  ]

  it('returns null without a key (never calls fetch)', async () => {
    const fetchFn = vi.fn()
    expect(await fetchT212Positions({}, fetchFn as unknown as typeof fetch)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('normalizes tickers and derives pplPct from avg/current', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(sample), { status: 200 }))
    const positions = (await fetchT212Positions({ T212_API_KEY: 'k', T212_SECRET_KEY: 's' }, fetchFn as unknown as typeof fetch))!
    expect(positions).toHaveLength(3)
    expect(positions[0]).toMatchObject({ symbol: 'AAPL', rawTicker: 'AAPL_US_EQ', pplPct: 10 })
    expect(positions[1]).toMatchObject({ symbol: '3LTS.L', pplPct: -25 })
    expect(positions[2].pplPct).toBeNull() // averagePrice 0 → guarded
    // the Authorization header was the Basic secret:apiKey form
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ headers: { Authorization: `Basic ${Buffer.from('s:k').toString('base64')}` } })
  })

  it('returns null on a non-ok response', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 502 }))
    expect(await fetchT212Positions({ T212_API_KEY: 'k' }, fetchFn as unknown as typeof fetch)).toBeNull()
  })

  it('returns null when the fetch throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(await fetchT212Positions({ T212_API_KEY: 'k' }, fetchFn as unknown as typeof fetch)).toBeNull()
  })
})
