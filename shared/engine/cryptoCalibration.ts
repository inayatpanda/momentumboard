import type { Candle } from '../types'
import { isCryptoSymbol } from '../symbols'
import { round1, type PredOutcome } from './types'
import {
  ENGINE_MODEL_VERSION,
  baseHitRate,
  gradeBaseRate,
  migrateCalibration,
  probabilityFor,
  updateCalibration,
  type BucketPopulation,
  type CalibrationState,
} from './calibration'

// ─────────────────────────────────────────────────────────────────────────────
// THE CRYPTO PARTITION (Stage 1c Phase B, Task B1) — its own calibration, its
// own clock, its own truth.
//
// Phase A proved the equity engine can be kept clean of crypto and RECORDED
// what it had already been measured with (`isCryptoSymbol`, shared/symbols.ts:
// the guard at every leak). This module is the other half of that promise: the
// capability the containment was buying time for. It BUILDS the surface; it
// wires nothing. Every Phase-A guard is still unconditional at HEAD — relaxing
// them at the explicitly-built sites is Task B2's job, one named relaxation at
// a time.
//
// WHY A SEPARATE MODULE AND A SEPARATE BLOB [recon §1.4 Option B, ratified in
// the plan]. The requirement is "never pools into or out of equity evidence".
// Option A would have enforced that with a filter inside `poolBuckets` — one
// `if` standing between an equity rung and a crypto bucket, forever, defended
// by nothing but attention. Here the partition is STRUCTURAL: the crypto
// evidence lives in a different object under a different blob key, so there is
// no filter to forget and no key scheme to collide. `poolBuckets` is untouched,
// `CALIB_DEF_VERSION` does not move, `seed.json` is not opened, and every
// stored equity blob reads byte-for-byte as it did before this file existed.
//
// WHAT IS REUSED, AND WHY THAT IS SAFE. Almost all of calibration.ts is PURE
// OVER THE STATE IT IS HANDED — it reads the object in front of it and knows
// nothing about which blob that object came from. Those functions are reused
// verbatim, deliberately: two isotonic fits, two shrinkage ladders or two
// Laplace priors that were "the same" on the day they were written are two
// numbers that drift. The table below is the audit of that decision.
//
//   REUSED AS-IS (pure over the given state)
//   ├─ migrateCalibration  backfills modelVersion/setupBuckets/seedGeneration/
//   │                      evidence on whatever object it is given
//   ├─ poolBuckets (private, via curveFor)  the key parse is cohort-agnostic;
//   │                      inside the crypto blob EVERY key is a crypto key, so
//   │                      the 'any' arm means "all crypto" and nothing else can
//   │                      possibly be in scope
//   ├─ curveFor / isotonicFit / readCurve (private) / setupCurveFor / setupStat
//   │                      pure maths on bands; no cohort, no venue, no clock
//   ├─ bandFor             |composite| → band; conviction has no calendar
//   ├─ probabilityFor      the ladder, WRAPPED below as `cryptoProbabilityFor`
//   │                      so the cohort argument is un-passable (see there)
//   ├─ baseHitRate         sums every bucket IN THE STATE GIVEN — which is the
//   │                      crypto pooled base, and its ≥50 cliff is exactly the
//   │                      honest cold start the plan ratified
//   ├─ gradeBaseRate       `referenceBase ?? pooled base`; crypto has no sweep,
//   │                      so it falls back to its own pool — the legacy pattern
//   ├─ gradeFor            takes numbers; A/B/C is a claim about evidence, not
//   │                      about an asset class
//   └─ updateCalibration   WRAPPED below (`updateCryptoCalibration`) for one
//                          reason only: it keys on `capCohortOf(pred.capUsdM)`,
//                          and a crypto row has no cap
//
//   CRYPTO VARIANT REQUIRED
//   └─ gradePrediction  → `gradeCryptoPrediction`. Three things differ and each
//                         one is a definition, not a parameter: the BASIS
//                         (absolute, no benchmark — `gradePrediction` demands a
//                         `spyCandles` argument that cannot exist here), the
//                         CLOCK (14 crypto bars, and `horizon` is typed 5|10|21
//                         over there), and the ENTRY BAR (the first bar that
//                         OPENS after publication, not the one containing it).
//
//   NOT REUSED AT ALL
//   └─ updateIcStats / the Brier trail / the risk ladder / the miss ledger /
//      gate feedback / the scorecard panes — crypto feeds none of them. Those
//      are Phase-A exclusions and they STAY exclusions; B2 gives crypto its own
//      rung stream where the plan says so.
//
// WHY `gradeCryptoPrediction` LIVES HERE and not beside `gradePrediction`
// [documented choice, per the task]. Putting the two definitions one screen
// apart, with `HIT_EXCESS_MIN` in scope of both, invites the next editor to
// "unify" them — and unifying them is precisely the drift this partition
// exists to make impossible. calibration.ts is imported by the whole engine;
// this file is imported only by the crypto lane, so the crypto definition
// cannot leak into an equity code path by autocomplete.
// ─────────────────────────────────────────────────────────────────────────────

/** THE CRYPTO CALIBRATION BLOB. A sibling of `engine-calibration`, never a
 * field inside it: two keys, two reads, two writes, and a deploy that reads the
 * equity blob alone behaves exactly as it does today. */
export const CRYPTO_CALIB_KEY = 'crypto-calibration'

