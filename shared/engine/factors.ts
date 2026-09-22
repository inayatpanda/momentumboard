import type { EmaStack, Stage } from '../technicals'
import type { SeasonalitySummary } from '../seasonality'
import type { Candle } from '../types'
import { atr } from '../indicators'
import type { CatalystTag } from './catalyst'
import { bbWidthPctl120Of, ema50Slope20Of, emaSeries, retPct } from './discovery/features'
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

/** How much an aligned stack is worth. Big enough to separate two charts at the
 * same stage — a pullback where every horizon agrees (70) from one where they
 * don't (55) — and small enough that it can never outvote the stage itself. */
const STACK_BONUS = 15
const THRUST_HIGH = 1.5 // a week of the crowd arriving
const THRUST_LOW = 0.6 // a week of the crowd leaving
const THRUST_AMPLIFY = 1.15
const THRUST_DAMP = 0.85

const STACK_WORDS: Record<'bull' | 'bear' | 'mixed', string> = {
  bull: 'every timeframe pointing up',
  bear: 'every timeframe pointing down',
  mixed: 'timeframes disagree',
}

/** THE PIPELINE, in this order and for these reasons:
 *
 *   1. stage score          — where the chart is (the enum lookup, unchanged)
 *   2. × 0.7 unconfirmed-turn damp, early-reversal only
 *   3. ± STACK_BONUS        — do the timeframes agree with the stage?
 *   4. × thrust             — has the crowd been arriving all week?
 *   5. × 1.2 long-only volume amplifier
 *   6. clamp ±100
 *
 * The damp stays at (2), BEFORE the stack, because it qualifies the STAGE claim
 * and nothing else: "a turn with no volume behind it is a guess" is a statement
 * about today's tape, and letting it also shrink the stack bonus would be one
 * quiet session discounting a fact about the last fifty.
 *
 * The thrust sits at (4), applied to the SIGNED score in both directions, because
 * participation is not a side: a week of heavy volume into weakness confirms the
 * weakness exactly as it confirms strength. That is the opposite of the ×1.2 at
 * (5), which is deliberately long-only on measured evidence and stays that way —
 * the two multipliers are different claims and both are kept.
 *
 * (4) and (5) commute (both are sign-preserving multiplies), so the only thing
 * their order decides is what (5) tests, and it now tests the COMPOSED score
 * rather than the bare stage — which is why a bull stack that lifts a stage above
 * zero also earns the long amplifier, and a bear stack that pushes one below zero
 * loses it. With both new legs unknown the bonus is 0 and the multiplier is 1, so
 * every v2 score is preserved to the digit. */
