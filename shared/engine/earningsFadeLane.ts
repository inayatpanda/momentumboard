// The earnings-fade lane. A post-earnings POP is a short, and the tape is the
// only reason to believe it.
//
// The walk-forward study over two years of bars
// (docs/superpowers/plans/2026-09-22-discovery-walk-forward-results.md, appendix)
// swept every post-earnings cohort it could build and found exactly one
// relationship that was monotone, sign-stable and t_NW-significant — and it ran
// the WRONG way. Buying a name that beat on EPS **and** gapped up 3%+ at the
// next open lost 1.47pp to SPY over 10 sessions and 3.43pp over 20 (n = 212,
// hit 34.0% / 28.8%, t_NW −3.34 / −6.79), and every tightening of the filter
// made it worse. Read as the obvious long it is the opposite of an edge. Read as
// a FADE it is a candidate event lane, which is what this file is.
//
// THE CAVEATS ARE THE REASON THIS LANE NEVER CARRIES MONEY. n = 212 over 24
// dates in ONE earnings season; the whole earnings cohort underperformed
// (−1.02pp), so most of the effect may be "names that just reported lagged"
// rather than the gap; the study's coverage was the discovery seed only; `time`
// was unavailable historically, so a pre-market reporter's gap was already spent
// by the entry open the study used; and there is no borrow, no cost and no
// slippage in the number. One season is a season, not an edge — so the owner's
// ruling (2026-09-22, "option 1") is that the lane PUBLISHES, is GRADED, and is
// NEVER SIZED. Evidence accrues under the engine's own scoring rules until there
// is enough of it to argue with; nothing in between costs the reader a penny.
//
// WHY A LANE AT ALL, rather than a catalyst tag. The same argument dipLane.ts
// makes, mirrored: the ordinary path derives its side from core momentum, and a
// name that just gapped +8% on a beat has strongly POSITIVE momentum — it
// composites as a long, at exactly the moment this evidence says to be short.
// A catalyst tag cannot fix that either (context is capped colour and must never
// set a direction). So the lane reads the event and the price signature itself
// and builds its own short, which then walks the ordinary calibration path
// (probabilityFor needs only side/regime/|composite|/cohort) and is graded like
// everything else.
//
// Pure module: candles and one calendar row in, a read and a call out. No IO, no
// LLM, no clock. The engine loop (buildBoard) supplies the calendar snapshot
// (nasdaqEarnings.ts), the cap and the shadow flag.

import type { Candle } from '../types'
import { atr, swingCapacity } from '../indicators'
import { SMALL_CAP_MAX_USD_M } from './capClass'
import { DEFAULT_WEIGHTS } from './composite'
import { clamp, round1, round2, type CallEvidence, type EngineCall, type FactorName, type FactorScore } from './types'
import { earningsFadeThesis } from './voice'

/** Below this the price signature simply isn't readable — no verdict at all. */
export const MIN_CANDLES = 30
/** The study's own filter, both legs. A beat that the market did not pay up for
 * is not the cohort that faded, and neither is a gap on a miss. */
export const GAP_TRIGGER_PCT = 3
export const MIN_SURPRISE_PCT = 0
/** How stale a reaction bar may be and still be this trade. The study entered at
 * the open AFTER the reaction session; two sessions of tolerance covers a run
 * that missed a morning without letting the lane call a week-old pop. */
export const MAX_REACTION_AGE = 2
/** The stop sits above the reaction bar's HIGH — the level that would say the
 * pop is not fading — plus half an ATR of air, so ordinary noise around that
 * high cannot fire it. */
export const STOP_ATR_MULT = 0.5
/** The target: give back twice what the gap paid. The gap IS the thing being
 * faded, so the trade's size is measured in gaps rather than in ATRs. */
export const TARGET_GAP_MULT = 2
/** …or the clock runs out first. The study's stronger horizon was 20 sessions;
 * 21 is the engine's own month, and it is stated in the row's own words so a
 * reader is never waiting on a target that was always a time-stop. */
export const HORIZON_SESSIONS = 21
/** A stop closer than this to entry is not a falsifier, it is noise — the same
 * floor the velocity lane applies to its trail. */
export const MIN_RISK_FRAC = 0.01
/** At most this many fade rows a run, deepest gap first. A single earnings
 * morning can print thirty qualifying pops; publishing all of them would drown
 * the ledger in one correlated bet and starve every other shadow. */
export const EARNINGS_FADE_MAX_PER_RUN = 3

/** THE LEVER, mirroring `cryptoDisabled` exactly (cryptoLane.ts): one env var,
 * read defensively, and a `true` answer means the lane never runs and the board
 * is byte-for-byte what it was. A lane that publishes shadow rows into the
 * calibration buckets has to be switchable off without a deploy. */