/** THE CRYPTO OUTCOME BASIS — what a hit MEANS in this partition, fixed at
 * birth (spec §4.1 as amended by the Stage-1c plan's ratified design).
 *
 *   A crypto hit is a SIDE-ADJUSTED RAW RETURN of at least +1pp, measured from
 *   the OPEN of the first completed bar that opens after publication to the
 *   CLOSE of the fourteenth bar after it, with a close through the published
 *   stop at any point inside that window disqualifying it forever.
 *
 * ABSOLUTE, NOT VS-SPY, AND NOT VS-BTC. A 24/7 asset class has no SPY: the
 * benchmark's bars are 13.5 hours out of phase, it has no Saturday, and ten of
 * its sessions are fourteen of crypto's — an excess computed across that is a
 * subtraction of two different time spans (recon §2.2, measured: 1,827 ETH bars
 * to SPY's 1,255 over the same five years). vs-BTC was the spec's original
 * intent and was rejected here for two reasons: it makes BTC itself ungradeable
 * (0 excess, always), and it puts two different hit definitions inside one
 * cohort's buckets. A synthetic crypto index has no data source and no
 * precedent. Absolute is one definition, applied identically to all three
 * pairs and to both sides.
 *
 * THIS DEFINES THE CRYPTO PARTITION'S BASIS AND CHANGES NOTHING ABOUT EQUITY.
 * `CALIB_DEF_VERSION` (calibration.ts) stays 3 and still means the 10-session
 * excess-vs-SPY: it is a different constant, read by a different loader, over a
 * different blob. This one is 3 because the crypto partition is born in the
 * same engine epoch and a reader comparing the two numbers should see the same
 * epoch — but they are TWO constants precisely so an equity redefinition can
 * bump one without silently discarding crypto's evidence, and vice versa.
 *
 * BUMP THIS when the crypto outcome definition changes (the basis, the horizon,
 * the entry rule, the stop rule). `loadCryptoCalibration` then discards the
 * stored crypto buckets — there is no crypto seed to fall back on, so the
 * partition simply goes cold again, which is the honest answer. */
export const CRYPTO_CALIB_DEF_VERSION = 3

/** The bar, in percentage points, side-adjusted and ABSOLUTE. Numerically equal
 * to the equity `HIT_EXCESS_MIN` today and deliberately NOT imported from it:
 * that one is "excess over a benchmark", this one is "the move itself", and one
 * edit must never answer two questions. */
export const CRYPTO_HIT_MIN_PCT = 1

/** The three pairs, and the whole universe (spec §7: alts, DeFi, memecoins and
 * on-chain are OUT). All three are already served by the existing Yahoo path —
 * `isYahooSymbol` has been true for them since Stage 3a — so the seam below
 * adds a cutoff, not a data source. */
export const CRYPTO_UNIVERSE = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const

// ---- the clock ----

/** Crypto prints seven bars a week; an exchange prints five. Every wall-clock
 * window in the engine was written in SESSIONS, so reading it on a 24/7 series
 * silently shortens it by 30% — "the 50-day" becomes seven weeks instead of ten
 * (recon §3.4). `cryptoLookback` is the one place that conversion happens. */
export const CRYPTO_BARS_PER_WEEK = 7
export const EQUITY_BARS_PER_WEEK = 5

/** An equity session window, re-expressed in crypto bars: ×7/5, NEAREST whole
 * bar. Nearest and not floor, stated because it changes real windows: 14 → 19.6
 * rounds to 20 where a floor would say 19, and 21 → 29.4 rounds to 29 where a
 * ceiling would say 30. A window is an estimate of a span, so the nearest bar is
 * the honest reading of it in both directions. */
export const cryptoLookback = (equityBars: number): number => Math.round((equityBars * CRYPTO_BARS_PER_WEEK) / EQUITY_BARS_PER_WEEK)

/** The three grading lenses, in crypto bars — the ×7/5 images of the equity
 * 5/10/21 (a week, the calibrated horizon, a month). The MIDDLE one is what
 * calibration learns from, exactly as 10 is on the equity side. */
export const CRYPTO_HORIZONS = [cryptoLookback(5), cryptoLookback(10), cryptoLookback(21)] as const
export type CryptoHorizon = (typeof CRYPTO_HORIZONS)[number]

/** THE CALIBRATED CRYPTO HORIZON: 14 bars = 14 calendar days ≈ the ten trading
 * days the equity engine grades on. "Momentum clocks matched" means WALL CLOCK,
 * not bar count (the plan's ratified design) — a 10-bar crypto call would be a
 * two-week thesis judged in ten days. */
export const CRYPTO_GRADE_HORIZON: CryptoHorizon = CRYPTO_HORIZONS[1]

/** One daily bar, in seconds. Named because it is load-bearing in two places
 * that must agree: the entry rule below and the completed-bar cutoff. */
const DAY_SEC = 86_400

// ---- the state ----

const zero = () => ({ n: 0, hits: 0 })

/** THE CRYPTO BLOB'S BRAND. `basis` is a discriminator, not data: both
 * partitions answer to defVersion 3, so a version check alone cannot tell the
 * equity blob from the crypto one — and an equity blob stored under the crypto
 * key would hand this partition 8,500 SPY-benchmarked rows and the 0.4158
 * anchor it exists to never inherit. The brand closes that at both layers:
 * `loadCryptoCalibration` goes cold on a blob that does not carry it, and the
 * wrappers below accept only the branded type, so handing them the equity
 * state is a compile error rather than a runtime discovery. */
