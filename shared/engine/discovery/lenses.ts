// Seven readings of one tape. Each lens is a stated hypothesis about why a name
// might be worth a call, expressed as a gate (does the shape exist?) and a score
// (how much of it is there?). Spec §4.4.
//
// Two rules hold everywhere:
//   • Gates are percentile-based wherever "extreme relative to the market" is
//     the claim, and absolute wherever the claim is about the name itself
//     (RVOL ≥ 2 is 2× that name's own median, whatever the tape is doing).
//   • Every score is a weighted mean of terms in 0–1, each MONOTONE in the
//     evidence, so "better setup ⇒ higher score" is a property of the arithmetic
//     rather than a hope. A score is only comparable within its own lens.
//
// The reasons are the product. They go in the trace and, through the candidate,
// into the reader's line — so each one carries the numbers that fired it.

import type { Candle } from '../../types'
import { clamp, round1 } from '../types'
import { classifyDip } from '../dipLane'
import { unusualRatio } from './rank'
import { LENS_IDS, type Features, type LensHit, type Percentiles, type UniverseMember } from './types'

const clamp01 = (x: number) => clamp(x, 0, 1)
const score4 = (x: number) => Math.round(clamp01(x) * 10_000) / 10_000
const pp = (x: number) => `${x >= 0 ? '+' : ''}${round1(x)}pp`
const pct = (x: number) => `${round1(Math.abs(x))}%`

/** Today's move against the name's own typical day. No side: a hard fall is a
 * short OR a dip depending on what the tape does next, and composeCall owns
 * that call — this lens only says "look at this one". */
export function unusualLens(f: Features, p: Percentiles): LensHit | null {
  const ratio = unusualRatio(f)
  if (ratio == null || f.ret1 == null || f.typicalMove10 == null) return null
  // Top decile of the day AND at least half again the name's own typical day:
  // the percentile alone would hand back 10% of a dead tape as "unusual".
  if (p.unusual < 0.9 || ratio < 1.5) return null
  const score = score4(0.6 * clamp01((ratio - 1) / 3) + 0.4 * p.unusual)
  const dir = f.ret1 >= 0 ? 'up' : 'down'
  return {
    lens: 'unusual',
    score,
    // Two floors, and both are the arithmetic's own:
    //  • the typical day printed is the one the RATIO was divided by — the 1%
    //    floor from unusualRatio. Printing the raw figure made the sentence lie
    //    about itself: a name whose typical day is 0.4% and moved 3% read
    //    "3.0× its typical 0.4% day", which is 7.5×, not 3;
    //  • 0.1%: the top-ranked name percentiles to exactly 1, and "top 0% of the
    //    universe" is not a sentence anyone should read in the paper.
    reason: `${dir} ${pct(f.ret1)} today, ${round1(ratio)}× its typical ${round1(Math.max(f.typicalMove10 / Math.sqrt(10), 1))}% day (top ${round1(Math.max((1 - p.unusual) * 100, 0.1))}% of the universe).`,
    side: null,
  }
}

/** The steady runner: beating SPY over both windows, above a rising 50-EMA, and
 * not yet stretched. Extension is the disqualifier — a leader you have to chase
 * two ATR above the 21-EMA is a climax setup wearing a leader's clothes. */
export function rsLeaderLens(f: Features, p: Percentiles): LensHit | null {
  if (f.rsSpy20 == null || f.rsSpy60 == null || f.ema50 == null || f.ema50Slope20 == null || f.distEma21Atr == null) return null
  if (p.rsSpy20 < 0.9 || p.rsSpy60 < 0.9) return null
  if (f.close <= f.ema50 || f.ema50Slope20 <= 0) return null
  if (f.distEma21Atr >= 2) return null
  const room = clamp01((2 - f.distEma21Atr) / 2)
  const score = score4(0.4 * p.rsSpy20 + 0.3 * p.rsSpy60 + 0.2 * room + 0.1 * clamp01(f.ema50Slope20 / 10))
  return {
    lens: 'rs-leader',
    score,
    reason: `beating SPY by ${pp(f.rsSpy20)} over 20 sessions and ${pp(f.rsSpy60)} over 60 (top decile both), ${round1(f.distEma21Atr)} ATR above a 50-EMA rising ${pct(f.ema50Slope20)} over 20 sessions.`,
    side: 'long',
  }
}

/** A leader catching its breath: back at the 21-EMA within an ATR, sellers not
 * paying up (volume fading), the 50-EMA still under it. */
export function pullbackLens(f: Features, p: Percentiles): LensHit | null {
  if (f.rsSpy60 == null || f.ema50 == null || f.ema50Slope20 == null || f.distEma21Atr == null || f.volTrend5 == null) return null
  if (p.rsSpy60 < 0.8) return null
  if (Math.abs(f.distEma21Atr) > 1) return null
  if (f.close <= f.ema50 || f.ema50Slope20 <= 0) return null
  if (f.volTrend5 >= 1) return null
  const proximity = clamp01(1 - Math.abs(f.distEma21Atr))
  const quiet = clamp01(1 - f.volTrend5)
  const score = score4(0.4 * p.rsSpy60 + 0.3 * proximity + 0.3 * quiet)
  return {
    lens: 'pullback',
    score,
    reason: `60-day leader (${pp(f.rsSpy60)} vs SPY) back to ${round1(Math.abs(f.distEma21Atr))} ATR of its 21-EMA on ${round1(f.volTrend5)}× the prior volume, 50-EMA still below.`,
    side: 'long',
  }
}

