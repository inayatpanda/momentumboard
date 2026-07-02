import { describe, it, expect, vi } from 'vitest'
import { parseYahooChart, fetchYahooChart } from './yahoo'
import { fetchFinnhubQuote } from './finnhub'

const yahooFixture = {
  chart: {
    result: [{
      meta: { currency: 'USD', symbol: '3LTS.L', regularMarketPrice: 2.981, chartPreviousClose: 2.167, regularMarketVolume: 5771, regularMarketTime: 1782920120 },
      timestamp: [1782800000, 1782886400],
      indicators: { quote: [{ open: [2.1, 2.5], high: [2.2, 3.0], low: [2.0, 2.4], close: [2.167, 2.981], volume: [4000, 5771] }] }
    }],
    error: null
  }
}

describe('parseYahooChart', () => {
  it('maps meta and bars, computing changePct vs the prior BAR (not chartPreviousClose)', () => {
    const { candles, quote } = parseYahooChart(yahooFixture, '3LTS.L')
    expect(candles).toHaveLength(2)
    expect(candles[1]).toEqual({ t: 1782886400, o: 2.5, h: 3.0, l: 2.4, c: 2.981, v: 5771 })
    expect(quote.price).toBe(2.981)
    expect(quote.currency).toBe('USD')
    // last bar (2.981) IS the live bar → previous close is the bar before it (2.167),
    // NOT meta.chartPreviousClose, which is relative to the range start
    expect(quote.changePct).toBeCloseTo(((2.981 - 2.167) / 2.167) * 100, 4)
    expect(quote.source).toBe('yahoo')
  })
  it('uses the LAST bar as previous close when the market price has moved past it', () => {
    const fx = structuredClone(yahooFixture)
    fx.chart.result[0].meta.regularMarketPrice = 3.1 // live price beyond the last daily bar
    const { quote } = parseYahooChart(fx, '3LTS.L')
    expect(quote.prevClose).toBe(2.981)
  })
  it('throws yahoo-shape on garbage', () => {
    expect(() => parseYahooChart({ nope: 1 }, 'X')).toThrow('yahoo-shape')
  })
  it('skips bars with null close', () => {
    const fx = structuredClone(yahooFixture)
    fx.chart.result[0].indicators.quote[0].close[0] = null as unknown as number
    expect(parseYahooChart(fx, '3LTS.L').candles).toHaveLength(1)
  })
  it('drops the zero-volume placeholder bar Yahoo appends off-session', () => {
    const fx = structuredClone(yahooFixture)
    const q = fx.chart.result[0].indicators.quote[0]
    fx.chart.result[0].timestamp.push(1782972800)
    q.open.push(2.981); q.high.push(2.981); q.low.push(2.981); q.close.push(2.981); q.volume.push(0)
    const { candles, quote } = parseYahooChart(fx, '3LTS.L')
    expect(candles).toHaveLength(2) // zombie bar removed
    expect(quote.prevClose).toBe(2.167) // change still measured vs the real prior session
  })
})

describe('fetchers pass URL and headers', () => {
  it('yahoo: hits v8 chart with UA header', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(yahooFixture)))
    await fetchYahooChart('3LTS.L', '1y', fetchFn as unknown as typeof fetch)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/v8/finance/chart/3LTS.L?range=1y&interval=1d')
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('Mozilla')
  })
  it('finnhub: maps c/pc into a Quote', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ c: 294.38, pc: 289.36, t: 1782936000 })))
    const q = await fetchFinnhubQuote('AAPL', 'k', fetchFn as unknown as typeof fetch)
    expect(q.price).toBe(294.38)
    expect(q.changePct).toBeCloseTo(1.7349, 3)
    expect(q.todayVolume).toBeNull()
    expect(q.source).toBe('finnhub')
  })
})