export interface CryptoCalibrationState extends CalibrationState {
  basis: 'absolute'
}

/** A cold crypto partition. EMPTY, by ratified decision: no seed walk ships in
 * 1c (deep-seeding crypto is a recorded follow-up), so `baseHitRate` reads its
 * hard 0.5 under fifty outcomes, `gradeBaseRate` inherits that, and every
 * crypto row grades C at half size until the cohort has watched itself ~50
 * times. That is the DESIGNED behaviour, not a discovered one — an engine that
 * has never graded a coin has no business claiming an edge over a base rate it
 * has not measured (calibration.ts, `baseHitRate`'s own note).
 *
 * `seedGeneration: 0` means "no crypto seed artefact has ever installed here",
 * so a future generation-1 crypto seed can land exactly once under the equity
 * install rule (`seedGen > storedGen`). The equity contract's "absent means 1"
 * does not apply — this namespace has no legacy blobs to be compatible with —
 * and the LOADER enforces that, because `migrateCalibration` would otherwise
 * backfill the equity default into an absent field. */
export function emptyCryptoCalibration(): CryptoCalibrationState {
  return {
    basis: 'absolute',
    buckets: {},
    setupBuckets: {},
    brier: [],
    seeded: false,
    defVersion: CRYPTO_CALIB_DEF_VERSION,
    modelVersion: ENGINE_MODEL_VERSION,
    seedGeneration: 0,
    evidence: { seed: zero(), live: zero(), shadow: zero() },
  }
}

/** The crypto blob's load rule — the equity `loadState`'s definition swap, with
 * the two halves it cannot have: there is no crypto seed to install and no
 * generation to swap, so a blob written under a different outcome definition
 * goes COLD rather than being replaced by an artefact that does not exist.
 *
 * TWO refusals, not one. A wrong `defVersion` is a different hit definition; a
 * missing `basis` brand is a different BLOB — the equity state carries the same
 * defVersion, so the brand is the only thing standing between this partition
 * and silently adopting the whole equity record if a write ever lands under
 * the wrong key. Cold is the honest answer to both.
 *
 * It reads only what it is given. Nothing here opens `seed.json`, and that is a
 * structural claim about the partition, not an omission: the committed seed was
 * swept over an equity universe with crypto explicitly filtered out
 * (`replay-window.ts` `seedUniverse`), so it is not evidence about a coin. */
export function loadCryptoCalibration(stored: CalibrationState | null | undefined): CryptoCalibrationState {
  if (!stored || stored.defVersion !== CRYPTO_CALIB_DEF_VERSION) return emptyCryptoCalibration()
  if ((stored as Partial<CryptoCalibrationState>).basis !== 'absolute') return emptyCryptoCalibration()
  // Absent means 0 HERE: `migrateCalibration`'s `??= 1` is the equity contract
  // for blobs that predate generations, and this namespace has none. Stamp
  // before migrating, or the backfill guesses 1 and a future generation-1
  // crypto seed can never land (`1 > 1` is false).
  stored.seedGeneration ??= 0
  return migrateCalibration(stored) as CryptoCalibrationState
}

/** The crypto cohort's own pooled base rate — `baseHitRate` over the CRYPTO
 * state. Same arithmetic, same fifty-observation cliff, a different population.
 * Nothing filters: the state IS the filter. */
export const cryptoBaseHitRate = (state: CryptoCalibrationState, population: BucketPopulation = 'pooled'): { rate: number; n: number } =>
  baseHitRate(state, population)

/** THE CRYPTO GRADE ANCHOR. `gradeBaseRate` unchanged, over the crypto state:
 * `state.referenceBase ?? pooled`. There is no crypto `referenceBase` today and
 * there will not be one until a crypto sweep exists (B3's spine ships ready for
 * it), so this is the legacy fallback path — the same one every equity blob
 * took before the reference was swept. The equity 0.4158 must never appear
 * here: it was measured on a universe crypto was filtered out of. */
export const cryptoGradeBaseRate = (state: CryptoCalibrationState): number => gradeBaseRate(state)

/** Calibrated probability, off the CRYPTO ladder.
 *
 * `probabilityFor` verbatim, with the cohort argument pinned to 'unknown' and
 * removed from the signature. Two reasons, and both are the partition:
 *
 *  · 'unknown' selects the two-rung ladder `[{any, regime}, {any, null}]`, and
 *    inside a blob where every key is a crypto key that reads exactly "this
 *    regime, then all regimes, then my own base rate" — the crypto cohort's own
 *    hierarchy, with no equity rung underneath it because there is no equity
 *    bucket in the object.
 *  · a caller cannot pass 'large' or 'small'. Cap cohorts are an equity concept
 *    (`capCohortOf` reads Finnhub's `profile2`, which returns nothing for a
 *    coin); leaving the door open would let a stray cap split the crypto
 *    evidence into rungs that can never fill. */
export function cryptoProbabilityFor(
  state: CryptoCalibrationState,
  side: 'long' | 'short',
  regime: string,
  absComposite: number,
  population: BucketPopulation = 'pooled',
  setup?: string | null,
): { p: number; provisional: boolean; nEff: number; belowEvidence: boolean } {
  return probabilityFor(state, side, regime, absComposite, 'unknown', population, setup)
}

