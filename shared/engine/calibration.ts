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
 * eligibility, context factors capped at CONTEXT_MAX_PTS (composite.ts).
 * v3 (stage 2): the owner-ordered weight vector with a real re-base migration,
 * the EMA stack in the technical read, and — the reason the stamp matters most —
 * probability stopped being a four-step staircase and became a monotone,
 * shrunk curve read at the call's own |composite| (probabilityFor below).
 * A v2 row and a v3 row in the same ledger were scored by different models and
 * the Brier trail mixes them; `modelVersion` is the ONLY thing that separates
 * the two epochs, which is the whole reason this bump exists. It gates nothing
 * at load time — CALIB_DEF_VERSION is untouched, so no live bucket is discarded
 * (what counts as a hit has not changed, only what we predict about it). */
export const ENGINE_MODEL_VERSION = 3

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
  /** Which committed seed these buckets descend from. `defVersion` says what a
   * hit IS; this says WHICH WALK measured it — the one thing that separates a
   * regenerated seed from the one it replaces when the outcome definition did
   * not move (a deeper window, a wider universe, more lanes). loadState installs
   * a seed over the stored blob only when the seed's generation is higher, so a
   * better artefact can land exactly once and never twice.
   * ABSENT MEANS 1 (migrateCalibration backfills): every blob written before
   * this field existed descends from the generation-1 seed of record. */
  seedGeneration?: number
  /** THE ANCHOR GRADES ARE MEASURED AGAINST (spec §9, ratified 2026-08-13): the
   * UNCONDITIONAL gate-clearing hit rate, swept over the same window, universe and
   * model as the walk that emitted these buckets.
   *
   * It exists because the two questions came apart. `buckets` describe the
   * population the engine PUBLISHES, which is selected — a board-driven deep seed
   * pools to ~0.42 where the unconditional sweep reads ~0.37 — and grading against
   * the pool therefore asks "is a high-composite board row better than a low one?".
   * Measured over 2024-08 → 2026-08 the honest answer is "barely" (the 2026-08-13
   * walk: long:green reads 48.3% at 55-70 and 41.6% at 70+), so every one of 531
   * acceptance rows graded C. The reader's question is the other one — "how much
   * better is this pick than an ordinary candidate?" — and this field is what makes
   * a grade answer it.
   *
   * Probability is NOT anchored here: `probabilityFor` keeps reading the
   * board-population buckets, because that is the population a published row is
   * actually drawn from and pricing it against any other would be a lie about the
   * row in front of the reader. Only grade thresholds and the null floor move
   * (`gradeBaseRate` below).
   *
   * ABSENT MEANS "no sweep measured one" and falls back to the pooled base —
   * byte-for-byte the behaviour that shipped before this field existed. The
   * committed generation-1 seed carries none, so installing this code moves
   * nothing live; behaviour changes only when a generation-2+ seed installs.
   * Deliberately NOT backfilled by `migrateCalibration`: defaulting it to the pool
   * would write the same number under a name that later readers could no longer
   * tell from a measured one. Operator-supplied values are equally forbidden — the
   * emitter computes it from the same candles or the walk refuses to serialise. */
  referenceBase?: number
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
  // absence is not "unknown", it is generation 1 — the committed seed of record
  // when the field did not exist yet. Backfilling here is what lets the install
  // rule in loadState compare two numbers instead of three states.
  state.seedGeneration ??= 1
  // `referenceBase` is deliberately NOT backfilled here — see its doc comment.
  // Absence is a measurement that was never taken, and `gradeBaseRate` answers it
  // with the pooled base at read time rather than writing one into the blob.
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

/** The B gate, and the definition of `provisional`: below this a read has not
 * earned the right to be sized at the full rung. */
const MIN_BUCKET_N = 15
/** The A gate. Twice MIN_BUCKET_N, deliberately: an A is the engine saying "this
 * beats my own base rate by ten points AND I have watched it happen enough times
 * to believe it", and one is worth nothing without the other. */
