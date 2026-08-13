import type { Candle } from '../types'
import { DEFAULT_WEIGHTS, ZERO_IS_A_READING } from './composite'
import { capCohortOf, type CapCohort, type CapCohortOrUnknown } from './capClass'
import { clamp, round1, type FactorName, type PredOutcome, type Prediction } from './types'

// The learning loop, all deterministic: outcomes fill calibration buckets
// (score → realized win rate becomes tomorrow's probability) and factor IC
// stats (factors that kept being right earn weight — slowly, within bounds).

export type Band = '25-40' | '40-55' | '55-70' | '70+'

/** One bucket's evidence — and, since stage 3c, WHOSE evidence it is.
 *
 * `n`/`hits` are the pooled totals and are FROZEN in meaning: every legacy blob,
 * every committed seed and `poolBuckets`'s key parse are unchanged, and
 * `CALIB_DEF_VERSION` does not move (a hit still means what it meant).
 *
 * `shadowN`/`shadowHits` are the SUB-COUNT of those totals contributed by rows the
 * reader could never have been offered AT ANY GRADE — an earnings print inside the
 * horizon, an unroutable short, a lane stand-down (`Prediction.accrual`, stamped at
 * publication from the shadow's CAUSE). NOT every zero-size row: a grade-null
 * demotion or a below-base watch row accrues SIZED, because it is the band's own
 * record of what happened to it and sealing it stops a band ever earning its way
 * back over the anchor. They live inside the totals rather than beside them, so the
 * sized read is a subtraction (`n − shadowN`) and nothing downstream of `n`/`hits`
 * changed.
 *
 * ABSENT MEANS "THIS EVIDENCE WAS NEVER PARTITIONED" — not "no shadows here" —
 * and the sized read then falls back to the pooled one, byte for byte. That is
 * what makes the partition installable over the generation-1/2/3 seeds and every
 * stored blob without a migration: the same absent-means-legacy contract
 * `referenceBase` uses, and the reason `migrateCalibration` deliberately does NOT
 * backfill a zero here (a stored `shadowN: 0` would be a measurement claim, and
 * the generation-3 seed's own aggregate says 2,249 of its 6,608 rows were
 * shadow). Sub-counts are only ever written where they were actually observed. */
export interface BucketStat { n: number; hits: number; shadowN?: number; shadowHits?: number }

/** Which population a read asks about. 'pooled' is every graded row (what the
 * engine did before the partition, and what a SHADOW's own probability is still
 * priced against — a shadow is not reader money); 'sized' is every row the reader
 * COULD have been offered, whatever the grade then decided about it, which is what
 * a sized row's grade must be measured on. */
export type BucketPopulation = 'sized' | 'pooled'

/** The sized slice of one bucket: the totals minus the shadow sub-count, with
 * both clamps present because a stored blob is untrusted. Sub-counts can never
 * exceed their totals when this module wrote them (see `updateCalibration`), so
 * a blob where they do is corrupt — and the safe reading of corrupt evidence is
 * LESS evidence, never a negative sample or a hit count above it. */
const sizedSlice = (b: BucketStat): BucketStat => {
  const n = Math.max(0, b.n - (b.shadowN ?? 0))
  return { n, hits: Math.min(n, Math.max(0, b.hits - (b.shadowHits ?? 0))) }
}

/** One bucket as the requested population reads it. The pooled read returns the
 * bucket itself — identical arithmetic to the pre-partition tree. */
const statIn = (b: BucketStat, population: BucketPopulation): BucketStat => (population === 'sized' ? sizedSlice(b) : b)

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
  // cell). READ BY `probabilityFor` since stage 3c task 2, but only where the
  // family has EARNED it: a sized read, a caller that named the setup, a bucket
  // that can prove it is partitioned, and thirty sized outcomes in the call's own
  // band — then 0.3 of the price (see `blendSetup`). Anything short of all four
  // and these stay pure accrual, which is what every blob in existence does
  // today. A specialist model earns its existence from logged evidence, exactly
  // like a new factor.
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
  // `BucketStat.shadowN`/`shadowHits` are NOT backfilled for the same reason and
  // one stronger: a stored `shadowN: 0` would assert that every row in that bucket
  // was sized, and the generation-3 seed's own aggregate says 2,249 of its 6,608
  // rows were shadow. Absence means "never partitioned", the sized read falls back
  // to the pooled one, and the blob stays byte-identical until real partitioned
  // evidence accrues on top of it.
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
 * `regime: null` matches any regime.
 *
 * THE KEY PARSE IS UNTOUCHED BY THE PARTITION, deliberately: provenance lives in
 * the VALUE (`BucketStat.shadowN`), never in the key, because a fifth key part
 * would silently reclassify every cohort-tagged key as legacy here. Each bucket
 * is clamped to its population BEFORE it is summed, so one corrupt bucket can
 * never drag the accumulator negative. */
