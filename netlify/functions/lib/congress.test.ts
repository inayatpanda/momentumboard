import { describe, expect, it } from 'vitest'
import { accumulateCongressHistory, congressAggregates, fetchCongressTrades, type CongressTrade } from './congress'
import { aggregateInsiderClusters, type InsiderSummary } from './insiders'

const today = new Date().toISOString().slice(0, 10)
const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

const harness = (seed: Record<string, unknown> = {}) => {
  const cache = new Map<string, unknown>(Object.entries(seed))
  return {
    cache,
    cacheGet: async <T>(k: string) => (cache.get(k) as T) ?? null,
    cacheSet: async (k: string, v: unknown) => void cache.set(k, v),
  }
}

describe('fetchCongressTrades — QuiverQuant rung', () => {
  const quiverRow = {
    Representative: 'Jane Doe',
    House: 'Representatives',
    Transaction: 'Purchase',
    Range: '$15,001 - $50,000',
    TransactionDate: today,
    ReportDate: today,
    Ticker: 'NVDA',
    Party: 'D',
  }

  it('maps Quiver rows and reports the source', async () => {
    const { cacheGet, cacheSet } = harness()
    const fetchFn = (async (url: string) =>
      String(url).includes('quiverquant') ? jsonRes([quiverRow, { ...quiverRow, Transaction: 'Exchange' }]) : jsonRes({}, 500)) as typeof fetch
    const { trades, source } = await fetchCongressTrades({ QUIVER_API_KEY: 'qk' }, [], { fetchFn, cacheGet, cacheSet })
    expect(source).toBe('quiverquant')
    expect(trades).toHaveLength(1) // Exchange carries no side → dropped
    expect(trades[0]).toEqual({
      politician: 'Jane Doe',
      chamber: 'house',
      party: 'D',
      symbol: 'NVDA',
      side: 'buy',
      amountRange: '$15,001–$50,000',
      traded: today,
      filed: today,
    } satisfies CongressTrade)
  })

  it('falls back to the Token auth scheme when Bearer fails (Quiver 500s bad tokens)', async () => {
    const { cacheGet, cacheSet } = harness()
    const schemes: string[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (!String(url).includes('quiverquant')) return jsonRes({}, 403)
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
      schemes.push(auth.split(' ')[0])
      return auth.startsWith('Token') ? jsonRes([quiverRow]) : jsonRes('<html>', 500)
    }) as typeof fetch
    const { source } = await fetchCongressTrades({ QUIVER_API_KEY: 'qk' }, [], { fetchFn, cacheGet, cacheSet })
    expect(schemes).toEqual(['Bearer', 'Token'])
    expect(source).toBe('quiverquant')
  })
})

describe('fetchCongressTrades — FMP rung', () => {
  const stableSenateRow = { symbol: 'NVDA', firstName: 'Tommy', lastName: 'Tuberville', transactionDate: today, disclosureDate: today, type: 'Purchase', amount: '$50,001 - $100,000' }

  it('uses the market-wide stable latest lists and outranks Finnhub', async () => {
    const { cacheGet, cacheSet } = harness()
    let finnhubCalled = false
    const fetchFn = (async (url: string) => {
      const u = String(url)
      if (u.includes('finnhub')) finnhubCalled = true
      if (u.includes('/stable/senate-latest')) return jsonRes([stableSenateRow])
      if (u.includes('/stable/house-latest')) return jsonRes([])
      return jsonRes({}, 403)
    }) as typeof fetch
    const { trades, source } = await fetchCongressTrades({ FMP_API_KEY: 'mk', FINNHUB_API_KEY: 'fk' }, ['NVDA'], { fetchFn, cacheGet, cacheSet })
    expect(source).toBe('fmp')
    expect(finnhubCalled).toBe(false)
    expect(trades[0]).toMatchObject({ politician: 'Tommy Tuberville', chamber: 'senate', symbol: 'NVDA', side: 'buy', amountRange: '$50,001–$100,000', traded: today })
  })

  it('never calls the legacy v4 endpoints, and a free-tier 402 does not mark FMP down', async () => {
    // v4 endpoints 403 for every key created after Aug 2025 — calling them
    // would wrongly trip the 24h down-marker while stable still works.
    const { cache, cacheGet, cacheSet } = harness()
    let v4Called = false
    const fetchFn = (async (url: string) => {
      const u = String(url)
      if (u.includes('/api/v4/')) {
        v4Called = true
        return jsonRes({}, 403)
      }
      if (u.includes('/stable/')) return jsonRes({ 'Error Message': 'Payment Required' }, 402) // over free-tier page cap
      return jsonRes({}, 403)
    }) as typeof fetch
    const { source } = await fetchCongressTrades({ FMP_API_KEY: 'mk' }, ['AMD'], { fetchFn, cacheGet, cacheSet })
    expect(v4Called).toBe(false)
    expect(source).toBe('none')
    expect(cache.has('congress:fmp-unavailable')).toBe(false)
  })

  it('marks a bad key unavailable for 24h and falls through the ladder', async () => {
    const { cache, cacheGet, cacheSet } = harness()
    const fetchFn = (async (url: string) =>
      String(url).includes('financialmodelingprep') ? jsonRes({ 'Error Message': 'Invalid API KEY.' }, 401) : jsonRes({}, 403)) as typeof fetch
    const res = await fetchCongressTrades({ FMP_API_KEY: 'bad' }, ['AAPL'], { fetchFn, cacheGet, cacheSet })
    expect(res).toEqual({ trades: [], source: 'none' })
    expect(cache.get('congress:fmp-unavailable')).toBe(true)
    let fmpCalls = 0
    const fetchFn2 = (async (url: string) => {
      if (String(url).includes('financialmodelingprep')) fmpCalls++
      return jsonRes({}, 403)
    }) as typeof fetch
    await fetchCongressTrades({ FMP_API_KEY: 'bad' }, ['AAPL'], { fetchFn: fetchFn2, cacheGet, cacheSet })
    expect(fmpCalls).toBe(0) // honoured the marker
  })
})