const MIN_GRADE_A_N = 30
const laplace = (b: BucketStat) => (b.hits + 2) / (b.n + 4)

/** Band midpoints — the READ path's x-axis. The write path's edges (bandFor, and
 * the bucket keys they produce) are FROZEN; what changed is that a band's
 * evidence is now treated as sitting at the CENTRE of the band it was booked
 * into, and everything between two midpoints is interpolated. */
const BAND_MID: Record<Band, number> = { '25-40': 32.5, '40-55': 47.5, '55-70': 62.5, '70+': 77.5 }
/** Sorted by midpoint STRUCTURALLY, not by the literal order above. Everything
 * downstream — PAVA's notion of "adjacent", the running max, the piecewise read —
 * is only correct on an x-ordered list, and that correctness must not rest on how
 * someone happens to type the object literal. */
const BANDS = (Object.keys(BAND_MID) as Band[]).sort((a, b) => BAND_MID[a] - BAND_MID[b])

/** Hierarchical shrinkage strength: a band speaks for itself with weight
 * n/(n + SHRINK_K), so at 25 observations a band's own evidence and its parent
 * rung's evidence carry equal weight. NOT MIN_BUCKET_N (15) — that is the grade
 * gate, a different question with a different answer; conflating them would
 * quietly tie how much we believe a number to how much we are willing to bet. */
const SHRINK_K = 25

/** One point on a rung's curve: where it sits (a band midpoint), what it reads,
 * and how many ORIGINAL observations that band carries. */
export interface CurvePoint { mid: number; p: number; n: number }

/** Weighted PAVA — standard isotonic regression. Pools adjacent violators, then
 * ASSIGNS each ORIGINAL band its block's pooled value: interpolating over
 * pooled-block midpoints would move the x-axis and fabricate conviction, so the
 * x-axis stays the original band midpoints. Returns the monotone fit per
 * original band, alongside each band's ORIGINAL n (never the block's — a pooled
 * block of 178 observations does not make an 8-observation band trustworthy). */
export function isotonicFit(bands: { band: Band; p: number; n: number }[]): CurvePoint[] {
  const blocks = bands.map(b => ({ p: b.p, n: b.n, members: [b] }))
  let i = 0
  while (i < blocks.length - 1) {
    if (blocks[i].p <= blocks[i + 1].p + 1e-12) { i++; continue }
    const a = blocks[i], b = blocks[i + 1]
    const n = a.n + b.n
    blocks.splice(i, 2, { p: (a.p * a.n + b.p * b.n) / n, n, members: [...a.members, ...b.members] })
    if (i > 0) i--
  }
  // every original band keeps its own x (midpoint) and its own n; only p is fitted
  return blocks.flatMap(bl => bl.members.map(m => ({ mid: BAND_MID[m.band], p: bl.p, n: m.n })))
}

