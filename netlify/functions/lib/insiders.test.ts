import { describe, expect, it } from 'vitest'
import { collectInsiderCoverage, fetchInsiderBuys, rotationSlice } from './insiders'

describe('rotationSlice', () => {
  const syms = Array.from({ length: 80 }, (_, i) => `S${String(i).padStart(2, '0')}`)

  it('is deterministic for a day index and advances by the slice size the next day', () => {
    const day = rotationSlice(syms, 100, 20) // start = (100·20)%80 = 0
    expect(rotationSlice(syms, 100, 20)).toEqual(day) // same day → identical slice
    expect(day).toHaveLength(20)
    expect(day[0]).toBe(syms[0])
    const next = rotationSlice(syms, 101, 20) // start = (101·20)%80 = 20
    expect(next).not.toEqual(day)
    expect(next[0]).toBe(syms[20])
  })

  it('covers the whole roster over one cycle (~4 days for 80/20)', () => {
    const seen = new Set<string>()
    for (let d = 100; d < 104; d++) for (const s of rotationSlice(syms, d, 20)) seen.add(s)
    expect(seen.size).toBe(80)
  })

  it('wraps past the end and handles empty / undersized rosters', () => {
    expect(rotationSlice(['A', 'B', 'C'], 1, 2)).toEqual(['C', 'A']) // start (1·2)%3 = 2, wrap
    expect(rotationSlice([], 5, 20)).toEqual([])
    expect(rotationSlice(['A', 'B'], 5, 20)).toEqual(['A', 'B'])
  })
})

describe('collectInsiderCoverage', () => {
  const today = new Date().toISOString().slice(0, 10)
  const buyTxn = { name: 'CEO', change: 5000, transactionDate: today, transactionCode: 'P', transactionPrice: 100, isDerivative: false }
  const resp = (txns: unknown[]) => ({ ok: true, json: async () => ({ data: txns }) }) as unknown as Response

  const harness = (seed: Record<string, unknown> = {}) => {
    const cache = new Map<string, unknown>(Object.entries(seed))
    return {
      cache,
      cacheGet: async <T>(k: string) => (cache.get(k) as T) ?? null,
      cacheSet: async (k: string, v: unknown) => void cache.set(k, v),
    }
  }

  it('distinguishes checked-empty (null) from never-checked (absent), and marks cluster buys', async () => {
    const { cache, cacheGet, cacheSet } = harness()
    const fetchFn = (async (url: string) => {
      const sym = new URL(url).searchParams.get('symbol')
      return sym === 'AAA' ? resp([buyTxn, { ...buyTxn, name: 'CFO' }]) : resp([]) // AAA cluster, rest empty
    }) as typeof fetch
    const cov = await collectInsiderCoverage(['AAA', 'BBB', 'CCC'], [], today, 'key', { fetchFn, cacheGet, cacheSet, sliceSize: 20 })

    expect(cov.get('AAA')?.isCluster).toBe(true) // two buyers → cluster
    expect(cov.get('BBB')).toBeNull() // checked, no buys → factor will score 0
    expect(cov.has('CCC')).toBe(true) // in the fetched slice → checked
    expect(cov.has('ZZZ')).toBe(false) // not on the roster → never checked → factor stays null
    // every fetched name is persisted with an explicit marker so tomorrow knows it was checked
    expect(cache.get('insiders:cov:BBB')).toEqual({ summary: null })
    expect((cache.get('insiders:cov:AAA') as { summary: { isCluster: boolean } }).summary.isCluster).toBe(true)
  })

  it('serves prior-day cached names without re-fetching (coverage accumulates)', async () => {
    const { cacheGet, cacheSet } = harness({ 'insiders:cov:OLD': { summary: null } }) // checked-empty yesterday
    let fetched = 0
    const fetchFn = (async () => {
      fetched++
      return resp([])
    }) as typeof fetch
    const cov = await collectInsiderCoverage(['OLD'], [], today, 'key', { fetchFn, cacheGet, cacheSet })
    expect(cov.has('OLD')).toBe(true)
    expect(cov.get('OLD')).toBeNull()
    expect(fetched).toBe(0) // already cached, and not on the watchlist → no network
  })

  it('always fetches the watchlist even when it is a cache miss', async () => {
    const { cache, cacheGet, cacheSet } = harness()
    const seen: string[] = []
    const fetchFn = (async (url: string) => {
      seen.push(new URL(url).searchParams.get('symbol')!)
      return resp([])
    }) as typeof fetch
    await collectInsiderCoverage(['WAT'], ['WAT'], today, 'key', { fetchFn, cacheGet, cacheSet })
    expect(seen).toContain('WAT')
    expect(cache.get('insiders:cov:WAT')).toEqual({ summary: null })
  })

  it('skips non-US symbols entirely', async () => {
    const { cacheGet, cacheSet } = harness()
    const fetchFn = (async () => resp([])) as typeof fetch
    const cov = await collectInsiderCoverage(['3LTS.L', 'BTC-USD'], [], today, 'key', { fetchFn, cacheGet, cacheSet })
    expect(cov.size).toBe(0)
  })

  // Finnhub's insider endpoint is US-listed only, and the roster filter reads
  // exchangeFor(). BT-A.L was excluded for the WRONG reason (it read CRYPTO);
  // it must stay excluded now that it reads LSE, and BRK-B — a US share class
  // the dash rule wrote off — must now be looked up like the equity it is.
  it('excludes BT-A.L as the LSE name it is, and stops writing off the dashed US share class', async () => {
    const { cacheGet, cacheSet } = harness()
    const seen: string[] = []
    const fetchFn = (async (url: string) => {
      seen.push(new URL(url).searchParams.get('symbol')!)
      return resp([])
    }) as typeof fetch
    const cov = await collectInsiderCoverage(['BT-A.L', 'BRK-B', 'AAPL'], ['BT-A.L', 'BRK-B'], today, 'key', { fetchFn, cacheGet, cacheSet })
    expect(seen).not.toContain('BT-A.L')
    expect(seen).toContain('BRK-B')
    expect(cov.has('BT-A.L')).toBe(false)
    expect(cov.has('BRK-B')).toBe(true)
  })
})

describe('fetchInsiderBuys — the venue filter', () => {
  const resp = () => ({ ok: true, json: async () => ({ data: [] }) }) as unknown as Response

  it('asks Finnhub only about the US names', async () => {
    const seen: string[] = []
    const fetchFn = (async (url: string) => {
      seen.push(new URL(url).searchParams.get('symbol')!)
      return resp()
    }) as typeof fetch
    await fetchInsiderBuys(['AAPL', 'BT-A.L', 'RR.L', 'ETH-USD', 'BRK-B'], 'key', fetchFn)
    expect(seen.sort()).toEqual(['AAPL', 'BRK-B'])
  })
})