describe('fetchCongressTrades — Finnhub rung', () => {
  it('maps per-symbol rows when the endpoint is open', async () => {
    const { cacheGet, cacheSet } = harness()
    const fetchFn = (async (url: string) => {
      const u = new URL(String(url))
      if (!u.pathname.includes('congressional-trading')) return jsonRes({}, 404)
      return u.searchParams.get('symbol') === 'AAPL'
        ? jsonRes({ data: [{ name: 'Sen. Smith', position: 'Senate', transactionType: 'Sale (Full)', transactionDate: today, filingDate: today, amountFrom: 1001, amountTo: 15000, symbol: 'AAPL' }] })
        : jsonRes({ data: [] })
    }) as typeof fetch
    const { trades, source } = await fetchCongressTrades({ FINNHUB_API_KEY: 'fk' }, ['AAPL', 'MSFT'], { fetchFn, cacheGet, cacheSet })
    expect(source).toBe('finnhub')
    expect(trades[0]).toMatchObject({ politician: 'Sen. Smith', chamber: 'senate', side: 'sell', symbol: 'AAPL', amountRange: '$1,001–$15,000' })
  })

  it('marks the source unavailable for 24h on a premium gate (403) and stops calling it', async () => {
    const { cache, cacheGet, cacheSet } = harness()
    let finnhubCalls = 0
    const fetchFn = (async (url: string) => {
      if (String(url).includes('congressional-trading')) {
        finnhubCalls++
        return jsonRes({ error: 'no access' }, 403)
      }
      return jsonRes({}, 403) // stock watcher buckets dead too
    }) as typeof fetch
    const first = await fetchCongressTrades({ FINNHUB_API_KEY: 'fk' }, ['AAPL', 'MSFT'], { fetchFn, cacheGet, cacheSet })
    expect(first).toEqual({ trades: [], source: 'none' })
    expect(finnhubCalls).toBe(1) // bailed on the first 403, did not sweep the rest
    expect(cache.get('congress:finnhub-unavailable')).toBe(true)
    await fetchCongressTrades({ FINNHUB_API_KEY: 'fk' }, ['AAPL'], { fetchFn, cacheGet, cacheSet })
    expect(finnhubCalls).toBe(1) // second sweep honoured the marker
  })
})

describe('fetchCongressTrades — Stock Watcher rung', () => {
  const senateRow = { senator: 'John Roe', transaction_date: '07/01/2026', disclosure_date: '07/05/2026', ticker: 'TSLA', type: 'Purchase', amount: '$1,001 - $15,000' }
  const houseRow = { representative: 'Hon. Amy Poe', transaction_date: '2026-07-02', disclosure_date: '07/06/2026', ticker: 'AMD', type: 'sale_partial', amount: '$15,001 - $50,000' }

  it('merges both chambers, normalises US dates, strips Hon., skips junk tickers', async () => {
    const { cacheGet, cacheSet } = harness()
    const fetchFn = (async (url: string) => {
      if (String(url).includes('senate-stock-watcher')) return jsonRes([senateRow, { ...senateRow, ticker: '--' }])
      if (String(url).includes('house-stock-watcher')) return jsonRes([houseRow])
      return jsonRes({}, 403)
    }) as typeof fetch
    const { trades, source } = await fetchCongressTrades({}, [], { fetchFn, cacheGet, cacheSet })
    expect(source).toBe('stock-watcher')
    expect(trades).toHaveLength(2)
    expect(trades.find(t => t.chamber === 'senate')).toMatchObject({ politician: 'John Roe', symbol: 'TSLA', side: 'buy', traded: '2026-07-01', filed: '2026-07-05' })
    expect(trades.find(t => t.chamber === 'house')).toMatchObject({ politician: 'Amy Poe', symbol: 'AMD', side: 'sell', traded: '2026-07-02' })
  })

  it('treats a dataset whose newest trade is >180 days old as dead and caches that', async () => {
    const { cache, cacheGet, cacheSet } = harness()
    const fetchFn = (async (url: string) =>
      String(url).includes('stock-watcher') ? jsonRes([{ ...senateRow, transaction_date: '01/15/2024' }]) : jsonRes({}, 403)) as typeof fetch
    const res = await fetchCongressTrades({}, [], { fetchFn, cacheGet, cacheSet })
    expect(res).toEqual({ trades: [], source: 'none' })
    expect(cache.get('congress:stockwatcher-unavailable')).toBe(true)
  })

  it('returns the none floor when every rung throws', async () => {
    const { cacheGet, cacheSet } = harness()
    const fetchFn = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const res = await fetchCongressTrades({ QUIVER_API_KEY: 'qk', FINNHUB_API_KEY: 'fk' }, ['AAPL'], { fetchFn, cacheGet, cacheSet })
    expect(res).toEqual({ trades: [], source: 'none' })
  })
})