/** ONE RUNG's curve: the per-band Laplace estimates for a (side, cohort, regime)
 * slice, made monotone, then shrunk toward the PARENT rung's read at the same
 * conviction.
 *
 * A band with NO evidence contributes NO point. An empty bucket is not a 0.5
 * observation, and letting the Laplace prior stand in for one would put a
 * fabricated reading on the curve and — worse — make 62.5 an interior point, so
 * a 70+ call would interpolate toward an invented number instead of inheriting
 * the best-evidenced band below it.
 *
 * `parentAt(mid)` IS the hierarchy, and it is the whole reason the ladder below
 * is a ladder: rung 1's target is rung 2's read at that midpoint, rung 2's is
 * rung 3's, and rung 4's is the engine base rate (the default here, for a caller
 * that names no parent). It replaces shrinking toward the rung's OWN pooled rate
 * — which was circular where it mattered most: a rung holding one populated band
 * pooled to exactly that band, so the shrinkage was the identity and a single
 * lucky observation read its raw 0.60 and graded a sized C. A parent must be a
 * DIFFERENT, broader population, and the rung below is precisely that.
 *
 * Note what the target is NOT: the rung below read at the CALL's conviction. Each
 * band shrinks toward the parent at its OWN midpoint, so the curve stays a
 * function of x alone, and a band is only ever compared with the same conviction
 * measured on more data.
 *
 * The weight is the band's ORIGINAL n over n + SHRINK_K — the PAVA block's n is
 * never used, so a pooled block of 178 cannot make an 8-observation band speak
 * with 178 observations' confidence.
 *
 * The final running-max is a guard, and it earns its place on the committed
 * seed. Shrinkage is applied per band with a weight that RISES with n, while n
 * FALLS as conviction rises — so the thin top of a curve is pulled harder toward
 * the parent than the thick band under it, and can land below it. The seed's
 * long/green rung does exactly this: the fit is 0.3920 / 0.4400 / 0.5000, and
 * shrinkage turns it into 0.3929 / 0.4310 / 0.4206 — a curve that says a 62
 * composite is worse than a 47 one, which is the very pathology stage 2 exists
 * to end. PAVA guarantees monotonicity of the FIT; this restores it after the
 * pooling, at the cost of flattening the thin top onto its neighbour (whose nEff
 * still says how thin it is). */
export function curveFor(
  state: CalibrationState,
  side: 'long' | 'short',
  cohort: CapCohort | 'any',
  regime: string | null,
  // POOLED, not `gradeBaseRate` [§9]: this is the bottom of the SHRINKAGE
  // hierarchy, and a thin band is shrunk toward the broader population it belongs
  // to. That population is the board's own — the buckets right here — so pulling
  // it toward a reference measured over a DIFFERENT (unconditional) population
  // would bias every published probability toward names the board never publishes.
  parentAt: (mid: number) => number = () => baseHitRate(state).rate,
): CurvePoint[] {
  const seen = BANDS.map(band => ({ band, stat: poolBuckets(state, side, band, cohort, regime) })).filter(b => b.stat.n > 0)
  if (!seen.length) return []
  const fitted = isotonicFit(seen.map(b => ({ band: b.band, p: laplace(b.stat), n: b.stat.n })))
  let floor = -Infinity
  return fitted.map(pt => {
    const w = pt.n / (pt.n + SHRINK_K)
    floor = Math.max(floor, w * pt.p + (1 - w) * parentAt(pt.mid))
    return { mid: pt.mid, p: floor, n: pt.n }
  })
}

/** Read a rung's curve at a conviction: piecewise-linear between the midpoints,
 * FLAT beyond the outer ones — nothing is extrapolated off either end. The flat
 * extension is applied to the SHRUNK points, which is why a 70+ call reads
 * exactly the final 55-70 value and never the raw eight-observation number that
 * band would claim on its own (spec §4.2's floor: high conviction may read below
 * base if the whole context does — that is a shadow, and it is intended — but it
 * may never read below the band beneath it).
 *
 * nEff is the MINIMUM of the two straddling bands' ORIGINAL n (the single band's
 * n at or beyond the edges). Pooling can never inflate it: a read that leans on
 * an 8-observation band is an 8-observation read, whatever the band next door
 * has seen.
 *
 * `belowEvidence` marks the DOWNWARD extension specifically. The two extensions
 * are not the same act: extending upward inherits the best-evidenced band under
 * the call (§4.2's floor — a 70+ call reads the 55-70 number, which is a claim
 * the evidence supports), while extending downward hands a high-conviction
 * number to a call the engine has never watched at that conviction. The read is
 * still the best available answer, so p is unchanged; what changes is what may
 * be CLAIMED from it — see gradeFor. */
