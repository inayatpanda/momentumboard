import type { Candle } from '../types'
import { DEFAULT_WEIGHTS } from './composite'
import { capCohortOf, type CapCohort, type CapCohortOrUnknown } from './capClass'
import { clamp, round1, type FactorName, type PredOutcome, type Prediction } from './types'

// The learning loop, all deterministic: outcomes fill calibration buckets
// (score → realized win rate becomes tomorrow's probability) and factor IC
// stats (factors that kept being right earn weight — slowly, within bounds).

export type Band = '25-40' | '40-55' | '55-70' | '70+'

export interface BucketStat { n: number; hits: number }

/** A "hit" must clear this much excess vs SPY (pp over the horizon). Beating
 * the benchmark by an epsilon is noise, not edge — probabilities built on
 * epsilon-wins overstate what a reader can actually capture. */
export const HIT_EXCESS_MIN = 1

/** Bump when the OUTCOME DEFINITION changes (what counts as a hit). Buckets
 * counted under an older definition aren't comparable — loadState discards
 * them for the reseeded calibration when versions differ (it swaps in the
 * committed seed, which carries the current defVersion).
 *
 * NOT bumped for Phase 2's cap-class cohorts: cohorts change the bucket KEY
 * scheme (`${cohort}:${side}:${regime}:${band}` alongside the legacy
 * `${side}:${regime}:${band}`), never what a hit IS. The legacy cohortless
 * buckets (and the seed, which is cohortless) stay perfectly valid — they simply
 * become the pooled/combined rung of the fallback ladder below. Reseeding here
 * would throw away real graded evidence for no reason.
 *
 * v3: calibrated horizon 5→10 sessions (reader holds 1-2wk+); seed regenerated
 * at 10d 2026-07-16. A hit is now the 10-session excess-vs-SPY, not the 5-session
 * one, so every pre-v3 live bucket is discarded on load and rebuilt from the 10d
 * seed. Grading still stores outcome5/10/21 — the ledger keeps all three lenses;
 * only what CALIBRATION learns moved to 10d. */
export const CALIB_DEF_VERSION = 3
/** Bump when factor semantics, composition, or bucket interpretation changes.
 * Unlike CALIB_DEF_VERSION this does not redefine a hit; it identifies which
 * scoring model emitted a prediction.
 * v2: two-layer composite — core (price-derived) factors set direction and
 * eligibility, context factors capped at CONTEXT_MAX_PTS (composite.ts). */
export const ENGINE_MODEL_VERSION = 2

export interface CalibrationState {
  // Keys are EITHER cohort-tagged `${cohort}:${side}:${regime}:${band}` (cohort ∈
  // large|small, written once a graded call's cap is known) OR legacy cohortless
  // `${side}:${regime}:${band}` (the seed + everything graded before Phase 2, and
  // still where unknown-cap grades land). probabilityFor's ladder reads both.
  buckets: Record<string, BucketStat>
  // Per-setup-family outcome stats, keyed `${setup}:${side}:${band}` (regime
  // deliberately pooled — three setups × the full key space would starve every
  // cell). ACCRUAL ONLY for now: probabilityFor does not read these until the
  // families have real sample sizes — a specialist model must earn its
  // existence from logged evidence, exactly like a new factor.
  setupBuckets?: Record<string, BucketStat>
  brier: { date: string; mean: number; n: number }[]
  seeded?: boolean
  defVersion?: number
  modelVersion?: number
  evidence?: {
    seed: BucketStat
    live: BucketStat
    shadow: BucketStat
  }
}

const addEvidence = (a: BucketStat, hit: boolean) => ({ n: a.n + 1, hits: a.hits + (hit ? 1 : 0) })

/** Backfill provenance for legacy calibration blobs. Existing seeded state is
 * conservatively labelled seed/prior; all newly graded observations are then
 * tracked exactly as live or shadow. */
export function migrateCalibration(state: CalibrationState): CalibrationState {
  state.modelVersion ??= ENGINE_MODEL_VERSION
  state.setupBuckets ??= {}
  if (!state.evidence) {
    const total = Object.values(state.buckets).reduce((a, b) => ({ n: a.n + b.n, hits: a.hits + b.hits }), { n: 0, hits: 0 })
    state.evidence = {
      seed: state.seeded ? total : { n: 0, hits: 0 },
      live: state.seeded ? { n: 0, hits: 0 } : total,
      shadow: { n: 0, hits: 0 },
    }
  }
  return state
}

/** Sum the buckets matching a side+band: a specific cohort's tagged keys (4 parts)
 * when `cohort` is 'large'/'small', or EVERY cohort AND the legacy cohortless keys
 * (3 parts) when `cohort` is 'any' (the pooled rungs, which include the seed).
 * `regime: null` matches any regime. */