export function technicalFactor(
  read: { stage: Stage; volumeConfirmed: boolean; rvol: number | null; emaStack: Pick<EmaStack, 'aligned'> | null; volThrust: number | null } | null,
): FactorScore {
  if (!read) return { score: null, detail: 'no chart data' }
  let base = STAGE_SCORE[read.stage]
  // a turn with no volume behind it is a guess, not a reversal — damp it.
  // Confirmed reversals keep the full score plus the ×1.2 volume boost below.
  const dampedReversal = read.stage === 'early-reversal' && !read.volumeConfirmed
  if (dampedReversal) base *= 0.7
  // Timeframe agreement: price > 8 > 21 > 50 (or the mirror) is a stronger
  // statement than any single horizon's opinion. 'mixed' is worth nothing —
  // disorder is the absence of a vote, not a vote against — and so is null,
  // which is an absence of evidence rather than evidence of disorder.
  const aligned = read.emaStack?.aligned ?? null
  base += aligned === 'bull' ? STACK_BONUS : aligned === 'bear' ? -STACK_BONUS : 0
  // Multi-day participation. Unlike rvol (one session) this asks whether the
  // crowd has been arriving all week, and it scales conviction whichever way the
  // score already points. It can never CREATE a score: 0 × anything is 0.
  const thrust = read.volThrust
  const thrusting =
    base === 0 || thrust == null ? null // 0 × anything is still 0, and an unknown week says nothing
    : thrust >= THRUST_HIGH ? 'building'
    : thrust <= THRUST_LOW ? 'thinning'
    : null
  if (thrusting) base *= thrusting === 'building' ? THRUST_AMPLIFY : THRUST_DAMP
  // The confirmation boost is LONG-ONLY. Measured over 96 live shorts
  // (2026-07-28): weakness without volume confirmation hit 65.3% for +4.31%
  // average excess; weakness WITH it hit 47.6% for -1.97% — yet the x1.2 was
  // deepening the score, i.e. raising conviction on the worse group. Heavy
  // volume into weakness is usually capitulation, a bounce setup, not
  // continuation. Bearish stages keep their base score; the RVOL is still
  // reported so the reader sees what the engine saw.
  const amplify = read.volumeConfirmed && base > 0
  const score = clamp(amplify ? base * 1.2 : base, -100, 100)
  const parts: string[] = [read.stage]
  if (aligned) parts.push(STACK_WORDS[aligned])
  if (thrusting) parts.push(`a week of ${thrusting} participation`)
  if (read.volumeConfirmed) parts.push(`volume-confirmed (RVOL ${read.rvol})`)
  else if (dampedReversal) parts.push('unconfirmed turn (damped)')
  return { score: round1(score), detail: parts.join(', ') }
}

/** THE RS-LEADER GATE, per name, and why it is not the discovery lens's gate.
 *
 * `rsLeaderLens` (discovery/lenses.ts) asks for the TOP DECILE of the day's
 * universe on both windows, and the walk-forward study measured that lens: +1.1pp
 * over 10 sessions, +2.6pp over 20, on 5,982 name-dates. A decile is a statement
 * about the cross-section, and `momentumFactor` sees one name and one index — it
 * cannot compute one. So the gate here is the same SHAPE in absolute points:
 * ahead of SPY by ≥ 5pp over the short window and ≥ 10pp over 60 sessions, above
 * a rising 50-EMA, and not yet stretched (< 2 ATR above the 21-EMA — the lens's
 * own disqualifier, because a leader you have to chase is a climax wearing a
 * leader's clothes). It is a PROXY for the lens's population, not the lens, and
 * on a weak tape it will admit names no decile would and on a roaring one refuse
 * names every decile would.
 *
 * ONE SESSION OF DRIFT, stated rather than papered over: the study's short window
 * is `rsSpy20` (20 sessions) and this factor has read a 21-session return since
 * it was written. Extending it rather than replacing it is the instruction and
 * the right call — the stored ledger's momentum scores all mean 21 sessions — so
 * the gate is applied to the 21-session number and the two are one session apart.
 *
 * THE FLAG PAYS NOTHING. `rsLeader` writes a word into the detail and moves no
 * score: the study's own verdict on the lens is t_NW 1.6, short of the bar for
 * sizing, so leadership earns ATTENTION (the priority bump in discovery/rank.ts,
 * which only orders a pool every candidate already entered) and not conviction.
 * Paying for it here and there would be paying twice for one t of 1.6. */
const RS_LEADER_SHORT_PP = 5
const RS_LEADER_LONG_PP = 10
const RS_LEADER_MAX_ATR = 2
/** The 60-session leg's points per pp — and the arithmetic behind the number,
 * because the obvious choice is wrong.
 *
 * A 60-session relative-strength reading is roughly THREE TIMES a 21-session one
 * at the same drift rate, simply because it has had three times as long to
 * accumulate. So "a quarter of the 21-session leg" is not 4/4 = 1 pt/pp — at 1
 * pt/pp a steady drift scores about three quarters of what the short leg scores,
 * which is a co-equal second opinion, not a term. Scaling the short leg's 4 by
 * 21/60 gives 1.4 pt/pp for EQUAL influence at equal drift, and a quarter of that
 * is 0.35.
 *
 * Deliberately small, and the study is why: `rsSpy60` is one of the ten features
 * whose IC changes SIGN between the halves (+0.0207 → −0.0651 at 20 sessions). It
 * is here to tell a 60-day leader from a one-month wonder — which is what the
 * rs-leader gate below needs — not to carry conviction. */
