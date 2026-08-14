import type { Candle, RegimeColor } from '../types'
import { swingCapacity } from '../indicators'
import { EQUITY_SETUP_WINDOWS, regimeFromCandles, type IndexWindows, type SetupWindows } from '../setups'
import { type TechWindows } from '../technicals'
import { clamp, round1, type FactorScore } from './types'
import { initRisk, type CohortRung } from './riskLadder'
import { CRYPTO_GRADE_HORIZON, CRYPTO_LOOKBACKS, CRYPTO_UNIVERSE } from './cryptoCalibration'

// ─────────────────────────────────────────────────────────────────────────────
// THE CRYPTO LANE (Stage 1c Phase B, Task B2) — the wiring B1 built the
// partition for.
//
// B1 shipped the PARTITION: a separate calibration blob, an absolute outcome
// basis, a 14-bar clock, a completed-bars candle seam and the adjudicated
// lookback table. It wired nothing. This module is the lane's own pure half —
// the clock profiles threaded from that table, the BTC regime, the crypto
// momentum factor, the size cap and its earn-out, the rung blob, the voice and
// the CRYPTO=off seam. `buildBoard` and `gradeOutstanding` are where it is
// plugged in; everything here is pure and testable on its own.
//
// WHAT IS NOT HERE, AND WHY. No grading (B1 owns `gradeCryptoPrediction`), no
// calibration arithmetic (B1 owns the wrappers), and no equity behaviour of any
// kind. The Phase-A containment guards stay unconditional everywhere except at
// the two sites this lane explicitly builds, and each of those relaxations is
// named in a comment at the site and pinned by a test that says so.
// ─────────────────────────────────────────────────────────────────────────────

/** THE LEVER (the house pattern: `FUNNEL_TRACE=off`, `REGRET=off`, `GATES=off`,
 * `WILDCARD=off`). `CRYPTO=off` kills the lane ENTIRELY — no crypto candidate,
 * no crypto row, no crypto grading accrual, no crypto rung — and restores the
 * Phase-A guards exactly, so a walk can prove the tree with the lane off is the
 * tree before it existed.
 *
 * What it deliberately does NOT touch: watching. A reader's crypto watchlist
 * entry still gets quotes, news and alerts with the lever off, exactly as it
 * did through the whole of Phase A. The lever is on ENGINE mechanisms.
 *
 * Read per call, not memoised, for the same reason `regretDisabled` is: a run
 * that sets it after the module loaded must still be off. The try/catch is for
 * the browser bundle, which has no `process` at all. */
export function cryptoDisabled(): boolean {
  try {
    return typeof process !== 'undefined' && process.env?.CRYPTO === 'off'
  } catch {
    return false
  }
}

// ---- the clock profiles ----

const L = CRYPTO_LOOKBACKS

/** The setup cascade on the crypto clock — every window READ OFF B1's
 * adjudicated table, never multiplied here. The two derived rows are named:
 *
 *  · `basingMinHistory` is `basePrior + baseSessions` by construction (the
 *    equity 40 is exactly 30 + 10), so it follows the two windows it protects
 *    rather than carrying a number of its own — B1's minimum-history rule.
 *  · `divergenceLookback` is a plain wall-clock window (40 sessions ≈ two
 *    months) and takes the ×7/5 image of it; it is not in the table because the
 *    table lists named constants and this one was a default argument.
 *
 * `rsi` is 14 in BOTH profiles and that is the whole point of the row: the
 * period is the smoothing constant the fixed thresholds reading it were
 * calibrated against (CRYPTO_LOOKBACKS.rsi14's `why`). */
export const CRYPTO_SETUP_WINDOWS: SetupWindows = {
  sma20: L.sma20.crypto,
  sma50: L.sma50.crypto,
  sma200: L.sma200.crypto,
  atr: L.atr14.crypto,
  rsi: L.rsi14.crypto,
  baseSessions: L.baseSessions10.crypto,
  basePrior: L.basePrior30.crypto,
  basingMinHistory: L.basePrior30.crypto + L.baseSessions10.crypto,
  divergenceLookback: Math.round((EQUITY_SETUP_WINDOWS.divergenceLookback * 7) / 5),
  knifeWindow: L.knifeWindow20.crypto,
  pullbackHigh: L.pullbackHigh20.crypto,
  breakoutWatch: L.breakoutWatchWindow15.crypto,
  rvolBaseline: L.rvolBaseline20.crypto,
  minHistory: L.setupsMinHistory25.crypto,
}