function readCurve(pts: CurvePoint[], x: number): { p: number; nEff: number; belowEvidence: boolean } {
  const first = pts[0], last = pts[pts.length - 1]
  if (x <= first.mid) return { p: first.p, nEff: first.n, belowEvidence: x < first.mid }
  if (x >= last.mid) return { p: last.p, nEff: last.n, belowEvidence: false }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    if (x <= b.mid) {
      const t = (x - a.mid) / (b.mid - a.mid)
      return { p: a.p + t * (b.p - a.p), nEff: Math.min(a.n, b.n), belowEvidence: false }
    }
  }
  return { p: last.p, nEff: last.n, belowEvidence: false }
}

/** Calibrated probability: a CONTINUOUS, monotone read at the call's own
 * |composite|, off the most specific rung that has any evidence at all.
 *
 * The ladder is unchanged in shape, most-specific first:
 *   1. this cohort, this regime      `${cohort}:${side}:${regime}:*`
 *   2. this cohort, pooled regimes   `${cohort}:${side}:*:*`
 *   3. all cohorts, this regime      (cohort-tagged + cohortless/seed) at `${regime}`
 *   4. all cohorts, pooled regimes   (everything for this side, incl. the seed)
 *   5. global base rate              (baseHitRate) when the side has nothing anywhere
 * Unknown-cap calls skip rungs 1–2 — they were never guessed into a cohort.
 *
 * What changed: a rung is now taken as soon as it holds ANY evidence, in any
 * band, instead of only once one BAND cleared MIN_BUCKET_N. The old promotion
 * test bought its confidence by silently answering from a different population
 * (all regimes pooled) and returning that as non-provisional. Under a curve
 * there is a better answer to thinness than moving the question: the rung's own
 * curve is built, the thin bands are shrunk toward the rung's parent rate, and
 * `nEff` reports — honestly, per read — how many observations actually straddle
 * this call. Grades then price that directly (gradeFor below).
 *
 * The ladder is also the SHRINKAGE hierarchy, not just a fallback order: rung r's
 * curve is shrunk toward rung r+1's read at the same conviction (curveFor above),
 * recursively, with the base rate at the bottom. Built lazily and memoised — only
 * the rungs a read actually needs are ever constructed — and a rung with no
 * evidence is not a parent, so the chain skips it and asks the next one down.
 *
 * Returns `{ p, provisional, nEff, belowEvidence }`. `provisional` is DISPLAY
 * ONLY (nEff < MIN_BUCKET_N); the grade reads nEff and belowEvidence itself. */
export function probabilityFor(
  state: CalibrationState,
  side: 'long' | 'short',
  regime: string,
  absComposite: number,
  cohort: CapCohortOrUnknown = 'unknown',
): { p: number; provisional: boolean; nEff: number; belowEvidence: boolean } {
  const rungs: { cohort: CapCohort | 'any'; regime: string | null }[] =
    cohort === 'unknown'
      ? [{ cohort: 'any', regime }, { cohort: 'any', regime: null }]
      : [{ cohort, regime }, { cohort, regime: null }, { cohort: 'any', regime }, { cohort: 'any', regime: null }]

  const curves: CurvePoint[][] = []
  const curveAtRung = (i: number): CurvePoint[] => {
    if (i >= rungs.length) return []
    // an empty array is truthy, so a rung that HAS been built and holds nothing
    // is never rebuilt: the memo is on the slot, not on the contents
    if (!curves[i]) curves[i] = curveFor(state, side, rungs[i].cohort, rungs[i].regime, mid => parentRead(i + 1, mid))
    return curves[i]
  }
  /** The shrinkage target for the rung ABOVE i: the first rung from i down that
   * has any evidence, read at this midpoint — and the engine's base rate if none
   * of them do. Only ever recurses downward, so it terminates. */
  const parentRead = (i: number, mid: number): number => {
    for (let j = i; j < rungs.length; j++) {
      const curve = curveAtRung(j)
      if (curve.length) return readCurve(curve, mid).p
    }
    return baseHitRate(state).rate // POOLED [§9] — the shrinkage floor, exactly as in curveFor above
  }

  for (let i = 0; i < rungs.length; i++) {
    const curve = curveAtRung(i)
    if (!curve.length) continue
    const { p, nEff, belowEvidence } = readCurve(curve, absComposite)
    return { p, provisional: nEff < MIN_BUCKET_N, nEff, belowEvidence }
  }

  // rung 5: nothing for this side anywhere → the engine's own base rate
  // (baseHitRate is a hoisted declaration below). Not a curve read at all, so
  // there is no evidence for it to sit below — a C at most either way.
  // POOLED [§9]: this IS the emitted probability, and a probability must describe
  // the population the row was drawn from. The reference answers a grading
  // question about ordinary candidates, not a pricing question about this one.
  return { p: baseHitRate(state).rate, provisional: true, nEff: 0, belowEvidence: false }
}

