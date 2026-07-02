import type { Candle } from '../types'
import { round1 } from './types'

// Every YouTube stance is a mini-prediction, graded like the engine's own:
// excess vs SPY at +5 sessions. Channels earn (or bleed) credibility, which
// is what the channels factor weighs their next call by. Trust, but verify —
// favourites start at 0.6 instead of 0.5; ~20 graded calls dominate either way.

export interface ChannelCredEntry {
  graded: number
  hits: number
  sumExcess: number
  recent: { key: string; at: number; sym: string; stance: string; hit: boolean }[]
}

export type ChannelCredState = Record<string, ChannelCredEntry>

export interface ExtractLike {
  url: string
  channel: string
  at: number
  tickers: { sym: string; stance: 'bull' | 'bear' | 'neutral' }[]
}

const PRIOR_WEIGHT = 8

export function credibilityOf(state: ChannelCredState, channel: string, favourites: string[]): number {
  const prior = favourites.includes(channel) ? 0.6 : 0.5
  const e = state[channel]
  if (!e) return prior
  return (e.hits + prior * PRIOR_WEIGHT) / (e.graded + PRIOR_WEIGHT)
}

const DAY = 86_400
const MIN_AGE = 7 * DAY // ≥5 trading sessions must have passed
const MAX_AGE = 60 * DAY

export function gradeChannelStances(
  extracts: ExtractLike[],
  candlesBySym: Map<string, Candle[]>,
  spyCandles: Candle[],
  state: ChannelCredState,
  nowSec: number,
): { state: ChannelCredState; graded: number } {
  const seen = new Set<string>()
  for (const e of Object.values(state)) for (const r of e.recent) seen.add(r.key)

  let graded = 0
  for (const ex of extracts) {
    const age = nowSec - ex.at
    if (age < MIN_AGE || age > MAX_AGE) continue
    for (const t of ex.tickers) {
      if (t.stance === 'neutral') continue
      const key = `${ex.url}|${t.sym}`
      if (seen.has(key)) continue
      const candles = candlesBySym.get(t.sym)
      if (!candles) continue
      const entryIdx = candles.findIndex(c => c.t > ex.at) // first session after the video
      if (entryIdx === -1 || entryIdx + 5 >= candles.length) continue
      const spyIdx = spyCandles.findIndex(c => c.t > ex.at)
      if (spyIdx === -1 || spyIdx + 5 >= spyCandles.length) continue
      // grading measures the capturable move from the first tradeable print: base
      // at the OPEN of the first session after the video, not its close (a viewer
      // acts at the next session's open, not at a close they couldn't have filled)
      const base = candles[entryIdx].o
      const rawPct = ((candles[entryIdx + 5].c - base) / base) * 100
      const spyBase = spyCandles[spyIdx].o
      const spyPct = ((spyCandles[spyIdx + 5].c - spyBase) / spyBase) * 100
      const sign = t.stance === 'bear' ? -1 : 1
      const excess = round1(sign * (rawPct - spyPct))
      const hit = excess > 0

      const entry = state[ex.channel] ?? { graded: 0, hits: 0, sumExcess: 0, recent: [] }
      entry.graded++
      if (hit) entry.hits++
      entry.sumExcess = round1(entry.sumExcess + excess)
      entry.recent.push({ key, at: ex.at, sym: t.sym, stance: t.stance, hit })
      if (entry.recent.length > 200) entry.recent = entry.recent.slice(-200)
      state[ex.channel] = entry
      seen.add(key)
      graded++
    }
  }
  return { state, graded }
}
