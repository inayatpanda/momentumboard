import type { Stage } from '../technicals'
import type { SeasonalitySummary } from '../seasonality'
import { clamp, round1, type FactorScore } from './types'

// Every factor is pure and returns a SIGNED score toward long (−100..+100),
// or null when the data simply isn't there — null renormalises the composite,
// it never masquerades as "neutral".

const STAGE_SCORE: Record<Stage, number> = {
  'early-reversal': 70,
  pullback: 55,
  basing: 25,
  trending: 15,
  weak: -30,
  extended: -45,
  exhausted: -70,
  'falling-knife': 0, // wait — no edge either side until the turn confirms
}

export function technicalFactor(read: { stage: Stage; volumeConfirmed: boolean; rvol: number | null } | null): FactorScore {
  if (!read) return { score: null, detail: 'no chart data' }
  const base = STAGE_SCORE[read.stage]
  const score = clamp(read.volumeConfirmed ? base * 1.2 : base, -100, 100)
  return { score: round1(score), detail: `${read.stage}${read.volumeConfirmed ? ` volume-confirmed (RVOL ${read.rvol})` : ''}` }
}

export function momentumFactor(closes: number[] | null, spyCloses: number[] | null): FactorScore {
  if (!closes || !spyCloses || closes.length < 22 || spyCloses.length < 22) return { score: null, detail: 'insufficient history' }
  const ret21 = (xs: number[]) => ((xs[xs.length - 1] - xs[xs.length - 22]) / xs[xs.length - 22]) * 100
  const rs = ret21(closes) - ret21(spyCloses)
  return { score: round1(clamp(rs * 4, -80, 80)), detail: `21d RS vs SPY ${rs >= 0 ? '+' : ''}${round1(rs)}pp` }
}

export function sectorFactor(rankPct: number | null): FactorScore {
  if (rankPct == null) return { score: null, detail: 'no sector read' }
  return { score: round1((rankPct - 0.5) * 80), detail: `sector RS rank p${Math.round(rankPct * 100)}` }
}

/** Social hype is fuel, not thesis: long-only contribution, capped, and halved
 * when the name is already overbought — a crowded hot chart has burnt its fuel. */
export function socialFactor(
  row: { redditRank: number | null; surgeMultiple: number | null; sources: number } | null,
  rsi: number | null,
): FactorScore {
  if (!row) return { score: null, detail: 'no social data' }
  let s = row.sources >= 2 ? 20 : 10
  if (row.redditRank != null) s += Math.max(0, 25 - row.redditRank)
  if (row.surgeMultiple != null) s += row.surgeMultiple >= 2 ? 20 : row.surgeMultiple >= 1.5 ? 10 : 0
  s = Math.min(60, s)
  const crowded = rsi != null && rsi > 70
  if (crowded) s /= 2
  const bits = [`${row.sources} source(s)`]
  if (row.redditRank != null) bits.push(`reddit #${row.redditRank}`)
  if (row.surgeMultiple != null) bits.push(`${row.surgeMultiple}x surge`)
  if (crowded) bits.push('crowded+hot, halved')
  return { score: round1(s), detail: bits.join(', ') }
}

export function channelsFactor(
  stances: { channel: string; stance: 'bull' | 'bear' | 'neutral' }[],
  credOf: (channel: string) => number,
): FactorScore {
  const voiced = stances.filter(s => s.stance !== 'neutral')
  if (!voiced.length) return { score: null, detail: 'no channel views' }
  let net = 0
  for (const s of voiced) net += (s.stance === 'bull' ? 1 : -1) * 2 * credOf(s.channel)
  const names = [...new Set(voiced.map(s => s.channel))].slice(0, 4).join(', ')
  return { score: round1(clamp(net * 18, -70, 70)), detail: `${voiced.length} stance(s): ${names}` }
}

export function insiderFactor(summary: { isCluster: boolean; buyers: string[] } | null | undefined): FactorScore {
  if (summary === undefined) return { score: null, detail: 'not checked' }
  if (!summary || !summary.buyers.length) return { score: 0, detail: 'no insider buying' }
  return summary.isCluster
    ? { score: 45, detail: `cluster: ${summary.buyers.length} insiders buying` }
    : { score: 20, detail: 'insider buying' }
}

/** 13F smart-money overlap. What a tracked fund did to a roster name in its
 * latest filing: newly-bought or increased → +25 per fund, exited → −20 per
 * fund, clamped ±30. Small AND explicitly stale (up to ~45d filing lag), so the
 * learning loop is EXPECTED to decay this toward the floor if it's just noise —
 * that decay is the experiment, not a failure. No confident match → null. */
export interface SmartMoneyInput {
  bought: string[] // fund names that newly bought or increased
  exited: string[] // fund names that exited
  filedAt: string // latest relevant filing date, ISO
}

export function smartMoneyFactor(m: SmartMoneyInput | null): FactorScore {
  if (!m || (!m.bought.length && !m.exited.length)) return { score: null, detail: 'no 13F match' }
  const score = round1(clamp(25 * m.bought.length - 20 * m.exited.length, -30, 30))
  const parts: string[] = []
  if (m.bought.length) parts.push(`${m.bought.join(', ')} bought/added`)
  if (m.exited.length) parts.push(`${m.exited.join(', ')} exited`)
  return { score, detail: `${parts.join('; ')} (13F, filed ${m.filedAt} — up to 45d lag)` }
}

// Exported so the display-only global newsTone (worldTape.ts) scores headlines
// on the SAME keyword sets as this per-ticker factor — one lexicon, no drift.
export const POS = new Set(['beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps', 'upgrade', 'upgraded', 'record', 'wins', 'rally', 'top', 'tops'])
export const NEG = new Set(['miss', 'misses', 'plunge', 'plunges', 'sink', 'sinks', 'fall', 'falls', 'cut', 'cuts', 'downgrade', 'downgraded', 'probe', 'lawsuit', 'recall', 'warn', 'warns', 'slump', 'slumps'])

/** Crude by design: counts polarity words in ticker-tagged titles. Nuance is
 * the LLM overlay's job — this factor only measures pressure and direction. */
export function newsFactor(headlinesForSym: string[]): FactorScore {
  if (!headlinesForSym.length) return { score: 0, detail: 'quiet tape' }
  let net = 0
  let hits = 0
  for (const h of headlinesForSym) {
    for (const w of h.toLowerCase().split(/\W+/)) {
      if (POS.has(w)) { net++; hits++ }
      else if (NEG.has(w)) { net--; hits++ }
    }
  }
  const score = clamp(15 * net + 5 * Math.sign(net) * hits, -50, 50)
  return { score: round1(score), detail: `${headlinesForSym.length} headline(s), polarity ${net >= 0 ? '+' : ''}${net}` }
}

/** Seasonal edges are real but thin — capped at ±15 and honesty-gated by the
 * seasonality lib's own reliability flag (~2 years of candles minimum). */
export function seasonalityFactor(summary: SeasonalitySummary | null, month: number): FactorScore {
  if (!summary?.reliable) return { score: null, detail: 'insufficient history for seasonality' }
  const m = summary.months.find(x => x.month === month)
  if (!m || m.avgPct == null || m.n < 3) return { score: null, detail: 'no read for this month' }
  return { score: round1(clamp(m.avgPct * 4, -15, 15)), detail: `${m.name} avg ${m.avgPct >= 0 ? '+' : ''}${round1(m.avgPct)}% over ${m.n} yrs` }
}