/** Pooled hit rate across every bucket — the engine's own base rate under the
 * CURRENT outcome definition. Grades measure edge over THIS, not over a coin
 * flip: with hits defined as ≥1pp excess the base rate sits well under 0.5,
 * and absolute 0.5-anchored thresholds would silently retire the board.
 *
 * The `n ≥ 50 else a hard 0.5` cliff is deliberately unchanged, and it has a
 * consequence worth stating out loud: on a COLD store the base is 0.5, so grade
 * A needs p ≥ 0.60 from a bucket that cannot possibly carry 30 observations yet.
 * A cold engine therefore hands out no As at all. That is intended — the first
 * fifty graded calls are the engine learning what its own base rate is, and it
 * has no business claiming an edge over a number it has not measured. */
export function baseHitRate(state: CalibrationState): { rate: number; n: number } {
  let n = 0
  let hits = 0
  for (const b of Object.values(state.buckets)) {
    n += b.n
    hits += b.hits
  }
  return { rate: n >= 50 ? laplace({ n, hits }) : 0.5, n }
}

/** THE GRADE ANCHOR — the one number every threshold in `gradeFor` is measured
 * from, and the ONLY place the pooled/reference choice is made.
 *
 * `state.referenceBase` when a seed swept one (spec §9: the unconditional
 * gate-clearing rate — "how much better is this pick than any ordinary
 * candidate?"), else the pooled base over the buckets themselves, which is what
 * the engine did before the field existed and what it still does for the
 * committed generation-1 seed and every legacy blob.
 *
 * It is a separate function rather than a line inside `gradeFor` because
 * `gradeFor` takes a NUMBER: it is called from the board (engine.ts), from the
 * replay harness's counterfactual, and from tests that pass a bare rate, and
 * threading a whole CalibrationState through it would make the fallback
 * unreadable at three call sites instead of readable at one. Every caller that
 * asks a GRADE question calls this; every caller that asks a PROBABILITY
 * question keeps calling `baseHitRate` — see the call-site comments there.
 *
 * The fallback inherits `baseHitRate`'s flat 0.5 under fifty observations, and that
 * is NOT the same rule as the emitter's ≥500-row refusal on a swept reference
 * (replay-window.ts REFERENCE_MIN_N) — deliberately. This is the legacy cold-start
 * default: a store with almost no history has measured nothing, and 0.5 is the
 * deliberately unreachable anchor that hands out no As until it has (see
 * baseHitRate). The emitter's floor guards the opposite failure — a thin sweep
 * STORED as a yardstick, where absence would have been the safer answer. One
 * refuses to write a number, the other refuses to trust one it never wrote. */
export function gradeBaseRate(state: CalibrationState): number {
  return state.referenceBase ?? baseHitRate(state).rate
}