/** One graded crypto outcome into the crypto blob.
 *
 * `updateCalibration` verbatim with ONE substitution: `capUsdM` is forced to
 * null, so the row books the cohortless key `${side}:${regime}:${band}` — the
 * only key scheme this blob will ever hold. The caller may hand over a whole
 * `Prediction` (B2 will), cap and all; a cap that somehow arrived on a coin is
 * not a reason to mint a `large:` key inside the crypto partition and split its
 * already-cold evidence in two.
 *
 * Everything else the equity path does still happens, INSIDE THIS STATE: the
 * sized/shadow sub-counts (`accrual`), the setup-family buckets, the
 * seed/live/shadow evidence counters. They are crypto's own copies of the same
 * mechanisms, which is what makes the partition a partition rather than an
 * amputation. */
export function updateCryptoCalibration(
  state: CryptoCalibrationState,
  pred: {
    side: string
    regime: string
    composite: number
    capUsdM?: number | null
    shadow?: boolean
    setup?: string | null
    provenance?: 'seed' | 'live' | 'shadow'
    accrual?: 'sized' | 'shadow'
    riskPct?: number
  },
  outcome: PredOutcome,
): CryptoCalibrationState {
  // `updateCalibration` mutates and returns the state it was handed, so the
  // brand survives the round-trip and the cast states a fact.
  return updateCalibration(state, { ...pred, capUsdM: null }, outcome) as CryptoCalibrationState
}

// ---- the grade ----

/** Outcome vs what price actually did, on the crypto basis: the SIDE-ADJUSTED
 * RAW return over fourteen crypto bars, with a stop close-through a permanent
 * miss. No benchmark — see `CRYPTO_CALIB_DEF_VERSION` for why there cannot be
 * one — so `excessPct` here IS the side-adjusted move and `spyPct` is a
 * structural 0.
 *
 * `PredOutcome` IS REUSED, AND `spyPct: 0` IS A RE-READ, NOT A LIE. The field
 * is named for the equity benchmark and is rendered as such on equity surfaces;
 * for a crypto row it means "nothing was subtracted", and 0 is the only honest
 * value for a subtraction that did not happen. Renaming the field would rewrite
 * every stored row in the ledger for a cosmetic gain. B2 owns what a crypto row
 * PRINTS; this owns what it means.
 *
 * ── THE ENTRY BAR: the first bar that OPENS ON OR AFTER THE DAY AFTER the
 * call, and this is the one line that differs from `gradePrediction` for a
 * reason that is neither the benchmark nor the clock.
 *
 * The equity rule ("the base is the entry SESSION's open") is honest because
 * the paper publishes pre-open: the bar being measured had not started when the
 * call was made. A crypto bar starts at 00:00 UTC and the engine publishes at
 * ~06:00 UTC (`daily-paper.yml`), so the honest fill is a price INSIDE the
 * publication day's bar — which a daily OHLC does not contain. Both candidate
 * proxies miss it in opposite directions: D's open is six hours BEFORE the
 * fill, D+1's open eighteen hours after it. The 00:00→06:00 move is not a
 * lookahead — the engine's inputs stop at D−1's close, so that move is unknown
 * to it either way — but it is not neutral either: for a momentum engine the
 * six-hour drift correlates with the side just picked, so basing at D's open
 * would hand every call a small optimistic credit. The entry bar is therefore
 * the first bar that OPENS STRICTLY AFTER the call's date: the return leg
 * forfeits the publication-day move rather than claiming move it cannot place,
 * and forfeiting is the conservative side of the trade.
 *
 * THE STOP DOES NOT SHARE THIS ENTRY. The reader is holding from ~06:00 on D,
 * so D's close is the first close under exposure — the stop walk below starts
 * at the publication day's own bar, not at the return leg's entry. The two
 * legs face opposite directions of conservatism on purpose: the return is what
 * the engine may claim, the stop is what the reader lived through.
 *
 * Written as `t >= dayEpoch + one day` rather than `t > dayEpoch` so the intent
 * survives the assumption: the two are identical for a series whose bars are
 * stamped 00:00 UTC (which the seam below guarantees, and Yahoo's crypto chart
 * gives — exchTz UTC, gmtoffset 0), and only the explicit form still means "the
 * day after" if a bar ever arrives with an intraday stamp. A gap in the tape
 * moves the entry to the next bar that exists, under either spelling.
 *
 * A consequence, stated so nobody rediscovers it: a call dated D matures on
 * D+15's bar (entry D+1, plus fourteen), and it needs D+15's bar to be
 * COMPLETE, so it grades on the run of D+16.
 *
 * ── COMPLETED BARS ONLY, and this function cannot check it. It has no `now` to
 * compare against; the cut happens once at the fetch seam (`cryptoCandlesVia`
 * below) so the grader, the indicators and the open-trace all read the same
 * series. Handing this raw Yahoo output on the day of the outcome bar would
 * grade against a partial bar — pinned in the tests, at the seam. */
