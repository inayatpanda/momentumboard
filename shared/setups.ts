import type { Candle, RegimeColor, SetupKind } from './types'
import { sma, rsi, atr } from './indicators'

export const THRESHOLDS = {
  baseSessions: 10,
  declineOffHighPct: 25,
  reclaimRvol: 1.5,
  breakoutRvol: 2,
  pullbackMinPct: 3,
  pullbackMaxPct: 8,
  overextRsi: 75,
  knifeRsi: 30,
  knifeVolX: 1.5,
} as const

const last = <T,>(a: T[]): T => a[a.length - 1]

/** THE BAR WINDOWS every setup read is measured over, lifted out of the code as
 * data (Stage 1c Phase B, Task B2).
 *
 * WHY THIS EXISTS. Every number below was written in EQUITY SESSIONS, and a
 * session is five-sevenths of a week. Read unchanged on a 24/7 tape, "the
 * 50-day" becomes seven weeks instead of ten and "a 20-bar low" is a fortnight
 * rather than four weeks (recon §3.4). The crypto lane therefore needs the same
 * READS over different SPANS — not different reads — so the windows become a
 * parameter and the logic stays in exactly one place. Two profiles, one
 * cascade: the alternative was a second copy of `detectSetups` on the crypto
 * clock, which is two definitions of `basing` drifting apart from the day it is
 * written.
 *
 * THE DEFAULT IS THE EQUITY PROFILE and every existing call site omits the
 * argument, so nothing about an equity read moves by a single byte. The crypto
 * profile is built in `shared/engine/cryptoLane.ts` from B1's adjudicated
 * `CRYPTO_LOOKBACKS` table — per indicator, with the exceptions argued there —
 * and never by multiplying this object by 1.4.
 *
 * `THRESHOLDS` above is deliberately NOT part of this: those are percentages,
 * ratios and oscillator levels with no calendar in them (B1's
 * `CRYPTO_NOT_A_CLOCK`), and scaling a percentile is meaningless. */
export interface SetupWindows {
  readonly sma20: number
  readonly sma50: number
  readonly sma200: number
  readonly atr: number
  /** The RSI PERIOD, and it does not scale — the fixed thresholds that read it
   * (knifeRsi 30, overextRsi 75, the 35–55 pullback band) were calibrated
   * against this smoothing constant. See CRYPTO_LOOKBACKS.rsi14. */
  readonly rsi: number
  /** How many bars count as "the base" in `isBasing`. */
  readonly baseSessions: number
  /** The window the base is compared against — the decline that preceded it. */
  readonly basePrior: number
  /** `isBasing`'s minimum history: the prior window plus the base itself. */
  readonly basingMinHistory: number
  readonly divergenceLookback: number
  /** The low a falling knife has to be making. */
  readonly knifeWindow: number
  /** The high the pullback drawdown is measured from. */
  readonly pullbackHigh: number
  /** The coil window a breakout-watch is measured over. */
  readonly breakoutWatch: number
  /** The volume baseline `avgVol20` averages over (today excluded). */
  readonly rvolBaseline: number
  /** Below this many bars `detectSetups` returns nothing at all. */
  readonly minHistory: number
}

/** The windows as they have always been written — five-day weeks. */
export const EQUITY_SETUP_WINDOWS: SetupWindows = {
  sma20: 20,
  sma50: 50,
  sma200: 200,
  atr: 14,
  rsi: 14,
  baseSessions: THRESHOLDS.baseSessions,
  basePrior: 30,
  basingMinHistory: 40,
  divergenceLookback: 40,
  knifeWindow: 20,
  pullbackHigh: 20,
  breakoutWatch: 15,
  rvolBaseline: 20,
  minHistory: 25,
}

/** The windows the INDEX read is measured over — `indexHealthy`'s own three.
 * Separate from `SetupWindows` because it answers a different question about a
 * different series (a whole tape's health, not one name's setup shape), and
 * because the crypto lane feeds it BTC alone. */
export interface IndexWindows {
  readonly sma20: number
  readonly sma50: number
  /** How many bars back the 20-SMA slope is read over. */
  readonly slopeLag: number
}

export const EQUITY_INDEX_WINDOWS: IndexWindows = { sma20: 20, sma50: 50, slopeLag: 5 }

function indexHealthy(candles: Candle[], w: IndexWindows = EQUITY_INDEX_WINDOWS): 'up' | 'down' | 'mixed' {
  const closes = candles.map(c => c.c)
  const s20 = sma(closes, w.sma20)
  const s50 = sma(closes, w.sma50)
  const c = last(closes)
  const m20 = last(s20)
  const m50 = last(s50)
  const m20prev = s20[s20.length - (w.slopeLag + 1)] // 20-SMA five bars ago → slope
  if (m20 == null || m50 == null || m20prev == null) return 'mixed'
  if (c > m20 && m20 > m20prev && c > m50) return 'up'
  if (c < m50 && m20 <= m20prev) return 'down'
  return 'mixed'
}

export function regimeFromCandles(spy: Candle[], qqq: Candle[], w: IndexWindows = EQUITY_INDEX_WINDOWS): RegimeColor {
  const a = indexHealthy(spy, w)
  const b = indexHealthy(qqq, w)
  if (a === 'up' && b === 'up') return 'green'
  if (a === 'down' || b === 'down') return a === b ? 'red' : 'amber'
  return 'amber'
}

/** Index SMA slope is a narrow lens: a green SPY carried by five megacaps over
 * rotting breadth is not a green tape, and no SMA read survives a VIX spike.
 * Refines the base regime with market breadth (share of a broad universe above
 * its 50-SMA) and the VIX LEVEL (the world-tape vote uses only its daily
 * change). Null inputs leave the base read untouched — no data, no opinion. */
