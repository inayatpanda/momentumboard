import type { Candle } from './types'
import { sma, rsi, atr } from './indicators'
import { detectSetups } from './setups'

// Where is a stock IN its move? The reversal-first read: reward names that are
// basing / turning up / pulling back into support; penalise names that have
// already climbed and are extended, overbought and near their highs — those are
// chases, not entries, whatever their momentum. Volume tells us if a move is real.

export type Stage =
  | 'early-reversal' // basing after decline, now turning up on volume — the prize
  | 'basing' // coiling after a decline, no trigger yet — watch
  | 'pullback' // healthy dip in an uptrend, near support — a buy zone
  | 'trending' // advancing, not extended — fine but not an ideal fresh entry
  | 'extended' // stretched above the 20-day, overbought — chasing here is poor R:R
  | 'exhausted' // very extended AND pinned at range highs — reversal/fade risk
  | 'falling-knife' // still dropping, oversold, no turn yet — wait
  | 'weak' // below the 50-day, drifting — avoid

export type EntryQuality = 'early' | 'neutral' | 'chase' | 'wait'

export interface TechnicalRead {
  sym: string
  price: number | null
  rsi: number | null
  pctFrom20d: number | null // +ve = above the 20-day (extension)
  pctFrom50d: number | null
  atrMultFrom20d: number | null // how many ATRs above/below the 20-day
  rangePos: number | null // 0 = at 60-day low, 1 = at 60-day high
  rvol: number | null // last session volume vs 20-day average
  volumeConfirmed: boolean // move backed by above-average volume
  setups: string[]
  stage: Stage
  entryQuality: EntryQuality
  note: string // one-line plain-English read for the paper
}

const lastOf = <T,>(a: T[]): T | undefined => a[a.length - 1]

export function technicalStage(sym: string, candles: Candle[]): TechnicalRead | null {
  if (!candles || candles.length < 30) return null
  const closes = candles.map(c => c.c)
  const vols = candles.map(c => c.v)
  const price = lastOf(closes)!
  const r = lastOf(rsi(closes)) ?? null
  const m20 = lastOf(sma(closes, 20)) ?? null
  const m50 = lastOf(sma(closes, 50)) ?? null
  const a14 = lastOf(atr(candles)) ?? null

  const pctFrom20d = m20 ? Math.round(((price - m20) / m20) * 1000) / 10 : null
  const pctFrom50d = m50 ? Math.round(((price - m50) / m50) * 1000) / 10 : null
  const atrMultFrom20d = m20 && a14 ? Math.round(((price - m20) / a14) * 10) / 10 : null

  const win = closes.slice(-60)
  const lo = Math.min(...win)
  const hi = Math.max(...win)
  const rangePos = hi > lo ? Math.round(((price - lo) / (hi - lo)) * 100) / 100 : null

  const avgVol20 = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
  const rvol = avgVol20 > 0 ? Math.round((lastOf(vols)! / avgVol20) * 10) / 10 : null
  const volumeConfirmed = rvol != null && rvol >= 1.3

  const setups = detectSetups(candles, rvol)

  // stage: reversal-first classification
  let stage: Stage
  if (setups.includes('fallingKnife')) stage = 'falling-knife'
  else if (setups.includes('reclaim') || (setups.includes('basing') && (setups.includes('divergence') || (rvol != null && rvol >= 1.5 && price > (m20 ?? price))))) stage = 'early-reversal'
  else if (setups.includes('basing') || setups.includes('divergence')) stage = 'basing'
  else if (setups.includes('overextended') || (r != null && r >= 72 && atrMultFrom20d != null && atrMultFrom20d >= 2)) stage = rangePos != null && rangePos >= 0.9 ? 'exhausted' : 'extended'
  else if (setups.includes('pullbackZone')) stage = 'pullback'
  else if (m50 != null && price < m50 && (pctFrom50d ?? 0) < -1) stage = 'weak'
  else if (m20 != null && price > m20 && (pctFrom20d ?? 0) > 0) stage = 'trending'
  else stage = 'weak'

  const entryQuality: EntryQuality =
    stage === 'early-reversal' || stage === 'pullback' ? 'early'
    : stage === 'extended' || stage === 'exhausted' ? 'chase'
    : stage === 'falling-knife' ? 'wait'
    : 'neutral'

  const note = buildNote(stage, { r, pctFrom20d, rangePos, rvol, volumeConfirmed })
  return { sym, price, rsi: r, pctFrom20d, pctFrom50d, atrMultFrom20d, rangePos, rvol, volumeConfirmed, setups, stage, entryQuality, note }
}

function buildNote(stage: Stage, m: { r: number | null; pctFrom20d: number | null; rangePos: number | null; rvol: number | null; volumeConfirmed: boolean }): string {
  const vol = m.volumeConfirmed ? `volume-confirmed (RVOL ${m.rvol})` : `on light volume (RVOL ${m.rvol ?? '?'})`
  const rangeStr = m.rangePos != null ? `${Math.round(m.rangePos * 100)}% up its 60-day range` : ''
  switch (stage) {
    case 'early-reversal':
      return `Turning up out of a base, ${vol} — the reversal-first entry, near support with room to run.`
    case 'basing':
      return `Coiling after a decline, no trigger yet (${rangeStr}). Watch for a volume reclaim of the 20-day.`
    case 'pullback':
      return `Healthy pullback in an uptrend (RSI ${m.r ?? '?'}) — buying the dip near support, not chasing.`
    case 'trending':
      return `Advancing but not extended (${m.pctFrom20d ?? '?'}% above the 20-day) — acceptable, not a fresh setup.`
    case 'extended':
      return `Already extended ${m.pctFrom20d ?? '?'}% above the 20-day, RSI ${m.r ?? '?'} — chasing here is poor risk/reward; wait for a pullback.`
    case 'exhausted':
      return `Stretched and pinned at the highs (${rangeStr}, RSI ${m.r ?? '?'}) — reversal risk; a fade candidate, not a long.`
    case 'falling-knife':
      return `Still falling, oversold, no turn confirmed — wait for a base and a reclaim before touching it.`
    case 'weak':
      return `Below the 50-day and drifting — no edge here.`
  }
}