/** The technical read on the crypto clock, same rule and same table. */
export const CRYPTO_TECH_WINDOWS: TechWindows = {
  sma20: L.sma20.crypto,
  sma50: L.sma50.crypto,
  atr: L.atr14.crypto,
  rsi: L.rsi14.crypto,
  range: L.rangeWindow60.crypto,
  rvolBaseline: L.rvolBaseline20.crypto,
  ema8: L.ema8.crypto,
  ema21: L.ema21.crypto,
  ema50: L.ema50.crypto,
  thrustRecent: L.thrustRecent5.crypto,
  thrustBase: L.thrustBase20.crypto,
  minHistory: L.minHistory30.crypto,
  setups: CRYPTO_SETUP_WINDOWS,
}

/** The INDEX read on the crypto clock — the three windows `indexHealthy` uses. */
export const CRYPTO_INDEX_WINDOWS: IndexWindows = {
  sma20: L.sma20.crypto,
  sma50: L.sma50.crypto,
  slopeLag: L.smaSlopeLag5.crypto,
}

/** The shortest BTC tape that can produce a regime at all: the 50-SMA plus the
 * slope lag it is read against, plus the bar being read. Below it the answer is
 * `unknown` — and an unknown regime fails the evidence contract, which is the
 * honest consequence of not knowing what tape the call is being made into. */
export const CRYPTO_INDEX_MIN_BARS = CRYPTO_INDEX_WINDOWS.sma50 + CRYPTO_INDEX_WINDOWS.slopeLag + 1

/** THE HOLDING PERIOD, in crypto bars — what `swingCapacity` must be asked
 * about for a crypto row (B1: `swingCapacityWindow10` is the holding period, not
 * a lookback, so it is pinned to the horizon), over a CALENDAR year of a 7-day
 * tape (`swingCapacityLookback250` → 365, not the ratio's 350). */
export const CRYPTO_CAPACITY_WINDOW = CRYPTO_GRADE_HORIZON
export const CRYPTO_CAPACITY_LOOKBACK = L.swingCapacityLookback250.crypto

/** This pair's swing capacity, on its own clock. One call site in the engine
 * and one definition here, so the expected-move floor and the target can never
 * be computed off a different window from the one the grade will use. */
export const cryptoCapacity = (closes: number[]): number | null => swingCapacity(closes, CRYPTO_CAPACITY_WINDOW, CRYPTO_CAPACITY_LOOKBACK)

// ---- the regime ----

/** THE CRYPTO TAPE — BTC's own bars through the EXISTING regime machinery, on
 * the crypto clock (the ratified design: "BTC replaces SPY as the regime input
 * for the cohort, computed BEFORE composeCall and fed in, never relabelled").
 *
 * BTC IS PASSED AS BOTH ARGUMENTS, and that is a decision rather than a
 * shortcut. `regimeFromCandles(index, confirmer)` encodes "two independent
 * tapes must agree" — SPY and QQQ. Crypto has ONE index and no confirmer: the
 * universe is three pairs, of which two ARE the alts the regime is being read
 * for, and a breadth vote over three series is below `breadthAbove50`'s own
 * ten-series floor (B1's `CRYPTO_NOT_A_CLOCK` says exactly this). Handing BTC
 * to both slots makes the agreement rule degenerate to `indexHealthy(BTC)`,
 * which IS the ratified read — and it goes through the shipped function rather
 * than a private copy of it, so a change to what 'green' means changes it for
 * both partitions at once.
 *
 * NO REFINEMENT. `refineRegime` takes breadth (see above: no honest sample) and
 * the VIX LEVEL, which is an equity-options fear gauge with nothing to say
 * about a coin. Both would be null, and `refineRegime(base, null, null)` is
 * `base` — so the call is omitted rather than written as a no-op that invites a
 * future editor to "wire the VIX in".
 *
 * THE LABELS ARE REUSED ('green' | 'amber' | 'red') and that is safe HERE for
 * one structural reason: the crypto buckets live in a DIFFERENT BLOB (B1's
 * partition), so `long:green:55-70` inside `crypto-calibration` can only ever
 * mean "green the bitcoin tape". Nothing pools the two; there is no key scheme
 * to collide. Adding a fourth `RegimeColor` would instead be a compile error at
 * `LONG_REGIME_MULT` and in the UI's copy table — a cost with no benefit the
 * blob boundary is not already paying. */