/** A/B/C = how far the read beats the GRADE ANCHOR, AND how much evidence is
 * actually under it. Both, or the grade drops a rung:
 *   A  ≥ base + 0.10  and  nEff ≥ 30
 *   B  ≥ base + 0.05  and  nEff ≥ 15
 *   C  ≥ base                            (no evidence floor — C carries half size at most)
 *   null below base — no edge over the anchor; suppress, don't dress it up.
 *
 * `baseRate` is whatever the caller anchors to, and callers with a
 * CalibrationState in hand must get it from `gradeBaseRate` — the stored
 * `referenceBase` when a seed swept one, the pooled base otherwise (spec §9).
 * The FLOOR moves with the thresholds, deliberately and as one: a row between the
 * reference and a higher pooled base is a real edge over ordinary odds, and
 * suppressing it while grading its neighbours off the reference would be two
 * different questions answered in one row.
 *
 * `belowEvidence` (probabilityFor) caps the result at C: the read was handed
 * DOWN from the lowest band this rung has ever graded, so the engine has watched
 * nothing at or below this conviction and an A or a B would be a claim about
 * evidence that does not exist. A CAP, not a floor — a below-base read is still
 * suppressed. Deliberately the last thing checked, so the reason a call is a C
 * is always "one of p / nEff / evidence-at-this-conviction was short".
 *
 * The nEff test on B is the change that matters. The old B rung tested neither
 * provisionality nor capacity, so the seed's 55-70 short bucket — EIGHT
 * observations reading a flat 0.5 — graded B and carried full size (spec §2.4).
 * Eight observations may now say C and no more, whatever p looks like.
 *
 * `capacityPct` has left the signature. It was a hard condition on A, which put
 * a sizing question ("does this name move enough to be worth the spread?") inside
 * a confidence question ("does this bucket beat our base rate, and do we have
 * enough of it?"). Capacity still drives expected move, targets and the
 * eligibility floor in composite.ts, where it belongs. [R6]
 *
 * A is unreachable on a cold store, by construction — see baseHitRate. */
export function gradeFor(p: number, nEff: number, baseRate = 0.5, belowEvidence = false): 'A' | 'B' | 'C' | null {
  if (p < baseRate) return null
  if (belowEvidence) return 'C'
  if (p >= baseRate + 0.10 && nEff >= MIN_GRADE_A_N) return 'A'
  if (p >= baseRate + 0.05 && nEff >= MIN_BUCKET_N) return 'B'
  return 'C'
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
  /** Which committed seed this vector's IC descends from — the same channel as
   * CalibrationState.seedGeneration, tracked separately because the two blobs
   * are stored separately and a load can be interrupted between the writes.
   * They still move together: one walk emits both, and installing one epoch's
   * buckets beside another's factor evidence would grade tomorrow's calls with
   * a yardstick that never measured them. ABSENT MEANS 1 (migrateWeights). */
  seedGeneration?: number
}

const FACTOR_NAMES = Object.keys(DEFAULT_WEIGHTS) as FactorName[]

const zeroIc = (): IcStat => ({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })

export function initWeights(base: Record<FactorName, number> = DEFAULT_WEIGHTS): WeightsState {
  return {
    base: { ...base },
    current: { ...base },
    ic: Object.fromEntries(Object.keys(base).map(f => [f, zeroIc()])) as Record<FactorName, IcStat>,
    gradedSinceNudge: 0,
    history: [],
  }
}

/** Forward-migrate a stored/seeded weights snapshot that predates a newly added
 * factor: backfill any missing key into base/current (from defaults) and ic
 * (zeroed) so an old blob never silently zeroes a new factor's weight. Mutates
 * and returns the same object; idempotent. */
export function migrateWeights(state: WeightsState, base: Record<FactorName, number> = DEFAULT_WEIGHTS): WeightsState {
  state.seedGeneration ??= 1 // absence is generation 1 — see CalibrationState.seedGeneration
  for (const name of Object.keys(base) as FactorName[]) {
    if (state.base[name] == null) state.base[name] = base[name]
    if (state.current[name] == null) state.current[name] = base[name]
    if (!state.ic[name]) state.ic[name] = zeroIc()
  }
  return state
}

