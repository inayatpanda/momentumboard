// The dip lane. A quality name hit hard but HOLDING is a long, not a short.
//
// The ordinary path can never say that: composeCall derives the side from core
// momentum, and a name that just fell 12% has deeply negative momentum — it
// composites as a SHORT, at exactly the moment the reader wants to be buying it.
// A catalyst tag cannot fix that either: context is capped colour and must never
// set a direction [R3]. So the dip lane classifies the price signature itself and
// builds its own long call, which then walks the ordinary calibration path
// (probabilityFor needs only side/regime/|composite|/cohort) and is graded and
// learned from like everything else.
//
// The lane is deliberately modest: its composite lives inside the calibrated
// 25-55 bands. Buying a falling name is a real edge, not a high-conviction one.
//
// "Holding" is three legs: no new 5-session closing low TODAY, a reclaim path
// (over the 50-EMA or 3% off the dip low) TODAY, and a volume-paid turn in the
// last five sessions. Only the volume leg is turn-scoped, and what it accepts is
// real participation printed inside that window — the capitulation OR the
// confirmation, whichever the tape spent it on (ratified 2026-08-12; see
// classifyDip, which names the GLW case where those were different sessions).
//
// Pure module: candles in, a read and a call out. No IO, no LLM. The engine loop
// (buildBoard) supplies the earnings calendar and the catalyst narration tag.

import type { Candle } from '../types'
import { emaLast, swingCapacity } from '../indicators'
import { SMALL_CAP_MAX_USD_M } from './capClass'
import { DEFAULT_WEIGHTS } from './composite'
import { clamp, round1, round2, type CallEvidence, type EngineCall, type FactorName, type FactorScore } from './types'

/** Below this the price signature simply isn't readable — no dip verdict at all. */
export const MIN_CANDLES = 30
/** The reference high the dip is measured from, and the destination of the retrace. */
export const HIGH_WINDOW = 20
/** How far back "the dip" runs: the low the stop hides under, and the one-day shock window. */
export const DIP_WINDOW = 10
/** Trigger A: how far below the 20-session closing high counts as a dip. */
export const DROP_TRIGGER_PCT = 12
/** Trigger B: one violent session (close-to-close OR a down open-gap) is a dip on its own. */
export const ONE_DAY_TRIGGER_PCT = 7
/** Holding: the reclaim has to be PAID for. An unconfirmed bounce is a bounce, not a base. */
export const VOLUME_MULT = 1.5
/** …and paid ONCE is paid. How many sessions back the confirming print may sit
 * (today included) — see the turn-scoped note in `classifyDip`. */
export const VOLUME_LOOKBACK = 5
/** Holding: the slide case's reclaim path — off the low by this much, no 50-EMA required [G6]. */
export const RECLAIM_PCT = 3
export const EMA_PERIOD = 50

export interface DipRead {
  /** The price signature of a dip is present (either trigger). */
  triggered: boolean
  /** ...and it is being bought, not still falling. Only a holding dip is tradeable. */
  holding: boolean
  /** Depth: % below the 20-session closing high. Drives the composite and the retrace target. */
  dropPct: number
  detail: string
}

/** The dip's floor: lowest intraday low of the DIP_WINDOW sessions BEFORE today.
 * Today is excluded on purpose — the reclaim is measured against the low the
 * market already made, not against a low today is still in the middle of. */
function dipWindowLow(candles: Candle[]): number | null {
  const window = candles.slice(-(DIP_WINDOW + 1), -1)
  if (!window.length) return null
  return Math.min(...window.map(c => c.l))
}

const pct = (x: number) => `${round1(x)}%`

