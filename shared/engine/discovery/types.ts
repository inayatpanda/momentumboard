// Discovery engine v2 — the contract between the pure core (features, lenses,
// ranking, universe), the I/O layer (bars fetch + cache, netlify/functions/lib)
// and the wiring in buildBoard. See docs/superpowers/specs/2026-09-22-discovery-engine-v2-design.md.
//
// Everything here is plain data. No module in shared/engine/discovery may do I/O.

import type { Candle } from '../../types'
// Type-only, and only for `IndexTag`: universeSeedBuild.ts is pure with no
// imports of its own, so this cannot make a cycle. The tags travel with a member
// because "which index listed it" is evidence the seed HAS and the band alone
// throws away (see UniverseMember.index).
import type { IndexTag } from './universeSeedBuild'

export type { IndexTag }

export type Exchange = 'US' | 'LSE'
export type CapBand = 'large' | 'mid' | 'small'

/** One name the engine may look at. Seed rows come from index membership;
 * dynamic rows are nominated at run time (screens, social, news, LLM, watchlist…). */
export interface UniverseMember {
  sym: string
  exchange: Exchange
  capBand: CapBand | null
  sector: string | null
  /** The seed's own index tags ('sp500', 'ftse100'…). Absent on a dynamic member:
   * a nominator says "look at this", never "the S&P lists it". Carried because
   * `capBand` is LOSSY — sp500 and sp600 both collapse into a band, and the only
   * consumer that treats a band as size evidence (the dip lane's quality door)
   * needs to know WHICH list said so. */
  index?: IndexTag[]
  /** Yahoo's quote currency for the name ('USD', 'GBp', 'EUR'). `GBp` is PENCE
   * and is the only value that earns the pence divisor and the 50p price floor —
   * eight LSE-listed rows in the committed seed (CPG.L, IHG.L…) quote in USD or
   * EUR, and treating those as pence floors them out of the scan. Absent =
   * unknown, and only then does the exchange decide. */
  currency?: string | null
  /** why the name is in the universe: 'seed:sp500', 'seed:ftse250', 'nom:screener:gainers', 'nom:social', 'nom:watchlist' … */
  origins: string[]
  /** ISO date the name last earned its place (seed rows: the seed's generatedAt) */
  lastSeen: string
}

/** Persisted dynamic membership — blob `universe:v1`. Seed rows are never stored. */
export interface DynamicUniverseState {
  version: 1
  members: Record<string, { origins: string[]; joined: string; lastSeen: string; capBand: CapBand | null; sector: string | null; exchange: Exchange }>
}

export const DYNAMIC_UNIVERSE_KEY = 'universe:v1'
export const DYNAMIC_UNIVERSE_MAX = 600
/** sessions a dynamic member survives without being re-nominated or selected */
export const DYNAMIC_UNIVERSE_TTL_SESSIONS = 60

export type LensId = 'unusual' | 'rs-leader' | 'pullback' | 'breakout' | 'dip' | 'weak' | 'climax'
export const LENS_IDS: readonly LensId[] = ['unusual', 'rs-leader', 'pullback', 'breakout', 'dip', 'weak', 'climax']

/** Per-name features computed from ≥ 60 daily bars. Null = not computable. */
export interface Features {
  sym: string
  bars: number
  lastT: number
  close: number
  ret1: number | null
  ret5: number | null
  ret10: number | null
  ret20: number | null
  ret60: number | null
  gapPct: number | null
  atrPct14: number | null
  /** the name's own typical 10-session |move|, p80 over ~1y (shared/indicators swingCapacity) */
  typicalMove10: number | null
  rvol: number | null // today's volume / 20-day median volume
  dollarVol20: number | null // median of close*volume over 20 sessions
  ema8: number | null
  ema21: number | null
  ema50: number | null
  ema50Slope20: number | null // (ema50 today − ema50 20 sessions ago) / ema50, as %
  distEma21Atr: number | null // (close − ema21) / ATR14
  rsi14: number | null
  ddFrom20dHigh: number | null // % below the 20-session high (≤ 0)
  ddFrom60dHigh: number | null
  distTo52wHigh: number | null // % below the ~250-session high (≤ 0)
  upDays5: number | null
  upDays10: number | null
  broke20dHigh: boolean | null
  broke60dHigh: boolean | null
  broke20dLow: boolean | null
  bbWidthPctl120: number | null // percentile (0–1) of today's Bollinger width vs last 120 sessions
  rsSpy20: number | null // ret20 − SPY ret20, in pp
  rsSpy60: number | null
  volTrend5: number | null // mean vol last 5 / mean vol prior 20
  lowerHighs: boolean | null // last two 10-session swing highs descending
}