export function refineRegime(base: RegimeColor, breadthPct: number | null, vixLevel: number | null): RegimeColor {
  let r = base
  if (breadthPct != null) {
    if (r === 'green' && breadthPct < 0.35) r = 'amber' // thin leadership: don't trust the green
    if (r === 'red' && breadthPct > 0.65) r = 'amber' // broad participation under a red index read: repair underway
  }
  if (vixLevel != null) {
    if (vixLevel >= 32) r = 'red' // panic pricing overrides everything
    else if (vixLevel >= 25 && r === 'green') r = 'amber' // elevated fear caps a green read
  }
  return r
}

/** Breadth: the share of series whose last close sits above its 50-SMA.
 * Needs a minimum sample to mean anything — below that, null. */
export function breadthAbove50(seriesList: number[][], minSeries = 10): number | null {
  let above = 0
  let total = 0
  for (const closes of seriesList) {
    if (closes.length < 50) continue
    const m50 = sma(closes, 50)[closes.length - 1]
    if (m50 == null) continue
    total++
    if (closes[closes.length - 1] > m50) above++
  }
  return total >= minSeries ? above / total : null
}

export function hasBullishDivergence(closes: number[], rsiVals: (number | null)[], lookback = EQUITY_SETUP_WINDOWS.divergenceLookback): boolean {
  const n = closes.length
  if (n < lookback) return false
  const from = n - lookback
  const mid = from + Math.floor(lookback / 2)
  const minIdx = (s: number, e: number) => {
    let idx = s
    for (let i = s; i < e; i++) if (closes[i] < closes[idx]) idx = i
    return idx
  }
  const i1 = minIdx(from, mid)
  const i2 = minIdx(mid, n)
  const r1 = rsiVals[i1]
  const r2 = rsiVals[i2]
  if (r1 == null || r2 == null) return false
  return closes[i2] <= closes[i1] * 1.005 && r2 > r1 + 2
}

function isBasing(candles: Candle[], w: SetupWindows = EQUITY_SETUP_WINDOWS): boolean {
  const closes = candles.map(c => c.c)
  const n = closes.length
  if (n < w.basingMinHistory) return false
  const min = (a: number[]) => Math.min(...a)
  const max = (a: number[]) => Math.max(...a)
  const recent10 = closes.slice(-w.baseSessions)
  const prior = closes.slice(-w.basePrior, -w.baseSessions)
  const noNewLow = min(recent10) > min(prior)
  // Contraction vs the whole preceding 20-bar window (includes the decline),
  // not just the previous 10 bars — inside a long flat base those are identical.
  const recentRange = max(recent10) - min(recent10)
  const contracting = recentRange < 0.5 * (max(prior) - min(prior))
  const s200 = last(sma(closes, w.sma200))
  const c = last(closes)
  const declined = c <= (1 - THRESHOLDS.declineOffHighPct / 100) * max(closes) || (s200 != null && c < s200)
  return noNewLow && contracting && declined
}

export function detectSetups(candles: Candle[], rvol: number | null, w: SetupWindows = EQUITY_SETUP_WINDOWS): SetupKind[] {
  const out: SetupKind[] = []
  const closes = candles.map(c => c.c)
  const vols = candles.map(c => c.v)
  const n = closes.length
  if (n < w.minHistory) return out
  const c = last(closes)
  const rsiSeries = rsi(closes, w.rsi)
  const r = last(rsiSeries)
  const s20series = sma(closes, w.sma20)
  const m20 = last(s20series)
  const m50 = last(sma(closes, w.sma50))
  const m200 = last(sma(closes, w.sma200))
  const a14 = last(atr(candles, w.atr))
  const min = (a: number[]) => Math.min(...a)
  const max = (a: number[]) => Math.max(...a)

  const avgVol20 = vols.slice(-(w.rvolBaseline + 1), -1).reduce((s, v) => s + v, 0) / w.rvolBaseline
  const knife = c <= min(closes.slice(-w.knifeWindow)) && r != null && r < THRESHOLDS.knifeRsi && last(vols) > THRESHOLDS.knifeVolX * avgVol20
  if (knife) out.push('fallingKnife')

  if (!knife && isBasing(candles, w)) out.push('basing')
  if (!knife && hasBullishDivergence(closes, rsiSeries, w.divergenceLookback) && c <= 0.75 * max(closes)) out.push('divergence')

  const m20y = s20series[n - 2]
  if (
    m20 != null && m20y != null && closes[n - 2] <= m20y && c > m20 &&
    rvol != null && rvol >= THRESHOLDS.reclaimRvol && isBasing(candles.slice(0, -1), w)
  ) out.push('reclaim')

  const uptrend = (m50 != null && m200 != null && m50 > m200) || (m200 == null && m20 != null && m50 != null && m20 > m50)
  if (uptrend && m20 != null && r != null) {
    const high20 = max(closes.slice(-w.pullbackHigh))
    const ddPct = ((high20 - c) / high20) * 100
    if (ddPct >= THRESHOLDS.pullbackMinPct && ddPct <= THRESHOLDS.pullbackMaxPct && r >= 35 && r <= 55) out.push('pullbackZone')
  }

  const allHigh = max(closes)
  if (c >= allHigh && rvol != null && rvol >= THRESHOLDS.breakoutRvol) out.push('breakoutLive')
  else if (c >= 0.95 * allHigh && (max(closes.slice(-w.breakoutWatch)) - min(closes.slice(-w.breakoutWatch))) / c < 0.08) out.push('breakoutWatch')

  if (m20 != null && a14 != null && r != null && c > m20 + 2 * a14 && r > THRESHOLDS.overextRsi) out.push('overextended')

  return out
}