export function gradeCryptoPrediction(
  pred: { date: string; side: 'long' | 'short'; priceAtPrediction: number; stop: number },
  candles: Candle[],
  horizon: CryptoHorizon = CRYPTO_GRADE_HORIZON,
): PredOutcome | null {
  const dayEpoch = Date.parse(pred.date) / 1000
  const entryIdx = candles.findIndex(c => c.t >= dayEpoch + DAY_SEC)
  if (entryIdx === -1 || entryIdx + horizon >= candles.length) return null

  const base = candles[entryIdx].o
  const rawPct = ((candles[entryIdx + horizon].c - base) / base) * 100

  // Close-based, exactly as the equity grader is and for the same reason: a
  // wick through the stop is survivable noise, and the level that counts is the
  // PUBLISHED stop, not a trail the books may have re-read since.
  //
  // The scan starts at the PUBLICATION DAY'S bar (see the entry-bar note
  // above): a close through the stop on the day the call went out is a stop
  // the reader took, and starting at D+1 would grade it a clean hit. On a
  // gapped tape the first bar at-or-after D is the entry bar itself, and the
  // scan degrades to the return leg's window.
  const stopFrom = candles.findIndex(c => c.t >= dayEpoch)
  let stopped = false
  for (let i = stopFrom; i <= entryIdx + horizon; i++) {
    if (pred.side === 'long' ? candles[i].c <= pred.stop : candles[i].c >= pred.stop) {
      stopped = true
      break
    }
  }
  const sign = pred.side === 'short' ? -1 : 1
  const excessPct = round1(sign * rawPct)
  return { excessPct, rawPct: round1(rawPct), spyPct: 0, stopped, hit: !stopped && excessPct >= CRYPTO_HIT_MIN_PCT }
}

// ---- the candle seam ----

/** Every bar that had CLOSED before the current UTC day began.
 *
 * Yahoo stamps a crypto daily bar 00:00 UTC and keeps updating it all day
 * (recon §3.1, live-probed: at 06:04 UTC the last bar is today's, six hours
 * old, with real volume — `parseYahooChart`'s zero-volume drop does not touch
 * it). Equities never needed this: at 06:35 UTC the last US bar is yesterday's
 * completed one, which is why "the bar under judgement IS the last bar" is
 * correct-by-construction everywhere in the engine and wrong for a coin.
 *
 * The cut is on the UTC DAY BOUNDARY, not on elapsed hours — a run at 06:00 and
 * a run at 23:59 see the identical series, so the engine's answer does not
 * depend on which of the three cron slots (05:35/06:35/07:35 UTC) fired. It is
 * idempotent, and it makes crypto's "today" mean yesterday's completed day: the
 * same relationship equities already have. */
export const completedCryptoBars = (candles: Candle[], nowSec: number): Candle[] => {
  // SECONDS, loudly. A millisecond clock here would put "today" three
  // millennia out, drop every bar, and fail SOFT to an empty tape — the one
  // failure mode worse than throwing, because nothing downstream would know.
  // A unit confusion is a programming error, and it gets an error.
  if (nowSec > 1e11) throw new Error(`completedCryptoBars: nowSec ${nowSec} looks like milliseconds`)
  const startOfTodayUtc = Math.floor(nowSec / DAY_SEC) * DAY_SEC
  return candles.filter(c => c.t < startOfTodayUtc)
}

/** THE CRYPTO CANDLE SEAM — a wrapper over the candle fetcher the engine
 * already has, not a new dep on `EngineDeps`.
 *
 * Least-invasive by design [documented choice, per the task]: `deps.candles`
 * already serves all three pairs through `isYahooSymbol` → `cachedCandles` →
 * `fetchYahooChart`, so a new `deps.cryptoCandles` field would add nothing but
 * a required property on every EngineDeps literal in the tests and a second
 * cache path. B2 builds its crypto fetcher as
 * `cryptoCandlesVia(deps.candles, nowSec)` and hands THAT to the lane; the
 * equity path is not touched, and one wrapper is the single door every crypto
 * consumer comes through.
 *
 * IT REFUSES A NON-CRYPTO SYMBOL (null, and it does not even fetch). The cut
 * above deletes any bar stamped today — for an equity series read after the US
 * close that bar is COMPLETE, and dropping it would silently rewrite what an
 * equity indicator sees. A crypto rule may only ever be applied to a crypto
 * symbol; asking this for SPY is a programming error, and the safe answer to a
 * programming error inside a daily engine run is "no data" (fail-soft, the way
 * every other dep in this engine fails), never "quietly different data". */
export const cryptoCandlesVia =
  (fetchCandles: (sym: string) => Promise<Candle[] | null>, nowSec: number) =>
  async (sym: string): Promise<Candle[] | null> => {
    if (!isCryptoSymbol(sym)) return null
    const candles = await fetchCandles(sym)
    return candles ? completedCryptoBars(candles, nowSec) : null
  }

/** The three pairs' completed series in one pass. Fail-soft per symbol: a dead
 * SOL fetch is a null in the map, never a thrown run — `SOL-USD` in particular
 * has no Stooq fallback (`stooq.ts` maps BTC and ETH only), so it is the pair
 * most likely to be missing and the lane must survive that. */
export async function cryptoCandleMap(
  fetchCandles: (sym: string) => Promise<Candle[] | null>,
  nowSec: number,
  syms: readonly string[] = CRYPTO_UNIVERSE,
): Promise<Map<string, Candle[] | null>> {
  const cryptoCandles = cryptoCandlesVia(fetchCandles, nowSec)
  const pairs = await Promise.all(syms.map(async sym => [sym, await cryptoCandles(sym).catch(() => null)] as const))
  return new Map(pairs)
}

// ---- the indicator scaling table ----