function poolBuckets(
  state: CalibrationState,
  side: 'long' | 'short',
  band: Band,
  cohort: CapCohort | 'any',
  regime: string | null,
  population: BucketPopulation = 'pooled',
): BucketStat {
  const acc: BucketStat = { n: 0, hits: 0 }
  for (const [key, b] of Object.entries(state.buckets)) {
    const parts = key.split(':')
    // legacy cohortless: [side, regime, band]; cohort-tagged: [cohort, side, regime, band]
    const [kCohort, kSide, kRegime, kBand] = parts.length === 4 ? parts : [null, parts[0], parts[1], parts[2]]
    if (kSide !== side || kBand !== band) continue
    if (regime !== null && kRegime !== regime) continue
    if (cohort !== 'any' && kCohort !== cohort) continue // a named cohort matches only its own tagged keys
    const stat = statIn(b, population)
    acc.n += stat.n
    acc.hits += stat.hits
  }
  return acc
}

/** One setup family's bucket, in the requested population — the read side of the
 * `setupBuckets` partition, and the panel's accessor. `probabilityFor`'s blend
 * (`blendSetup`, stage 3c task 2) does NOT come through here: it needs the raw
 * stored bucket to see whether sub-counts were ever written, and this function has
 * already collapsed that into a reading. Both read 'sized' for the same reason —
 * blending shadow-diluted family evidence into a sized grade would re-import
 * exactly the dilution this partition removes. A family with no bucket reads
 * `{ n: 0, hits: 0 }` — an absence, which every caller must gate on before it
 * treats the read as evidence. */