/** WHOSE TAPE THE COHORT'S REGIME IS. Named rather than inlined because the
 * lane must fetch it even when the reader watches only ETH: the regime is BTC's,
 * so a run that skipped BTC would price an ETH call against `unknown` and fail
 * its evidence contract for want of a fetch nobody made. */
export const CRYPTO_REGIME_SYMBOL = 'BTC-USD'

export function cryptoRegimeFrom(btc: Candle[] | null | undefined): RegimeColor | 'unknown' {
  if (!btc || btc.length < CRYPTO_INDEX_MIN_BARS) return 'unknown'
  return regimeFromCandles(btc, btc, CRYPTO_INDEX_WINDOWS)
}

// ---- the momentum factor ----

/** The 29-bar window — the ×7/5 image of the equity 21-session month
 * (CRYPTO_LOOKBACKS.momentumRet21). */
export const CRYPTO_MOMENTUM_WINDOW = L.momentumRet21.crypto

/** Saturation: a move `CRYPTO_MOMENTUM_SATURATION` times the pair's own
 * typical 29-bar travel scores the full ±80. See the note below for why this is
 * the matched STATEMENT rather than a matched constant. */
export const CRYPTO_MOMENTUM_SATURATION = 2

/** MOMENTUM, ABSOLUTE, ON THIS PAIR'S OWN SCALE.
 *
 * WHY IT HAD TO BE BUILT AT ALL (recon §2.4, and B1's binding). `momentumFactor`
 * is `ret21(closes) − ret21(spyCloses)`: a CORE factor at weight 0.9 and one of
 * the two mandatory legs of the evidence contract. Handed a crypto pair it
 * subtracts a 21-calendar-day crypto return from a ~30-calendar-day SPY return,
 * and handed `null` for the SPY leg it returns `score: null` — which fails the
 * contract for every crypto row, forever, and makes the whole cohort permanently
 * watch-only for a reason that has nothing to do with the trade. Either answer
 * is wrong, so the crypto lane gets its own.
 *
 * NO BENCHMARK, because the partition has none: the outcome basis is ABSOLUTE
 * (B1, `CRYPTO_CALIB_DEF_VERSION`), and a factor measured against a benchmark
 * the grade does not use is a factor arguing about a different question from
 * the one it will be scored on.
 *
 * THE DENOMINATOR IS THE PAIR'S OWN TRAVEL, and this is the part worth reading
 * twice. The equity factor is `RS_pp × 4, clamped ±80` — it saturates at 20
 * percentage points of 21-day relative return, which for a large cap is roughly
 * two standard deviations: an extreme move. Reusing that CONSTANT on an
 * absolute crypto return would saturate on a 20% month, which BTC prints
 * routinely — the factor would read ±80 nearly every day, becoming the constant
 * placeholder that `LANE_CATALYST_KINDS` exists to keep out of the IC loop, and
 * `famAgree` would be satisfied by a number that says nothing. Inventing a
 * smaller multiplier instead would be a magic constant with no evidence behind
 * it, and the crypto cohort has no record yet to derive one from.
 *
 * So the STATEMENT is preserved rather than the number: "an extreme move for
 * this thing scores the maximum". `swingCapacity(closes, 29, 365)` is already
 * the engine's own answer to "how far does this name travel over this horizon"
 * — the 80th percentile of its absolute 29-bar moves over a calendar year of
 * its own tape — so the score is the move expressed in units of that, saturating
 * at twice it. It is self-calibrating per pair (SOL is more volatile than BTC
 * and its own tape says so), it introduces no constant that was not already in
 * the engine, and it re-derives itself as the tape changes.
 *
 * NULL WHEN THE TAPE CANNOT ANSWER — the pair's typical move is what the score
 * is denominated in, so without it there is no score, and a crypto row on a
 * 40-bar tape correctly fails the contract rather than being handed a number
 * off an unmeasurable scale. In production this is unreachable: the crypto
 * fetch is a calendar year (~365 bars) against `swingCapacity`'s 59-bar floor. */
