import { exchangeFor } from '../../../shared/symbols'
import { getCached, setCached } from './cache'

export interface InsiderSummary {
  symbol: string
  buyers: string[]
  totalBought: number // shares
  totalValueUsd: number // where price reported
  isCluster: boolean // ≥2 distinct insiders buying in the window, or > $250k
  latest: { name: string; shares: number; date: string }[]
}

interface FinnhubTx {
  name: string
  change: number
  transactionDate: string
  transactionCode: string
  transactionPrice: number
  isDerivative: boolean
}

/** Open-market insider BUYS (Form 4 code 'P') over the last ~90 days, per US symbol.
 * Clustered buying — several insiders purchasing — is one of the few signals
 * with real empirical support. Sales are ignored: they happen for many reasons. */
export async function fetchInsiderBuys(
  symbols: string[],
  finnhubKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<InsiderSummary[]> {
  const usSymbols = symbols.filter(s => exchangeFor(s) === 'US').slice(0, 15)
  const out: InsiderSummary[] = []
  await Promise.all(
    usSymbols.map(async symbol => {
      try {
        const res = await fetchFn(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${finnhubKey}`)
        if (!res.ok) return
        const j = (await res.json()) as { data?: FinnhubTx[] }
        const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
        const buys = (j.data ?? []).filter(t => !t.isDerivative && t.transactionCode === 'P' && t.change > 0 && t.transactionDate >= cutoff)
        if (!buys.length) return
        const buyers = [...new Set(buys.map(b => b.name))]
        const totalBought = buys.reduce((s, b) => s + b.change, 0)
        const totalValueUsd = buys.reduce((s, b) => s + b.change * (b.transactionPrice || 0), 0)
        out.push({
          symbol,
          buyers,
          totalBought,
          totalValueUsd,
          isCluster: buyers.length >= 2 || totalValueUsd > 250_000,
          latest: buys.slice(0, 5).map(b => ({ name: b.name, shares: b.change, date: b.transactionDate })),
        })
      } catch {
        /* one symbol failing must not kill the sweep */
      }
    }),
  )
  return out.sort((a, b) => Number(b.isCluster) - Number(a.isCluster) || b.totalValueUsd - a.totalValueUsd)
}

// ---- full-roster coverage via rotation + 24h caching ----
//
// buildBoard used to fetch insider data for the watchlist only, so the other
// ~75 roster names always went to a null factor. Insider windows are 90 days,
// so coverage can accumulate cheaply: fetch the watchlist every run plus a
// deterministic rotating slice of non-watchlist names, cache each summary for
// 24h, and let coverage build to the whole roster over ~4 runs.

const INSIDER_TTL_SEC = 24 * 3600
const INSIDER_SLICE = 20 // ~roster/4 → full coverage every ~4 runs
const FETCH_CHUNK = 15 // fetchInsiderBuys slices to 15 US symbols per call — respect it
// Distinct namespace from market-data.mts's list key `insiders:${sortedSyms}`
// (a single-symbol request there would otherwise collide on `insiders:AAPL`).
const coverageKey = (sym: string) => `insiders:cov:${sym}`

interface InsiderCacheEntry {
  summary: InsiderSummary | null // null = checked, no open-market buys; entry present at all = "checked"
}

/** Deterministic rotating window over a sorted list: same day → same slice,
 * next day → the window advanced by `size` (wrapping). No Math.random. */
export function rotationSlice(sorted: string[], dayIndex: number, size: number): string[] {
  const n = sorted.length
  if (n === 0 || size <= 0) return []
  const start = ((dayIndex * size) % n + n) % n
  const take = Math.min(size, n)
  const out: string[] = []
  for (let i = 0; i < take; i++) out.push(sorted[(start + i) % n])
  return out
}

const dayIndexFor = (dateISO: string) => Math.floor(Date.parse(dateISO) / 86_400_000)

export interface InsiderCoverageOpts {
  fetchFn?: typeof fetch
  cacheGet?: <T>(key: string) => Promise<T | null>
  cacheSet?: (key: string, value: unknown, ttlSec: number) => Promise<void>
  sliceSize?: number
}

/** Roster-wide insider coverage. Returns a map keyed by every symbol that has
 * been CHECKED (cache hit from any prior day ≤24h, or fetched this run):
 *   - value = InsiderSummary → open-market buys found
 *   - value = null           → checked, no buys (factor scores 0)
 * A symbol absent from the map was never checked → factor stays null. */
export async function collectInsiderCoverage(
  rosterSyms: string[],
  watchSyms: string[],
  dateISO: string,
  finnhubKey: string,
  opts: InsiderCoverageOpts = {},
): Promise<Map<string, InsiderSummary | null>> {
  const fetchFn = opts.fetchFn ?? fetch
  const cacheGet = opts.cacheGet ?? getCached
  const cacheSet = opts.cacheSet ?? setCached
  const sliceSize = opts.sliceSize ?? INSIDER_SLICE

  const coverage = new Map<string, InsiderSummary | null>()
  const watch = new Set(watchSyms)
  const usRoster = [...new Set(rosterSyms.filter(s => exchangeFor(s) === 'US'))]

  // 1. seed coverage from cache — this is how coverage accumulates day over day
  const cached = new Set<string>()
  await Promise.all(
    usRoster.map(async sym => {
      const hit = await cacheGet<InsiderCacheEntry>(coverageKey(sym))
      if (hit) {
        coverage.set(sym, hit.summary ?? null)
        cached.add(sym)
      }
    }),
  )

  // 2. fetch set: watchlist every run (as before) + a rotating slice of non-watchlist US misses
  const usWatch = watchSyms.filter(s => exchangeFor(s) === 'US')
  const nonWatch = usRoster.filter(s => !watch.has(s)).sort()
  const window = rotationSlice(nonWatch, dayIndexFor(dateISO), sliceSize)
  const rotatingMisses = window.filter(s => !cached.has(s))
  const toFetch = [...new Set([...usWatch, ...rotatingMisses])]

  // 3. fetch in ≤15-symbol chunks, sequential — well under Finnhub's 60 req/min
  for (let i = 0; i < toFetch.length; i += FETCH_CHUNK) {
    const chunk = toFetch.slice(i, i + FETCH_CHUNK)
    const results = await fetchInsiderBuys(chunk, finnhubKey, fetchFn)
    const buysBySym = new Map(results.map(r => [r.symbol, r]))
    for (const sym of chunk) {
      const summary = buysBySym.get(sym) ?? null // absent from results = no buys = checked-empty
      coverage.set(sym, summary)
      await cacheSet(coverageKey(sym), { summary } satisfies InsiderCacheEntry, INSIDER_TTL_SEC)
    }
  }

  return coverage
}