export function setupStat(
  state: CalibrationState,
  setup: string,
  side: 'long' | 'short',
  band: Band,
  population: BucketPopulation = 'pooled',
): BucketStat {
  const b = state.setupBuckets?.[`${setup}:${side}:${band}`]
  if (!b) return { n: 0, hits: 0 }
  // a READING, never the stored object: `statIn` hands back the bucket itself on
  // a pooled read (the accumulator loop above wants no allocation), and a caller
  // that mutated what it got would be mutating the blob.
  const stat = statIn(b, population)
  return { n: stat.n, hits: stat.hits }
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
/** THE EARN-INFLUENCE BAR for a setup family [spec §4.3(c)]: a family's own
 * record starts moving probability at thirty SIZED outcomes in the call's band.
 * Numerically MIN_GRADE_A_N, deliberately NOT the same constant — that one is a
 * grade's evidence floor ("may this read claim an A?") and this one is a
 * specialist model's admission test ("has this family earned a vote at all?").
 * Tying them would make one edit answer two questions. */
const SETUP_BLEND_MIN_N = 30
/** …and the vote is worth 0.3 of the price. Spec §4.3(c) verbatim:
 * `p = 0.7·p_ladder + 0.3·p_setup`. */
const SETUP_BLEND_W = 0.3
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
  // Resolved inside rather than defaulted in the signature so the fallback can see
  // `population` (a default may only reference parameters to its LEFT), and the
  // positional signature every existing caller uses is left exactly where it was.
  parentAt?: (mid: number) => number,
  // …and the default base is read in the SAME population as the curve: a sized
  // curve shrunk toward the pooled base would pull sized bands back toward the
  // very shadow-diluted number the partition exists to get out from under.
  population: BucketPopulation = 'pooled',
): CurvePoint[] {
  const parent = parentAt ?? (() => baseHitRate(state, population).rate)
  // A band with no evidence IN THIS POPULATION contributes no point — the same
  // rule, and the same line, that has always governed an empty bucket. A bucket
  // that is entirely shadow is, to a sized read, a bucket that was never graded.
  const seen = BANDS.map(band => ({ band, stat: poolBuckets(state, side, band, cohort, regime, population) })).filter(b => b.stat.n > 0)
  if (!seen.length) return []
  const fitted = isotonicFit(seen.map(b => ({ band: b.band, p: laplace(b.stat), n: b.stat.n })))
  let floor = -Infinity
  return fitted.map(pt => {
    const w = pt.n / (pt.n + SHRINK_K)
    floor = Math.max(floor, w * pt.p + (1 - w) * parent(pt.mid))
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
  /** WHOSE HISTORY THIS READ IS DRAWN FROM [stage 3c].
   *
   * 'sized' answers "what happened to rows the reader could have taken at this
   * conviction?" and is what a SIZED row's probability and grade must be built
   * on — the unmasking. 'pooled' answers "what happened to everything the engine
   * graded here?" and stays the default, so every existing call site, every
   * legacy blob and every committed seed read exactly what they read before.
   *
   * The engine chooses per row (engine.ts): a candidate for sizing is read
   * 'sized'; a row that structurally cannot be sized — an earnings shadow, an
   * unroutable short, a lane stand-down, a near miss — is PRICED 'pooled',
   * because its probability is a record of what the engine thought, not money the
   * reader can put down, and the pooled population is the one it belongs to.
   *
   * The whole ladder moves together: rungs, the shrinkage parents between them,
   * and the base rate at the bottom are all read in this population. Mixing them
   * would shrink sized bands toward a shadow-diluted target and undo the split
   * one rung below where it was made. */
  population: BucketPopulation = 'pooled',
  /** THE CALL'S SETUP FAMILY [stage 3c, spec §4.3(c)] — continuation / reversal /
   * fade / velocity. Optional and LAST, so every existing call site keeps the
   * exact signature and the exact answer it had; absent means no blend, which is
   * also what every non-production caller (the replay harness, the tests that
   * probe the ladder) wants. The engine passes `call.setup` for the one row it is
   * pricing. See `blendSetup` below for what it does and every condition on it. */
  setup?: string | null,
): { p: number; provisional: boolean; nEff: number; belowEvidence: boolean } {
  /** THE SETUP BLEND: `p = 0.7·p_ladder + 0.3·p_setup`, and nothing else moves.
   *
   * WHAT IT IS. The ladder answers "how do calls at this conviction, in this
   * cohort and regime, tend to do?". The setup buckets answer a question the
   * ladder cannot see: "how does THIS SHAPE of call — a dip bought, a breakout
   * ridden, a hype spike faded — tend to do at this conviction?". Once a family
   * has watched itself thirty sized times in the call's own band, it has earned a
   * minority say in the price. A specialist model earns its existence from logged
   * evidence, exactly like a new factor.
   *
   * IT ADJUSTS PRICE, NOT EVIDENCE MASS. `nEff`, `provisional` and
   * `belowEvidence` are returned as the LADDER computed them and are never
   * blended. nEff is "how many observations straddle this read on the main
   * curve", the number `gradeFor` prices an A or a B against; a family's thirty
   * outcomes are a different population answering a different question, and
   * adding them would let a setup bucket buy an evidence floor the main curve
   * never earned. The blend can move a call across a grade threshold — through
   * `p`, on the merits, which is the whole point — but it can never buy it one.
   *
   * SIZED READS ONLY, in both directions. The blend is skipped entirely on a
   * pooled read, because a pooled read is what prices a SHADOW — a row nobody was
   * offered — and a shadow's probability is a record of what the engine thought,
   * not money on offer; leaving it as the pure ladder keeps every shadow priced
   * exactly as it was before this existed. And the family's own stat is read
   * 'sized', because blending shadow-diluted family evidence into a sized grade
   * would re-import precisely the dilution the partition exists to remove.
   *
   * AN UNPARTITIONED FAMILY BUCKET REFUSES [adjudicated, stage 3c]. Absent
   * sub-counts are ambiguous by construction: a sized row writes no sub-count, so
   * "never partitioned" and "partitioned, all sized" are the same bytes. It
   * cannot be resolved at the store level either — a live blob holds the gen-3
   * seed's unpartitioned setup buckets AND post-partition live accrual in ONE
   * object, so "this store has written sub-counts somewhere" would license
   * reading the seed's shadow-diluted 313-row `reversal:long:40-55` as fully
   * sized. So: evidence that cannot PROVE it is sized adds no influence. The cost
   * is a fully-sized family bucket that also refuses, and that is the right way
   * round — refusing costs a blend that would mostly have agreed with the ladder;
   * accepting would re-import the dilution into the one read the reader's money
   * follows. The practical effect is that the blend stays dark until a
   * partitioning walk rebuilds `setupBuckets`, which is exactly when it should
   * turn on. */
  const blendSetup = (pLadder: number): number => {
    if (population !== 'sized' || !setup) return pLadder
    const raw = state.setupBuckets?.[`${setup}:${side}:${bandFor(absComposite)}`]
    if (!raw || (raw.shadowN == null && raw.shadowHits == null)) return pLadder // never partitioned → cannot prove sized
    const sized = sizedSlice(raw)
    if (sized.n < SETUP_BLEND_MIN_N) return pLadder
    return (1 - SETUP_BLEND_W) * pLadder + SETUP_BLEND_W * laplace(sized)
  }

  const rungs: { cohort: CapCohort | 'any'; regime: string | null }[] =
    cohort === 'unknown'
      ? [{ cohort: 'any', regime }, { cohort: 'any', regime: null }]
      : [{ cohort, regime }, { cohort, regime: null }, { cohort: 'any', regime }, { cohort: 'any', regime: null }]

  const curves: CurvePoint[][] = []
  const curveAtRung = (i: number): CurvePoint[] => {
    if (i >= rungs.length) return []
    // an empty array is truthy, so a rung that HAS been built and holds nothing
    // is never rebuilt: the memo is on the slot, not on the contents
    if (!curves[i]) curves[i] = curveFor(state, side, rungs[i].cohort, rungs[i].regime, mid => parentRead(i + 1, mid), population)
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
    return baseHitRate(state, population).rate // POOLED [§9] vs the reference; read in THIS population, exactly as in curveFor above
  }

  for (let i = 0; i < rungs.length; i++) {
    const curve = curveAtRung(i)
    if (!curve.length) continue
    const { p, nEff, belowEvidence } = readCurve(curve, absComposite)
    return { p: blendSetup(p), provisional: nEff < MIN_BUCKET_N, nEff, belowEvidence }
  }

  // rung 5: nothing for this side anywhere → the engine's own base rate
  // (baseHitRate is a hoisted declaration below). Not a curve read at all, so
  // there is no evidence for it to sit below — a C at most either way.
  // POOLED [§9] as against the swept REFERENCE: this IS the emitted probability,
  // and a probability must describe the population the row was drawn from. The
  // reference answers a grading question about ordinary candidates, not a pricing
  // question about this one. Within that, it is read in the caller's population —
  // a sized read that finds no sized evidence anywhere lands on the sized base
  // (the cold 0.5 until fifty SIZED outcomes exist), which is the honest answer
  // rather than a quiet fallback to the pool the partition just removed.
  //
  // NOT BLENDED, and it cannot be: every row that books a setup bucket books a
  // main bucket in the same band and side on the same call (updateCalibration),
  // so a family with thirty sized outcomes here implies thirty sized main-bucket
  // rows, and rung 4 would have found them. Reaching this line means the side has
  // no evidence anywhere in this population — there is no p_ladder to adjust,
  // only a base rate, and blending a family's record into "we have never graded
  // this side" would dress a cold store up as a measurement.
  return { p: baseHitRate(state, population).rate, provisional: true, nEff: 0, belowEvidence: false }
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
 * has no business claiming an edge over a number it has not measured.
 *
 * `population` [stage 3c] takes the same partition as the curve, and it must:
 * this is the SHRINKAGE FLOOR under every rung and the rung-5 answer when a side
 * has nothing anywhere, so a sized curve read against a pooled base would pull
 * every thin sized band back toward the shadow-diluted pool one level below where
 * the split was made. The fifty-observation cliff then applies to the SIZED n —
 * a store with 4,000 pooled rows and 40 sized ones is, to a sized read, a cold
 * store, and 0.5 is the correct thing for it to say. Unchanged on any blob
 * without sub-counts: the two populations are the same sum.
 *
 * NOT `gradeBaseRate`, which is untouched by the partition: `referenceBase` is an
 * UNCONDITIONAL sweep over the raw tape (spec §9), a population with no board and
 * therefore no sizing in it at all — there is no sized slice of it to take. */
export function baseHitRate(state: CalibrationState, population: BucketPopulation = 'pooled'): { rate: number; n: number } {
  let n = 0
  let hits = 0
  for (const b of Object.values(state.buckets)) {
    const stat = statIn(b, population)
    n += stat.n
    hits += stat.hits
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

/** Add one graded outcome to a bucket, and — since stage 3c — record whether the
 * reader could have taken it.
 *
 * THE DISCRIMINATOR IS `pred.accrual`, the stamp the engine writes at publication
 * from THE SHADOW'S CAUSE (types.ts): 'shadow' only for the three pre-grade,
 * grade-proof causes — an earnings print inside the horizon, an unroutable short,
 * a lane stand-down — and 'sized' for every other row, including the ones that
 * publish at zero risk.
 *
 * It is deliberately NOT the row's size. Size was the first ratification and it
 * sealed a band's recovery: a grade-null demotion carries riskPct 0, so every
 * call a below-anchor band made accrued OUTSIDE the population that decides its
 * grade, and the sized read could never move again however well the band did —
 * while the pooled read, on the very same outcomes, recovered. The demotions ARE
 * the band's recovery record. (The velocity door's 0.25/0.5 caps stay sized for
 * the same reason they always did: a door cap is momentum sizing, not an evidence
 * deficiency.)
 *
 * A SIZED row writes no sub-count at all, so a store that only ever books sized
 * rows stays byte-identical to what the pre-partition tree wrote. Only a shadow
 * row leaves a mark, which is what keeps "absent means never partitioned" true of
 * every bucket rather than only of legacy ones.
 *
 * LEGACY FALLBACK — an ABSENT stamp falls back to `riskPct > 0 ⇒ sized`, the rule
 * that shipped, so every row already sitting in the ledger books exactly as it
 * would have; and an absent `riskPct` on top of that is not a shadow either, but a
 * caller that answered neither question, whose safe reading is the pre-partition
 * one: count it in the totals, partition nothing, let the sized read see what the
 * pooled read sees. Booking silence as shadow would let one forgetful call site
 * quietly delete the sized history. Both production callers are explicit:
 * engine.ts's grader passes the whole `Prediction` (stamped at publication), and
 * the reference sweep stamps its rows 'sized' by construction. */
export function updateCalibration(
  state: CalibrationState,
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
): CalibrationState {
  migrateCalibration(state)
  // The stamp when there is one; otherwise the shipped rule. `!= null` on both,
  // and not a truthiness test: 0 is the value that MEANS unsized under the
  // fallback, and it is the whole point of the field there.
  const unsized = pred.accrual != null ? pred.accrual === 'shadow' : pred.riskPct != null && pred.riskPct <= 0
  /** One increment, with the sub-count carried alongside the totals. Spreading
   * `cur` first preserves any sub-count already on a bucket when a SIZED row
   * lands in it — the two counters are independent and a bucket holds both. */
  const book = (cur: BucketStat | undefined, hit: boolean): BucketStat => {
    const b = cur ?? { n: 0, hits: 0 }
    const next: BucketStat = { ...b, n: b.n + 1, hits: b.hits + (hit ? 1 : 0) }
    if (unsized) {
      next.shadowN = (b.shadowN ?? 0) + 1
      next.shadowHits = (b.shadowHits ?? 0) + (hit ? 1 : 0)
    }
    return next
  }
  // A known cap books into its cohort bucket `${cohort}:${side}:${regime}:${band}`;
  // an unknown cap books into the LEGACY cohortless `${side}:${regime}:${band}` —
  // never guessed into a cohort. Unknown grades thus keep feeding the pooled rungs
  // (3–5) that every cohort falls back to, exactly like the seed does.
  const cohort = capCohortOf(pred.capUsdM)
  const band = bandFor(Math.abs(pred.composite))
  const tail = `${pred.side}:${pred.regime}:${band}`
  const key = cohort === 'unknown' ? tail : `${cohort}:${tail}`
  state.buckets[key] = book(state.buckets[key], outcome.hit)
  // setup-family stats accrue in parallel, and take the IDENTICAL partition: the
  // blend that reads them (`blendSetup`) reads them sized, or it would re-import
  // into a sized grade exactly the dilution the main buckets just shed — and it
  // refuses a bucket with no sub-counts at all, so this write is what eventually
  // turns the blend on for a family. Calls without a setup stamp simply don't
  // book here; the main buckets above remain the source of truth.
  if (pred.setup) {
    const sk = `${pred.setup}:${pred.side}:${band}`
    state.setupBuckets![sk] = book(state.setupBuckets![sk], outcome.hit)
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

/** The precision every weight-history line is written at. One helper rather than
 * three copies of the same expression, because the three writers (the load-time
 * clamp, the re-base, the nudge) are all writing the SAME field and a reader
 * comparing two entries must never be comparing two roundings. */
const r3 = (x: number) => Math.round(x * 1000) / 1000

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
 * and returns the same object; idempotent.
 *
 * …AND HOLD THE BAND, BECAUSE THIS IS THE LOAD PATH [stage 3c]. `current` may
 * never leave `[WEIGHT_BAND_LO × base, WEIGHT_BAND_HI × base]` — that is an
 * INVARIANT on the vector, not a bound on the nudge step (see maybeNudgeWeights)
 * — and until this clamp existed the nudge loop was the only thing enforcing it.
 * The gap that leaves is not theoretical: a stored vector outside the band goes on
 * SCORING BOARDS, and publishing composites, for up to `NUDGE_EVERY` graded
 * predictions before the repair fires. So the same clamp runs here, on the one
 * function every load goes through before anything is scored, against the blob's
 * OWN base and after the backfill above has filled any missing one.
 *
 * IDEMPOTENT, and its log is: the history entry is written only when a weight
 * actually moved, so a second load finds an in-band vector, moves nothing and
 * writes nothing. It mirrors the nudge's entry — the same `changes` shape with
 * `ic: 0` (no measurement made this; the `rebaseWeights` precedent) and the same
 * `N weight(s) clamped into the […] band` phrase the panel already reads, prefixed
 * `on load:` where the nudge's is prefixed with its cadence, because a reader of
 * the trail must be able to tell which pass repaired the weight.
 *
 * It runs BEFORE `rebaseWeights` (engine.ts), which may then discard the repaired
 * vector wholesale. That ordering is deliberate and the trail survives it: the
 * clamp's entry records the true `from` (what production last scored with) and the
 * re-base's records the clamped value it superseded, so the two lines chain into
 * the whole story instead of one line hiding half of it. */
export function migrateWeights(
  state: WeightsState,
  base: Record<FactorName, number> = DEFAULT_WEIGHTS,
  dateISO: string = new Date().toISOString().slice(0, 10),
): WeightsState {
  state.seedGeneration ??= 1 // absence is generation 1 — see CalibrationState.seedGeneration
  for (const name of Object.keys(base) as FactorName[]) {
    if (state.base[name] == null) state.base[name] = base[name]
    if (state.current[name] == null) state.current[name] = base[name]
    if (!state.ic[name]) state.ic[name] = zeroIc()
  }
  // the band, over every key the blob carries — including one this vector has
  // retired, whose weight still scores until `rebaseWeights` drops it
  const changes: Record<string, { from: number; to: number; ic: number }> = {}
  for (const name of Object.keys(state.current ?? {}) as FactorName[]) {
    const cur = state.current[name]
    const anchor = state.base[name]
    if (cur == null || anchor == null) continue
    const next = clamp(cur, WEIGHT_BAND_LO * anchor, WEIGHT_BAND_HI * anchor)
    if (Math.abs(next - cur) <= 1e-9) continue
    changes[name] = { from: r3(cur), to: r3(next), ic: 0 }
    state.current[name] = next
  }
  const repaired = Object.keys(changes).length
  if (repaired) {
    // same defensive assumption rebaseWeights makes: this runs on the first load
    // of a blob written by who-knows-which deploy, so it asserts nothing
    if (!Array.isArray(state.history)) state.history = []
    state.history.push({ date: dateISO, changes, evidence: `on load: ${repaired} weight(s) clamped into the [${WEIGHT_BAND_LO}×, ${WEIGHT_BAND_HI}×] band` })
    if (state.history.length > 100) state.history = state.history.slice(-100)
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

/** Book one graded outcome into every factor's agree/disagree columns.
 *
 * NULL IS ALWAYS SKIPPED — "we could not look" is not evidence about anything.
 * ZERO IS PER FACTOR [stage 3c, spec §4.3(b)]: `ZERO_IS_A_READING` (composite.ts)
 * carries the adjudication and the argument for each of the ten. The shipped line
 * skipped both together, which quietly selected news IC down to loud tapes only —
 * `newsFactor` returns 0 for a quiet tape and never returns null at all.
 *
 * …AND PER READING, where the factor says so. The table answers "does a zero from
 * this factor mean anything?"; `FactorScore.silence` answers "did THIS zero?", and
 * a flagged zero is skipped even where the table admits the factor. It exists for
 * news, whose zero has two causes — the quiet-tape branch (the reading the table
 * was admitting) and an exact polarity tie on a loud tape (an arithmetic
 * cancellation, a silence by the table's own test). The factor is the only thing
 * that still knows which, so it marks it; this line obeys. Absent means "not a
 * silence", so every other factor and every legacy stored Prediction books exactly
 * as it did before.
 *
 * AN ACCRUED ZERO BOOKS BY THE MODULE'S ONE CONVENTION, `score > 0 === (side ===
 * 'long')`, and that convention is not symmetric about zero: a zero counts
 * AGAINST a long and WITH a short. That is deliberate rather than overlooked. The
 * scores are signed TOWARD LONG, so "no upward pressure" is the honest reading of
 * a quiet tape or a flat month for a long thesis, and the mirror of it for a
 * short one. The alternative — a third, neutral column — would need its own
 * meaning in an IC defined as the gap between two means, and there is none: a
 * factor that said nothing has no claim to be right or wrong about the call.
 * Which is precisely why a SILENT zero (see the table) is skipped instead. */
export function updateIcStats(state: WeightsState, pred: Prediction, outcome: PredOutcome): WeightsState {
  for (const name of FACTOR_NAMES) {
    const f = pred.factors[name]
    if (!f || f.score == null) continue
    // the table, then the reading's own veto — a factor may be admitted and this
    // particular zero still be a silence (see above)
    if (f.score === 0 && (f.silence || !ZERO_IS_A_READING[name])) continue
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
/** THE TWO-SIDED IC FLOOR [stage 3c]: a nudge needs `nAgree ≥ 20` AND
 * `nDisagree ≥ 20`, not twenty observations between them.
 *
 * An information coefficient is the GAP BETWEEN TWO MEANS, so a column with
 * almost nothing in it does not make the IC uncertain — it makes it a reading of
 * the other column plus noise. The gen-2 vector is the proof: momentum's weight
 * sat pinned at the old 2× cap, 73% of a weight-normalised composite, on a
 * disagreement mean of FIFTEEN observations against 5,697 agreements. The old
 * combined `nAgree + nDisagree ≥ 20` test is subsumed (both sides at 20 is 40),
 * and the spec's separate `nDisagree === 0` repair is subsumed with it — zero is
 * simply the loudest case of "under twenty". */
const MIN_IC_SIDE_N = 20
const NUDGE_STEP = 0.15
/** THE ABSOLUTE WEIGHT BAND [stage 3c]. `current` may not leave
 * `[0.5×base, 1.5×base]` — replacing the old `[floor, 2×base]`, whose floor
 * LIFTED TO ZERO once a factor passed 200 observations (the retired
 * `PRUNE_MIN_N`). That escape hatch is what let ~450 compounding walk nudges
 * decay technical — the owner's #1 factor — to 0.0791, a 3% share of the core,
 * while momentum sat on the ceiling; "a signal that kept being wrong may decay to
 * nothing" is a fine principle and a terrible mechanism, because the thing that
 * kept being wrong was a weight vector drifting away from the ratified order
 * inside its own measurement window.
 *
 * The band is an INVARIANT, not a bound on the step: see maybeNudgeWeights. */
const WEIGHT_BAND_LO = 0.5
const WEIGHT_BAND_HI = 1.5

/** Bounded, slow, evidenced: weights drift toward factors that kept being right,
 * never outside [0.5×, 1.5×] of the ratified base — no whipsawing, no runaway,
 * and no factor switched off by the loop that was supposed to be tuning it.
 *
 * TWO BRAKES, ANSWERING TWO QUESTIONS.
 *
 * The IC floor asks "has this factor been measured against itself?" and skips the
 * nudge unless BOTH columns hold 20 observations (MIN_IC_SIDE_N).
 *
 * The band asks "how far may the loop move a weight from the vector the owner
 * ratified?" — and it is applied to every factor on every pass, including the
 * ones the IC floor just skipped. That is the whole point rather than a
 * side-effect: a stored vector already outside the band (the gen-2 install:
 * technical 0.0791, momentum 1.8) would otherwise sit there forever, and would
 * sit there most immovably for exactly the factor whose evidence is too one-sided
 * to nudge — the failure would protect itself. A clamp with no nudge behind it is
 * recorded like any other change with `ic: 0`, because no measurement made it,
 * and the history line names it so the panel can say what happened. That line
 * counts the weights THE CLAMP decided, which is not the same set as the ones the
 * IC floor skipped: an eligible factor sitting out of band has a real `ic`, is
 * nudged further out, and is clamped back — the band decided the value, so the
 * band is what the line reports.
 *
 * The band is ALSO held at load (`migrateWeights`), so a stored out-of-band vector
 * is repaired before any board scores with it rather than up to fifteen graded
 * predictions later. This pass stays the invariant's enforcement DURING the loop;
 * the two are the same clamp against the same base.
 *
 * Consequence worth stating: a factor is now guaranteed at least half its base
 * weight forever. The way to retire a factor is to remove it from
 * DEFAULT_WEIGHTS, which `rebaseWeights` turns into a real, logged re-base — an
 * explicit decision with an author, not a slow drift nobody signed. */
export function maybeNudgeWeights(state: WeightsState, dateISO: string): WeightsState {
  if (state.gradedSinceNudge < NUDGE_EVERY) return state
  const changes: Record<string, { from: number; to: number; ic: number }> = {}
  let repaired = 0
  for (const name of FACTOR_NAMES) {
    const st = state.ic[name]
    const cur = state.current[name]
    // BOTH columns, independently — see MIN_IC_SIDE_N
    const eligible = !!st && st.nAgree >= MIN_IC_SIDE_N && st.nDisagree >= MIN_IC_SIDE_N
    // the phantom-zero guards stay on the means, but they are now unreachable:
    // eligibility already proved both counts are ≥ 20
    const ic = eligible ? clamp((st.sumAgree / st.nAgree - st.sumDisagree / st.nDisagree) / 10, -1, 1) : 0
    // what the nudge asked for, and then what the band allowed — kept apart so
    // the history line can say WHICH ONE decided the value
    const nudged = eligible ? cur * (1 + NUDGE_STEP * ic) : cur
    const next = clamp(nudged, WEIGHT_BAND_LO * state.base[name], WEIGHT_BAND_HI * state.base[name])
    if (Math.abs(next - cur) > 1e-9) {
      // COUNTED WHENEVER THE CLAMP DECIDED IT, not whenever the IC floor skipped
      // the factor. The two coincided while the only clamped weights were
      // ineligible ones, and diverge on an eligible factor sitting out of band:
      // its nudge is computed, overruled by the band, and the line said nothing
      // about a band. The claim "N weight(s) clamped into the band" is about the
      // clamp, so it counts the clamp.
      if (Math.abs(next - nudged) > 1e-9) repaired++
      changes[name] = { from: r3(cur), to: r3(next), ic: Math.round(ic * 100) / 100 }
      state.current[name] = next
    }
  }
  const banded = repaired ? `; ${repaired} weight(s) clamped into the [${WEIGHT_BAND_LO}×, ${WEIGHT_BAND_HI}×] band` : ''
  state.history.push({ date: dateISO, changes, evidence: `${state.gradedSinceNudge} predictions graded since last nudge${banded}` })
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