/** Out of a coiled base on real volume. All three legs are absolute: the base is
 * measured against the name's own 120-day Bollinger widths, the volume against
 * its own median, and the break against its own prior high. */
export function breakoutLens(f: Features, _p: Percentiles): LensHit | null {
  if (f.rvol == null || f.bbWidthPctl120 == null) return null
  const broke60 = f.broke60dHigh === true
  const broke20 = f.broke20dHigh === true
  if (!broke20 && !broke60) return null
  if (f.rvol < 2 || f.bbWidthPctl120 > 0.3) return null
  const compression = clamp01(1 - f.bbWidthPctl120)
  const reach = broke60 ? 1 : 0.6
  const score = score4(0.4 * clamp01((f.rvol - 1) / 4) + 0.3 * compression + 0.3 * reach)
  return {
    lens: 'breakout',
    score,
    reason: `closed above its ${broke60 ? '60' : '20'}-day high on ${round1(f.rvol)}× volume, out of a base in the ${round1(f.bbWidthPctl120 * 100)}th percentile of its 120-day Bollinger width.`,
    side: 'long',
  }
}

/** The dip lane's own reading, reused rather than re-derived.
 *
 * classifyDip already owns what a dip IS (−12% from the 20-session high or a −7%
 * shock) and what "holding" means (no new 5-session low, a reclaim path, a
 * volume-paid turn inside the window) — three legs ratified against replay. A
 * second definition here would be a second falsifier wearing the same name.
 *
 * The one thing this lens adds is quality: the dip lane is for names worth
 * catching, so a small cap is refused. Unknown cap passes — no data never blocks. */
export function dipLens(f: Features, member: UniverseMember, candles: Candle[] | null): LensHit | null {
  if (!candles || !candles.length) return null
  if (member.capBand === 'small') return null
  const read = classifyDip(candles)
  if (!read || !read.triggered || !read.holding) return null
  const depth = clamp01(read.dropPct / 25)
  const participation = clamp01((f.rvol ?? 1) / 3)
  const quality = member.capBand === 'large' ? 1 : 0.7
  const score = score4(0.45 * depth + 0.3 * participation + 0.25 * quality)
  return {
    lens: 'dip',
    score,
    reason: `${read.detail} — ${member.capBand ?? 'unknown'}-cap name on ${round1(f.rvol ?? 0)}× volume today.`,
    side: 'long',
  }
}

/** The mirror of rs-leader: bottom-decile RS on both windows, under a falling
 * 50-EMA, each rally topping lower than the last. A routable short candidate. */
export function weakLens(f: Features, p: Percentiles): LensHit | null {
  if (f.rsSpy20 == null || f.rsSpy60 == null || f.ema50 == null || f.ema50Slope20 == null) return null
  if (p.rsSpy20 > 0.1 || p.rsSpy60 > 0.1) return null
  if (f.close >= f.ema50 || f.ema50Slope20 >= 0) return null
  if (f.lowerHighs !== true) return null
  const score = score4(0.4 * (1 - p.rsSpy20) + 0.3 * (1 - p.rsSpy60) + 0.3 * clamp01(-f.ema50Slope20 / 10))
  return {
    lens: 'weak',
    score,
    reason: `lagging SPY by ${pp(f.rsSpy20)} over 20 sessions and ${pp(f.rsSpy60)} over 60 (bottom decile both), below a 50-EMA falling ${pct(f.ema50Slope20)} over 20 sessions, lower highs.`,
    side: 'short',
  }
}

/** Blow-off: a near-unbroken run, stretched ≥ 3 ATR above the 21-EMA, with the
 * crowd already thinning. Spec says "≥ 5 up-days of 6"; the feature set carries
 * 5- and 10-session counts, so the same 80%+ reading is taken as 4 of the last 5. */
export function climaxLens(f: Features, _p: Percentiles): LensHit | null {
  if (f.upDays5 == null || f.distEma21Atr == null || f.volTrend5 == null) return null
  if (f.upDays5 < 4) return null
  if (f.distEma21Atr < 3) return null
  if (f.volTrend5 >= 1) return null
  const stretch = clamp01((f.distEma21Atr - 3) / 3)
  const fading = clamp01(1 - f.volTrend5)
  const score = score4(0.4 * stretch + 0.3 * (f.upDays5 / 5) + 0.3 * fading)
  return {
    lens: 'climax',
    score,
    reason: `${f.upDays5} of the last 5 sessions up and ${round1(f.distEma21Atr)} ATR above its 21-EMA, volume already fading to ${round1(f.volTrend5)}× the prior 20 sessions.`,
    side: 'short',
  }
}

/** All seven, best score first (ties → the fixed lens order, so the list never
 * depends on iteration luck). `candles` is optional only because six of the
 * seven lenses do not need them; without the tape the dip lens cannot fire. */
export function runLenses(f: Features, p: Percentiles, member: UniverseMember, candles?: Candle[] | null): LensHit[] {
  const hits = [
    unusualLens(f, p),
    rsLeaderLens(f, p),
    pullbackLens(f, p),
    breakoutLens(f, p),
    dipLens(f, member, candles ?? null),
    weakLens(f, p),
    climaxLens(f, p),
  ].filter((h): h is LensHit => h != null)
  hits.sort((a, b) => b.score - a.score || LENS_IDS.indexOf(a.lens) - LENS_IDS.indexOf(b.lens))
  return hits
}