/** Cross-sectional percentile (0–1) of the features a lens actually reads.
 *
 * EXACTLY those three. Ranking a field costs a sort over the whole universe every
 * run, and six of the original nine (ret1, ret5, ret20, rvol, dollarVol20,
 * ddFrom20dHigh) were read by nothing — a cost with no reader. `rank.test.ts`
 * pins the set against the fields lenses.ts actually dereferences, so adding a
 * field without a reader fails, and so does a lens reading a field nobody ranks. */
export interface Percentiles {
  rsSpy20: number
  rsSpy60: number
  unusual: number // |ret1| / typicalMove10-scaled
}

export interface LensHit {
  lens: LensId
  /** 0–1, comparable across names within one lens on one day */
  score: number
  /** one honest sentence for the trace and the paper */
  reason: string
  /** side the lens argues; null = no stance (unusual lets composeCall decide) */
  side: 'long' | 'short' | null
}

export interface DiscoveryCandidate {
  sym: string
  exchange: Exchange
  capBand: CapBand | null
  sector: string | null
  /** the seed index tags behind `capBand`, carried for the one caller that needs
   * to know which list conferred it (buildBoard's dip-lane quality door) */
  index?: IndexTag[]
  lenses: LensHit[] // best first, at most 2
  features: Features
  /** 0–1 blended priority used to order the pool; ≥ 2 independent nominators bump it */
  priority: number
  nominators: string[] // origins that also named it today (e.g. 'nom:social')
}

export type DiscoveryRejectCode =
  | 'no-bars' // fetch failed and nothing fresh in cache
  | 'stale-bars' // last bar older than the freshness limit
  | 'too-short' // < 60 bars
  | 'etp' // leveraged/inverse route, never an underlying
  | 'price-floor'
  | 'liquidity-floor'
  | 'no-lens' // features fine, no lens fired
  | 'lens-cut' // fired but fell past the lens's top-N / sector cap
  | 'budget-cut' // scan budget (time/requests) ran out before this name was read

export interface DiscoveryTraceRow {
  sym: string
  /** 'selected' or the reject code */
  outcome: 'selected' | DiscoveryRejectCode
  lenses?: { lens: LensId; score: number }[]
  detail?: string
}

export interface DiscoveryStats {
  universeSize: number
  seedSize: number
  dynamicSize: number
  // The four bars columns PARTITION the universe:
  //   barsFetched + barsFromCache + barsFailed + barsUnread === universeSize
  // A name served from cache after the budget cut is `fromCache` and nothing
  // else — it was read, so it is not unread, not failed, and it faces the lenses
  // like any other tape.
  barsFetched: number
  barsFromCache: number
  /** attempted and unreadable: no fetch, no cache, no fallback */
  barsFailed: number
  /** the budget never let the run attempt them, and nothing was held for them */
  barsUnread: number
  scanned: number // names with computable features
  selected: number
  perLens: Record<LensId, number>
  /** How many names each reject code accounted for. The trace is bounded at
   * DISCOVERY_TRACE_MAX and ordered near-misses first, so the hygiene rejects —
   * 139 names in the 2026-09-22 dry run — fall off the end of it and appear
   * NOWHERE. These counts are over the whole universe, unbounded. Codes that
   * rejected nobody are absent rather than zero. */
  rejects: Partial<Record<DiscoveryRejectCode, number>>
  /** Tapes whose last bar was the session still in progress and was discarded
   * before any feature read it (discoveryBars.isPartialLastBar). Non-zero means
   * the run happened during market hours; 0 is the expected pre-open number. */
  partialDropped: number
  elapsedMs: number
  budgetHit: boolean
}

export interface DiscoveryResult {
  date: string
  candidates: DiscoveryCandidate[]
  /** every universe name, bounded by DISCOVERY_TRACE_MAX (selected rows first) */
  trace: DiscoveryTraceRow[]
  stats: DiscoveryStats
  /** the bars the scan already holds — buildBoard reuses them so no candle is fetched twice */
  tapes: Map<string, Candle[]>
}

export const DISCOVERY_TRACE_MAX = 400
export const DISCOVERY_TRACE_KEY = (date: string) => `discovery-trace:${date}`

/** Hygiene floors (applied in rank/universe, pure). */
export const HYGIENE = {
  minBars: 60,
  maxStaleSessions: 3,
  minPriceUS: 2,
  minPriceGBp: 50, // only for a name that actually quotes in pence (currency 'GBp')
  minDollarVol20US: 5_000_000,
  minDollarVol20LSE: 2_000_000, // £ (pence/100 × volume)
} as const

/** Per-lens selection caps; the sum is the scan's contribution to the candidate pool. */
export const LENS_TOP_N: Record<LensId, number> = {
  unusual: 25,
  'rs-leader': 20,
  pullback: 15,
  breakout: 20,
  dip: 15,
  weak: 15,
  climax: 10,
}
export const LENS_SECTOR_SHARE_MAX = 0.3
export const MAX_LENSES_PER_NAME = 2