function poolBuckets(
  state: CalibrationState,
  side: 'long' | 'short',
  band: Band,
  cohort: CapCohort | 'any',
  regime: string | null,
): BucketStat {
  const acc: BucketStat = { n: 0, hits: 0 }
  for (const [key, b] of Object.entries(state.buckets)) {
    const parts = key.split(':')
    // legacy cohortless: [side, regime, band]; cohort-tagged: [cohort, side, regime, band]
    const [kCohort, kSide, kRegime, kBand] = parts.length === 4 ? parts : [null, parts[0], parts[1], parts[2]]
    if (kSide !== side || kBand !== band) continue
    if (regime !== null && kRegime !== regime) continue
    if (cohort !== 'any' && kCohort !== cohort) continue // a named cohort matches only its own tagged keys
    acc.n += b.n
    acc.hits += b.hits
  }
  return acc
}

export function bandFor(absComposite: number): Band {
  if (absComposite >= 70) return '70+'
  if (absComposite >= 55) return '55-70'
  if (absComposite >= 40) return '40-55'
  return '25-40'
}

const MIN_BUCKET_N = 15
const laplace = (b: BucketStat) => (b.hits + 2) / (b.n + 4)

/** Calibrated probability with a cohort-aware fallback ladder — the cap-class
 * analogue of the regime pooling this function has always done. Each rung is used
 * only once it clears MIN_BUCKET_N; a young cohort (all cohort buckets empty for
 * MONTHS after launch) simply falls through to the pooled/cohortless rungs, which
 * INCLUDE the backtest seed — so pooling is the normal path, not the exception.
 *
 * The ladder, most-specific first:
 *   1. this cohort, this regime      `${cohort}:${side}:${regime}:${band}`
 *   2. this cohort, pooled regimes   `${cohort}:${side}:*:${band}`
 *   3. all cohorts, this regime      (cohort-tagged + cohortless/seed) at `${regime}`
 *   4. all cohorts, pooled regimes   (everything for side+band, incl. seed) — terminal
 *   5. global base rate              (baseHitRate) when even rung 4 is empty
 * Rungs 1–3 return non-provisional once they clear MIN_BUCKET_N; rung 4 returns
 * whatever it has (provisional when thin); rung 5 anchors bands with no data at all
 * (e.g. 70+ before any 70+ call has ever been graded). Unknown-cap calls skip rungs
 * 1–2 (they were never guessed into a cohort) and start pooled at rung 3. */
export function probabilityFor(
  state: CalibrationState,
  side: 'long' | 'short',
  regime: string,
  absComposite: number,
  cohort: CapCohortOrUnknown = 'unknown',
): { p: number; n: number; provisional: boolean } {
  const band = bandFor(absComposite)

  if (cohort !== 'unknown') {
    const cohortRegime = poolBuckets(state, side, band, cohort, regime) // rung 1
    if (cohortRegime.n >= MIN_BUCKET_N) return { p: laplace(cohortRegime), n: cohortRegime.n, provisional: false }
    const cohortBand = poolBuckets(state, side, band, cohort, null) // rung 2
    if (cohortBand.n >= MIN_BUCKET_N) return { p: laplace(cohortBand), n: cohortBand.n, provisional: false }
  }

  const allRegime = poolBuckets(state, side, band, 'any', regime) // rung 3
  if (allRegime.n >= MIN_BUCKET_N) return { p: laplace(allRegime), n: allRegime.n, provisional: false }

  const allBand = poolBuckets(state, side, band, 'any', null) // rung 4
  if (allBand.n > 0) return { p: laplace(allBand), n: allBand.n, provisional: allBand.n < MIN_BUCKET_N }

  // rung 5: nothing for this side+band anywhere → the engine's own base rate
  // (baseHitRate is a hoisted declaration below)
  return { p: baseHitRate(state).rate, n: 0, provisional: true }
}

/** Pooled hit rate across every bucket — the engine's own base rate under the
 * CURRENT outcome definition. Grades measure edge over THIS, not over a coin
 * flip: with hits defined as ≥1pp excess the base rate sits well under 0.5,
 * and absolute 0.5-anchored thresholds would silently retire the board. */
export function baseHitRate(state: CalibrationState): { rate: number; n: number } {
  let n = 0
  let hits = 0
  for (const b of Object.values(state.buckets)) {
    n += b.n
    hits += b.hits
  }
  return { rate: n >= 50 ? laplace({ n, hits }) : 0.5, n }
}

/** A/B/C = the bucket beats the engine's base rate by ≥12pp / ≥5pp / at all.
 * With the legacy epsilon-hit definition (base ≈ 0.5) these reduce to the old
 * absolute thresholds 0.62 / 0.55 / 0.50. */