const RS60_PTS_PER_PP = 0.35

/** Relative strength vs SPY over two windows, signed toward long.
 *
 * The 21-session leg is unchanged — same lookback, same ×4, same clamp — so every
 * name whose tape is too short for the 60-session leg scores exactly what it
 * scored before. `candles` is optional and only ever ADDS: without it the
 * extension leg of the leader gate cannot be measured, so the flag simply does
 * not fire. */
export function momentumFactor(closes: number[] | null, spyCloses: number[] | null, candles?: Candle[] | null): FactorScore {
  if (!closes || !spyCloses || closes.length < 22 || spyCloses.length < 22) return { score: null, detail: 'insufficient history' }
  const ret21 = (xs: number[]) => ((xs[xs.length - 1] - xs[xs.length - 22]) / xs[xs.length - 22]) * 100
  const rs = ret21(closes) - ret21(spyCloses)
  const rs60 =
    closes.length >= 61 && spyCloses.length >= 61 ?
      (() => {
        const own = retPct(closes, 60)
        const bench = retPct(spyCloses, 60)
        return own != null && bench != null ? own - bench : null
      })()
    : null
  const score = round1(clamp(rs * 4 + (rs60 ?? 0) * RS60_PTS_PER_PP, -80, 80))
  const parts = [`21d RS vs SPY ${rs >= 0 ? '+' : ''}${round1(rs)}pp`]
  if (rs60 != null) parts.push(`60d ${rs60 >= 0 ? '+' : ''}${round1(rs60)}pp`)
  if (rsLeader(closes, rs, rs60, candles ?? null)) parts.push('RS leader')
  return { score, detail: parts.join(', ') }
}

/** All four legs of the leader shape, or false. Any leg it cannot MEASURE is a
 * refusal, never a pass: an unknown must not clear a gate. */
function rsLeader(closes: number[], rs21: number, rs60: number | null, candles: Candle[] | null): boolean {
  if (rs21 < RS_LEADER_SHORT_PP) return false
  if (rs60 == null || rs60 < RS_LEADER_LONG_PP) return false
  const slope = ema50Slope20Of(closes)
  const ema50 = emaSeries(closes, 50)[closes.length - 1] ?? null
  const close = closes[closes.length - 1]
  if (slope == null || slope <= 0 || ema50 == null || close <= ema50) return false
  // the extension leg needs highs and lows — ATR is not computable from closes
  if (!candles || candles.length < 22) return false
  const atr14 = atr(candles, 14)[candles.length - 1] ?? null
  const ema21 = emaSeries(closes, 21)[closes.length - 1] ?? null
  if (atr14 == null || atr14 <= 0 || ema21 == null) return false
  return (close - ema21) / atr14 < RS_LEADER_MAX_ATR
}