describe('aggregateInsiderClusters', () => {
  const summary = (symbol: string, buyers: string[], totalValueUsd: number, date = today): InsiderSummary => ({
    symbol,
    buyers,
    totalBought: 1000,
    totalValueUsd,
    isCluster: buyers.length >= 2,
    latest: buyers.map(name => ({ name, shares: 500, date })),
  })

  it('reads only existing coverage blobs, sorts by dollars, skips checked-empty and unchecked', async () => {
    const { cacheGet } = harness({
      'insiders:cov:AAA': { summary: summary('AAA', ['CEO', 'CFO'], 500_000) },
      'insiders:cov:BBB': { summary: summary('BBB', ['Dir'], 900_000, '2026-06-01') },
      'insiders:cov:CCC': { summary: null }, // checked, no buys
    })
    const rows = await aggregateInsiderClusters(['AAA', 'BBB', 'CCC', 'DDD'], cacheGet)
    expect(rows.map(r => r.symbol)).toEqual(['BBB', 'AAA']) // by totalValueUsd desc
    expect(rows[1]).toEqual({ symbol: 'AAA', buyers: 2, totalValueUsd: 500_000, lastDate: today, names: ['CEO', 'CFO'] })
    expect(rows[0].lastDate).toBe('2026-06-01')
  })

  it('caps the board at the limit', async () => {
    const seed: Record<string, unknown> = {}
    for (let i = 0; i < 30; i++) seed[`insiders:cov:S${i}`] = { summary: summary(`S${i}`, ['X'], i * 1000 + 1) }
    const { cacheGet } = harness(seed)
    const rows = await aggregateInsiderClusters(Object.keys(seed).map(k => k.split(':')[2]), cacheGet)
    expect(rows).toHaveLength(20)
    expect(rows[0].symbol).toBe('S29')
  })
})

describe('congress history + aggregates', () => {
  const mkStore = (seed: Record<string, unknown> = {}) => {
    const blobs = new Map<string, unknown>(Object.entries(seed))
    return {
      blobs,
      read: async <T,>(k: string) => (blobs.get(k) as T) ?? null,
      write: async (k: string, v: unknown) => void blobs.set(k, v),
    }
  }
  const trade = (politician: string, symbol: string, side: 'buy' | 'sell', traded: string): CongressTrade => ({
    politician, symbol, side, traded, chamber: 'house', amountRange: '', filed: traded,
  })

  it('accumulates sweeps with dedupe and a 90-day window', async () => {
    const store = mkStore()
    const t1 = trade('A', 'NVDA', 'buy', today)
    const old = trade('B', 'OLD', 'sell', '2020-01-01') // far outside the window
    await accumulateCongressHistory(store, [t1, old])
    await accumulateCongressHistory(store, [t1, trade('C', 'T', 'buy', today)]) // t1 again → deduped
    const hist = (await store.read<CongressTrade[]>('congress-history'))!
    expect(hist).toHaveLength(2)
    expect(hist.some(t => t.symbol === 'OLD')).toBe(false)
  })

  it('an empty sweep never wipes prior history', async () => {
    const store = mkStore({ 'congress-history': [trade('A', 'NVDA', 'buy', today)] })
    const merged = await accumulateCongressHistory(store, [])
    expect(merged).toHaveLength(1)
    expect((await store.read<CongressTrade[]>('congress-history'))!).toHaveLength(1)
  })

  it('aggregates need ≥30 records, then rank tickers and politicians', () => {
    expect(congressAggregates([trade('A', 'NVDA', 'buy', today)])).toBeNull()
    const hist: CongressTrade[] = []
    for (let i = 0; i < 20; i++) hist.push(trade(`P${i % 4}`, 'NVDA', i % 3 ? 'buy' : 'sell', today))
    for (let i = 0; i < 15; i++) hist.push(trade(`P${i % 5}`, 'AAPL', 'buy', today))
    const agg = congressAggregates(hist)!
    expect(agg.topTickers[0].symbol).toBe('NVDA')
    expect(agg.topTickers[0].buys + agg.topTickers[0].sells).toBe(20)
    expect(agg.topPoliticians[0].trades).toBeGreaterThanOrEqual(agg.topPoliticians[1].trades)
    expect(agg.historyCount).toBe(35)
  })
})
