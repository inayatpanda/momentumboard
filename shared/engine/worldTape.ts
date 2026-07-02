import { round1 } from './types'
import { NEG, POS } from './factors'

// The engine runs 05:20 UTC: Asia is closed, Europe is open, US futures are
// live. This module turns that overnight world tape into a BOUNDED, ATTRIBUTABLE
// conviction nudge — it never touches the calibration bucketing (the regime
// string is passed through untouched); it only scales |composite| by side.

export interface WorldRead {
  sym: string
  name: string
  changePct: number | null // latest daily % change; null = a vote it cannot cast
}

// The overnight panel the tone is read from (VIX is passed separately — it votes
// on fear, not direction, so it earns an EXTRA vote at a wider ±5% threshold).
export const WORLD_SYMBOLS: { sym: string; name: string }[] = [
  { sym: '^N225', name: 'Nikkei' },
  { sym: '^HSI', name: 'Hang Seng' },
  { sym: '^NSEI', name: 'Nifty 50' }, // India's session is live at the 05:20 UTC run, same as Europe — no special handling
  { sym: '^GDAXI', name: 'DAX' },
  { sym: '^FTSE', name: 'FTSE 100' },
  { sym: 'ES=F', name: 'S&P fut' },
  { sym: 'NQ=F', name: 'Nasdaq fut' },
]
export const VIX_SYMBOL = { sym: '^VIX', name: 'VIX' }

const VOTE_THRESHOLD = 0.75
const VIX_THRESHOLD = 5

export type WorldTone = 'risk-on' | 'risk-off' | 'mixed'

const label = (r: WorldRead) => `${r.name} ${(r.changePct ?? 0) >= 0 ? '+' : ''}${round1(r.changePct ?? 0)}%`

/** Count each index/future as an off vote (≤ −0.75%) or on vote (≥ +0.75%); a
 * VIX spike (+5% or more) adds one extra off vote, a VIX collapse (−5% or less)
 * one extra on vote. tone = risk-off when off ≥ 4 and on ≤ 1, risk-on mirrored,
 * else mixed. Null reads cast nothing. */
export function worldTone(
  reads: WorldRead[],
  vixChangePct: number | null,
): { tone: WorldTone; votes: { on: number; off: number }; detail: string } {
  let on = 0
  let off = 0
  const offMovers: string[] = []
  const onMovers: string[] = []
  for (const r of reads) {
    if (r.changePct == null) continue
    if (r.changePct <= -VOTE_THRESHOLD) {
      off++
      offMovers.push(label(r))
    } else if (r.changePct >= VOTE_THRESHOLD) {
      on++
      onMovers.push(label(r))
    }
  }
  if (vixChangePct != null) {
    if (vixChangePct >= VIX_THRESHOLD) {
      off++
      offMovers.push(`VIX +${round1(vixChangePct)}%`)
    } else if (vixChangePct <= -VIX_THRESHOLD) {
      on++
      onMovers.push(`VIX ${round1(vixChangePct)}%`)
    }
  }
  const tone: WorldTone = off >= 4 && on <= 1 ? 'risk-off' : on >= 4 && off <= 1 ? 'risk-on' : 'mixed'
  const movers = [...offMovers, ...onMovers]
  const detail = `${tone} (off ${off} / on ${on})${movers.length ? ` — ${movers.join(', ')}` : ' — quiet overnight'}`
  return { tone, votes: { on, off }, detail }
}

/** The ONLY allowed multipliers. Risk-off leans against longs and with shorts;
 * risk-on the reverse; mixed is neutral. Bound: at most +10% conviction, −15%. */
export function worldMult(tone: WorldTone, side: 'long' | 'short'): number {
  if (tone === 'risk-off') return side === 'long' ? 0.85 : 1.1
  if (tone === 'risk-on') return side === 'long' ? 1.1 : 0.85
  return 1
}

/** Global news tone — DISPLAY / LOG ONLY, explicitly NOT a factor. Sums polarity
 * across ALL titles on the same POS/NEG lexicon the per-ticker newsFactor uses.
 * Factor status must be EARNED from the logged history first. */
export function newsTone(titles: string[]): { score: number; label: 'sour' | 'neutral' | 'upbeat'; hits: number } {
  let score = 0
  let hits = 0
  for (const t of titles) {
    for (const w of t.toLowerCase().split(/\W+/)) {
      if (POS.has(w)) {
        score++
        hits++
      } else if (NEG.has(w)) {
        score--
        hits++
      }
    }
  }
  const label = score <= -4 ? 'sour' : score >= 4 ? 'upbeat' : 'neutral'
  return { score, label, hits }
}