/** WIDE BANDS, NOT A COILED ONE — the bandwidth factor.
 *
 * THE EVIDENCE, AND THE DIRECTION IT ACTUALLY POINTS. The 2026-09-22 walk-forward
 * study (docs/superpowers/plans/2026-09-22-discovery-walk-forward-results.md) swept
 * 14 price features over ~348k name-dates and found exactly one whose information
 * coefficient keeps its SIGN in both halves of the sample, on both venues, and
 * STRENGTHENS with the horizon: `bbWidthPctl120`, where today's Bollinger width
 * sits inside the last 120 readings of the name's own width. IC t 3.0 at 10
 * sessions, 5.5 at 20.
 *
 * That IC is POSITIVE and the deciles are cut on the percentile ITSELF, so D10 is
 * the WIDEST bands: +0.49pp over 10 sessions against the tightest decile's −0.08pp,
 * and +1.08pp over 20 against +0.07pp. Wide-and-expanding beat coiled-and-quiet in
 * that sample. This factor was first built the other way round, as a "bandwidth"
 * squeeze scoring `1 − percentile`, on a label in the study's prose rather than on
 * its table; the owner adjudicated for the table on 2026-09-22 and the factor was
 * flipped and renamed with it. The name is `bandwidth` now precisely so that the
 * code cannot go on asserting a direction the data does not.
 *
 * THE STRENGTH IS THE PERCENTILE, unaltered: bands at the widest they have been in
 * 120 sessions score 1, bands at their tightest score 0. Linear, because the
 * study's deciles are monotone across the whole range rather than a top-decile
 * effect.
 *
 * NO CAUSAL CLAIM IS MADE OR IMPLIED, here or in the reader's copy (voice.ts). The
 * study measured an association over one regime of one sample and said so at
 * length; "wide bands have carried the better forward record" is the strongest
 * sentence the evidence supports, and it is the sentence the reader gets.
 *
 * THE SIGN IS BORROWED, and that is unchanged by the flip. Bandwidth has no side —
 * wide is wide — so the score is signed by the direction the core is already
 * arguing: the 50-EMA's slope over 20 sessions, and where that is flat or
 * unreadable, the 20-session return. When BOTH are flat or unknown there is no
 * direction to lend and the factor returns NULL rather than guessing: a volatile
 * chart going nowhere is not evidence for either side.
 *
 * WHAT WAS MEASURED, AND WHAT IS ASSUMED. The study scored LONGS — forward excess
 * vs SPY on names held long — so the evidence above is about the long side only. A
 * short inherits the sign by SYMMETRY, on the unverified assumption that wide bands
 * under a falling 50-EMA are worth what wide bands under a rising one are worth.
 * Nothing in the study tested it. The factor is seeded at 0.4 against technical's
 * 1.0 (composite.ts) precisely so the IC loop can price both sides from live
 * outcomes rather than from that assumption.
 *
 * MINIMUM 140 CLOSES: 20 to make the first Bollinger width, 120 widths to rank
 * today's inside, and 71 for the 50-EMA slope — the width percentile is the
 * binding one. */
export const BANDWIDTH_MIN_BARS = 140
/** Maximum bandwidth in a clear trend is worth half a maxed-out chart read. Below
 * momentum's ±80 and technical's ±100, above sector's ±40 — the ordering the
 * evidence supports: this is the most reliable of the price features and by some
 * distance the smallest in effect (+1.00pp per decile spread over 20 sessions). */
const BANDWIDTH_MAX_PTS = 50
/** WHAT COUNTS AS FLAT, and why it is not `=== 0`. Both direction readings are
 * floating-point percentages off real closes, so exact zero is unreachable in
 * practice and testing for it would make the fallback — and the null branch the
 * whole "a chart going nowhere is not evidence" argument rests on — dead code that
 * only ever looked safe. A 50-EMA that has moved 0.05% in twenty sessions has moved
 * 0.0025% a session: that is a level, not a direction, and the same threshold reads
 * the same way on a 20-session return. */
const FLAT_PCT = 0.05