/** How a window was arrived at, because "×7/5" is only one of four honest
 * answers and the difference between them is the whole point of reading each
 * indicator's semantics instead of multiplying a list of numbers.
 *
 *  · `scaled`   — a wall-clock lookback. ×7/5 preserves the span it was
 *                 written to measure. The default, and the ratified rule.
 *  · `fixed`    — scaling it would be WRONG. The window is not a span, or the
 *                 constants that read it were calibrated against this exact
 *                 period. `crypto === equity`, and `why` says which.
 *  · `calendar` — the window is an implicit CALENDAR span (a year), and the
 *                 calendar answers it directly. ×7/5 is 50 weeks and quietly
 *                 loses the exchange holidays: 350 ≠ 365.
 *  · `horizon`  — the window IS the holding period, so it is pinned to
 *                 `CRYPTO_GRADE_HORIZON` and moves if the horizon ever does. */
export type LookbackRule = 'scaled' | 'fixed' | 'calendar' | 'horizon'

export interface LookbackScaling {
  /** The equity window as it is written in the code today. */
  readonly equity: number
  /** What the crypto lane must use instead, in bars. */
  readonly crypto: number
  readonly rule: LookbackRule
  /** Where it lives, so B2 knows what it is changing. */
  readonly site: string
  /** REQUIRED on every non-`scaled` row: an exception nobody can read is an
   * exception nobody will honour. */
  readonly why?: string
}

/** THE SCALING TABLE — every indicator lookback the crypto lane will read,
 * adjudicated one at a time against the indicator's own semantics.
 *
 * B1 SHIPS THE TABLE, NOT THE REWIRING. Nothing in the engine reads this yet;
 * B2 threads it into the factor-input seam. Recording it here, with the
 * exceptions argued and pinned, is what stops B2 from multiplying a list of
 * numbers by 1.4 and calling it a matched clock.
 *
 * The lanes' unnamed inline slices (dipLane's `prior4`, velocityLane's
 * `closes.slice(-(BREAKOUT_WINDOW + 1), -1)`) follow their named constant by
 * construction; only the constants are listed. */
