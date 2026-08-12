// The velocity lane. A name already MOVING is a long, and the ordinary path is
// structurally unable to say so in time.
//
// composeCall derives its levels from an ATR-scaled conviction number, which is a
// mean-reversion instrument: the further a name has run, the wider its ATR, the
// worse its risk-reward looks, and the later it clears. By the time a momentum
// name composites well it is usually five green days old — the single worst bar
// of the move to buy. So the velocity lane, like the dip lane, classifies the
// price signature itself and builds its own long call, which then walks the
// ordinary calibration path (probabilityFor needs only side/regime/|composite|/
// cohort) and is graded and learned from like everything else.
//
// TWO DOORS, deliberately, because a move has two tradeable moments and they are
// not the same trade:
//
//   early        — the first break of the 20-session high, PAID FOR (3× volume).
//                  Youngest, least confirmed, highest slippage risk. Smallest size.
//   confirmation — the move is already established (+15% in five sessions, or three
//                  of the last five up inside a net-UP window), it was PAID FOR —
//                  either way — by real participation printed ON an up-day, and the
//                  tape has just PAUSED without losing the 8-EMA. Both legs, always:
//                  a big move nobody printed volume on is a move nobody defends.
//                  Later, better evidence, larger size.
//
// Both open at once → early wins, and its smaller cap applies: the same tape read
// through the younger, riskier lens gets the younger, riskier size.
//
// ONE TRAIL. Both doors stop at the same place — max(8-EMA, the lowest low of the
// five COMPLETED sessions before today). Momentum dies by losing its trail, not by
// retracing a fixed percentage, and the target is 2R rather than a level: runs are
// ridden. The trail deliberately does not read today's own low; a level that moves
// down with the bar it is meant to falsify can never fire against it [C3].
//
// AND THE NTH GREEN DAY IS NEVER BOUGHT. Both doors carry the same entry-timing
// rule — at most two consecutive up-closes. Chasing the fifth green candle is the
// characteristic way a momentum system loses money, and no amount of volume,
// breakout or run buys past it.
//
// The composite lives inside the calibrated 25-55 bands, like every lane: catching
// a real move is an edge, not a certainty.
//
// Pure module: candles in, a read and a call out. No IO, no LLM. The engine loop
// (buildBoard) supplies the earnings calendar and the catalyst narration tag — this
// lane never sets one, because a price signature is not news.

import type { Candle } from '../types'
import { swingCapacity } from '../indicators'
import { SMALL_CAP_MAX_USD_M } from './capClass'
import { DEFAULT_WEIGHTS } from './composite'
import { clamp, round1, round2, type CallEvidence, type EngineCall, type FactorName, type FactorScore } from './types'

/** Below this the price signature simply isn't readable — no velocity verdict at all. */
export const MIN_CANDLES = 30
/** The high the early door breaks — measured over the sessions BEFORE today. */
export const BREAKOUT_WINDOW = 20
/** The early door's price: a break nobody paid for is a break nobody defends. */
export const EARLY_VOL_MULT = 3
/** The confirmation door's price, and it must print ON an up-day [C7]. */
export const CONFIRM_VOL_MULT = 2
/** The confirmation door's run window, and the trail's low window. */
export const RUN_WINDOW = 5
/** Confirmation leg A: a five-session move this size is a move, full stop. */
export const RUN_TRIGGER_PCT = 15
/** Confirmation leg B: this many of the last RUN_WINDOW sessions closing up. */
export const UP_DAYS_MIN = 3
/** Entry timing, both doors: buy the pause, never the Nth green candle. */
export const MAX_GREEN_STREAK = 2
/** The trail's moving component. Short on purpose — this is a momentum stop. */
export const EMA_PERIOD = 8
/** Reward as a multiple of the risk the trail defines. */
export const TARGET_R = 2
/** The smallest risk distance worth trading, as a fraction of entry. A trail that
 *  sits 4p under a 107.40 close is not a stop: ordinary noise takes it out, the 2R
 *  target lands inside the same bar's range, and any R-based size explodes. */
export const MIN_RISK_FRAC = 0.01