/** Read the dip signature off the tape. null iff the history is too short. */
export function classifyDip(candles: Candle[]): DipRead | null {
  if (candles.length < MIN_CANDLES) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.c)
  const high20 = Math.max(...closes.slice(-HIGH_WINDOW))

  // Trigger A — depth. Rounded before the comparison so float noise on an exact
  // 12.0% can't flip the verdict; the tolerance is 0.05pp.
  const dropPct = high20 > 0 ? round1(((high20 - last.c) / high20) * 100) : 0

  // Trigger B — shock. The worst single session in the window, measured as the
  // WORSE of close-to-close and the down open-gap: a name that gapped -9% and
  // closed the hole was still hit hard, and that is the dip we want to buy.
  let worstDayPct = 0
  for (let i = Math.max(1, candles.length - DIP_WINDOW); i < candles.length; i++) {
    const prev = candles[i - 1].c
    if (prev <= 0) continue
    const c2c = ((prev - candles[i].c) / prev) * 100
    const gap = ((prev - candles[i].o) / prev) * 100
    worstDayPct = Math.max(worstDayPct, c2c, gap)
  }
  worstDayPct = round1(worstDayPct)

  const triggered = dropPct >= DROP_TRIGGER_PCT || worstDayPct >= ONE_DAY_TRIGGER_PCT

  // --- holding: the three gates that separate a base from a knife ---

  // 1. The knife guard. A new 5-session closing low TODAY is still falling,
  //    whatever else is true. Non-negotiable: ties count as a new low.
  const prior4 = closes.slice(-5, -1)
  const low5 = prior4.length ? Math.min(...prior4) : null
  const newLow = low5 != null && last.c <= low5

  // 2. Volume — TURN-SCOPED. Same 20-session trailing baseline technicals.ts uses
  //    (excluding the session being measured), but the leg is satisfied if ANY of
  //    the last VOLUME_LOOKBACK sessions printed >= VOLUME_MULT×, today included.
  //
  //    What this leg accepts is REAL PARTICIPATION printed inside the turn window —
  //    capitulation or confirmation, whichever way the tape chose to spend it. It is
  //    explicitly NOT "the session that reversed the name", and the flagship case is
  //    why: GLW's 3.6× bar was the −12% CAPITULATION day, and the +9% session that
  //    actually turned it printed a mere 1.34×. Reading the crowd's size on either
  //    side of the low is the evidence; insisting it land on the up-day would have
  //    refused the turn outright, and insisting it land on TODAY refused it for nine
  //    sessions while the name rallied +28% off that low (`holding` false on all 21
  //    replay days — docs/superpowers/plans/2026-08-11-stage1-replay-results.md §4).
  //    Ratified 2026-08-12: paid once inside the window is paid.
  //
  //    The loosening is bounded by the OTHER two legs, which are unchanged and still
  //    measured on TODAY — a name making a new 5-session low, or back under both
  //    reclaim paths, is not holding however it traded last Tuesday. Volume says the
  //    turn was real; the knife guard and the reclaim say it is still standing.
  const rvolAt = (i: number): number | null => {
    const w = candles.slice(Math.max(0, i - HIGH_WINDOW), i).map(c => c.v)
    if (w.length < 5) return null
    const avg = w.reduce((s, v) => s + v, 0) / w.length
    return avg > 0 ? candles[i].v / avg : null
  }
  // The confirming print is the NEAREST qualifying session, not the loudest: scan
  // back from today and stop at the first one that paid. Reporting the window's
  // biggest print instead made the read cite evidence that was not the nearest —
  // on GLW, "3.6× volume 2 sessions ago" while a 1.8× session sat one day old.
  let paidRvol: number | null = null
  let paidAgo = 0
  // …and separately the loudest print in the window, which is what a REFUSAL
  // quotes ("best 1.4×"): there the reader wants to know how close the tape came.
  let bestRvol: number | null = null
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - VOLUME_LOOKBACK); i--) {
    const r = rvolAt(i)
    if (r == null) continue
    if (bestRvol == null || r > bestRvol) bestRvol = r
    if (paidRvol == null && r >= VOLUME_MULT) {
      paidRvol = r
      paidAgo = candles.length - 1 - i
    }
  }
  const volumeOk = paidRvol != null

  // 3. A reclaim path. Either back over the 50-EMA (the shallow-pullback case),
  //    or RECLAIM_PCT off the dip low — the slide case, where the 50-EMA is far
  //    above and demanding it would reject every deep dip that ever turns [G6].
  const low = dipWindowLow(candles)
  const ema50 = emaLast(closes, EMA_PERIOD)
  const aboveEma = ema50 != null && last.c > ema50
  const offLow = low != null && low > 0 ? ((last.c - low) / low) * 100 : null
  const reclaimed = offLow != null && offLow >= RECLAIM_PCT
  const reclaim = aboveEma || reclaimed

  const holding = triggered && !newLow && volumeOk && reclaim

  const paidStr = paidRvol != null ? `${round1(paidRvol)}×` : 'unknown'
  const bestStr = bestRvol != null ? `${round1(bestRvol)}×` : 'unknown'
  // WHEN the turn was paid for is part of the read, not decoration: "on 1.6× volume"
  // when today paid, "on 1.6× volume 3 sessions ago" when the confirmation is older.
  const when = paidAgo === 0 ? '' : ` ${paidAgo} session${paidAgo === 1 ? '' : 's'} ago`
  let detail: string
  if (!triggered) {
    detail = `no dip: ${pct(dropPct)} off the 20-session high, worst session −${pct(worstDayPct)}`
  } else {
    const depth = dropPct >= DROP_TRIGGER_PCT ? `−${pct(dropPct)} from the 20-session high` : `one-day shock −${pct(worstDayPct)}`
    if (holding) {
      const how = aboveEma ? 'back over the 50-EMA' : `${pct(offLow ?? 0)} above the ${round2(low ?? 0)} dip low`
      detail = `dip ${depth} · holding: ${how} on ${paidStr} volume${when}`
    } else {
      const why: string[] = []
      if (newLow) why.push('new 5-session closing low')
      if (!volumeOk) why.push(`no ${VOLUME_MULT}× session in the last ${VOLUME_LOOKBACK} (best ${bestStr})`)
      if (!reclaim) why.push('no reclaim of the 50-EMA or the dip low')
      detail = `dip ${depth} · not holding: ${why.join('; ')}`
    }
  }

  return { triggered, holding, dropPct, detail }
}