export const CRYPTO_LOOKBACKS = {
  // ── the EMA stack (technicals.ts `emaStackOf`, indicators.ts `emaLast`).
  // A standard EMA seeded with the SMA of its first `period` values: a pure
  // wall-clock smoother, so a matched clock is exactly ×7/5. The stack's whole
  // claim is "every HORIZON agrees", and horizons are weeks, not bars.
  ema8: { equity: 8, crypto: cryptoLookback(8), rule: 'scaled', site: 'technicals.ts emaStackOf' },
  ema21: { equity: 21, crypto: cryptoLookback(21), rule: 'scaled', site: 'technicals.ts emaStackOf' },
  ema50: { equity: 50, crypto: cryptoLookback(50), rule: 'scaled', site: 'technicals.ts emaStackOf / dipLane EMA_PERIOD' },

  // ── the SMA levels (technicals.ts, setups.ts). "Above the 20-day" is a
  // fortnight's mean, "below the 50-day" a quarter's; both are spans.
  // sma200 → 280 needs 280 bars, which a 1y crypto fetch (365) carries.
  sma20: { equity: 20, crypto: cryptoLookback(20), rule: 'scaled', site: 'technicals.ts pctFrom20d / setups.ts indexHealthy' },
  sma50: { equity: 50, crypto: cryptoLookback(50), rule: 'scaled', site: 'technicals.ts pctFrom50d / setups.ts indexHealthy' },
  sma200: { equity: 200, crypto: cryptoLookback(200), rule: 'scaled', site: 'setups.ts isBasing / detectSetups' },
  smaSlopeLag5: { equity: 5, crypto: cryptoLookback(5), rule: 'scaled', site: 'setups.ts indexHealthy (20-SMA five bars ago)' },

  // ── volatility. ATR is a SCALE estimator and its consumers are all ratios of
  // it (atrMultFrom20d, the 1.5×ATR stop), so what must be preserved is the
  // span of tape the estimate is drawn from, not the bar count.
  atr14: { equity: 14, crypto: cryptoLookback(14), rule: 'scaled', site: 'indicators.ts atr / technicals.ts a14' },

  // ── RSI. THE EXCEPTION. See `why`.
  rsi14: {
    equity: 14,
    crypto: 14,
    rule: 'fixed',
    site: 'indicators.ts rsi / technicals.ts / setups.ts THRESHOLDS',
    why:
      'The period is not a lookback the reader reasons about — it is the smoothing constant the FIXED thresholds that read it were calibrated against (overextRsi 75, knifeRsi 30, the 72 in the stage cascade, the 35–55 pullback band). Lengthening it to 20 compresses the distribution so those same numbers describe a different event, and re-deriving four thresholds on a cohort with zero outcomes is not something this stage can measure. Scale the window OR keep the thresholds; doing one without the other is the only wrong answer. Revisit when the crypto cohort has its own record.',
  },

  // ── participation. The rvol baseline is "an ordinary month of volume" and
  // the thrust pair is "this week against the month before it" — both spans.
  rvolBaseline20: { equity: 20, crypto: cryptoLookback(20), rule: 'scaled', site: 'technicals.ts avgVol20 (vols.slice(-21,-1))' },
  thrustRecent5: { equity: 5, crypto: cryptoLookback(5), rule: 'scaled', site: 'technicals.ts THRUST_RECENT' },
  thrustBase20: { equity: 20, crypto: cryptoLookback(20), rule: 'scaled', site: 'technicals.ts THRUST_BASE' },
  avgDailyVolume30: { equity: 30, crypto: cryptoLookback(30), rule: 'scaled', site: 'rvol.ts avgDailyVolume(days)' },

  // ── structure. "Where in its 60-day range" and the setup windows are spans.
  rangeWindow60: { equity: 60, crypto: cryptoLookback(60), rule: 'scaled', site: 'technicals.ts rangePos' },
  baseSessions10: { equity: 10, crypto: cryptoLookback(10), rule: 'scaled', site: 'setups.ts THRESHOLDS.baseSessions' },
  basePrior30: { equity: 30, crypto: cryptoLookback(30), rule: 'scaled', site: 'setups.ts isBasing prior window' },
  knifeWindow20: { equity: 20, crypto: cryptoLookback(20), rule: 'scaled', site: 'setups.ts detectSetups (20-bar low)' },
  pullbackHigh20: { equity: 20, crypto: cryptoLookback(20), rule: 'scaled', site: 'setups.ts detectSetups (pullback drawdown)' },
  breakoutWatchWindow15: { equity: 15, crypto: cryptoLookback(15), rule: 'scaled', site: 'setups.ts detectSetups (breakoutWatch coil)' },

  // ── the lanes' windows (B2 decides whether the lanes admit crypto at all;
  // the numbers are recorded here so that decision has numbers).
  dipHighWindow20: { equity: 20, crypto: cryptoLookback(20), rule: 'scaled', site: 'dipLane.ts HIGH_WINDOW' },
  dipWindow10: { equity: 10, crypto: cryptoLookback(10), rule: 'scaled', site: 'dipLane.ts DIP_WINDOW' },
  dipVolumeLookback5: { equity: 5, crypto: cryptoLookback(5), rule: 'scaled', site: 'dipLane.ts VOLUME_LOOKBACK' },
  velocityBreakoutWindow20: { equity: 20, crypto: cryptoLookback(20), rule: 'scaled', site: 'velocityLane.ts BREAKOUT_WINDOW' },
  velocityRunWindow5: { equity: 5, crypto: cryptoLookback(5), rule: 'scaled', site: 'velocityLane.ts RUN_WINDOW' },

  // ── momentum. A CORE factor at weight 0.9 and one of the two mandatory legs
  // of the evidence contract, so it must return a real score for crypto or
  // every crypto row is permanently half-size (recon §2.4). The WINDOW is a
  // month either way; the DENOMINATOR is the basis question, and the absolute
  // basis answers it — B2 wires a 29-bar absolute return with no SPY leg.
  momentumRet21: { equity: 21, crypto: cryptoLookback(21), rule: 'scaled', site: 'factors.ts momentumFactor ret21' },

  // ── minimum-history guards. Derived, not independent: each one exists to
  // guarantee the longest window inside its function is computable, so it moves
  // with the windows it protects. Guards written as `window + k` follow their
  // window by construction (only the named constant is listed, the same rule
  // as the lanes' inline slices): momentum's `closes.length < 22` is ret
  // window + 1 and swingCapacity's `usable.length < window + 30` carries the
  // buffer row below.
  minHistory30: { equity: 30, crypto: cryptoLookback(30), rule: 'scaled', site: 'technicals.ts technicalStage guard' },
  setupsMinHistory25: { equity: 25, crypto: cryptoLookback(25), rule: 'scaled', site: 'setups.ts detectSetups guard' },
  momentumGuardWindow21: { equity: 21, crypto: cryptoLookback(21), rule: 'scaled', site: 'factors.ts momentumFactor guard (closes.length < ret window + 1)' },
  swingCapacityGuardBuffer30: { equity: 30, crypto: cryptoLookback(30), rule: 'scaled', site: 'indicators.ts swingCapacity guard (usable.length < window + buffer)' },

  // ── the open-trace clock. Not an indicator, but the one other place that
  // walks an entry bar and a horizon over a tape — and it currently holds the
  // equity answers to BOTH questions this module re-answers: GRADE_HORIZON 10
  // and an entry of `t >= dayEpoch` (the publication day). Fed a crypto row
  // unchanged, the trace and the grade would disagree about the entry bar AND
  // the maturity date in front of a reader. B2 either hands it the crypto
  // clock or keeps crypto rows out of it — a decision, not a discovery.
  openTraceGradeHorizon10: {
    equity: 10,
    crypto: CRYPTO_GRADE_HORIZON,
    rule: 'horizon',
    site: 'openTrace.ts GRADE_HORIZON / entry findIndex / gradesInSessions',
    why:
      'The window IS the holding period (swingCapacityWindow10\'s claim, one layer up), so it is pinned to CRYPTO_GRADE_HORIZON. Its entry rule must match gradeCryptoPrediction — return leg based at the first bar OPENING after the call, stop exposure from the publication bar — and `gradesInSessions` counts crypto BARS, which are calendar days, not sessions.',
  },

  // ── capacity. TWO windows, and NEITHER is a plain ×7/5.
  swingCapacityWindow10: {
    equity: 10,
    crypto: CRYPTO_GRADE_HORIZON,
    rule: 'horizon',
    site: 'indicators.ts swingCapacity(window)',
    why:
      'This window is not a lookback at all — it is the HOLDING PERIOD. Capacity asks "has this name demonstrably been able to travel far enough in the time I will hold it", and it feeds the expected-move floor and the target. So it is pinned to CRYPTO_GRADE_HORIZON and must move with the horizon, not with the bar ratio. That ×7/5 of 10 is also 14 is a coincidence worth naming, because it is exactly the kind of coincidence that hides a wrong dependency.',
  },
  swingCapacityLookback250: {
    equity: 250,
    crypto: 365,
    rule: 'calendar',
    site: 'indicators.ts swingCapacity(lookback)',
    why:
      '250 sessions is an implicit trading YEAR (252 minus a rounding), and a year of a 24/7 tape is 365 bars, not the ratio\'s 350. The 15-bar gap is precisely the exchange holidays the ×7/5 rule cannot see, and it is the difference between "a year of history" and "fifty weeks of it". An implicit calendar span is re-expressed in the calendar; it is never multiplied.',
  },
  seasonalityYear252: {
    equity: 252,
    crypto: 365,
    rule: 'calendar',
    site: 'market-data.mts years = candles.length / 252',
    why:
      'The same trap one layer up, and it is already live: dividing a crypto series by 252 reports a 5-year history as 7.2 years, which is what lets the seasonality library call a tendency "reliable" on tape it never had. The divisor is a calendar year (365) for a 7-day series. Note that crypto also fills SEVEN day-of-week buckets where an equity fills five — a separate consequence for seasonality, recorded for B2.',
  },
} satisfies Record<string, LookbackScaling>