/** THE RE-BASE — the one path allowed to overwrite a stored weights vector.
 *
 * `migrateWeights` above only ever fills nulls, deliberately, so that a learned
 * value is never clobbered by a default. The consequence is that re-ordering
 * DEFAULT_WEIGHTS moves the seed and the tests and NOTHING in production: the
 * stored blob is preferred over the seed on every load, and the only writer is
 * the nudge loop, so the live engine would keep scoring on the retired vector
 * forever while every test in the repo showed the new one.
 *
 * So: when the stored base differs from `base` on any key, base AND current are
 * set to the new vector and the IC state is ZEROED. The zeroing is the whole
 * argument, not housekeeping — every agreement and disagreement in `ic` was
 * measured on calls the OLD vector composed, so feeding it to the nudge loop
 * would let a retired model steer its replacement. (It also carries no real
 * signal: the live blob's technical IC is nAgree 778 / nDisagree 0, an
 * all-agree column that can compute no information coefficient at all.)
 *
 * Idempotent by construction — once the stored base IS the vector, this is a
 * no-op — so it is safe to run on every load, which is where it runs.
 *
 * `changes` records what was actually SCORING before (`current`) against the new
 * value, because that is the number that moved. `ic: 0` is not a measurement:
 * a re-base has no IC behind it, and the `evidence` string says what did it. */
export function rebaseWeights(
  state: WeightsState,
  base: Record<FactorName, number> = DEFAULT_WEIGHTS,
  dateISO: string = new Date().toISOString().slice(0, 10),
): WeightsState {
  const names = [...new Set([...Object.keys(base), ...Object.keys(state.base ?? {})])] as FactorName[]
  if (!names.some(n => state.base?.[n] !== base[n])) return state // fingerprint match → nothing to do
  const changes: Record<string, { from: number; to: number; ic: number }> = {}
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  for (const n of names) {
    const from = r3(state.current?.[n] ?? 0)
    const to = base[n] ?? 0 // absent from the new vector → the factor is retired, and drops out below
    if (from !== to) changes[n] = { from, to, ic: 0 }
  }
  state.base = { ...base }
  state.current = { ...base }
  state.ic = Object.fromEntries((Object.keys(base) as FactorName[]).map(n => [n, zeroIc()])) as Record<FactorName, IcStat>
  state.gradedSinceNudge = 0 // the cadence counts evidence, and the evidence just went
  // maybeNudgeWeights can assume `history` exists because it only ever pushes
  // after 15 graded predictions have already flowed through this state. This
  // runs on the FIRST load of a blob written by who-knows-which deploy, and the
  // live blob is not inspectable from a dev machine — so it asserts nothing.
  if (!Array.isArray(state.history)) state.history = []
  state.history.push({ date: dateISO, changes, evidence: 'stage-2 re-base to the owner-ordered vector' })
  if (state.history.length > 100) state.history = state.history.slice(-100)
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
//
// The continuous probability flows in here unchanged, and for a while the trail
// will MIX epochs: rows stamped modelVersion 2 carry a four-step read, rows
// stamped 3 carry the curve. That is accepted rather than papered over — the
// alternative is discarding a real Brier history to make a chart tidy — and the
// stamp on each Prediction is what makes the two separable after the fact.
// `brierImproving` gates risk-rung promotion (riskLadder.ts), so the crossover
// window is the one place to read the trail with the epoch in mind.
export function brierPoint(preds: { probability: number; outcome10?: PredOutcome }[]): number | null {
  const graded = preds.filter(p => p.outcome10)
  if (!graded.length) return null
  const sum = graded.reduce((s, p) => s + (p.probability - (p.outcome10!.hit ? 1 : 0)) ** 2, 0)
  return sum / graded.length
}