/** How much of the rung each door may size to (Task 5's input). The early read is
 * the same move seen younger and less confirmed, so it is sized smaller — not
 * because it is wrong more often, but because it is wrong sooner and wider. */
export const VELOCITY_DOOR_CAP = { early: 0.25, confirmation: 0.5 } as const

export type VelocityDoor = 'early' | 'confirmation'

export interface VelocityRead {
  /** The door actually taken. Early wins when both are open. */
  door: VelocityDoor | null
  /** …and both diagnostics independently, so a replay can report EVERY firing
   *  rather than only the one that won the tie-break. */
  earlyTriggered: boolean
  confirmationTriggered: boolean
  /** Consecutive up-closes ending today. The entry-timing rule reads this. */
  greenStreak: number
  detail: string
}

/** Standard EMA: seeded with the SMA of the first `period` values. null when the
 * history is shorter than the period — an unknown never passes a gate. */
function emaLast(values: number[], period: number): number | null {
  if (values.length < period) return null
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) e += k * (values[i] - e)
  return e
}

/** Mean volume of the BREAKOUT_WINDOW sessions before today. Today is excluded
 * everywhere in this lane: the bar being judged must not sit in the baseline it
 * is judged against, or a big print quietly raises its own bar. */
function avgVol(candles: Candle[]): number | null {
  const w = candles.slice(-(BREAKOUT_WINDOW + 1), -1)
  if (w.length < BREAKOUT_WINDOW) return null
  const avg = w.reduce((s, c) => s + c.v, 0) / w.length
  return avg > 0 ? avg : null
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${round1(Math.abs(x))}%`

/** The falsifier level, and the lane's stop: the higher of the 8-EMA and the
 * lowest intraday low of the RUN_WINDOW sessions BEFORE today.
 *
 * Excluding today is the whole point [C3]. A trail that included today's own low
 * would be redefined downward by every bar it was supposed to falsify — on a
 * washout session it slides under the spike and the stop can never be hit, which
 * is precisely the day the reader most needs it to be. Task 6 re-reads this daily
 * against the live tape, so it is rounded here: the published stop and the daily
 * check must be the same number, not two numbers that agree to six places. */
export function velocityTrail(candles: Candle[]): number | null {
  const window = candles.slice(-(RUN_WINDOW + 1), -1)
  if (window.length < RUN_WINDOW) return null
  const ema = emaLast(candles.map(c => c.c), EMA_PERIOD)
  // Both legs or nothing. Falling back to the low alone would publish a LOOSER
  // stop than the trail is defined to be, which is the wrong way to fail.
  if (ema == null) return null
  return round2(Math.max(ema, Math.min(...window.map(c => c.l))))
}

/** Read the velocity signature off the tape. null iff the history is too short. */
export function classifyVelocity(candles: Candle[]): VelocityRead | null {
  if (candles.length < MIN_CANDLES) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.c)
  const n = closes.length

  // --- shared inputs ---
  const priorCloses = closes.slice(-(BREAKOUT_WINDOW + 1), -1)
  const high20 = Math.max(...priorCloses)
  const baseVol = avgVol(candles)
  const volMult = baseVol != null ? last.v / baseVol : null
  const ema8 = emaLast(closes, EMA_PERIOD)

  // Consecutive up-CLOSES ending today. Flat is not up: a name that has not moved
  // has not extended, and pausing is exactly what this lane wants to buy.
  let greenStreak = 0
  for (let i = n - 1; i > 0; i--) {
    if (closes[i] > closes[i - 1]) greenStreak++
    else break
  }
  const timingOk = greenStreak <= MAX_GREEN_STREAK

  const ref5 = closes[n - 1 - RUN_WINDOW]
  const move5Pct = ref5 > 0 ? ((last.c - ref5) / ref5) * 100 : 0

  // --- the early door ---
  // The level is the max close of the prior 20 sessions EXCLUDING today: the
  // breakout bar must not be allowed into the high it is breaking [gpt-oss #7],
  // or the only tape that ever clears is one that closes below its own close.
  const brokeOut = last.c > high20
  const paidEarly = volMult != null && volMult >= EARLY_VOL_MULT
  const earlyTriggered = brokeOut && paidEarly && timingOk

  // --- the confirmation door ---
  // A RUN, in one of two shapes: large, or broad. Rounded before the comparison so
  // float noise on an exact 15.0% cannot flip the verdict (the dip lane's convention).
  // raw at the gate, rounded only in prose — round1 here let a 14.95% move
  // through a 15% door (codex cross-check, 2026-08-12)
  const bigRun = move5Pct >= RUN_TRIGGER_PCT

  // PAID: at least one of the up-days inside the window printed >= 2× the baseline.
  // The volume evidence has to sit on an up-day [C7]: a 3× DOWN day inside a mixed
  // week is distribution, and counting it let the loudest sellers in the window
  // vouch for the buyers.
  let upDays = 0
  let bestUpMult = 0
  let paidUpDay = false
  for (let i = Math.max(1, n - RUN_WINDOW); i < n; i++) {
    if (closes[i] <= closes[i - 1]) continue
    upDays++
    const m = baseVol != null ? candles[i].v / baseVol : 0
    if (m > bestUpMult) bestUpMult = m
    if (m >= CONFIRM_VOL_MULT) paidUpDay = true
  }
  // A run is either large or broad — and, either way, UP. Three green sessions
  // inside a collapse are bounces, so the breadth leg reads the direction of the
  // window it is counting inside; without that a −6% five-session slide with a
  // paid bounce reads as momentum.
  const runLeg = bigRun || (upDays >= UP_DAYS_MIN && move5Pct > 0)

  // …and BOTH run shapes must be paid for. A big move nobody printed volume on is
  // a move nobody defends, and letting the 15% leg stand alone also let the door
  // open on a tape whose volume was unknowable (`baseVol == null` ⇒ every up-day
  // multiple is 0, i.e. no evidence at all, which must never read as evidence).
  const holdsEma = ema8 != null && last.c > ema8
  const confirmationTriggered = runLeg && paidUpDay && timingOk && holdsEma

  // Both open → early. The younger read is not the better one; it is the one whose
  // size cap is smaller, and on a tape that satisfies both we take the cautious cap.
  const door: VelocityDoor | null = earlyTriggered ? 'early' : confirmationTriggered ? 'confirmation' : null

  const volStr = volMult != null ? `${round1(volMult)}×` : 'unknown'
  // With no baseline there is no multiple — say so. Printing "0×" would state a
  // measurement that was never taken, and 0× reads as "nobody traded".
  const bestUpStr = baseVol != null ? `${round1(bestUpMult)}×` : 'unknown'
  const streakStr = `${greenStreak} green day${greenStreak === 1 ? '' : 's'}`
  let detail: string
  if (door === 'early') {
    detail = `velocity (early door): ${round2(last.c)} broke the ${round2(high20)} 20-session high on ${volStr} volume · ${pct(move5Pct)} over ${RUN_WINDOW} sessions · ${streakStr}`
  } else if (door === 'confirmation') {
    const how = bigRun
      ? `${pct(move5Pct)} over ${RUN_WINDOW} sessions`
      : `${upDays}/${RUN_WINDOW} up-days paid by a ${bestUpStr} up-day`
    detail = `velocity (confirmation door): ${how} · holding the ${EMA_PERIOD}-EMA at ${round2(ema8 ?? 0)} · ${streakStr}`
  } else {
    const earlyWhy: string[] = []
    if (!brokeOut) earlyWhy.push(`no break of the ${round2(high20)} 20-session high`)
    if (!paidEarly) earlyWhy.push(`${volStr} volume under ${EARLY_VOL_MULT}×`)
    if (!timingOk) earlyWhy.push(streakStr)
    const confWhy: string[] = []
    // The two legs refuse for different reasons and each must SAY which. Reporting
    // only the joint failure left every "the run was there, nobody paid for it"
    // refusal printing an empty clause — the least readable possible outcome for a
    // reader asking why a name they can see moving was not called.
    if (!runLeg) {
      confWhy.push(
        move5Pct > 0
          ? `no ${RUN_TRIGGER_PCT}% ${RUN_WINDOW}-session run (${pct(move5Pct)}) and only ${upDays}/${RUN_WINDOW} up-days`
          : `no run at all (${pct(move5Pct)} over ${RUN_WINDOW} sessions)`,
      )
    } else if (!paidUpDay) {
      confWhy.push(`no ${CONFIRM_VOL_MULT}× up-day (${upDays}/${RUN_WINDOW} up, best up-day ${bestUpStr})`)
    }
    if (!timingOk) confWhy.push(streakStr)
    if (!holdsEma) confWhy.push(`below the ${EMA_PERIOD}-EMA`)
    detail = `no velocity · early: ${earlyWhy.join(', ')} · confirmation: ${confWhy.join(', ')}`
  }

  return { door, earlyTriggered, confirmationTriggered, greenStreak, detail }
}

/** The velocity lane's own long call. Only an open door earns one.
 *
 * Everything here is structural rather than composite-derived: the stop is the
 * trail (the level that would falsify the move), the target is 2R off that risk
 * because a run is ridden rather than measured to a retrace level, and the
 * composite is the five-session move offset into the calibrated 25-55 bands —
 * honest about the fact that catching a move in flight is a modest edge. */
export function velocityCall(
  sym: string,
  candles: Candle[],
  read: VelocityRead,
  capUsdM: number | null,
): EngineCall | null {
  if (!read.door) return null
  if (candles.length < MIN_CANDLES) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.c)

  const entry = round2(last.c)
  const stop = velocityTrail(candles)
  // No room = no trade. Reachable when the 8-EMA still carries an older, higher
  // shelf: a break of the 20-session high that is nevertheless under the average
  // of the last eight closes has no risk distance to size against.
  if (stop == null || stop >= entry) return null
  // And "barely any room" is the same trade. A pullback that lands a hair above its
  // own 8-EMA prints a technically-valid stop pennies away; the risk distance is
  // then smaller than the tape's own noise, so the stop is not a falsifier and the
  // 2R target is not a move. Refuse rather than publish a fake risk number.
  if (entry - stop < MIN_RISK_FRAC * entry) return null
  const target = round2(entry + TARGET_R * (entry - stop))

  const expectedMovePct = round1(((target - entry) / entry) * 100)
  const ref5 = closes[closes.length - 1 - RUN_WINDOW]
  const move5Pct = ref5 > 0 ? ((last.c - ref5) / ref5) * 100 : 0
  // max(0, …) not abs(…): this lane is long-only, so a NEGATIVE five-session move
  // is not conviction of the same size — abs() scored a −20% slide exactly like a
  // +20% run. A door reached with a net-down window scores the floor.
  const composite = round1(clamp(25 + Math.max(0, move5Pct), 25, 55))
  const smallCap = capUsdM != null && capUsdM < SMALL_CAP_MAX_USD_M

  // A minimal, honest factor record: the lane's read is technical, everything
  // else has no vote here (weight 0 — the composite above is NOT a weighted sum,
  // and pretending otherwise would let the display imply votes that never happened).
  const factors = Object.fromEntries(
    (Object.keys(DEFAULT_WEIGHTS) as FactorName[]).map(name => [
      name,
      name === 'technical'
        ? ({ score: 40, detail: read.detail, weight: 0 } as FactorScore & { weight: number })
        : ({ score: null, detail: 'velocity lane', weight: 0 } as FactorScore & { weight: number }),
    ]),
  ) as Record<FactorName, FactorScore & { weight: number }>

  // The lane's own gates ARE its evidence contract: a paid break or a paid,
  // EMA-holding run, plus the entry-timing rule, all had to pass to reach here.
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
    setup: 'velocity',
    evidence,
    expectedMovePct,
    entry,
    stop,
    target,
    capacityPct: swingCapacity(closes) ?? 0,
    smallCap,
    earningsRisk: false, // overridden from the live earnings calendar at integration
    stage: 'trending',
    note: read.detail,
    // No catalyst here on purpose: a price signature is not news. buildBoard
    // attaches the narration tag when a real catalyst exists (Task 2).
  }
}
