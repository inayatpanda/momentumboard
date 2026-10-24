/** Descriptive market context; never used as a forecast probability or trading gate. */
export const PATTERN_ASSETS = [
  { symbol: 'SPY', name: 'US shares', detail: 'S&P 500 fund, including dividends' },
  { symbol: 'TLT', name: 'US government bonds', detail: 'Long-term Treasury bond fund; bond prices, not yields' },
  { symbol: 'USO', name: 'Oil futures fund', detail: 'Oil futures investment; rolling contracts and costs mean this is not the spot oil price' },
  { symbol: 'GLD', name: 'Gold', detail: 'Gold-backed fund, after fund expenses' },
  { symbol: 'SLV', name: 'Silver', detail: 'Silver-backed fund, after fund expenses' },
] as const
export interface PatternPeriod { date: string; endDate: string; returns: number[] }
export interface MarketPatternsSnapshot {
  version: 1
  generatedAt: number
  dataFrom: string
  dataThrough: string
  observations: number
  digest: string
  current: { symbol: string; monthPct: number; quarterPct: number }[]
  pairs: { a: string; b: string; recent: number | null; historical: number | null; recentN: number; historicalN: number }[]
  seasonal: PatternPeriod[]
  similar: (PatternPeriod & { distance: number; precedingReturns: number[] })[]
}