export function earningsFadeDisabled(): boolean {
  try {
    return typeof process !== 'undefined' && process.env?.EARNINGS_FADE === 'off'
  } catch {
    return false
  }
}

/** ONE CALENDAR ROW, in the only three fields the lane reads. Structurally
 * satisfied by `NasdaqEarningsRow` (netlify/functions/lib/nasdaqEarnings.ts) —
 * declared here rather than imported so this module stays pure and shared code
 * never depends on a function-side feed. */
export interface EarningsFadeEvent {
  /** YYYY-MM-DD — the session the company reported in. */
  date: string
  /** Which side of that session. `unknown` is treated as `post` (see below). */
  time: 'pre' | 'post' | 'unknown'
  /** Nasdaq's `% Surprise`, already a percent. */
  surprisePct: number | null
}

export interface EarningsFadeRead {
  /** The session the market actually repriced the print in. */
  reactionDate: string
  /** How many completed sessions ago that bar closed. 0 = the latest bar. */
  reactionAgo: number
  /** The open-gap over the prior close, in percent. Always >= GAP_TRIGGER_PCT. */
  gapPct: number
  surprisePct: number
  /** The reaction bar's high — the level the stop hides above. */
  reactionHigh: number
  /** Whether the timing came from a real `time` field or from the fallback. */
  timing: 'pre' | 'post' | 'unknown'
  detail: string
}

const pct = (x: number) => `${round1(x)}%`
const dateOf = (c: Candle) => new Date(c.t * 1000).toISOString().slice(0, 10)

/** WHICH BAR CARRIES THE REACTION, and why `unknown` falls the way it does.
 *
 *   pre-market  → the print lands before the open, so the PRINT DAY's own open
 *                 is the gap and the print day is the reaction bar.
 *   after-hours → the print lands after the close, so the gap is the NEXT
 *                 session's open and that is the reaction bar.
 *   unknown     → treated as after-hours. Nasdaq supplies `time` only while the
 *                 date is in the future, so `unknown` is what a row read purely
 *                 as history looks like — and the after-hours reading is the
 *                 conservative one: it waits a session rather than claiming a
 *                 gap the print could not yet have caused. The read carries the
 *                 fallback in `timing`, so nothing downstream can mistake it for
 *                 a measured fact. */
export const reactionOffset = (time: EarningsFadeEvent['time']): number => (time === 'pre' ? 0 : 1)

/** Read the post-earnings pop off the tape. null when there is no fade to call —
 * the history is too short, the print isn't on this tape, the beat wasn't a
 * beat, the market didn't pay up, or the reaction is already stale. */
export function classifyEarningsFade(candles: Candle[], event: EarningsFadeEvent, _spy?: Candle[] | null): EarningsFadeRead | null {
  if (!candles || candles.length < MIN_CANDLES) return null
  if (!event?.date) return null
  const surprisePct = event.surprisePct
  // A beat, measured by the calendar rather than by us. `null` is not zero: an
  // unreported surprise is an unknown, and the study's cohort was names that
  // BEAT. Ties fail too — `> 0`, exactly as the study filtered.
  if (surprisePct == null || !Number.isFinite(surprisePct) || surprisePct <= MIN_SURPRISE_PCT) return null

  // The print has to be ON this tape. A date the candles never covered is a
  // date this lane cannot measure a gap across, whatever the calendar says.
  let printIdx = -1
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = dateOf(candles[i])
    if (d === event.date) {
      printIdx = i
      break
    }
    // Chronological bars: once we are before the print date there is nothing
    // left to find, and scanning 250 bars per name per run is not free.
    if (d < event.date) break
  }
  if (printIdx < 0) return null

  const reactionIdx = printIdx + reactionOffset(event.time)
  // The reaction bar must EXIST and be CLOSED — an after-hours print whose next
  // session has not happened yet has no gap to read.
  if (reactionIdx < 1 || reactionIdx > candles.length - 1) return null
  const reactionAgo = candles.length - 1 - reactionIdx
  if (reactionAgo > MAX_REACTION_AGE) return null

  const reaction = candles[reactionIdx]
  const prevClose = candles[reactionIdx - 1].c
  if (!(prevClose > 0)) return null
  const gapPct = round1(((reaction.o - prevClose) / prevClose) * 100)
  if (gapPct < GAP_TRIGGER_PCT) return null

  const when = reactionAgo === 0 ? 'today' : `${reactionAgo} session${reactionAgo === 1 ? '' : 's'} ago`
  const timingStr = event.time === 'unknown' ? 'session timing unknown, read as after-hours' : `reported ${event.time === 'pre' ? 'pre-market' : 'after-hours'}`
  const detail = `post-earnings pop: +${pct(surprisePct)} EPS surprise, gapped +${pct(gapPct)} at the open ${when} · ${timingStr}`

  return {
    reactionDate: dateOf(reaction),
    reactionAgo,
    gapPct,
    surprisePct: round1(surprisePct),
    reactionHigh: round2(reaction.h),
    timing: event.time,
    detail,
  }
}