/** The dip lane's own long call. Only a triggered AND holding dip earns one.
 *
 * Everything here is structural rather than composite-derived: the stop hides
 * under the dip's actual low, the target is half the way back to the high the
 * name fell from (a full retrace is a hope, half is a trade), and the composite
 * is the dip's depth offset into the calibrated 25-55 bands — honest about the
 * fact that this lane is a modest edge, not a conviction call. */
export function dipCall(sym: string, candles: Candle[], read: DipRead, capUsdM: number | null): EngineCall | null {
  if (!read.triggered || !read.holding) return null
  if (candles.length < MIN_CANDLES) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.c)
  const low = dipWindowLow(candles)
  if (low == null) return null

  const entry = round2(last.c)
  // The stop sits under the WHOLE dip, today included — a stop inside today's
  // range is not a stop. (The reclaim check above deliberately excludes today;
  // risk placement is the one place today's low has to count.) Ratified
  // 2026-08-11: stop = min(dip-window low, today's low).
  const stop = round2(Math.min(low, last.l))
  const high20 = Math.max(...closes.slice(-HIGH_WINDOW))
  const target = round2(entry + (high20 - entry) / 2)
  // No room either way = no trade. Reachable only in degenerate shapes (a shock
  // that closed at the 20-session high, or a close exactly on the dip low).
  if (stop >= entry || target <= entry) return null

  // Minimum 1:1 reward-to-risk (ratified 2026-08-11). The trigger is depth-blind:
  // a one-day gap that closes near the 20-session high triggers the lane while
  // leaving a half-retrace target inches above entry and the stop a mile below,
  // under the whole dip. Structurally sound, but it is a bet that loses ten to
  // make one — it must never publish. Risking more than the target pays is not
  // a modest edge, it is a negative one.
  if (target - entry < entry - stop) return null

  const expectedMovePct = round1(((target - entry) / entry) * 100)
  const composite = round1(clamp(25 + read.dropPct, 25, 55))
  const smallCap = capUsdM != null && capUsdM < SMALL_CAP_MAX_USD_M

  // A minimal, honest factor record: the lane's read is technical, everything
  // else has no vote here (weight 0 — the composite above is NOT a weighted sum,
  // and pretending otherwise would let the display imply votes that never happened).
  const factors = Object.fromEntries(
    (Object.keys(DEFAULT_WEIGHTS) as FactorName[]).map(name => [
      name,
      name === 'technical'
        ? ({ score: 40, detail: read.detail, weight: 0 } as FactorScore & { weight: number })
        : ({ score: null, detail: 'dip lane', weight: 0 } as FactorScore & { weight: number }),
    ]),
  ) as Record<FactorName, FactorScore & { weight: number }>

  // The lane's own gates ARE its evidence contract: a measured drop, a volume-paid
  // reclaim and the knife guard all had to pass before this function was reached.
  const evidence: CallEvidence = {
    // NOMINAL placeholders — this lane has ONE real factor (its own price read).
    // Nothing downstream may read these as a count of independent evidence.
    coverage: 1,
    famAgree: 2,
    contract: true,
    contextPts: 0,
    detail: read.detail,
  }

  return {
    sym,
    side: 'long',
    composite,
    factors,
    setup: 'reversal',
    evidence,
    expectedMovePct,
    entry,
    stop,
    target,
    capacityPct: swingCapacity(closes) ?? 0,
    smallCap,
    earningsRisk: false, // overridden from the live earnings calendar at integration
    stage: 'early-reversal',
    note: read.detail,
  }
}