export function bandwidthFactor(closes: number[] | null): FactorScore {
  if (!closes || closes.length < BANDWIDTH_MIN_BARS) return { score: null, detail: 'insufficient history for a 120-session width percentile' }
  const pctl = bbWidthPctl120Of(closes)
  if (pctl == null) return { score: null, detail: 'no Bollinger width read' }
  const band = `Bollinger width p${Math.round(pctl * 100)} of its own 120 sessions`
  const slope = ema50Slope20Of(closes)
  const ret20 = retPct(closes, 20)
  // the 50-EMA slope first — it is the direction the chart read is built on — and
  // the 20-session return only where the slope is FLAT or unreadable
  const from =
    slope != null && Math.abs(slope) > FLAT_PCT ? { dir: Math.sign(slope), why: `a 50-EMA ${slope > 0 ? 'rising' : 'falling'} ${round1(Math.abs(slope))}% over 20 sessions` }
    : ret20 != null && Math.abs(ret20) > FLAT_PCT ? { dir: Math.sign(ret20), why: `a 20-session return of ${ret20 >= 0 ? '+' : ''}${round1(ret20)}%` }
    : null
  if (!from) return { score: null, detail: `${band}, but nothing to sign it with — the 50-EMA is flat and so are 20 sessions` }
  return { score: round1(from.dir * pctl * BANDWIDTH_MAX_PTS), detail: `${band} (bandwidth ${round1(pctl * 100) / 100}), signed by ${from.why}` }
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
 * the LLM overlay's job — this factor only measures pressure and direction.
 *
 * TWO ZEROS, AND THEY ARE NOT THE SAME CLAIM [stage 3c]. `ZERO_IS_A_READING`
 * (composite.ts) admits this factor's zero because of the FIRST one:
 *
 *   quiet tape — no headlines at all. A deliberate branch meaning "we looked and
 *                nobody wrote about this name", and since this factor has no null
 *                path it is the only way it can say so. A reading.
 *   polarity tie — headlines exist and their polarity words cancelled exactly
 *                (`net === 0` with `hits > 0`). That is the arithmetic
 *                cancellation the zero table calls a SILENCE everywhere it
 *                appears (channels' split panel, smartMoney's offsetting funds):
 *                the factor is genuinely mute, and booking muteness as evidence
 *                would count it against every long and for every short on no
 *                information at all.
 *
 * A tie therefore sets `silence` (types.ts) and the learning loop skips it. The
 * SCORE is untouched — both are 0, they always were, and nothing in the composite
 * reads the flag. Headlines with no polarity word at all (`hits === 0`) are the
 * quiet tape by another route: there were no votes to cancel, so no flag. */
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
  const detail = `${headlinesForSym.length} headline(s), polarity ${net >= 0 ? '+' : ''}${net}`
  // `net === 0` with votes cast IS the zero — `15 × 0 + 5 × 0 × hits` — so the
  // flag never travels with a scored reading.
  return net === 0 && hits > 0 ? { score: round1(score), detail, silence: true } : { score: round1(score), detail }
}

/** A market-moving catalyst's directional vote (catalyst.ts). null when there is
 * no catalyst; also null when the catalyst has no clean side — an "in play" name
 * earns the relaxed expected-move floor in composeCall but no free conviction. When
 * sided, the score is the side times a strength-scaled magnitude, capped ±90 so
 * a single loud headline can never single-handedly max the composite. */
export function catalystFactor(tag: CatalystTag | null | undefined): FactorScore {
  if (!tag) return { score: null, detail: 'no catalyst' }
  if (tag.side == null) return { score: null, detail: `in play: ${tag.reason}` }
  const dir = tag.side === 'long' ? 1 : -1
  const score = round1(dir * clamp(tag.strength * 0.9, 0, 90))
  return { score, detail: `${tag.kind}: ${tag.reason} (strength ${Math.round(clamp(tag.strength, 0, 100))})` }
}

/** Seasonal edges are real but thin — capped at ±15 and honesty-gated by the
 * seasonality lib's own reliability flag (~2 years of candles minimum). */
export function seasonalityFactor(summary: SeasonalitySummary | null, month: number): FactorScore {
  if (!summary?.reliable) return { score: null, detail: 'insufficient history for seasonality' }
  const m = summary.months.find(x => x.month === month)
  if (!m || m.avgPct == null || m.n < 3) return { score: null, detail: 'no read for this month' }
  return { score: round1(clamp(m.avgPct * 4, -15, 15)), detail: `${m.name} avg ${m.avgPct >= 0 ? '+' : ''}${round1(m.avgPct)}% over ${m.n} yrs` }
}