export function gradeFor(p: number, provisional: boolean, capacityPct: number, baseRate = 0.5): 'A' | 'B' | 'C' | null {
  if (p >= baseRate + 0.12 && !provisional && capacityPct >= 8) return 'A'
  if (p >= baseRate + 0.05) return 'B'
  if (p >= baseRate) return 'C'
  return null // no edge over the engine's own base rate — suppress, don't dress up
}

/** Outcome vs what price actually did: excess return over SPY, side-adjusted;
 * a stop CLOSE-through is a miss forever — recoveries after don't count. */
export function gradePrediction(
  pred: { date: string; side: 'long' | 'short'; priceAtPrediction: number; stop: number },
  candles: Candle[],
  spyCandles: Candle[],
  horizon: 5 | 10 | 21,
): PredOutcome | null {
  const dayEpoch = Date.parse(pred.date) / 1000
  const entryIdx = candles.findIndex(c => c.t >= dayEpoch)
  if (entryIdx === -1 || entryIdx + horizon >= candles.length) return null
  const spyIdx = spyCandles.findIndex(c => c.t >= dayEpoch)
  if (spyIdx === -1 || spyIdx + horizon >= spyCandles.length) return null

  // grading measures the capturable move from the first tradeable print: the
  // paper publishes pre-open, so the base is the entry session's OPEN, not the
  // prior close (priceAtPrediction, the level the card printed) — nobody could
  // fill at yesterday's close, so the untradeable overnight gap is not scored.
  const base = candles[entryIdx].o
  const rawPct = ((candles[entryIdx + horizon].c - base) / base) * 100
  const spyBase = spyCandles[spyIdx].o
  const spyPct = ((spyCandles[spyIdx + horizon].c - spyBase) / spyBase) * 100

  // GRADING is close-based: a wick through the stop is survivable noise (1.5×ATR
  // sits inside normal weekly range on these names — replay evidence 2026-07-02:
  // intraday-pierce grading scored directional judgment as coin-flip misses).
  // EXECUTION advice on prediction cards is unchanged: the stop remains a hard
  // intraday level for anyone actually in the trade.
  //
  // …and it is the PUBLISHED stop, deliberately, even for a velocity row whose
  // stop is a live trail (`Prediction.trail`). The books re-read that trail daily
  // and can exit above this level (openTrace.ts, paperBook.ts); grading does not,
  // because the hit definition is the calibration contract and moving it would be
  // a CALIB_DEF_VERSION change that silently re-scores every seed and every past
  // bucket. Grading measures the original thesis; the books trade the falsifier.
  let stopped = false
  for (let i = entryIdx; i <= entryIdx + horizon; i++) {
    if (pred.side === 'long' ? candles[i].c <= pred.stop : candles[i].c >= pred.stop) {
      stopped = true
      break
    }
  }
  const sign = pred.side === 'short' ? -1 : 1
  const excessPct = round1(sign * (rawPct - spyPct))
  return { excessPct, rawPct: round1(rawPct), spyPct: round1(spyPct), stopped, hit: !stopped && excessPct >= HIT_EXCESS_MIN }
}

export function updateCalibration(
  state: CalibrationState,
  pred: { side: string; regime: string; composite: number; capUsdM?: number | null; shadow?: boolean; setup?: string | null; provenance?: 'seed' | 'live' | 'shadow' },
  outcome: PredOutcome,
): CalibrationState {
  migrateCalibration(state)
  // A known cap books into its cohort bucket `${cohort}:${side}:${regime}:${band}`;
  // an unknown cap books into the LEGACY cohortless `${side}:${regime}:${band}` —
  // never guessed into a cohort. Unknown grades thus keep feeding the pooled rungs
  // (3–5) that every cohort falls back to, exactly like the seed does.
  const cohort = capCohortOf(pred.capUsdM)
  const band = bandFor(Math.abs(pred.composite))
  const tail = `${pred.side}:${pred.regime}:${band}`
  const key = cohort === 'unknown' ? tail : `${cohort}:${tail}`
  const b = state.buckets[key] ?? { n: 0, hits: 0 }
  state.buckets[key] = { n: b.n + 1, hits: b.hits + (outcome.hit ? 1 : 0) }
  // setup-family stats accrue in parallel (never read by probabilityFor yet —
  // see the CalibrationState comment). Calls without a setup stamp simply
  // don't book here; the main buckets above remain the source of truth.
  if (pred.setup) {
    const sk = `${pred.setup}:${pred.side}:${band}`
    const sb = state.setupBuckets![sk] ?? { n: 0, hits: 0 }
    state.setupBuckets![sk] = { n: sb.n + 1, hits: sb.hits + (outcome.hit ? 1 : 0) }
  }
  const source = pred.provenance ?? (pred.shadow ? 'shadow' : 'live')
  state.evidence![source] = addEvidence(state.evidence![source], outcome.hit)
  return state
}

