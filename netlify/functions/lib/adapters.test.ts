import { describe, it, expect, vi } from 'vitest'
import { CANDLE_RANGES, candleRange, parseYahooChart, fetchYahooChart } from './yahoo'
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
  it('treats float-noise differences as the same bar (197.58 vs 197.5800018)', () => {
    const fx = structuredClone(yahooFixture)
    fx.chart.result[0].meta.regularMarketPrice = 2.981
    fx.chart.result[0].indicators.quote[0].close[1] = 2.9810000183105 as unknown as number
    const { quote } = parseYahooChart(fx, '3LTS.L')
    expect(quote.prevClose).toBe(2.167) // prior session, not the same bar
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

// The intraday shapes, recorded from live Yahoo on 2026-08-17 (NVDA 1d/5m):
// `regularMarketPreviousClose` DOES NOT EXIST in v8 chart meta — only
// `previousClose` (the prior SESSION's close, present on intraday ranges) and
// `chartPreviousClose` (the close before the RANGE start: 5 sessions back on a
// 5d chart). The daily fallback — "the bar before the live one" — is the prior
// FIVE MINUTES on a 5m series, which would print the day's change as +0.02%.
const intradayFixture = {
  chart: {
    result: [{
      meta: {
        currency: 'USD', symbol: 'NVDA', regularMarketPrice: 225.16, chartPreviousClose: 223.96, previousClose: 225.3,
        regularMarketVolume: 15296328, regularMarketTime: 1786910400, dataGranularity: '5m', range: '1d',
      },
      timestamp: [1786887000, 1786887300, 1786887600],
      indicators: { quote: [{ open: [225.0, 225.1, 225.2], high: [225.4, 225.3, 225.3], low: [224.8, 225.0, 225.0], close: [225.1, 225.2, 225.16], volume: [400_000, 500_000, 1_531_506] }] }
    }],
    error: null
  }
}

describe('parseYahooChart — intraday bars', () => {
  it('measures the change against the prior SESSION, never the prior five minutes', () => {
    const { candles, quote } = parseYahooChart(intradayFixture, 'NVDA')
    expect(candles).toHaveLength(3)
    expect(quote.prevClose).toBe(225.3) // meta.previousClose, not candles[1].c (225.2)
    expect(quote.changePct).toBeCloseTo(((225.16 - 225.3) / 225.3) * 100, 4)
  })
  it('falls back to chartPreviousClose when the intraday meta carries no previousClose', () => {
    const fx = structuredClone(intradayFixture)
    delete (fx.chart.result[0].meta as { previousClose?: number }).previousClose
    expect(parseYahooChart(fx, 'NVDA').quote.prevClose).toBe(223.96)
  })
  it('reads the granularity from the caller when meta omits it', () => {
    const fx = structuredClone(intradayFixture)
    delete (fx.chart.result[0].meta as { dataGranularity?: string }).dataGranularity
    expect(parseYahooChart(fx, 'NVDA', '15m').quote.prevClose).toBe(225.3)
    expect(parseYahooChart(fx, 'NVDA', '1d').quote.prevClose).toBe(225.2) // daily rule: the bar before the live one
  })
})

describe('the candle range table', () => {
  it('pairs each range with the interval Yahoo serves it at, and its cache life', () => {
    expect(CANDLE_RANGES['1d']).toEqual({ interval: '5m', ttlSec: 300 })
    expect(CANDLE_RANGES['5d']).toEqual({ interval: '15m', ttlSec: 600 })
    expect(CANDLE_RANGES['1mo']).toEqual({ interval: '1d', ttlSec: 900 })
    expect(CANDLE_RANGES['3mo']).toEqual({ interval: '1d', ttlSec: 900 })
    // the engine's own long reads keep daily bars — seasonality counts sessions
    expect(CANDLE_RANGES['5y'].interval).toBe('1d')
  })
  it('whitelists the range, falling back to the default — including for inherited object keys', () => {
    expect(candleRange('1d')).toBe('1d')
    expect(candleRange('6mo')).toBe('6mo')
    expect(candleRange('10y')).toBe('1y')
    expect(candleRange(null)).toBe('1y')
    expect(candleRange('constructor')).toBe('1y')
    expect(candleRange('1d&interval=1m')).toBe('1y') // no query-string injection into the upstream URL
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
  it('yahoo: asks for the interval the range is served at — 5m for a day, 15m for a week', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(intradayFixture)))
    const urlOf = (i: number) => (fetchFn.mock.calls[i] as unknown as [string])[0]
    await fetchYahooChart('NVDA', '1d', fetchFn as unknown as typeof fetch)
    expect(urlOf(0)).toContain('?range=1d&interval=5m')
    await fetchYahooChart('BTC-USD', '5d', fetchFn as unknown as typeof fetch)
    expect(urlOf(1)).toContain('/v8/finance/chart/BTC-USD?range=5d&interval=15m')
    await fetchYahooChart('NVDA', '1mo', fetchFn as unknown as typeof fetch)
    expect(urlOf(2)).toContain('?range=1mo&interval=1d')
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
