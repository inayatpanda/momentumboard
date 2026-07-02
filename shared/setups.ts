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

function indexHealthy(candles: Candle[]): 'up' | 'down' | 'mixed' {
  const closes = candles.map(c => c.c)
  const s20 = sma(closes, 20)
  const s50 = sma(closes, 50)
  const c = last(closes)
  const m20 = last(s20)
  const m50 = last(s50)
  const m20prev = s20[s20.length - 6] // 20-SMA five bars ago → slope
  if (m20 == null || m50 == null || m20prev == null) return 'mixed'
  if (c > m20 && m20 > m20prev && c > m50) return 'up'
  if (c < m50 && m20 <= m20prev) return 'down'
  return 'mixed'
}

export function regimeFromCandles(spy: Candle[], qqq: Candle[]): RegimeColor {
  const a = indexHealthy(spy)
  const b = indexHealthy(qqq)
  if (a === 'up' && b === 'up') return 'green'
  if (a === 'down' || b === 'down') return a === b ? 'red' : 'amber'
  return 'amber'
}

export function hasBullishDivergence(closes: number[], rsiVals: (number | null)[], lookback = 40): boolean {
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

function isBasing(candles: Candle[]): boolean {
  const closes = candles.map(c => c.c)
  const n = closes.length
  if (n < 40) return false
  const min = (a: number[]) => Math.min(...a)
  const max = (a: number[]) => Math.max(...a)
  const recent10 = closes.slice(-THRESHOLDS.baseSessions)
  const prior = closes.slice(-30, -THRESHOLDS.baseSessions)
  const noNewLow = min(recent10) > min(prior)
  // Contraction vs the whole preceding 20-bar window (includes the decline),
  // not just the previous 10 bars — inside a long flat base those are identical.
  const recentRange = max(recent10) - min(recent10)
  const contracting = recentRange < 0.5 * (max(prior) - min(prior))
  const s200 = last(sma(closes, 200))
  const c = last(closes)
  const declined = c <= (1 - THRESHOLDS.declineOffHighPct / 100) * max(closes) || (s200 != null && c < s200)
  return noNewLow && contracting && declined
}

export function detectSetups(candles: Candle[], rvol: number | null): SetupKind[] {
  const out: SetupKind[] = []
  const closes = candles.map(c => c.c)
  const vols = candles.map(c => c.v)
  const n = closes.length
  if (n < 25) return out
  const c = last(closes)
  const rsiSeries = rsi(closes)
  const r = last(rsiSeries)
  const s20series = sma(closes, 20)
  const m20 = last(s20series)
  const m50 = last(sma(closes, 50))
  const m200 = last(sma(closes, 200))
  const a14 = last(atr(candles))
  const min = (a: number[]) => Math.min(...a)
  const max = (a: number[]) => Math.max(...a)

  const avgVol20 = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
  const knife = c <= min(closes.slice(-20)) && r != null && r < THRESHOLDS.knifeRsi && last(vols) > THRESHOLDS.knifeVolX * avgVol20
  if (knife) out.push('fallingKnife')

  if (!knife && isBasing(candles)) out.push('basing')
  if (!knife && hasBullishDivergence(closes, rsiSeries) && c <= 0.75 * max(closes)) out.push('divergence')

  const m20y = s20series[n - 2]
  if (
    m20 != null && m20y != null && closes[n - 2] <= m20y && c > m20 &&
    rvol != null && rvol >= THRESHOLDS.reclaimRvol && isBasing(candles.slice(0, -1))
  ) out.push('reclaim')

  const uptrend = (m50 != null && m200 != null && m50 > m200) || (m200 == null && m20 != null && m50 != null && m20 > m50)
  if (uptrend && m20 != null && r != null) {
    const high20 = max(closes.slice(-20))
    const ddPct = ((high20 - c) / high20) * 100
    if (ddPct >= THRESHOLDS.pullbackMinPct && ddPct <= THRESHOLDS.pullbackMaxPct && r >= 35 && r <= 55) out.push('pullbackZone')
  }

  const allHigh = max(closes)
  if (c >= allHigh && rvol != null && rvol >= THRESHOLDS.breakoutRvol) out.push('breakoutLive')
  else if (c >= 0.95 * allHigh && (max(closes.slice(-15)) - min(closes.slice(-15))) / c < 0.08) out.push('breakoutWatch')

  if (m20 != null && a14 != null && r != null && c > m20 + 2 * a14 && r > THRESHOLDS.overextRsi) out.push('overextended')

  return out
}