// ---- factor weight learning ----

export interface IcStat { nAgree: number; sumAgree: number; nDisagree: number; sumDisagree: number }

export interface WeightsState {
  base: Record<FactorName, number>
  current: Record<FactorName, number>
  ic: Record<FactorName, IcStat>
  gradedSinceNudge: number
  history: { date: string; changes: Record<string, { from: number; to: number; ic: number }>; evidence: string }[]
}

const FACTOR_NAMES = Object.keys(DEFAULT_WEIGHTS) as FactorName[]

export function initWeights(base: Record<FactorName, number> = DEFAULT_WEIGHTS): WeightsState {
  return {
    base: { ...base },
    current: { ...base },
    ic: Object.fromEntries(FACTOR_NAMES.map(f => [f, { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }])) as Record<FactorName, IcStat>,
    gradedSinceNudge: 0,
    history: [],
  }
}

/** Forward-migrate a stored/seeded weights snapshot that predates a newly added
 * factor: backfill any missing key into base/current (from defaults) and ic
 * (zeroed) so an old blob never silently zeroes a new factor's weight. Mutates
 * and returns the same object; idempotent. */
export function migrateWeights(state: WeightsState, base: Record<FactorName, number> = DEFAULT_WEIGHTS): WeightsState {
  for (const name of Object.keys(base) as FactorName[]) {
    if (state.base[name] == null) state.base[name] = base[name]
    if (state.current[name] == null) state.current[name] = base[name]
    if (!state.ic[name]) state.ic[name] = { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }
  }
  return state
}

export function updateIcStats(state: WeightsState, pred: Prediction, outcome: PredOutcome): WeightsState {
  for (const name of FACTOR_NAMES) {
    const f = pred.factors[name]
    if (!f || f.score == null || f.score === 0) continue
    const agree = f.score > 0 === (pred.side === 'long')
    const st = state.ic[name] ?? { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }
    if (agree) {
      st.nAgree++
      st.sumAgree += outcome.excessPct
    } else {
      st.nDisagree++
      st.sumDisagree += outcome.excessPct
    }
    state.ic[name] = st
  }
  state.gradedSinceNudge++
  return state
}

const NUDGE_EVERY = 15 // graded predictions between weight adjustments
const MIN_IC_N = 20
const NUDGE_STEP = 0.15
const PRUNE_MIN_N = 200 // evidence needed before a factor may decay below the floor

/** Bounded, slow, evidenced: weights drift toward factors that kept being
 * right, never beyond [0.4×, 2×] of their base — no whipsawing, no runaway.
 * EXCEPT: once a factor has PRUNE_MIN_N graded observations, the 0.4× floor
 * lifts — a signal that has kept being wrong over real evidence is allowed to
 * decay all the way to zero. The floor protects young factors, not dead ones. */
export function maybeNudgeWeights(state: WeightsState, dateISO: string): WeightsState {
  if (state.gradedSinceNudge < NUDGE_EVERY) return state
  const changes: Record<string, { from: number; to: number; ic: number }> = {}
  for (const name of FACTOR_NAMES) {
    const st = state.ic[name]
    const icN = st ? st.nAgree + st.nDisagree : 0
    if (!st || icN < MIN_IC_N) continue
    const meanAgree = st.nAgree ? st.sumAgree / st.nAgree : 0
    const meanDisagree = st.nDisagree ? st.sumDisagree / st.nDisagree : 0
    const ic = clamp((meanAgree - meanDisagree) / 10, -1, 1)
    const cur = state.current[name]
    const floor = icN >= PRUNE_MIN_N ? 0 : 0.4 * state.base[name]
    const next = clamp(cur * (1 + NUDGE_STEP * ic), floor, 2 * state.base[name])
    if (Math.abs(next - cur) > 1e-9) {
      changes[name] = { from: Math.round(cur * 1000) / 1000, to: Math.round(next * 1000) / 1000, ic: Math.round(ic * 100) / 100 }
      state.current[name] = next
    }
  }
  state.history.push({ date: dateISO, changes, evidence: `${state.gradedSinceNudge} predictions graded since last nudge` })
  if (state.history.length > 100) state.history = state.history.slice(-100)
  state.gradedSinceNudge = 0
  return state
}

// The emitted probability is calibrated on the 10-session outcome (CALIB_DEF_VERSION
// v3), so Brier — realized vs predicted — must score against outcome10, or it would
// grade the probability against a horizon it never predicted.
export function brierPoint(preds: { probability: number; outcome10?: PredOutcome }[]): number | null {
  const graded = preds.filter(p => p.outcome10)
  if (!graded.length) return null
  const sum = graded.reduce((s, p) => s + (p.probability - (p.outcome10!.hit ? 1 : 0)) ** 2, 0)
  return sum / graded.length
}