export function cryptoMomentumFactor(
  closes: number[] | null | undefined,
  window: number = CRYPTO_MOMENTUM_WINDOW,
  lookback: number = CRYPTO_CAPACITY_LOOKBACK,
): FactorScore {
  if (!closes || closes.length < window + 1) return { score: null, detail: `insufficient history (${closes?.length ?? 0} bars, needs ${window + 1})` }
  const from = closes[closes.length - 1 - window]
  if (!from) return { score: null, detail: 'no base price for the momentum window' }
  const ret = ((closes[closes.length - 1] - from) / from) * 100
  const typical = swingCapacity(closes, window, lookback)
  if (typical == null || typical <= 0) return { score: null, detail: 'no measurable travel to scale the move against' }
  const ratio = ret / typical
  return {
    score: round1(clamp((ratio / CRYPTO_MOMENTUM_SATURATION) * 80, -80, 80)),
    detail: `${window}-bar move ${ret >= 0 ? '+' : ''}${round1(ret)}% vs its own typical ${round1(typical)}% (${round1(ratio)}×)`,
  }
}

// ---- the size cap and its earn-out ----

/** THE HARD CAP (the ratified design). Half the rung, through `publishCall`'s
 * existing `sizeCap` parameter — a CAP, taken with `Math.min` against the tier
 * the grade earned, never multiplied into it (the velocity door's precedent,
 * engine.ts's own v1-D4 rule). */
export const CRYPTO_SIZE_CAP = 0.5

/** THE EARN-OUT: full-rung eligibility only once the crypto rung's OWN record
 * has cleared the promote bar.
 *
 * No new threshold is invented. `computeRung`'s promote branch already IS the
 * bar — 25 of the cohort's own graded calls at the rung, a 55% hit rate over
 * the last 25, and the cohort's own Brier trail improving — and the only way a
 * crypto rung leaves 0 is by clearing it (the crypto stream never mirrors the
 * equity book: see `cryptoCombinedFor`). So "rung ≥ 1" IS "this cohort's record
 * cleared the promote bar", read off the one artefact that can say so.
 *
 * A DEMOTION PUTS THE CAP BACK. If the cohort later goes cold and steps down to
 * rung 0, the cap returns to a half — which is the honest reading: the release
 * was earned by a record, and the record no longer says it. */
export const cryptoSizeCap = (rung: number): number => (rung >= 1 ? 1 : CRYPTO_SIZE_CAP)

// ---- the rung stream ----

/** THE CRYPTO RUNG'S OWN BLOB — a sibling of `risk-state`, never a field inside
 * it. Two keys, two reads, two writes: a deploy that reads `risk-state` alone
 * behaves exactly as it does today, `RiskState.cohorts` keeps its two members,
 * and no equity blob shape moves. Same argument as B1's `crypto-calibration`,
 * one mechanism over. */
export const CRYPTO_RISK_KEY = 'crypto-risk'

/** A cold crypto ladder: rung 0, no history. `initRisk`'s own rung shape,
 * reused so the two ladders can never drift in their fields. */
export const initCryptoRisk = (today: string): CohortRung => {
  const { cohorts: _cohorts, ...rung } = initRisk(today)
  return rung
}

/** The crypto rung blob's load rule. Anything that is not a well-formed ladder
 * — absent, a partial restore, a hand-edit — reads as COLD rather than being
 * patched into shape: a rung is permission to size, and permission recovered
 * from a malformed blob is permission nobody granted. */
export function loadCryptoRisk(stored: CohortRung | null | undefined, today: string): CohortRung {
  if (!stored || typeof stored.rung !== 'number' || stored.rung < 0 || stored.rung > 3) return initCryptoRisk(today)
  return {
    rung: Math.round(stored.rung) as CohortRung['rung'],
    sinceDate: typeof stored.sinceDate === 'string' ? stored.sinceDate : today,
    gradedAtRung: typeof stored.gradedAtRung === 'number' && stored.gradedAtRung >= 0 ? stored.gradedAtRung : 0,
    history: Array.isArray(stored.history) ? stored.history.slice(-50) : [],
  }
}