/** The lane's own SHORT. Only a read earns one.
 *
 * Structural rather than composite-derived, like every lane here: the stop hides
 * above the level that would falsify the fade (the reaction bar's high, plus
 * half an ATR of air), the target gives back twice the gap, and the composite is
 * the gap's own size offset into the calibrated 25-55 bands — NEGATIVE, because
 * that is how this engine spells a short (composite.ts: "the sign carries the
 * side, long >= 0").
 *
 * WHAT IS DELIBERATELY ABSENT: the 1:1 reward-to-risk gate the dip lane applies.
 * That gate exists to stop a SIZED row risking ten to make one; this row is
 * never sized, and its only product is a graded outcome. Refusing the shapes
 * where the close sits well under the reaction high would silently select the
 * sample — dropping exactly the pops that faded hardest intraday — and a biased
 * sample is worse than a wide one for a lane whose entire purpose is to collect
 * n. What is still refused is a shape that could not be GRADED honestly: a stop
 * at or below entry, a target at or above it, or a stop so close it is noise
 * rather than a falsifier. */
export function earningsFadeCall(sym: string, candles: Candle[], read: EarningsFadeRead, capUsdM: number | null): EngineCall | null {
  if (!read || candles.length < MIN_CANDLES) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.c)

  // The study entered at the open AFTER the reaction session. An open the engine
  // cannot know yet is not a number it may print, so the last close stands as the
  // entry — the price the reader is actually looking at — and the thesis says
  // what the level means. Every grading path in this engine reads the published
  // entry, so the honest printable number is the one that must be published.
  const entry = round2(last.c)
  if (!(entry > 0)) return null

  const atrSeries = atr(candles)
  const atrNow = atrSeries[atrSeries.length - 1]
  if (atrNow == null || !Number.isFinite(atrNow)) return null

  const stop = round2(read.reactionHigh + STOP_ATR_MULT * atrNow)
  const target = round2(entry * (1 - (TARGET_GAP_MULT * read.gapPct) / 100))
  if (stop <= entry || target >= entry) return null
  if (stop - entry < MIN_RISK_FRAC * entry) return null

  const expectedMovePct = round1(((entry - target) / entry) * 100)
  const composite = -round1(clamp(25 + read.gapPct, 25, 55))
  const smallCap = capUsdM != null && capUsdM < SMALL_CAP_MAX_USD_M

  // A minimal, honest factor record: the lane's read is technical, everything
  // else has no vote here (weight 0 — the composite above is NOT a weighted sum,
  // and pretending otherwise would let the display imply votes that never
  // happened). Identical in shape to the dip and velocity lanes.
  const factors = Object.fromEntries(
    (Object.keys(DEFAULT_WEIGHTS) as FactorName[]).map(name => [
      name,
      name === 'technical'
        ? ({ score: -40, detail: read.detail, weight: 0 } as FactorScore & { weight: number })
        : ({ score: null, detail: 'earnings-fade lane', weight: 0 } as FactorScore & { weight: number }),
    ]),
  ) as Record<FactorName, FactorScore & { weight: number }>

  // The lane's gates ARE its evidence contract: a dated print on this tape, a
  // positive surprise, a >= 3% gap and a reaction bar young enough to trade.
  const evidence: CallEvidence = {
    // NOMINAL placeholders — this lane has ONE real factor (its own event+price
    // read). Nothing downstream may read these as a count of independent evidence.
    coverage: 1,
    famAgree: 2,
    contract: true,
    contextPts: 0,
    detail: read.detail,
  }

  return {
    sym,
    side: 'short',
    composite,
    factors,
    // 'fade' already exists in the SetupFamily union (types.ts) — it is what
    // setupFamilyOf hands a short on any stage but weak/falling-knife, i.e. a
    // short into strength, which is exactly what this row is. The family's
    // calibration bucket is therefore shared with the composite's own fades,
    // which is correct: they fail the same way (the strength keeps going).
    setup: 'fade',
    evidence,
    expectedMovePct,
    entry,
    stop,
    target,
    capacityPct: swingCapacity(closes) ?? 0,
    smallCap,
    earningsRisk: false, // overridden from the live earnings calendar at integration
    // The print just happened, so the chart is stretched above its own averages
    // by construction. Named rather than measured: `technicalStage` would read
    // this tape too, and the two would disagree on the one bar that matters.
    stage: 'extended',
    note: read.detail,
    ...earningsFadeThesis({ sym, surprisePct: read.surprisePct, gapPct: read.gapPct, stop }),
  }
}