/** NOT CLOCKS — the constants that sit right beside a scaled window and must
 * NOT be scaled with it. Recorded as a list rather than left to inference,
 * because "multiply every number in the lane by 1.4" is the obvious wrong move
 * and this is the artefact that answers it. A percentage, a ratio and a sample
 * count have no calendar in them; a threshold counted INSIDE a scaled window
 * has one, but it is a re-derivation and not a multiplication. */
export const CRYPTO_NOT_A_CLOCK: { name: string; value: number; site: string; why: string }[] = [
  {
    name: 'upDaysMin3',
    value: 3,
    site: 'velocityLane.ts UP_DAYS_MIN',
    why: 'A COUNT inside a window that does scale (RUN_WINDOW 5 → 7), so it is the one entry here that is not simply invariant: preserving the fraction gives 4 of 7 (0.571) against today\'s 3 of 5 (0.600), and which of those the confirmation door means is a judgement B2 must make with the number in front of it, not a multiplication.',
  },
  {
    name: 'stopMult 1.5×ATR',
    value: 1.5,
    site: 'composite.ts levelsFor (stopMult = smallCap ? 2 : 1.5)',
    why: 'A MULTIPLE of an ATR that is already on the crypto clock once atr14 scales to 20 — and the single highest-leverage dimensionless ratio in the lane, because it sets the very close-through rate gradeCryptoPrediction walks. One cohort consequence, stated so B2 chooses it rather than inherits it: `smallCap` reads capUsdM, which is null for a coin, so crypto lands on the 1.5 arm by default.',
  },
  {
    name: 'volumeConfirmed 1.3×',
    value: 1.3,
    site: 'technicals.ts volumeConfirmed',
    why: 'A RATIO of today\'s volume to its baseline. Both sides of the ratio are already on the crypto clock once the baseline window scales, so the threshold itself is dimensionless and scaling it would change what "loud" means for no reason at all.',
  },
  {
    name: 'reclaimRvol 1.5 / breakoutRvol 2 / knifeVolX 1.5',
    value: 1.5,
    site: 'setups.ts THRESHOLDS',
    why: 'The same dimensionless ratios one layer down. They compare a bar to a baseline that is itself scaled, so the comparison is already on the crypto clock and the multiplier is not a span.',
  },
  {
    name: 'overextRsi 75 / knifeRsi 30',
    value: 75,
    site: 'setups.ts THRESHOLDS',
    why: 'Thresholds ON an oscillator whose period is deliberately unscaled (see CRYPTO_LOOKBACKS.rsi14). They are bounded readings between 0 and 100 with no time in them; scaling them would be scaling a percentile.',
  },
  {
    name: 'declineOffHighPct 25 / pullbackMinPct 3 / pullbackMaxPct 8',
    value: 25,
    site: 'setups.ts THRESHOLDS',
    why: 'PERCENTAGE MOVES, not spans. What they do need eventually is a volatility re-derivation — a 3-8% pullback in BTC is a different event from one in a large-cap equity — but that is a calibration question for the cohort\'s own record and it is emphatically not a bar-count conversion.',
  },
  {
    name: 'MIN_BUCKET_N 15 / MIN_GRADE_A_N 30 / SETUP_BLEND_MIN_N 30 / SHRINK_K 25',
    value: 30,
    site: 'calibration.ts',
    why: 'EVIDENCE counts, not clocks: they count OUTCOMES, and one crypto outcome is one outcome however many bars it took to mature. Scaling them would let a crypto band claim an A on 21 observations because its bars are shorter, which is the precise inversion of what an evidence floor is for.',
  },
  {
    name: 'breadthAbove50 minSeries 10',
    value: 10,
    site: 'setups.ts breadthAbove50',
    why: 'A sample-size floor over SERIES (how many names must be in the read), not over bars. There is no calendar in it, and the crypto universe is three pairs — which is why the crypto tape is read off BTC alone rather than a breadth vote (B2).',
  },
  {
    name: 'CRYPTO_HIT_MIN_PCT 1',
    value: 1,
    site: 'cryptoCalibration.ts',
    why: 'The outcome bar itself: one percentage point of side-adjusted move. It is the definition a hit is measured against, and it moves only under a CRYPTO_CALIB_DEF_VERSION bump — never with a window.',
  },
]