/** WHAT THE CRYPTO COHORT MIRRORS WHILE IT IS THIN — ITSELF.
 *
 * `computeCohortRung` takes a `combined` ladder and mirrors it until the cohort
 * has `COHORT_STANDALONE_N` graded calls of its own. For the equity sleeves
 * that is right: a young large-cap sleeve is never starved, because the whole
 * book's record is still evidence about it. For crypto it would be exactly the
 * contamination the partition exists to prevent — the equity book's earned rung
 * is a measurement of a market this cohort does not trade in, and inheriting it
 * would hand a cold coin the sizing 8,500 SPY-benchmarked equity outcomes paid
 * for.
 *
 * So the crypto stream is handed ITSELF as the combined ladder. While thin it
 * mirrors its own rung, which is a no-op that keeps `gradedAtRung` accumulating
 * honestly; once it has twenty of its own graded outcomes it stands on them
 * through `computeRung` exactly like any other cohort. The function is used
 * verbatim — this is the one argument that had to be chosen rather than
 * inherited. */
export const cryptoCombinedFor = (crypto: CohortRung): CohortRung => crypto

// ---- the universe ----

/** WHICH PAIRS THE LANE LOOKS AT TODAY: the reader's own watchlist, narrowed to
 * the three pairs the partition is defined over (`CRYPTO_UNIVERSE` — spec §7:
 * alts, DeFi, memecoins and on-chain are OUT).
 *
 * WATCHLIST-DRIVEN, so the lane is opt-in by construction: a reader who has
 * never asked about crypto gets a board with no crypto row on it, and the
 * starter watchlist's BTC/ETH is what turns it on for everyone else. A crypto
 * pair OUTSIDE the universe (DOGE-EUR, ETH-BTC) is watched exactly as it was
 * through Phase A and never evaluated — the containment guard still refuses it,
 * and says which universe it fell outside of.
 *
 * Returned in `CRYPTO_UNIVERSE` order rather than watchlist order: the lane's
 * candidate order must not depend on the order the reader happened to add
 * names in. */
export function cryptoUniverseFor(watchSyms: readonly string[]): string[] {
  const want = new Set(watchSyms.map(s => s.toUpperCase()))
  return CRYPTO_UNIVERSE.filter(s => want.has(s))
}

/** Is this name one the lane will actually evaluate today? The one test the
 * containment guard in `addSource` asks before deciding whether to claim the
 * trace row — see the relaxation note there. */
export const cryptoLaneOwns = (sym: string, universe: readonly string[]): boolean =>
  !cryptoDisabled() && universe.includes(sym.toUpperCase())

// ---- the voice ----

/** HOW MANY OUTCOMES THE COHORT NEEDS before its own base rate replaces the
 * hard 0.5 — `baseHitRate`'s cliff (calibration.ts), quoted so the copy and the
 * code cannot disagree about the number the reader is told. */
export const CRYPTO_COLD_START_N = 50

/** THE COHORT'S OWN SENTENCE, and the cold start explained rather than left to
 * look like a verdict.
 *
 * Every crypto row grades C at half size until the cohort has watched itself
 * about fifty times — not because the engine dislikes the trade, but because
 * `baseHitRate` reads a flat 0.5 under fifty outcomes and an engine that has
 * never graded a coin has no business claiming an edge over a base rate it has
 * not measured. A reader shown a wall of Cs with no explanation reads it as the
 * engine's opinion of bitcoin; this is the difference between a designed floor
 * and a judgement, said out loud on the row itself.
 *
 * ROUTING IS THE SECOND SENTENCE. Until the owner maps a real tracker in
 * `levMap`, a crypto row is paper only — the capped-short precedent, labelled
 * honestly rather than shown as a placeable trade. */
export function cryptoVoice(input: { sym: string; gradedN: number; routed: boolean; sizeCap: number }): { note: string; detail: string } {
  const cold = input.gradedN < CRYPTO_COLD_START_N
  const cohort =
    `crypto cohort — its own calibration, its own 14-bar clock, its own tape` +
    (cold
      ? `; this cohort has graded ${input.gradedN} of the ~${CRYPTO_COLD_START_N} outcomes it needs, so C at half size is the designed floor, not a verdict`
      : `; ${input.gradedN} graded outcomes of its own now price it`)
  const route = input.routed ? '' : ` · paper only — no ${input.sym} tracker configured yet`
  const cap = input.sizeCap < 1 ? ` · capped at ${input.sizeCap}× the rung until the cohort's own record earns the full one` : ''
  return { note: `${cohort}${route}${cap}`, detail: `${cohort}${route}` }
}
