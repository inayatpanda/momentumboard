import { describe, expect, it } from 'vitest'
import {
  bandFor,
  baseHitRate,
  brierPoint,
  curveFor,
  gradeBaseRate,
  gradeFor,
  gradePrediction,
  initWeights,
  isotonicFit,
  maybeNudgeWeights,
  migrateCalibration,
  migrateWeights,
  probabilityFor,
  rebaseWeights,
  setupStat,
  updateCalibration,
  updateIcStats,
  type Band,
  type CalibrationState,
  type IcStat,
  type WeightsState,
} from './calibration'
import { DEFAULT_WEIGHTS, ZERO_IS_A_READING } from './composite'
import type { Candle } from '../types'
import type { FactorName, Prediction } from './types'
import seedJson from './seed.json'

const emptyCal = (): CalibrationState => ({ buckets: {}, brier: [] })

/** `{ key: [n, hits] }` → a CalibrationState. Keys are written exactly as the
 * frozen write path writes them (legacy cohortless or cohort-tagged). */
const calOf = (rows: Record<string, [number, number]>): CalibrationState => ({
  buckets: Object.fromEntries(Object.entries(rows).map(([k, [n, hits]]) => [k, { n, hits }])),
  brier: [],
})

/** The committed seed's buckets verbatim (shared/engine/seed.json @ 01a6549):
 *  778 observations, 285 hits, baseHitRate (285+2)/(778+4) = 0.3670077. Shared by
 *  the curve tests and the SHIP GATE below — the point of both is that they are
 *  read off the shape production actually carries, not a contrived one. */
const seedShape = (): CalibrationState =>
  calOf({
    'long:green:25-40': [195, 76],
    'long:amber:25-40': [88, 38],
    'long:red:25-40': [18, 7],
    'long:green:40-55': [46, 20],
    'long:green:55-70': [2, 1],
    'short:green:25-40': [116, 47],
    'short:amber:25-40': [108, 33],
    'short:red:25-40': [147, 48],
    'short:amber:40-55': [19, 4],
    'short:red:40-55': [31, 7],
    'short:red:55-70': [8, 4],
  })

// 30 sessions of candles, one per day starting 2026-01-05, close ramps by `slope`/day
const mkCandles = (startClose: number, slope: number, days = 30, lowOffset = 1, highOffset = 1): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = startClose + slope * i
    const t = Date.parse('2026-01-05') / 1000 + i * 86_400
    return { t, o: c, h: c + highOffset, l: c - lowOffset, c, v: 1_000_000 }
  })

// explicit open/close per bar, one per day from 2026-01-05 — lets a bar's OPEN
// diverge from the prior close so we can model an overnight gap
const seq = (bars: { o: number; c: number }[]): Candle[] =>
  bars.map((b, i) => ({
    t: Date.parse('2026-01-05') / 1000 + i * 86_400,
    o: b.o,
    h: Math.max(b.o, b.c) + 1,
    l: Math.min(b.o, b.c) - 1,
    c: b.c,
    v: 1_000_000,
  }))

describe('bandFor', () => {
  // The WRITE path, and it is FROZEN: these four edges key every bucket in the
  // seed and every live bucket. The read path no longer steps on them — it reads
  // a continuous curve over the band MIDPOINTS (32.5/47.5/62.5/77.5) — but a
  // graded call is still BOOKED into the band these edges name.
  it('maps |composite| to bands', () => {
    expect(bandFor(25)).toBe('25-40')
    expect(bandFor(40)).toBe('40-55')
    expect(bandFor(69.9)).toBe('55-70')
    expect(bandFor(70)).toBe('70+')
  })
})

// ---------------------------------------------------------------------------
// The curve. Three independent pieces, unit-tested bottom-up: the monotone fit,
// the rung's shrunk curve, then the read across it.
// ---------------------------------------------------------------------------

const pt = (band: Band, p: number, n: number) => ({ band, p, n })

describe('isotonicFit — weighted PAVA over the ORIGINAL band midpoints', () => {
  it('an already-monotone read passes through untouched — midpoints and per-band n intact', () => {
    expect(isotonicFit([pt('25-40', 0.3, 10), pt('40-55', 0.4, 20), pt('55-70', 0.5, 30)])).toEqual([
      { mid: 32.5, p: 0.3, n: 10 },
      { mid: 47.5, p: 0.4, n: 20 },
      { mid: 62.5, p: 0.5, n: 30 },
    ])
  })

  it('the real short inversion — 0.41 on n=96 then 0.25 on n=8 — pools to ONE weighted block', () => {
    // The seed's shorts genuinely score WORSE with more conviction. PAVA pools
    // the violating pair by evidence: (0.41×96 + 0.25×8)/104 = (39.36 + 2)/104
    // = 41.36/104 = 0.3976923…  — not the unweighted 0.33; the 96 outvote the 8.
    const out = isotonicFit([pt('25-40', 0.41, 96), pt('40-55', 0.25, 8)])
    expect(out[0].p).toBeCloseTo(41.36 / 104, 12)
    expect(out[1].p).toBeCloseTo(41.36 / 104, 12)
    // …and the pooled value is assigned back to the ORIGINAL midpoints, each
    // band keeping its OWN n. The x-axis never becomes the block's midpoint and
    // the sample size never becomes the block's 104. [DeepSeek gate, blockers 1+2]
    expect(out.map(o => o.mid)).toEqual([32.5, 47.5])
    expect(out.map(o => o.n)).toEqual([96, 8])
  })

  it('a cascading violation re-pools BACKWARDS until the whole run is one block', () => {
    // 0.5 / 0.4 / 0.3 at one observation each: 0.5>0.4 pools to 0.45 (n2); the
    // new block then violates 0.3, so it pools again — (0.45×2 + 0.3×1)/3 = 0.4.
    // Without the `i--` backtrack the first block would be left at 0.45 > 0.4.
    const out = isotonicFit([pt('25-40', 0.5, 1), pt('40-55', 0.4, 1), pt('55-70', 0.3, 1)])
    for (const o of out) expect(o.p).toBeCloseTo(0.4, 12)
    expect(out.map(o => o.mid)).toEqual([32.5, 47.5, 62.5])
  })

  it('a single point is returned as-is — one band of evidence is still a reading', () => {
    expect(isotonicFit([pt('55-70', 0.62, 12)])).toEqual([{ mid: 62.5, p: 0.62, n: 12 }])
  })

  it('an all-equal read is not a violation — nothing pools, and no 0/0 is ever formed', () => {
    const out = isotonicFit([pt('25-40', 0.4, 3), pt('40-55', 0.4, 7), pt('55-70', 0.4, 11)])
    expect(out.map(o => o.p)).toEqual([0.4, 0.4, 0.4])
    expect(out.map(o => o.n)).toEqual([3, 7, 11])
  })

  it('pools by EVIDENCE, not by band count: 0.8 on n=100 barely moves for 0.2 on n=4', () => {
    // (0.8×100 + 0.2×4)/104 = 80.8/104 = 0.7769… — nowhere near the 0.5 an
    // unweighted pool would produce.
    const out = isotonicFit([pt('25-40', 0.8, 100), pt('40-55', 0.2, 4)])
    expect(out[0].p).toBeCloseTo(80.8 / 104, 12)
    expect(out[1].p).toBeCloseTo(80.8 / 104, 12)
  })
})

describe('curveFor — one rung’s monotone, shrunk curve', () => {
  it('shrinks each band toward the PARENT’s read AT THAT MIDPOINT — the target is a curve, not a number', () => {
    // The mechanism, isolated: the parent is supplied as a function of the
    // midpoint, and it DISAGREES with this rung in opposite directions at the two
    // ends — 0.20 under the 25-40 band, 0.80 over the 55-70 one. A rung's own
    // pooled rate is a single number and could never do that, so this arithmetic
    // is only reachable if the target really is the rung below's read at the same
    // conviction.
    //   25-40: n=100 hits=30 → 32/104 = 0.3076923, w = 100/125 = 0.8
    //          0.8×0.3076923 + 0.2×0.20 = 0.2461538 + 0.04 = 0.2861538
    //   55-70: n=5 hits=4    → 6/9     = 0.6666667, w = 5/30 = 0.1666667
    //          0.1666667×0.6666667 + 0.8333333×0.80 = 0.1111111 + 0.6666667 = 0.7777778
    const c = curveFor(
      calOf({ 'long:green:25-40': [100, 30], 'long:green:55-70': [5, 4] }),
      'long', 'any', 'green',
      mid => (mid < 50 ? 0.2 : 0.8),
    )
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({ mid: 32.5, n: 100 })
    expect(c[0].p).toBeCloseTo(0.2861538, 6)
    expect(c[1]).toMatchObject({ mid: 62.5, n: 5 })
    expect(c[1].p).toBeCloseTo(0.7777778, 6)
  })

  it('with NO parent supplied the target is the engine’s own base rate — the bottom of the ladder', () => {
    // 25-40: n=100 hits=30 → (30+2)/104 = 0.3076923
    // 55-70: n=5   hits=4  → (4+2)/9     = 0.6666667   (already monotone: PAVA is the identity)
    // baseHitRate over the whole store: n=105 hits=34 → 36/109 = 0.3302752. (It
    // coincides with this rung's own pool ONLY because the store holds nothing
    // else — which is exactly why the test above, not this one, is the mechanism.)
    //   25-40 w = 100/125 = 0.8       → 0.8×0.3076923      + 0.2×0.3302752       = 0.3122089
    //   55-70 w = 5/30   = 0.1666667  → 0.1666667×0.6666667 + 0.8333333×0.3302752 = 0.3863405
    const c = curveFor(calOf({ 'long:green:25-40': [100, 30], 'long:green:55-70': [5, 4] }), 'long', 'any', 'green')
    expect(c[0].p).toBeCloseTo(0.3122089, 6)
    expect(c[1].p).toBeCloseTo(0.3863405, 6) // NOT 0.667 — five observations do not get to claim 0.67
  })

  it('a band with NO evidence contributes no point — an empty bucket is not a 0.5 reading', () => {
    const c = curveFor(calOf({ 'long:green:55-70': [20, 14] }), 'long', 'any', 'green')
    expect(c.map(p => p.mid)).toEqual([62.5])
  })

  it('a rung with nothing in it is an empty curve — that is how the ladder falls through', () => {
    expect(curveFor(calOf({ 'long:green:25-40': [20, 14] }), 'short', 'any', 'green')).toEqual([])
  })

  it('the curve is re-projected MONOTONE after shrinkage — partial pooling may not undo the fit', () => {
    // The committed seed's long/green rung, exactly: 25-40 195/76, 40-55 46/20,
    // 55-70 2/1. Laplace 0.3919598 / 0.44 / 0.5 — already increasing, so PAVA is
    // the identity. Nothing else is in this store, so the default parent (the
    // base rate) is n=243 hits=97 → 99/247 = 0.4008097.
    //   25-40 w = 195/220 = 0.8863636 → 0.8863636×0.3919598 + 0.1136364×0.4008097 = 0.3929655
    //   40-55 w = 46/71   = 0.6478873 → 0.6478873×0.44      + 0.3521127×0.4008097 = 0.4262006
    //   55-70 w = 2/27    = 0.0740741 → 0.0740741×0.5       + 0.9259259×0.4008097 = 0.4081571
    // ← BELOW 40-55. Shrinkage is applied per band with a weight that rises with
    // n, and n FALLS as conviction rises, so the thin top of the curve is pulled
    // harder toward the (low-conviction-dominated) parent than the thick band
    // under it. The running-max guard restores the one invariant the whole stage
    // exists to deliver.
    const c = curveFor(calOf({ 'long:green:25-40': [195, 76], 'long:green:40-55': [46, 20], 'long:green:55-70': [2, 1] }), 'long', 'any', 'green')
    expect(c[0].p).toBeCloseTo(0.3929655, 6)
    expect(c[1].p).toBeCloseTo(0.4262006, 6)
    expect(c[2].p).toBeCloseTo(0.4262006, 6) // lifted from 0.4081571 to its neighbour
    expect(c[2].n).toBe(2) // …and it still declares that it rests on TWO observations
  })

  it('…and the guard still fires when the parent is a real rung, not the base rate', () => {
    // The same long/green bands, but now read off the WHOLE committed seed, so the
    // parent is rung 4 (long, every regime) rather than a flat number:
    //   rung 4: 25-40 301/121 → 123/305 = 0.4032787, 40-55 46/20 → 0.44, 55-70 2/1 → 0.5
    //           shrunk toward base 0.3670077: 0.4004972 / 0.4142985 / 0.3768590
    //           …the last one is BELOW its neighbour, so the guard already fires here
    //           and rung 4's 62.5 point is republished at 0.4142985.
    //   rung 3 (long/green) toward that parent, band by band:
    //     32.5 w=195/220=0.8863636 → 0.8863636×0.3919598 + 0.1136364×0.4004972 = 0.3929300
    //     47.5 w= 46/71 =0.6478873 → 0.6478873×0.44      + 0.3521127×0.4142985 = 0.4309502
    //     62.5 w=  2/27 =0.0740741 → 0.0740741×0.5       + 0.9259259×0.4142985 = 0.4206467
    //   ← still below 47.5. The thin-top pathology is a property of the WEIGHTS
    //   (w rises with n, n falls with conviction), so changing what the target is
    //   does not remove it. The guard lifts 62.5 back onto 0.4309502.
    const rung4 = curveFor(seedShape(), 'long', 'any', null) // its own parent is the base rate
    expect(rung4.map(p => p.p)).toEqual([expect.closeTo(0.4004972, 6), expect.closeTo(0.4142985, 6), expect.closeTo(0.4142985, 6)])
    // the parent is only ever asked at the midpoints it already has, so an exact
    // lookup is the same thing readCurve would return, with no interpolation
    const c = curveFor(seedShape(), 'long', 'any', 'green', mid => rung4.find(p => p.mid === mid)!.p)
    expect(c[0].p).toBeCloseTo(0.3929300, 6)
    expect(c[1].p).toBeCloseTo(0.4309502, 6)
    expect(c[2].p).toBeCloseTo(0.4309502, 6)
    // and end to end, through the ladder that builds that parent for itself
    expect(probabilityFor(seedShape(), 'long', 'green', 62.5).p).toBeCloseTo(0.4309502, 6)
    expect(probabilityFor(seedShape(), 'long', 'green', 47.5).p).toBeCloseTo(0.4309502, 6)
  })
})

describe('probabilityFor — a continuous read over the band midpoints', () => {
  // The fixture for the geometry tests:
  //   25-40 n=100 hits=30 → 32/104 = 0.3076923
  //   55-70 n=100 hits=60 → 62/104 = 0.5961538
  //   base rate n=200 hits=90 → 92/204 = 0.4509804 ; every w = 100/125 = 0.8
  // The read is rung 3 (all cohorts, this regime) and its parent is rung 4 (all
  // cohorts, every regime) — which here holds the SAME two buckets, so the shrink
  // happens twice, once toward the base rate and once toward the result:
  //   rung 4:  0.8×0.3076923 + 0.2×0.4509804 = 0.3363499
  //            0.8×0.5961538 + 0.2×0.4509804 = 0.5671192
  //   rung 3:  0.8×0.3076923 + 0.2×0.3363499 = 0.3134238
  //            0.8×0.5961538 + 0.2×0.5671192 = 0.5903469
  const twoBand = () => calOf({ 'long:green:25-40': [100, 30], 'long:green:55-70': [100, 60] })
  const LO = 0.3134238
  const HI = 0.5903469

  it('no data → the engine base rate (0.5 cold), provisional, nEff 0', () => {
    const { p, provisional, nEff } = probabilityFor(emptyCal(), 'long', 'green', 30)
    expect(p).toBe(0.5)
    expect(provisional).toBe(true)
    expect(nEff).toBe(0)
  })

  it('interpolates LINEARLY between the midpoints — 47.5 reads exactly halfway', () => {
    expect(probabilityFor(twoBand(), 'long', 'green', 47.5).p).toBeCloseTo((LO + HI) / 2, 6)
    // …and one point of conviction is now worth a real, different number
    const ps = [32.5, 40, 47.5, 55, 62.5].map(x => probabilityFor(twoBand(), 'long', 'green', x).p)
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1])
    expect(new Set(ps.map(x => Math.round(x * 100) / 100)).size).toBe(5) // five distinct 2dp reads, not one step
  })

  it('extends FLAT beyond the outer midpoints — nothing is extrapolated off the ends', () => {
    expect(probabilityFor(twoBand(), 'long', 'green', 25).p).toBeCloseTo(LO, 6)
    expect(probabilityFor(twoBand(), 'long', 'green', 32.5).p).toBeCloseTo(LO, 6)
    expect(probabilityFor(twoBand(), 'long', 'green', 62.5).p).toBeCloseTo(HI, 6)
    expect(probabilityFor(twoBand(), 'long', 'green', 100).p).toBeCloseTo(HI, 6)
  })

  it('70+ can never read BELOW 55-70 — the flat extension IS §4.2’s floor', () => {
    const cal = twoBand()
    const at62 = probabilityFor(cal, 'long', 'green', 62.5).p
    for (const x of [70, 75, 77.5, 95]) expect(probabilityFor(cal, 'long', 'green', x).p).toBeGreaterThanOrEqual(at62)
    expect(probabilityFor(cal, 'long', 'green', 95).p).toBeCloseTo(at62, 12) // …equals it EXACTLY
  })

  it('the flat extension carries the SHRUNK value, not the raw fitted one', () => {
    // 25-40 n=100 hits=30 (0.3076923) + 55-70 n=5 hits=4 (0.6666667). Base rate
    // 36/109 = 0.3302752; rung 4 shrinks 62.5 to 0.3863405 and rung 3 then shrinks
    // toward THAT: 0.1666667×0.6666667 + 0.8333333×0.3863405 = 0.4330615. So 75 —
    // beyond every midpoint — reads that, not the five-observation 0.667 the band
    // on its own would claim.
    const cal = calOf({ 'long:green:25-40': [100, 30], 'long:green:55-70': [5, 4] })
    expect(probabilityFor(cal, 'long', 'green', 75).p).toBeCloseTo(0.4330615, 6)
  })

  it('nEff is the MINIMUM of the two straddling bands’ ORIGINAL n — pooling can never inflate it', () => {
    // 25-40 n=96 hits=39 → 41/100 = 0.41 ; 40-55 n=8 hits=1 → 3/12 = 0.25.
    // PAVA pools them into one block of n=104 — but a read at 40 sits BETWEEN
    // the two original midpoints, so it is backed by min(96, 8) = 8 observations.
    const cal = calOf({ 'long:green:25-40': [96, 39], 'long:green:40-55': [8, 1] })
    expect(probabilityFor(cal, 'long', 'green', 40).nEff).toBe(8)
    expect(probabilityFor(cal, 'long', 'green', 40).provisional).toBe(true) // 8 < MIN_BUCKET_N
    // at or beyond an edge it is that single band's own n
    expect(probabilityFor(cal, 'long', 'green', 30).nEff).toBe(96)
    expect(probabilityFor(cal, 'long', 'green', 30).provisional).toBe(false)
    expect(probabilityFor(cal, 'long', 'green', 60).nEff).toBe(8)
  })

  it('a read arrived at by extending DOWNWARD says so — belowEvidence marks the two extensions apart', () => {
    // A rung whose only evidence sits at 62.5. Reading it at 30 is not a
    // measurement of a 30-composite call: it is the 55-70 number, handed
    // downward because there is nothing else to hand. Upward extension is the
    // opposite case — §4.2's floor, where a higher-conviction call inherits the
    // best-evidenced band BELOW it — and is not flagged.
    const cal = calOf({ 'long:green:55-70': [40, 30] })
    expect(probabilityFor(cal, 'long', 'green', 30).belowEvidence).toBe(true)
    expect(probabilityFor(cal, 'long', 'green', 62.4999).belowEvidence).toBe(true)
    expect(probabilityFor(cal, 'long', 'green', 62.5).belowEvidence).toBe(false) // ON the evidence, not below it
    expect(probabilityFor(cal, 'long', 'green', 70).belowEvidence).toBe(false) // upward: the floor, not a guess
    // …and the p is identical in all three: the flag prices the read, it does not move it
    const ps = [30, 62.5, 70].map(x => probabilityFor(cal, 'long', 'green', x).p)
    expect(new Set(ps).size).toBe(1)
    // interpolation between two evidenced bands is never below either of them
    const two = calOf({ 'long:green:25-40': [40, 30], 'long:green:55-70': [40, 30] })
    expect(probabilityFor(two, 'long', 'green', 45).belowEvidence).toBe(false)
    expect(probabilityFor(two, 'long', 'green', 25).belowEvidence).toBe(true) // …below the FIRST midpoint, still flagged
    // the base-rate rung is not a curve read at all, so it is not flagged
    expect(probabilityFor(emptyCal(), 'long', 'green', 30).belowEvidence).toBe(false)
  })

  it('is NON-DECREASING in conviction for every bucket shape — the property, not an example', () => {
    // 400 pseudo-random rung shapes (deterministic LCG), each read across the
    // whole composite range. The old step function violated this on the live
    // seed; the curve may not violate it anywhere.
    let s = 12345
    const rnd = (m: number) => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * m
    for (let t = 0; t < 400; t++) {
      const rows: Record<string, [number, number]> = {}
      for (const band of ['25-40', '40-55', '55-70', '70+']) {
        const n = Math.floor(rnd(300))
        if (n) rows[`long:green:${band}`] = [n, Math.floor(rnd(n + 1))]
      }
      const cal = calOf(rows)
      let prev = -Infinity
      for (let x = 20; x <= 100; x += 2.5) {
        const { p } = probabilityFor(cal, 'long', 'green', x)
        expect(p).toBeGreaterThanOrEqual(prev - 1e-12)
        prev = p
      }
    }
  })
})

describe('probabilityFor — cap-class fallback ladder', () => {
  const hit = { excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true }
  const miss = { excessPct: -2, rawPct: -2, spyPct: 0, stopped: true, hit: false }

  it('rung 1 — the cohort+regime rung is taken as soon as it has ANY evidence', () => {
    const cal = emptyCal()
    cal.buckets['large:long:green:25-40'] = { n: 20, hits: 14 } // (14+2)/(20+4) = 0.6666667
    const r = probabilityFor(cal, 'long', 'green', 32.5, 'large')
    // One band → a one-point curve, flat everywhere. Its shrinkage target is NOT
    // itself: rung 1 shrinks toward rung 2's read, rung 2 toward rung 3's, rung 3
    // toward rung 4's and rung 4 toward the base rate (0.5 cold, n=20 < 50). Every
    // rung here is the same twenty observations, so with w = 20/45 = 0.4444444 at
    // each step: 0.5740741 → 0.6152263 → 0.6380887 → 0.6507900.
    expect(r.p).toBeCloseTo(0.6507900, 6)
    expect(r.provisional).toBe(false)
    expect(r.nEff).toBe(20)
  })

  it('rung 2 — an EMPTY cohort+regime rung falls through to the cohort pooled across regimes', () => {
    const cal = emptyCal()
    cal.buckets['large:long:red:25-40'] = { n: 20, hits: 12 } // (12+2)/(20+4) = 0.5833333
    const r = probabilityFor(cal, 'long', 'green', 32.5, 'large') // nothing green at all
    // rung 1 (large/green) is empty, so rung 2 is the read. Its parent chain skips
    // rung 3 (all cohorts/green — also empty) and lands on rung 4, which holds the
    // same twenty observations: 0.4444444×0.5833333 + 0.5555556×0.5 = 0.5370370,
    // then rung 2 = 0.4444444×0.5833333 + 0.5555556×0.5370370 = 0.5576132.
    expect(r.p).toBeCloseTo(0.5576132, 6)
    expect(r.provisional).toBe(false)
    expect(r.nEff).toBe(20)
  })

  it('THE RULE CHANGE — a thin rung is still the rung; thinness is reported by nEff, not fixed by borrowing another population', () => {
    // Before: a bucket under MIN_BUCKET_N was skipped and the read silently came
    // from a DIFFERENT population (all regimes pooled), arriving non-provisional.
    // Now the read stays where its evidence is, borrows from the rung below in
    // PROPORTION to how thin it is, and declares how much there is.
    //   base rate: n=30 < 50 → 0.5
    //   rung 4 (long, every regime) 25-40: 18/34 = 0.5294118, w = 30/55 = 0.5454545
    //     → 0.5454545×0.5294118 + 0.4545455×0.5 = 0.5160428
    //   red  (10 obs, 4/14 = 0.2857143, w = 10/35 = 0.2857143)
    //     → 0.2857143×0.2857143 + 0.7142857×0.5160428 = 0.4502346
    //   green (20 obs, 16/24 = 0.6666667, w = 20/45 = 0.4444444)
    //     → 0.4444444×0.6666667 + 0.5555556×0.5160428 = 0.5829867
    const cal = calOf({ 'long:green:25-40': [20, 14], 'long:red:25-40': [10, 2] })
    const red = probabilityFor(cal, 'long', 'red', 32.5)
    expect(red.p).toBeCloseTo(0.4502346, 6) // red's own ten observations, heavily borrowed against…
    expect(red.nEff).toBe(10)
    expect(red.provisional).toBe(true) // …and they are declared thin (was: 18/34, non-provisional)
    const green = probabilityFor(cal, 'long', 'green', 32.5)
    expect(green.p).toBeCloseTo(0.5829867, 6)
    expect(green.provisional).toBe(false)
    expect(green.p).toBeGreaterThan(red.p) // the two populations still say different things
  })

  it('rung 3 — empty cohort buckets fall through to the cohortless/seed pool (the NORMAL early path)', () => {
    const cal = emptyCal()
    cal.buckets['long:green:25-40'] = { n: 100, hits: 40 } // legacy/seed, cohortless
    // a large-cap call with NO cohort buckets yet uses the cohortless seed evidence
    const r = probabilityFor(cal, 'long', 'green', 30, 'large')
    expect(r.p).toBeCloseTo(42 / 104, 6)
    expect(r.provisional).toBe(false)
    expect(r.nEff).toBe(100)
    // rung 3 pools ACROSS cohorts too: add a small-cap bucket, it joins the pool
    cal.buckets['small:long:green:25-40'] = { n: 10, hits: 5 }
    const r2 = probabilityFor(cal, 'long', 'green', 30, 'large')
    expect(r2.p).toBeCloseTo(47 / 114, 6) // (40+5+2)/(100+10+4)
    expect(r2.nEff).toBe(110)
  })

  it('rung 4 — only a different regime has data → pooled across regimes, provisional when thin', () => {
    const cal = emptyCal()
    cal.buckets['long:red:25-40'] = { n: 8, hits: 4 } // cohortless, wrong regime, thin
    const r = probabilityFor(cal, 'long', 'green', 30, 'large')
    expect(r.p).toBeCloseTo(6 / 12, 6)
    expect(r.provisional).toBe(true) // nEff 8 < 15
    expect(r.nEff).toBe(8)
  })

  it('rung 5 — no bucket for this SIDE anywhere → the engine base rate, provisional', () => {
    const cal = emptyCal()
    cal.buckets['long:green:25-40'] = { n: 100, hits: 30 }
    cal.buckets['long:red:25-40'] = { n: 100, hits: 44 } // base rate (74+2)/(200+4) = 0.3725490
    const r = probabilityFor(cal, 'short', 'green', 30, 'large') // shorts: never graded, anywhere
    expect(r.p).toBeCloseTo((74 + 2) / (200 + 4), 6)
    expect(r.provisional).toBe(true)
    expect(r.nEff).toBe(0)
  })

  it('…and a 70+ call is NO LONGER a rung-5 read: it inherits its own side’s curve', () => {
    // The seed carries no 70+ bucket of any kind, so before the curve the
    // highest-conviction call the engine can make fell all the way to the global
    // base rate — a number computed from the OTHER side's losses as much as its
    // own. Now it flat-extends the side's own best-evidenced band.
    //   long/green 25-40: 32/104 = 0.3076923, w = 100/125 = 0.8, base 0.3725490
    //   rung 4 (long, every regime) = the same band → 0.8×0.3076923 + 0.2×0.3725490 = 0.3206636
    //   rung 3 = 0.8×0.3076923 + 0.2×0.3206636 = 0.3102866
    const cal = calOf({ 'long:green:25-40': [100, 30], 'short:red:25-40': [100, 44] })
    const r = probabilityFor(cal, 'long', 'green', 75, 'large')
    expect(r.p).toBeCloseTo(0.3102866, 6) // the long/green band itself, shrunk down the ladder
    expect(r.nEff).toBe(100)
    expect(r.provisional).toBe(false)
    expect(r.p).not.toBeCloseTo(baseHitRate(cal).rate, 3) // …and NOT the base rate it used to return
  })

  it('a KNOWN cohort prefers its own bucket; an UNKNOWN cap skips rungs 1–2 and pools everything', () => {
    const cal = emptyCal()
    cal.buckets['large:long:green:25-40'] = { n: 20, hits: 20 } // large cohort: strong
    cal.buckets['long:green:25-40'] = { n: 20, hits: 4 } // cohortless: weak
    // The large call reads its OWN bucket (22/24 = 0.9166667) and shrinks it down
    // the ladder — rungs 3/4 pool both buckets (26/44 = 0.5909091, w = 40/65) and
    // pull it toward the weak cohortless evidence, which is the point of a
    // hierarchy: 0.5559441 → 0.5774610 → 0.7282191 → 0.8119736.
    expect(probabilityFor(cal, 'long', 'green', 32.5, 'large').p).toBeCloseTo(0.8119736, 6)
    // unknown-cap call was never guessed into large → pools all (large+cohortless)
    const u = probabilityFor(cal, 'long', 'green', 32.5, 'unknown')
    expect(u.p).toBeCloseTo(0.5774610, 6) // 0.6153846×0.5909091 + 0.3846154×0.5559441
    expect(u.provisional).toBe(false)
    expect(u.nEff).toBe(40)
    expect(u.p).toBeLessThan(probabilityFor(cal, 'long', 'green', 32.5, 'large').p) // the cohort still wins where it is known
  })

  it('the default cohort arg is unknown → the two pooled rungs, exactly as a legacy caller got', () => {
    const cal = emptyCal()
    cal.buckets['long:green:25-40'] = { n: 20, hits: 14 }
    // no cohort passed → unknown → rungs 3 and 4 only: 0.5740741 then 0.6152263
    expect(probabilityFor(cal, 'long', 'green', 32.5).p).toBeCloseTo(0.6152263, 6)
    // …and that is genuinely fewer shrinkage steps than a known cohort gets
    expect(probabilityFor(cal, 'long', 'green', 32.5).p).toBeLessThan(
      probabilityFor(calOf({ 'large:long:green:25-40': [20, 14] }), 'long', 'green', 32.5, 'large').p,
    )
  })

  it('updateCalibration books into the cohort bucket by cap; unknown cap → the legacy cohortless key', () => {
    const cal = emptyCal()
    updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, capUsdM: 50_000 }, hit) // large
    updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, capUsdM: 500 }, miss) // small
    updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, capUsdM: null }, hit) // unknown
    updateCalibration(cal, { side: 'long', regime: 'green', composite: 30 }, hit) // no cap field → unknown
    expect(cal.buckets['large:long:green:25-40']).toEqual({ n: 1, hits: 1 })
    expect(cal.buckets['small:long:green:25-40']).toEqual({ n: 1, hits: 0 })
    expect(cal.buckets['long:green:25-40']).toEqual({ n: 2, hits: 2 }) // both unknowns pooled here
  })
})

// ---------------------------------------------------------------------------
// THE LADDER IS A HIERARCHY. Every rung's curve shrinks toward the rung BELOW it
// read at the same conviction — never toward its own pooled rate, which for a
// rung with one populated band is the band itself, i.e. no shrinkage at all.
// ---------------------------------------------------------------------------
describe('the parent is the rung BELOW, read at the same conviction', () => {
  it('ONE lucky observation in a fresh cohort bucket no longer reads its own 0.60', () => {
    // The demo that ratified this: the committed seed, plus a single graded
    // large-cap short in amber that happened to win.
    //   band: large:short:amber:25-40 n=1 hits=1 → (1+2)/(1+4) = 0.60, w = 1/26 = 0.0384615
    //   base rate now (285+1+2)/(779+4) = 0.3678161
    //   rung 4 (short, every regime, all cohorts) at 32.5:
    //     25-40 n=372 hits=129 → 131/376 = 0.3484043, 40-55 50/11 → 13/54 = 0.2407407
    //     PAVA pools the pair → 0.3356479 ; w = 372/397 = 0.9370277
    //     → 0.9370277×0.3356479 + 0.0629723×0.3678161 = 0.3376736
    //   rung 3 (short/amber, all cohorts) at 32.5: 25-40 109/34 → 36/113 = 0.3185841,
    //     40-55 19/4 → 0.2608696, PAVA pools → 0.3100171 ; w = 109/134 = 0.8134328
    //     → 0.8134328×0.3100171 + 0.1865672×0.3376736 = 0.3151769
    //   rung 2 (large/short, every regime): 0.0384615×0.60 + 0.9615385×0.3151769 = 0.3261316
    //   rung 1 (large/short/amber):         0.0384615×0.60 + 0.9615385×0.3261316 = 0.3366650
    const cal = seedShape()
    cal.buckets['large:short:amber:25-40'] = { n: 1, hits: 1 }
    const r = probabilityFor(cal, 'short', 'amber', 32.5, 'large')
    expect(r.p).toBeCloseTo(0.3366650, 6)
    expect(r.nEff).toBe(1)
    expect(r.provisional).toBe(true)
    // …and the whole point: it is a shadow, not a sized C. Under the old own-rung
    // parent this rung's pool WAS the band, shrinkage was the identity, and one
    // observation read 0.60 — comfortably over base 0.3678 → C → half the rung.
    expect(gradeFor(r.p, r.nEff, baseHitRate(cal).rate)).toBeNull()
    expect(gradeFor(0.6, 1, baseHitRate(cal).rate)).toBe('C') // what it used to be worth
  })

  it('the parent is the rung below AT THE SAME CONVICTION, not the rung’s own cross-band pool', () => {
    // short/red on the seed at 62.5 is the cleanest separation of the two rules.
    //   this rung's OWN pool: n=186 hits=59 → 61/190 = 0.3210526  (the old target)
    //   the rung below at 62.5: rung 4's 55-70 point = 0.2424242×0.5 + 0.7575758×0.3670077
    //                         = 0.3992482                          (the new target)
    //   with w = 8/33 = 0.2424242: old → 0.3644338, new → 0.4236729
    const r = probabilityFor(seedShape(), 'short', 'red', 62.5, 'large')
    expect(r.p).toBeCloseTo(0.4236729, 6)
    expect(r.p).not.toBeCloseTo(0.3644338, 4)
  })

  it('an empty rung is not a parent — the chain falls through to the next one that has evidence', () => {
    // large-cap long in GREEN, evidence only in red: rungs 1 and 3 are both empty.
    // Rung 2 is the read and its parent is rung 4 (see the rung-2 case above).
    const cal = calOf({ 'large:long:red:25-40': [20, 12] })
    expect(probabilityFor(cal, 'long', 'green', 32.5, 'large').p).toBeCloseTo(0.5576132, 6)
  })

  it('the bottom of the chain is the ENGINE base rate — a long is pulled toward a number the shorts helped set', () => {
    //   long/green 25-40 n=100 hits=40 → 42/104 = 0.4038462, w = 100/125 = 0.8
    //   base rate over BOTH sides: (60+2)/(200+4) = 0.3039216
    //   rung 4 = 0.8×0.4038462 + 0.2×0.3039216 = 0.3838612
    //   rung 3 = 0.8×0.4038462 + 0.2×0.3838612 = 0.3998492
    const cal = calOf({ 'long:green:25-40': [100, 40], 'short:red:25-40': [100, 20] })
    expect(probabilityFor(cal, 'long', 'green', 32.5).p).toBeCloseTo(0.3998492, 6)
  })

  it('is still NON-DECREASING in conviction with the parent chain in place', () => {
    // The property that stage 2 exists for, re-run against a two-cohort store so
    // every rung of the ladder is populated and the parent chain is four deep.
    let s = 987654
    const rnd = (m: number) => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * m
    for (let t = 0; t < 200; t++) {
      const rows: Record<string, [number, number]> = {}
      for (const prefix of ['large:long:green', 'large:long:red', 'long:green', 'long:red']) {
        for (const band of ['25-40', '40-55', '55-70', '70+']) {
          const n = Math.floor(rnd(120))
          if (n) rows[`${prefix}:${band}`] = [n, Math.floor(rnd(n + 1))]
        }
      }
      const cal = calOf(rows)
      let prev = -Infinity
      for (let x = 20; x <= 100; x += 2.5) {
        const { p } = probabilityFor(cal, 'long', 'green', x, 'large')
        expect(p).toBeGreaterThanOrEqual(prev - 1e-12)
        prev = p
      }
    }
  })
})

describe('gradeFor', () => {
  it('with the default 0.5 base: A needs p≥.60 AND nEff≥30; B needs p≥.55 AND nEff≥15; <.50 suppressed', () => {
    expect(gradeFor(0.65, 30)).toBe('A')
    expect(gradeFor(0.60, 30)).toBe('A') // the A edge, exactly on base+0.10
    expect(gradeFor(0.65, 29)).toBe('B') // conviction is there, the evidence is one observation short
    expect(gradeFor(0.5999, 999)).toBe('B') // …and no amount of evidence buys an A below base+0.10
    expect(gradeFor(0.56, 15)).toBe('B') // the B edge, exactly on MIN_BUCKET_N
    expect(gradeFor(0.65, 14)).toBe('C') // fourteen observations cannot say B, however good p looks
    expect(gradeFor(0.52, 40)).toBe('C')
    expect(gradeFor(0.49, 999)).toBeNull() // below base is below base — evidence does not rescue it
  })

  it('grades measure edge over the engine base rate — the same p is A, B or C by how much backs it', () => {
    // base 0.37 → A at 0.47, B at 0.42, C at 0.37
    expect(gradeFor(0.47, 30, 0.37)).toBe('A')
    expect(gradeFor(0.47, 29, 0.37)).toBe('B')
    expect(gradeFor(0.47, 14, 0.37)).toBe('C')
    expect(gradeFor(0.38, 500, 0.37)).toBe('C')
    expect(gradeFor(0.36, 500, 0.37)).toBeNull()
  })

  it('NO GRADE IS BORN BELOW ITS EVIDENCE — a downward-extended read caps at C', () => {
    // A and B are claims about a conviction the engine has actually watched. When
    // the read came from extending the lowest evidenced band DOWNWARD, it has
    // watched nothing at or under this conviction, so the claim is not available
    // — however good p looks and however deep the band it was borrowed from is.
    expect(gradeFor(0.9, 999, 0.5, true)).toBe('C')
    expect(gradeFor(0.9, 999, 0.5, false)).toBe('A') // …the same read, on evidence at-or-below it
    expect(gradeFor(0.56, 15, 0.5, true)).toBe('C') // the B it would otherwise be
    // It is a CAP, not a floor: below base is still no edge at all, and is still
    // suppressed rather than dressed up as a C.
    expect(gradeFor(0.4, 999, 0.5, true)).toBeNull()
    // …and the flag is off by default, so every legacy caller is unaffected
    expect(gradeFor(0.65, 30, 0.5)).toBe('A')
  })

  it('…end to end: a 40-observation 55-70 rung read at a 30-composite is a C, not an A', () => {
    // base 0.5 (cold, n=40 < 50); 55-70 40/30 → 32/44 = 0.7272727, w = 40/65 = 0.6153846
    //   rung 4: 0.6153846×0.7272727 + 0.3846154×0.5 = 0.6398601
    //   rung 3: 0.6153846×0.7272727 + 0.3846154×0.6398601 = 0.6936525
    // p clears base+0.10 and nEff 40 clears MIN_GRADE_A_N — the ONLY thing between
    // this and an A is that the engine has never graded a 30-composite long here.
    const cal = calOf({ 'long:green:55-70': [40, 30] })
    const low = probabilityFor(cal, 'long', 'green', 30)
    expect(low.p).toBeCloseTo(0.6936525, 6)
    expect(gradeFor(low.p, low.nEff, baseHitRate(cal).rate, low.belowEvidence)).toBe('C')
    const high = probabilityFor(cal, 'long', 'green', 62.5)
    expect(gradeFor(high.p, high.nEff, baseHitRate(cal).rate, high.belowEvidence)).toBe('A')
  })

  it('grade A is UNREACHABLE in cold start, and that is the design', () => {
    // baseHitRate returns a hard 0.5 until 50 observations exist (the cliff is
    // deliberately unchanged), so A needs p ≥ 0.60 from a bucket that cannot yet
    // have 30 observations behind it. A cold engine hands out no As.
    expect(baseHitRate(emptyCal()).rate).toBe(0.5)
    expect(gradeFor(0.59, 1000)).toBe('B')
    expect(gradeFor(0.99, 29)).toBe('B')
  })
})

// ---------------------------------------------------------------------------
// REFERENCE-ANCHORED GRADING (spec §9, ratified 2026-08-13). A board-driven deep
// seed RAISES the pooled base — the published population is selected — so grades
// measured against the pool answer "is a high-composite board row better than a
// low one?" and collapse to all-C. The reader asks a different question: "how
// much better is this pick than any ordinary candidate?". `referenceBase` stores
// the answer to THAT question (the unconditional gate-clearing rate, swept over
// the same window/universe by the emitter) and every grade threshold anchors to
// it. Absent — the committed gen-1 seed, every legacy blob — nothing moves.
// ---------------------------------------------------------------------------

/** The shape §9 describes: board-population buckets pooling to 0.42 (996 rows,
 * 418 hits → 420/1000), beside a reference of 0.37 swept over the unconditional
 * population. The two numbers 5pp apart is the whole of the finding. */
const referenceShape = (): CalibrationState => ({
  ...calOf({ 'long:green:55-70': [584, 282], 'long:green:70+': [412, 136] }),
  referenceBase: 0.37,
})

describe('gradeBaseRate — which number a grade is measured against', () => {
  it('is the stored referenceBase when a seed measured one', () => {
    const cal = referenceShape()
    expect(baseHitRate(cal).rate).toBeCloseTo(0.42, 12) // the pool is still the pool…
    expect(gradeBaseRate(cal)).toBe(0.37) // …and the grade anchor is not it
  })

  it('falls back to the pooled base when absent — the committed seed is untouched', () => {
    expect(gradeBaseRate(seedShape())).toBe(baseHitRate(seedShape()).rate)
    expect(gradeBaseRate(seedShape())).toBeCloseTo(0.3670077, 7)
    // …including the cold-start cliff, which the fallback inherits whole
    expect(gradeBaseRate(emptyCal())).toBe(0.5)
  })

  it('migrateCalibration NEVER invents one — absence is a claim, not a gap', () => {
    // seedGeneration/modelVersion are backfilled because absence there means a
    // known value (generation 1). Absence here means "no sweep ever measured a
    // reference for this blob", and defaulting it to the pool would be the same
    // number by a different name — with a stored field that later swaps could
    // not distinguish from a measured one.
    const cal = migrateCalibration({ buckets: {}, brier: [] })
    expect('referenceBase' in cal).toBe(false)
    expect(cal.referenceBase).toBeUndefined()
    // …and a stored one survives the migration exactly as written
    expect(migrateCalibration(referenceShape()).referenceBase).toBe(0.37)
  })

  it('the COMMITTED seed carries its swept reference — grades anchor to it, not the pool', () => {
    // Generation 3 shipped 2026-08-13 (the frozen-vector re-walk): referenceBase
    // 0.4158, measured by the unconditional sweep over the walk's own 166-symbol
    // universe (4,178 rows). The number is UNCHANGED from generation 2 on purpose
    // and is the cleanest evidence that the anchor is what it claims to be: the
    // sweep runs `seedFromHistory` over the raw tape, so it never touches the
    // factor stack and cannot move when the scoring vector does. Generation 3's
    // BUCKETS moved a great deal (long:green:70+ 1270 rows → 26); the yardstick
    // they are read against did not budge.
    const committed = seedJson.calibration as unknown as CalibrationState
    expect(committed.referenceBase).toBe(0.4158)
    expect(gradeBaseRate(committed)).toBe(0.4158)
    expect(gradeBaseRate(committed)).not.toBe(baseHitRate(committed).rate) // pool 0.4161 — close, NOT equal
  })
})

describe('the COMMITTED seed was measured under the vector production scores with', () => {
  // Generation 2 shipped `current` carrying the walk's ~450 compounding nudges —
  // technical 0.0791 against a base of 1.0, momentum pinned at the 2× cap and 73 %
  // of a weight-normalised composite — which `loadState` installs verbatim as
  // production's scoring vector. Nothing downstream reacts to a drifted `current`
  // (`rebaseWeights` only ever compares BASE with DEFAULT_WEIGHTS), so this is the
  // assertion that keeps the committed artefact honest. The emitter refuses to
  // write an unpinned one; this refuses to commit one.
  it('ships current === base === DEFAULT_WEIGHTS, the owner-ratified factor order', () => {
    const w = seedJson.weights as unknown as WeightsState
    expect(w.base).toEqual(DEFAULT_WEIGHTS)
    expect(w.current).toEqual(DEFAULT_WEIGHTS)
    expect(w.current).toEqual(w.base)
    expect(w.current.technical).toBe(1) // the #1 factor, switched off at 0.0791 in generation 2
    expect(w.current.technical).toBeGreaterThan(w.current.momentum) // charts before extension (spec §4.2)
    expect(w.current.momentum).toBeGreaterThan(w.current.sector) // …and sector last of the core four
  })
  it('kept MEASURING while the applied vector was pinned — the IC is the walk’s', () => {
    // A frozen vector that also froze the measurement would satisfy the test above
    // vacuously and ship a seed with no factor evidence at all.
    const w = seedJson.weights as unknown as WeightsState
    for (const f of ['technical', 'momentum', 'sector', 'seasonality'] as const) expect(w.ic[f].nAgree + w.ic[f].nDisagree).toBeGreaterThan(0)
    expect(w.history.length).toBeGreaterThan(0)
  })
})

describe('gradeFor anchored to a referenceBase', () => {
  const ref = () => gradeBaseRate(referenceShape()) // 0.37
  const pooled = () => baseHitRate(referenceShape()).rate // 0.42

  it('a 0.43 read on 40 observations is a B against the reference — and a C against the pool', () => {
    // THE finding, in one line: long:green 55-70 read 48.3% while the pool it was
    // measured against had risen to 41.6%, so the board graded C at every rung.
    expect(gradeFor(0.43, 40, ref())).toBe('B')
    expect(gradeFor(0.43, 40, pooled())).toBe('C') // what the deep seed did to all 531 rows
  })

  it('A stays rare but reachable: 0.48 clears reference + 0.10 on 40 observations', () => {
    expect(gradeFor(0.48, 40, ref())).toBe('A')
    expect(gradeFor(0.48, 29, ref())).toBe('B') // the evidence gate is untouched
    expect(gradeFor(0.48, 14, ref())).toBe('C')
    expect(gradeFor(0.48, 40, pooled())).toBe('B') // …one whole rung lower against the pool
  })

  it('the null floor moved WITH the thresholds — below the reference is no edge', () => {
    expect(gradeFor(0.36, 999, ref())).toBeNull()
    expect(gradeFor(0.37, 999, ref())).toBe('C') // exactly on the reference is a C, not a suppression
    // …and a row between the reference and the pool is now VISIBLE (unsized, per
    // §3's board-never-blank rule) where the pooled anchor suppressed it entirely
    expect(gradeFor(0.40, 999, pooled())).toBeNull()
    expect(gradeFor(0.40, 999, ref())).toBe('C')
  })

  it('belowEvidence still caps at C, and still does not rescue a below-reference read', () => {
    expect(gradeFor(0.48, 40, ref(), true)).toBe('C') // the A it would otherwise be
    expect(gradeFor(0.43, 40, ref(), true)).toBe('C') // the B it would otherwise be
    expect(gradeFor(0.36, 999, ref(), true)).toBeNull() // a cap, never a floor
  })
})

describe('REGRESSION PIN — with no referenceBase, every grade is byte-for-byte today’s', () => {
  it('anchors every shape production actually carries to its OWN pooled base', () => {
    // The one guarantee the addendum makes about production: live behaviour does
    // not move until a generation-2+ seed installs. On these states — the committed
    // seed, a cold store, a sub-50 store, a warm board population — no reference has
    // ever been measured, so the anchor a grade is struck against IS the pooled base
    // and nothing downstream can tell the two apart.
    const states: [string, CalibrationState][] = [
      ['committed seed', seedShape()],
      ['cold store', emptyCal()],
      ['sub-50 store (base cliff)', calOf({ 'long:green:25-40': [40, 18] })],
      ['warm board population', calOf({ 'long:green:55-70': [584, 282], 'long:green:70+': [412, 136] })],
      // the committed artefact left this list 2026-08-13: generation 2 CARRIES a
      // reference, and its own pin above asserts the anchored behaviour
    ]
    for (const [label, state] of states) {
      expect(state.referenceBase, label).toBeUndefined()
      const pooled = baseHitRate(state).rate
      expect(gradeBaseRate(state), label).toBe(pooled)
    }
  })

  it('grades the committed seed EXACTLY these letters — a golden table, not a re-derivation', () => {
    // What stood here was a 1,200-cell matrix comparing gradeFor(…, gradeBaseRate(s))
    // with gradeFor(…, pooled) — identical arguments on both sides once the line
    // above is proved, so it would have passed for ANY implementation of gradeFor,
    // including one that returned 'A' for everything. The letters are written out by
    // hand instead, off the anchor the committed seed actually carries:
    //   base   = (285+2)/(778+4) = 0.3670077   → C at or above it, null below
    //   base+0.05 = 0.4170077, with nEff ≥ 15  → B
    //   base+0.10 = 0.4670077, with nEff ≥ 30  → A
    const anchor = gradeBaseRate(seedShape())
    expect(anchor).toBeCloseTo(0.3670077, 7) // the number every letter below was read off
    const GOLDEN: [p: number, nEff: number, grade: 'A' | 'B' | 'C' | null][] = [
      [0, 100, null],
      [0.2, 100, null],
      [0.3669, 100, null], // a ten-thousandth under the anchor is still no edge
      [0.367, 100, null], // …and so is 0.367 itself: the anchor is 0.3670077, not 0.367
      [0.3671, 0, 'C'], // at the anchor, C — the only rung with no evidence floor at all
      [0.4, 0, 'C'],
      [0.4166, 100, 'C'], // short of anchor + 0.05, however deep the bucket
      [0.4171, 14, 'C'], // clears B's threshold; fourteen observations do not clear its floor
      [0.4171, 15, 'B'],
      [0.42, 100, 'B'],
      [0.467, 100, 'B'], // 0.4670 < 0.4670077 — a ten-thousandth short of an A
      [0.4671, 29, 'B'], // clears A's threshold; twenty-nine observations do not
      [0.4671, 30, 'A'],
      [0.6, 30, 'A'],
      [0.75, 29, 'B'],
      [1, 0, 'C'], // certainty on no evidence at all is still only a C
    ]
    for (const [p, nEff, grade] of GOLDEN) expect(gradeFor(p, nEff, anchor), `p=${p} nEff=${nEff}`).toBe(grade)
    // belowEvidence is a CAP over the same table: every letter becomes C, every null stays null
    for (const [p, nEff, grade] of GOLDEN) expect(gradeFor(p, nEff, anchor, true), `below p=${p} nEff=${nEff}`).toBe(grade === null ? null : 'C')
    // …and the cold store's 0.5 anchor, the other shape production carries: A needs
    // 0.60 from a bucket that cannot yet hold 30 observations, so a cold engine
    // hands out none (baseHitRate's deliberate cliff).
    const cold = gradeBaseRate(emptyCal())
    expect(cold).toBe(0.5)
    expect(gradeFor(0.49, 100, cold)).toBeNull()
    expect(gradeFor(0.5, 0, cold)).toBe('C')
    expect(gradeFor(0.55, 100, cold)).toBe('B')
    expect(gradeFor(0.6, 30, cold)).toBe('A')
  })

  it('…and the end-to-end read path on the committed seed grades exactly as before', () => {
    // probabilityFor is UNCHANGED by the addendum (bucket probabilities stay
    // board-population); this pins that the grade it feeds is too.
    for (const side of ['long', 'short'] as const)
      for (const regime of ['green', 'amber', 'red'])
        for (const x of [26, 32.5, 40, 47.5, 55, 62.5, 70, 77.5, 90]) {
          const r = probabilityFor(seedShape(), side, regime, x)
          expect(gradeFor(r.p, r.nEff, gradeBaseRate(seedShape()), r.belowEvidence)).toBe(
            gradeFor(r.p, r.nEff, baseHitRate(seedShape()).rate, r.belowEvidence),
          )
        }
  })
})

// ---------------------------------------------------------------------------
// THE SHIP GATE. Stage 2 Task 2 re-based the weights and v3 composites can now
// actually reach the 55-70 band. On the committed seed that band holds EIGHT
// short observations and read a flat 0.5 — which the old gradeFor turned into a
// B, i.e. a full-size trade off eight data points (spec §2.4). This is the pin
// that says it cannot happen again.
// ---------------------------------------------------------------------------
describe('SHIP GATE — the thin 55-70 short can no longer buy a B', () => {
  it('the seed’s base rate is unchanged — the gate is about evidence, not about moving the bar', () => {
    expect(baseHitRate(seedShape()).rate).toBeCloseTo(287 / 782, 7) // 0.3670077
    expect(baseHitRate(seedShape()).n).toBe(778)
  })

  it('a 55-70 SHORT in red — the band that actually holds the eight observations — is not a B', () => {
    // rung 4 (all cohorts, every regime) is the parent, and it is built first:
    //   25-40 371/128 → 130/375 = 0.3466667 ; 40-55 50/11 → 13/54 = 0.2407407 ← inversion
    //   PAVA pools the pair: (0.3466667×371 + 0.2407407×50)/421 = 0.3340864
    //   55-70 8/4 → 6/12 = 0.5 (no violation above)
    //   shrunk toward base 0.3670077:
    //     32.5 w=371/396=0.9368687 → 0.3361648
    //     47.5 w= 50/75 =0.6666667 → 0.3450602
    //     62.5 w=  8/33 =0.2424242 → 0.3992482
    // rung 3 (all cohorts, regime red): 25-40 147/48 → 50/151 = 0.3311258
    //                                   40-55  31/7  → 9/35   = 0.2571429   ← inversion
    //                                   55-70   8/4  → 6/12   = 0.5
    // PAVA pools the first two: (0.3311258×147 + 0.2571429×31)/178 = 0.3182412
    // each band shrinks toward rung 4's read AT ITS OWN MIDPOINT:
    //   32.5 w=147/172=0.8546512 → 0.8546512×0.3182412 + 0.1453488×0.3361648 = 0.3208463
    //   47.5 w= 31/56 =0.5535714 → 0.5535714×0.3182412 + 0.4464286×0.3450602 = 0.3302139
    //   62.5 w=  8/33 =0.2424242 → 0.2424242×0.5       + 0.7575758×0.3992482 = 0.4236729
    // read at |composite| 60: t = (60−47.5)/15 = 0.8333333
    //   p = 0.3302139 + 0.8333333×(0.4236729 − 0.3302139) = 0.4080964
    //   nEff = min(31, 8) = 8
    const r = probabilityFor(seedShape(), 'short', 'red', 60, 'large')
    expect(r.p).toBeCloseTo(0.4080964, 6)
    expect(r.nEff).toBe(8) // …and NOT the 178 the pooled PAVA block would have claimed
    expect(r.provisional).toBe(true)
    expect(r.belowEvidence).toBe(false) // 60 sits between two evidenced midpoints
    const g = gradeFor(r.p, r.nEff, baseHitRate(seedShape()).rate, r.belowEvidence)
    // THE GATE, and it holds: eight observations may not buy a B, whatever p is.
    expect(g === 'A' || g === 'B').toBe(false)
    expect(g).toBe('C') // half the rung at most, and only with the full contract
    // …and this is a RATIFIED behaviour change to record, not an accident. Under
    // the own-rung parent this read was 0.3569442 — below base 0.3670077, i.e. a
    // shadow. The hierarchy raised it because at 62.5 the ONLY evidence anywhere
    // in the store is these same eight observations: the rung below cannot
    // contradict them, so the cross-band dilution that produced the shadow (the
    // rung's own pool, 0.3210526, dominated by 147 low-conviction observations)
    // is gone and the target is 0.3992482 instead. The 8 therefore speak with a
    // net weight of 1 − (1 − 0.2424242)² = 0.4260 rather than 0.2424 [carried
    // forward in the task-3 report as the double-count concern].
    expect(gradeFor(0.3569442, 8, baseHitRate(seedShape()).rate)).toBeNull() // what it read before
  })

  it('…and even at the OLD read of 0.5, eight observations grade C — nEff is the thing that kills the B', () => {
    // This is the arithmetic in one line. The old gradeFor took (0.5, provisional
    // true, capacity ≥ 0) and returned B because its B rung tested neither.
    expect(gradeFor(0.5, 8, 0.3670077)).toBe('C')
    expect(gradeFor(0.5, 15, 0.3670077)).toBe('B') // fifteen and it may speak
  })

  it('no regime lets a 55-70 short reach B — green and amber are checked too', () => {
    // green reads 0.3955375 on 116 observations (C), amber 0.3276646 on 19 (below
    // base → shadow), red 0.3831740 → 0.4236729 on EIGHT (C). Not one is A or B,
    // and the binding constraint differs in each: p in green, p in amber, nEff in
    // red. That is three independent reasons, which is what makes this a gate.
    const base = baseHitRate(seedShape()).rate
    for (const regime of ['green', 'amber', 'red']) {
      for (const x of [56, 60, 65, 69.9]) {
        const r = probabilityFor(seedShape(), 'short', regime, x, 'large')
        const g = gradeFor(r.p, r.nEff, base, r.belowEvidence)
        expect(g === 'A' || g === 'B').toBe(false)
      }
    }
  })

  it('the 70+ short — the very top of the engine’s conviction — is honest rather than flattering', () => {
    // Flat extension from 55-70, so it can never fall below it, and it is still
    // the eight-observation read: C at most, whatever else changes around it.
    const base = baseHitRate(seedShape()).rate
    const r = probabilityFor(seedShape(), 'short', 'red', 80, 'large')
    expect(r.p).toBeCloseTo(0.4236729, 6)
    expect(r.p).toBeGreaterThanOrEqual(probabilityFor(seedShape(), 'short', 'red', 69.9, 'large').p)
    expect(r.nEff).toBe(8)
    expect(gradeFor(r.p, r.nEff, base, r.belowEvidence)).toBe('C')
  })

  it('the LOW end of the same seed is capped by its evidence: a 30-composite long in amber is a C', () => {
    // long/amber holds ONE band, 25-40 88/38 → 40/92 = 0.4347826, w = 88/113 =
    // 0.7787611, parent rung 4 at 32.5 = 0.4004972 → 0.4271973 flat everywhere.
    // At 32.5 that is a B (base 0.3670077 + 0.05 = 0.4170077, nEff 88). At 30 the
    // number is identical — but it was handed DOWN from a band centred at 32.5,
    // and no long under 32.5 has ever been graded in amber, so it caps at C.
    const base = baseHitRate(seedShape()).rate
    const at30 = probabilityFor(seedShape(), 'long', 'amber', 30)
    const at325 = probabilityFor(seedShape(), 'long', 'amber', 32.5)
    expect(at30.p).toBeCloseTo(0.4271973, 6)
    expect(at30.p).toBeCloseTo(at325.p, 12) // the same number…
    expect(gradeFor(at30.p, at30.nEff, base, at30.belowEvidence)).toBe('C') // …two different grades
    expect(gradeFor(at325.p, at325.nEff, base, at325.belowEvidence)).toBe('B')
  })
})

describe('baseHitRate', () => {
  it('pools every bucket; defaults to 0.5 below 50 observations', () => {
    const cal = emptyCal()
    cal.buckets['long:green:25-40'] = { n: 100, hits: 30 }
    cal.buckets['short:red:25-40'] = { n: 100, hits: 44 }
    expect(baseHitRate(cal).rate).toBeCloseTo((74 + 2) / (200 + 4), 5)
    expect(baseHitRate(emptyCal()).rate).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// THE PROVENANCE PARTITION [stage 3c, task 1]. `BucketStat` gained optional
// `shadowN`/`shadowHits`; the keys did not move (poolBuckets still parses 3/4
// parts) and CALIB_DEF_VERSION is untouched — a hit still means what it meant.
//
// The rule these tests exist to hold: a row the reader could put money on is
// graded against evidence from rows the reader could have put money on. And the
// rule that makes it installable: ABSENCE of the sub-counts means "this evidence
// was never partitioned", so the sized read IS the pooled read on every legacy
// blob — the same absent-means-legacy pattern `referenceBase` uses.
// ---------------------------------------------------------------------------

/** `calOf` with the sub-counts: `[n, hits]` (unpartitioned) or `[n, hits, shadowN, shadowHits]`. */
const calPart = (rows: Record<string, number[]>): CalibrationState => ({
  buckets: Object.fromEntries(
    Object.entries(rows).map(([k, v]) => [k, v.length === 4 ? { n: v[0], hits: v[1], shadowN: v[2], shadowHits: v[3] } : { n: v[0], hits: v[1] }]),
  ),
  brier: [],
})

const PROBE_X = [25, 30, 32.5, 40, 47.5, 55, 62.5, 70, 77.5, 90]
const PROBE_SIDES = ['long', 'short'] as const
const PROBE_REGIMES = ['green', 'amber', 'red', 'unknown'] as const
const PROBE_COHORTS = ['large', 'small', 'unknown'] as const

describe('the provenance partition — sized rows grade against sized history', () => {
  describe('a blob with no sub-counts reads byte-identically in BOTH populations', () => {
    it('the COMMITTED generation-3 seed: same p, same nEff, same flags, every rung', () => {
      const committed = seedJson.calibration as unknown as CalibrationState
      // the fixture's own premise. The gen-3 seed predates the partition, so it
      // carries no sub-counts — and if a later generation ships some, this test
      // must fail loudly rather than keep passing while measuring nothing.
      expect(Object.values(committed.buckets).some(b => b.shadowN != null || b.shadowHits != null)).toBe(false)
      let probes = 0
      for (const side of PROBE_SIDES)
        for (const regime of PROBE_REGIMES)
          for (const cohort of PROBE_COHORTS)
            for (const x of PROBE_X) {
              // the DEFAULT is pooled (every existing call site is unchanged), and
              // the sized read of an unpartitioned blob must equal it exactly —
              // not close, equal, on all four returned fields
              const pooled = probabilityFor(committed, side, regime, x, cohort)
              expect(probabilityFor(committed, side, regime, x, cohort, 'pooled')).toEqual(pooled)
              expect(probabilityFor(committed, side, regime, x, cohort, 'sized')).toEqual(pooled)
              probes++
            }
      expect(probes).toBe(PROBE_SIDES.length * PROBE_REGIMES.length * PROBE_COHORTS.length * PROBE_X.length)
    })

    it('…and so do baseHitRate, curveFor and setupStat on that same seed', () => {
      const committed = seedJson.calibration as unknown as CalibrationState
      expect(baseHitRate(committed, 'sized')).toEqual(baseHitRate(committed))
      for (const side of PROBE_SIDES)
        for (const regime of [...PROBE_REGIMES, null])
          expect(curveFor(committed, side, 'any', regime, undefined, 'sized')).toEqual(curveFor(committed, side, 'any', regime))
      for (const key of Object.keys(committed.setupBuckets ?? {})) {
        const [setup, side, band] = key.split(':') as [string, 'long' | 'short', Band]
        expect(setupStat(committed, setup, side, band, 'sized')).toEqual(setupStat(committed, setup, side, band))
      }
    })

    it('migrateCalibration NEVER backfills a sub-count — absence is "never partitioned", not "no shadows"', () => {
      // The gen-3 seed's own aggregate says 2,249 of its 6,608 graded rows were
      // shadow. Writing `shadowN: 0` into each bucket would claim the opposite,
      // under a name no later reader could tell from a measured one — the exact
      // argument that keeps `referenceBase` out of the migration.
      const cal = migrateCalibration({ buckets: { 'long:green:25-40': { n: 10, hits: 4 } }, brier: [], seeded: true })
      expect(cal.buckets['long:green:25-40']).toEqual({ n: 10, hits: 4 })
      expect('shadowN' in cal.buckets['long:green:25-40']).toBe(false)
    })
  })

  describe('where a partition EXISTS, the sized read excludes the shadows', () => {
    it('a 60/40 sized/shadow bucket: the sized read is the 60, and it reads nothing like the 100', () => {
      // One bucket, so the rung's parent (all regimes pooled) is the same bucket
      // and the shrinkage is the identity: the curve IS the bucket, in whichever
      // population it is read. That isolates the partition from the hierarchy.
      const cal = calPart({ 'long:green:25-40': [100, 50, 40, 40] })
      // pooled: laplace(100, 50) = 52/104 = 0.5 on 100 observations
      const pooled = probabilityFor(cal, 'long', 'green', 32.5)
      expect(pooled.p).toBeCloseTo(0.5, 12)
      expect(pooled.nEff).toBe(100)
      // sized: n 100−40 = 60, hits 50−40 = 10 → laplace 12/64 = 0.1875. The forty
      // shadow rows were ALL winners; pooled they carried the bucket, sized they
      // are exactly what a reader was never offered.
      const sized = probabilityFor(cal, 'long', 'green', 32.5, 'unknown', 'sized')
      expect(sized.p).toBeCloseTo(0.1875, 12)
      expect(sized.nEff).toBe(60)
      expect(sized.provisional).toBe(false) // 60 ≥ MIN_BUCKET_N — thin is not the finding here
    })

    it('baseHitRate gains the same mode — and the fifty-observation cliff reads the SIZED n', () => {
      const cal = calPart({ 'long:green:25-40': [100, 50, 40, 40] })
      expect(baseHitRate(cal)).toEqual({ rate: 0.5, n: 100 })
      expect(baseHitRate(cal, 'sized').n).toBe(60)
      expect(baseHitRate(cal, 'sized').rate).toBeCloseTo(12 / 64, 12)
      // …and where the sized slice falls under fifty, the flat 0.5 applies to IT.
      // A partition can take a store back to the cold-start anchor, and that is
      // the honest answer: the engine has not watched fifty SIZED outcomes yet.
      const thin = calPart({ 'long:green:25-40': [100, 50, 60, 30] })
      expect(baseHitRate(thin).n).toBe(100)
      expect(baseHitRate(thin, 'sized')).toEqual({ rate: 0.5, n: 40 })
    })

    it('a bucket with NO sized evidence contributes no sized curve point — the empty-bucket rule, unchanged', () => {
      const cal = calPart({ 'long:green:25-40': [100, 40], 'long:green:55-70': [20, 18, 20, 18] })
      expect(curveFor(cal, 'long', 'any', 'green').map(p => p.mid)).toEqual([32.5, 62.5])
      expect(curveFor(cal, 'long', 'any', 'green', undefined, 'sized').map(p => p.mid)).toEqual([32.5])
      // so a 62.5 sized read is the FLAT upward extension of the band below it —
      // §4.2's floor — exactly as for a band that was never graded at all
      const sized = probabilityFor(cal, 'long', 'green', 62.5, 'unknown', 'sized')
      expect(sized.nEff).toBe(100)
      expect(sized.p).toBeCloseTo(probabilityFor(cal, 'long', 'green', 32.5, 'unknown', 'sized').p, 12)
      expect(sized.belowEvidence).toBe(false)
      expect(probabilityFor(cal, 'long', 'green', 62.5).nEff).toBe(20) // the pooled read still sees the shadows
    })

    it('a store whose every bucket is shadow has no sized evidence anywhere — and says so', () => {
      const cal = calPart({ 'long:green:25-40': [80, 40, 80, 40] })
      const sized = probabilityFor(cal, 'long', 'green', 32.5, 'unknown', 'sized')
      expect(sized.nEff).toBe(0)
      expect(sized.p).toBe(0.5) // rung 5: the cold base rate, and provisional with it
      expect(sized.provisional).toBe(true)
    })

    it('clamps at zero, and never lets a sub-count exceed its total', () => {
      // a corrupt blob must degrade to "no sized evidence" — never to a negative
      // n, and never to a hit count above the sample it came from
      const corrupt = calPart({ 'long:green:25-40': [10, 4, 99, 99] })
      expect(baseHitRate(corrupt, 'sized')).toEqual({ rate: 0.5, n: 0 })
      expect(curveFor(corrupt, 'long', 'any', 'green', undefined, 'sized')).toEqual([])
      const skewed = calPart({ 'long:green:25-40': [10, 10, 5, 0] }) // hits > the sized n
      const c = curveFor(skewed, 'long', 'any', 'green', undefined, 'sized')
      expect(c[0].n).toBe(5)
      expect(c[0].p).toBeLessThanOrEqual(1)
    })
  })

  describe('updateCalibration books the sub-counts by the row’s ACCRUAL stamp', () => {
    const hit = { excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true }
    const miss = { excessPct: -2, rawPct: -2, spyPct: 0, stopped: true, hit: false }

    it('the stamp outranks riskPct in BOTH directions — it is the shadow’s CAUSE, not the row’s size', () => {
      const cal = emptyCal()
      // A sized-stamped row at ZERO risk is the case the whole re-ratification is
      // about: a grade-null demotion carries no money and is still the band's own
      // record of what happened to it. It books no sub-count at all.
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, riskPct: 0, accrual: 'sized' }, hit)
      expect(cal.buckets['long:green:25-40']).toEqual({ n: 1, hits: 1 })
      // …and the converse holds too, so the stamp is genuinely the discriminator
      // rather than a hint riskPct could override.
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, riskPct: 1, accrual: 'shadow' }, miss)
      expect(cal.buckets['long:green:25-40']).toEqual({ n: 2, hits: 1, shadowN: 1, shadowHits: 0 })
      expect(baseHitRate(cal, 'sized')).toEqual({ rate: 0.5, n: 1 })
    })

    it('LEGACY FALLBACK — an unstamped row books by riskPct > 0, exactly as the shipped rule did', () => {
      const cal = emptyCal()
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, riskPct: 0.25 }, hit)
      // a door cap is momentum sizing, not an evidence deficiency: the reader
      // could put money on it, so it is sized-but-small and NOT a shadow. No
      // sub-count is written at all — a sized row leaves the bucket byte-identical
      // to what the pre-partition tree wrote.
      expect(cal.buckets['long:green:25-40']).toEqual({ n: 1, hits: 1 })
      expect(baseHitRate(cal, 'sized').n).toBe(1)
    })

    it('LEGACY FALLBACK — an unstamped riskPct 0 row is SHADOW: every row already stored keeps booking as it would have', () => {
      const cal = emptyCal()
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, riskPct: 1 }, hit)
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, riskPct: 0, shadow: true }, miss)
      expect(cal.buckets['long:green:25-40']).toEqual({ n: 2, hits: 1, shadowN: 1, shadowHits: 0 })
      expect(baseHitRate(cal).n).toBe(2)
      expect(baseHitRate(cal, 'sized').n).toBe(1)
      // a shadow WINNER books its hit into both counters, so the sized read loses
      // the win as well as the observation
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, riskPct: 0, shadow: true }, hit)
      expect(cal.buckets['long:green:25-40']).toEqual({ n: 3, hits: 2, shadowN: 2, shadowHits: 1 })
    })

    it('an ABSENT riskPct is not partitioned — the same absent-means-legacy rule the read side uses', () => {
      // Absence is a caller that did not answer the question, and the safe answer
      // is the pre-partition one: count it, partition nothing, and let the sized
      // read see exactly what the pooled read sees. (Both production callers —
      // engine.ts's grader and the seed walk — always supply it.)
      const cal = emptyCal()
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30 }, hit)
      expect(cal.buckets['long:green:25-40']).toEqual({ n: 1, hits: 1 })
      expect('shadowN' in cal.buckets['long:green:25-40']).toBe(false)
      expect(baseHitRate(cal, 'sized')).toEqual(baseHitRate(cal))
    })

    it('setupBuckets get the IDENTICAL treatment — the blend reads them sized', () => {
      const cal = emptyCal()
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, setup: 'velocity', riskPct: 0.5 }, hit)
      updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, setup: 'velocity', riskPct: 0 }, hit)
      expect(cal.setupBuckets!['velocity:long:25-40']).toEqual({ n: 2, hits: 2, shadowN: 1, shadowHits: 1 })
      expect(setupStat(cal, 'velocity', 'long', '25-40')).toEqual({ n: 2, hits: 2 })
      expect(setupStat(cal, 'velocity', 'long', '25-40', 'sized')).toEqual({ n: 1, hits: 1 })
      expect(setupStat(cal, 'reversal', 'long', '25-40', 'sized')).toEqual({ n: 0, hits: 0 }) // a family with nothing
    })

    it('the invariant holds over a mixed run: 0 ≤ shadowHits ≤ shadowN ≤ n, and shadowHits ≤ hits', () => {
      const cal = emptyCal()
      for (let i = 0; i < 200; i++)
        updateCalibration(
          cal,
          {
            side: i % 2 ? 'long' : 'short',
            regime: ['green', 'amber', 'red'][i % 3],
            composite: 25 + (i % 60),
            setup: ['velocity', 'reversal', 'continuation'][i % 3],
            riskPct: i % 3 === 0 ? 0 : 0.5,
          },
          i % 4 ? hit : miss,
        )
      for (const b of [...Object.values(cal.buckets), ...Object.values(cal.setupBuckets!)]) {
        expect(b.shadowN ?? 0).toBeGreaterThanOrEqual(0)
        expect(b.shadowN ?? 0).toBeLessThanOrEqual(b.n)
        expect(b.shadowHits ?? 0).toBeLessThanOrEqual(b.shadowN ?? 0)
        expect(b.shadowHits ?? 0).toBeLessThanOrEqual(b.hits)
      }
      // …and the two populations partition the whole: sized n + shadow n = pooled n
      const shadowN = Object.values(cal.buckets).reduce((s, b) => s + (b.shadowN ?? 0), 0)
      expect(shadowN).toBeGreaterThan(0) // the run really did book shadows
      expect(baseHitRate(cal, 'sized').n + shadowN).toBe(baseHitRate(cal).n)
    })

    // THE RECOVERY PIN — the defect the Task-1 review found, made unfailable.
    //
    // A band the sized read prices under the anchor grades NULL, and a grade-null
    // row publishes at riskPct 0. Under the shipped `riskPct > 0 ⇒ sized` rule
    // every one of those rows accrued as SHADOW, so the band's sized evidence
    // could never grow again however well its calls went: the sized read froze at
    // whatever it was on the day it dipped, while the pooled read — reading the
    // very same outcomes — recovered. That directly contradicts the invariant
    // engine.ts states in its own words at the grade-null branch ("buckets below
    // 50% can never earn their way back up"). The stamp is what un-seals it.
    it('THE RECOVERY PIN: a band under the anchor earns its way back up, because its demoted rows are SIZED evidence', () => {
      const anchor = 0.42
      // one bucket, so the base rate IS the bucket and the shrinkage hierarchy is
      // the identity in both populations — this test is about the partition, not
      // about the ladder.
      const seal = (stamp: 'sized' | undefined): CalibrationState => {
        const cal: CalibrationState = { buckets: { 'long:green:55-70': { n: 100, hits: 30 } }, brier: [], referenceBase: anchor }
        // 200 further calls in the same band at a TRUE 60% — the band is genuinely
        // good now, and every one of them published at zero size because the read
        // it was graded against still said "below the anchor".
        for (let i = 0; i < 200; i++)
          updateCalibration(
            cal,
            { side: 'long', regime: 'green', composite: 62, riskPct: 0, accrual: stamp },
            i < 120 ? { excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true } : { excessPct: -2, rawPct: -2, spyPct: 0, stopped: true, hit: false },
          )
        return cal
      }

      // Where it started: laplace(100, 30) = 32/104 = 0.3077, under the 0.42 anchor
      // → no grade, no size. Both branches begin here.
      const start: CalibrationState = { buckets: { 'long:green:55-70': { n: 100, hits: 30 } }, brier: [], referenceBase: anchor }
      const before = probabilityFor(start, 'long', 'green', 62.5, 'unknown', 'sized')
      expect(before.p).toBeCloseTo(32 / 104, 12)
      expect(gradeFor(before.p, before.nEff, gradeBaseRate(start), before.belowEvidence)).toBeNull()

      // STAMPED SIZED: the 200 demoted rows are the band's own recovery record.
      const recovered = seal('sized')
      expect(recovered.buckets['long:green:55-70']).toEqual({ n: 300, hits: 150 }) // no sub-count at all
      const after = probabilityFor(recovered, 'long', 'green', 62.5, 'unknown', 'sized')
      expect(after.p).toBeCloseTo(152 / 304, 12) // 0.5 — back over the bar
      expect(after.nEff).toBe(300)
      expect(gradeFor(after.p, after.nEff, gradeBaseRate(recovered), after.belowEvidence)).toBe('B')

      // UNSTAMPED (the shipped rule): the same 200 outcomes, booked as shadow.
      const sealed = seal(undefined)
      expect(sealed.buckets['long:green:55-70']).toEqual({ n: 300, hits: 150, shadowN: 200, shadowHits: 120 })
      const still = probabilityFor(sealed, 'long', 'green', 62.5, 'unknown', 'sized')
      expect(still.p).toBeCloseTo(32 / 104, 12) // the sized read never moved a hair
      expect(still.nEff).toBe(100)
      expect(gradeFor(still.p, still.nEff, gradeBaseRate(sealed), still.belowEvidence)).toBeNull()
      // …and this is the contradiction in one line: the POOLED read of those very
      // same outcomes recovered, so the band was demonstrably fine and only the
      // population that decides its grade was forbidden to notice.
      const pooled = probabilityFor(sealed, 'long', 'green', 62.5)
      expect(gradeFor(pooled.p, pooled.nEff, gradeBaseRate(sealed), pooled.belowEvidence)).toBe('B')
    })
  })

  describe('the review’s two read-side corners', () => {
    it('belowEvidence rides the SIZED read: a wholly-shadow band below leaves the sized curve starting high', () => {
      // The lower band exists and is graded — but every observation in it came
      // from a row nobody was offered. To a sized read the engine has watched
      // NOTHING at that conviction, so a read there is handed down from the band
      // above and may claim no more than a C, exactly as for a band that was never
      // graded at all. The pooled read of the same blob sits between two points
      // and claims what it likes.
      const cal = calPart({ 'long:green:25-40': [40, 20, 40, 20], 'long:green:55-70': [40, 24] })
      const pooled = probabilityFor(cal, 'long', 'green', 47.5)
      expect(pooled.belowEvidence).toBe(false)
      const sized = probabilityFor(cal, 'long', 'green', 47.5, 'unknown', 'sized')
      expect(sized.belowEvidence).toBe(true)
      expect(sized.nEff).toBe(40) // the 55-70 band's own n — the only sized evidence there is
      expect(sized.p).toBeGreaterThan(0.5) // p is unchanged by the flag; what it may CLAIM is not
      expect(gradeFor(sized.p, sized.nEff, 0.3, sized.belowEvidence)).toBe('C')
      expect(gradeFor(sized.p, sized.nEff, 0.3)).toBe('A') // …which is what the cap took away
    })

    it('a partitioned COHORT-TAGGED key partitions like any other — provenance lives in the value, never in the key', () => {
      // The 4-part key is the one place a fifth key part would have broken the
      // parse, which is why the sub-counts went into the value. A named cohort
      // still matches only its own tagged key, in either population.
      const cal = calPart({ 'large:long:green:55-70': [100, 60, 40, 40], 'long:green:55-70': [20, 8] })
      const flat = () => 0.5
      expect(curveFor(cal, 'long', 'large', 'green', flat).map(p => p.n)).toEqual([100])
      expect(curveFor(cal, 'long', 'large', 'green', flat)[0].p).toBeCloseTo(0.8 * (62 / 104) + 0.2 * 0.5, 12)
      expect(curveFor(cal, 'long', 'large', 'green', flat, 'sized').map(p => p.n)).toEqual([60]) // 100 − 40
      expect(curveFor(cal, 'long', 'large', 'green', flat, 'sized')[0].p).toBeCloseTo((60 / 85) * (22 / 64) + (25 / 85) * 0.5, 12)
      // 'any' pools the tagged key WITH the legacy cohortless one, sub-counts and all
      expect(curveFor(cal, 'long', 'any', 'green', flat, 'sized').map(p => p.n)).toEqual([80]) // 60 sized + 20 unpartitioned
      expect(curveFor(cal, 'long', 'any', 'green', flat).map(p => p.n)).toEqual([120])
      // …and the WRITE side reaches the 4-part key too: a known cap books into its
      // cohort bucket, and the stamp partitions it there
      const written = emptyCal()
      updateCalibration(
        written,
        { side: 'long', regime: 'green', composite: 62, capUsdM: 50_000, riskPct: 0, accrual: 'shadow' },
        { excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true },
      )
      expect(written.buckets['large:long:green:55-70']).toEqual({ n: 1, hits: 1, shadowN: 1, shadowHits: 1 })
      expect(curveFor(written, 'long', 'large', 'green', flat, 'sized')).toEqual([])
    })
  })
})

/** THE SETUP BLEND [stage 3c task 2, spec §4.3(c)]. `p = 0.7·p_ladder +
 * 0.3·p_setup`, and every condition on it is a pin below: sized evidence only,
 * n ≥ 30 only, the row's OWN family only, a sized read only. */
describe('the setup blend — a family that earned a voice gets 0.3 of one', () => {
  /** One main bucket, so the rung's parent is that same bucket and the shrinkage
   * is the identity: the ladder read IS laplace(bucket), which keeps every
   * assertion below about the BLEND rather than about the hierarchy. */
  const withSetups = (setups: Record<string, number[]>, main: Record<string, number[]> = { 'long:green:55-70': [100, 40] }): CalibrationState => ({
    ...calPart(main),
    setupBuckets: Object.fromEntries(
      Object.entries(setups).map(([k, v]) => [k, v.length === 4 ? { n: v[0], hits: v[1], shadowN: v[2], shadowHits: v[3] } : { n: v[0], hits: v[1] }]),
    ),
  })
  // 50 booked, 10 of them shadow → sized {n: 40, hits: 25} → laplace 27/44
  const EARNED = [50, 30, 10, 5]
  const P_SETUP = 27 / 44
  const read = (cal: CalibrationState, setup?: string, x = 62.5, population: 'sized' | 'pooled' = 'sized') =>
    probabilityFor(cal, 'long', 'green', x, 'unknown', population, setup)

  it('fires at sized n ≥ 30, and moves p by EXACTLY 0.3·(p_setup − p_ladder)', () => {
    const cal = withSetups({ 'continuation:long:55-70': EARNED })
    const ladder = read(cal)
    const blended = read(cal, 'continuation')
    expect(blended.p).toBeCloseTo(0.7 * ladder.p + 0.3 * P_SETUP, 12)
    expect(blended.p - ladder.p).toBeCloseTo(0.3 * (P_SETUP - ladder.p), 12)
  })

  it('the blend adjusts PRICE, not evidence mass: nEff, provisional and belowEvidence stay the ladder’s', () => {
    const cal = withSetups({ 'continuation:long:55-70': EARNED })
    const ladder = read(cal)
    const blended = read(cal, 'continuation')
    expect({ ...blended, p: ladder.p }).toEqual(ladder)
    expect(blended.nEff).toBe(100) // the MAIN bucket's n — the setup family's 40 buys no evidence
  })

  it('29 sized does not fire and 30 does — the earn-influence rule has one edge and it is sharp', () => {
    expect(read(withSetups({ 'continuation:long:55-70': [39, 25, 10, 5] }), 'continuation').p).toBeCloseTo(read(withSetups({}), 'continuation').p, 12)
    const at30 = withSetups({ 'continuation:long:55-70': [40, 25, 10, 5] })
    expect(read(at30, 'continuation').p).not.toBeCloseTo(read(at30).p, 6)
  })

  it('a shadow-diluted family stays mute: 40 booked with only 15 sized is 15, not 40', () => {
    const cal = withSetups({ 'continuation:long:55-70': [40, 25, 25, 15] })
    expect(read(cal, 'continuation').p).toBeCloseTo(read(cal).p, 12)
  })

  it('a POOLED read never blends — a shadow’s price stays the pure ladder', () => {
    const cal = withSetups({ 'continuation:long:55-70': EARNED })
    expect(read(cal, 'continuation', 62.5, 'pooled')).toEqual(read(cal, undefined, 62.5, 'pooled'))
  })

  it('a velocity row reads velocity:* and nothing else — a fat neighbouring family cannot leak into it', () => {
    const cal = withSetups({ 'velocity:long:55-70': EARNED, 'continuation:long:55-70': [4000, 400, 100, 10] })
    expect(read(cal, 'velocity').p).toBeCloseTo(0.7 * read(cal).p + 0.3 * P_SETUP, 12)
    // …and a family with no bucket at all is an absence, not a zero
    expect(read(cal, 'reversal').p).toBeCloseTo(read(cal).p, 12)
  })

  it('the setup key is the CALL’s band: the same family reads a different bucket at a different conviction', () => {
    const cal = withSetups({ 'continuation:long:25-40': EARNED, 'continuation:long:55-70': [4000, 4000, 1000, 1000] }, { 'long:green:25-40': [100, 40], 'long:green:55-70': [100, 40] })
    expect(read(cal, 'continuation', 32.5).p).toBeCloseTo(0.7 * read(cal, undefined, 32.5).p + 0.3 * P_SETUP, 12)
  })

  it('THE LEGACY ADJUDICATION: an unpartitioned setup bucket REFUSES to blend, however fat it is', () => {
    // Absent sub-counts are ambiguous by construction — a sized row writes no
    // sub-count, so "never partitioned" and "partitioned, all sized" are the same
    // bytes. And the ambiguity is not academic: a live blob holds the gen-3 seed's
    // unpartitioned setup buckets AND post-partition live accrual in ONE object,
    // so no store-level flag could disambiguate a single bucket either. The safe
    // reading of evidence that cannot prove it is sized is to add no influence.
    const cal = withSetups({ 'continuation:long:55-70': [4000, 3000] })
    expect(cal.setupBuckets!['continuation:long:55-70'].shadowN).toBeUndefined()
    expect(read(cal, 'continuation')).toEqual(read(cal))
    // the committed seed is exactly that blob, for every family it carries
    const committed = seedJson.calibration as unknown as CalibrationState
    for (const key of Object.keys(committed.setupBuckets ?? {})) {
      const [setup, side, band] = key.split(':') as [string, 'long' | 'short', Band]
      const x = { '25-40': 32.5, '40-55': 47.5, '55-70': 62.5, '70+': 77.5 }[band]
      expect(probabilityFor(committed, side, 'green', x, 'unknown', 'sized', setup)).toEqual(probabilityFor(committed, side, 'green', x, 'unknown', 'sized'))
    }
  })

  it('no setup argument → byte-identical to the pre-blend read, on every existing call site', () => {
    const cal = withSetups({ 'continuation:long:55-70': EARNED })
    expect(read(cal)).toEqual(probabilityFor(cal, 'long', 'green', 62.5, 'unknown', 'sized'))
    expect(read(cal, undefined, 62.5, 'pooled')).toEqual(probabilityFor(cal, 'long', 'green', 62.5))
  })
})

describe('gradePrediction', () => {
  const spy = mkCandles(500, 0) // flat benchmark
  it('clean long hit: +2/day for 5 sessions from 100 → ~+10% excess', () => {
    const candles = mkCandles(100, 2)
    const o = gradePrediction({ date: '2026-01-06', side: 'long', priceAtPrediction: 100, stop: 90 }, candles, spy, 5)!
    expect(o.stopped).toBe(false)
    expect(o.hit).toBe(true)
    expect(o.excessPct).toBeGreaterThan(8)
  })
  it('wick through the stop is survivable: closes hold above → not stopped, hit stands', () => {
    const candles = mkCandles(100, 2, 30, 15) // lows dip 15 below close → wicks pierce a 95 stop, closes never do
    const o = gradePrediction({ date: '2026-01-06', side: 'long', priceAtPrediction: 100, stop: 95 }, candles, spy, 5)!
    expect(o.stopped).toBe(false)
    expect(o.hit).toBe(true)
  })
  it('a CLOSE through the stop = miss forever, even if price recovers by the horizon', () => {
    // bar 2 closes at 94, through the 95 stop; then recovers to 112 by the 5-session mark
    const closes = [100, 100, 94, 100, 104, 108, 112, 114, 116]
    const candles: Candle[] = closes.map((c, i) => ({
      t: Date.parse('2026-01-05') / 1000 + i * 86_400,
      o: c, h: c + 1, l: c - 1, c, v: 1_000_000,
    }))
    const o = gradePrediction({ date: '2026-01-06', side: 'long', priceAtPrediction: 100, stop: 95 }, candles, spy, 5)!
    expect(o.stopped).toBe(true)
    expect(o.hit).toBe(false)
    expect(o.rawPct).toBeGreaterThan(0) // the recovery is real — but the stop close-through already ended the trade
  })
  it('short grading flips the sign', () => {
    const candles = mkCandles(100, -2) // falling
    const o = gradePrediction({ date: '2026-01-06', side: 'short', priceAtPrediction: 100, stop: 110 }, candles, spy, 5)!
    expect(o.hit).toBe(true)
    expect(o.excessPct).toBeGreaterThan(8)
  })
  it('grades from the entry OPEN, not the prior close: a long that gaps up overnight then fades is a MISS', () => {
    // prior close 100, but the entry session OPENS at 115 (gap up) and drifts to
    // close 112 by the 5-session mark. From the prior close this looks like +12%;
    // from the only fillable print (the open) it is −2.6% — an honest miss.
    const candles = seq([
      { o: 100, c: 100 }, // prior session
      { o: 115, c: 114 }, // entry session — gaps up
      { o: 113, c: 113 },
      { o: 113, c: 112.8 },
      { o: 112.6, c: 112.5 },
      { o: 112.3, c: 112.2 },
      { o: 112, c: 112 }, // graded close (+5 sessions)
      { o: 112, c: 112 },
    ])
    const o = gradePrediction({ date: '2026-01-06', side: 'long', priceAtPrediction: 100, stop: 80 }, candles, spy, 5)!
    expect(o.stopped).toBe(false)
    expect(o.hit).toBe(false) // close-from-prior-close would have credited a fake +12% win
    expect(o.excessPct).toBeLessThan(0)
  })
  it('...and a long that gaps DOWN overnight then recovers off the open is a HIT', () => {
    // prior close 100, entry session OPENS at 90 (gap down), recovers to 95.
    // From the prior close that is −5% (looks like a loss); from the fillable
    // open it is +5.6% — the reader who filled at the open actually won.
    const candles = seq([
      { o: 100, c: 100 },
      { o: 90, c: 91 }, // entry session — gaps down
      { o: 92, c: 92 },
      { o: 93, c: 93 },
      { o: 94, c: 94 },
      { o: 94.5, c: 94.5 },
      { o: 95, c: 95 }, // graded close (+5 sessions)
      { o: 95, c: 95 },
    ])
    const o = gradePrediction({ date: '2026-01-06', side: 'long', priceAtPrediction: 100, stop: 80 }, candles, spy, 5)!
    expect(o.stopped).toBe(false)
    expect(o.hit).toBe(true)
    expect(o.excessPct).toBeGreaterThan(0)
  })
  it('too recent → null', () => {
    const candles = mkCandles(100, 2, 4)
    expect(gradePrediction({ date: '2026-01-06', side: 'long', priceAtPrediction: 100, stop: 90 }, candles, spy, 5)).toBeNull()
  })
  it('a marginal excess below HIT_EXCESS_MIN is not a hit — beating SPY by an epsilon is noise', () => {
    const candles = mkCandles(100, 0.1) // ~+0.5% over 5 sessions vs flat SPY
    const o = gradePrediction({ date: '2026-01-06', side: 'long', priceAtPrediction: 100, stop: 90 }, candles, spy, 5)!
    expect(o.stopped).toBe(false)
    expect(o.excessPct).toBeGreaterThan(0)
    expect(o.excessPct).toBeLessThan(1)
    expect(o.hit).toBe(false)
  })
})

describe('weight learning', () => {
  const pred = (side: 'long' | 'short', scores: Partial<Record<FactorName, number>>): Prediction =>
    ({
      side,
      factors: Object.fromEntries(
        Object.entries({ technical: null, momentum: null, sector: null, social: null, channels: null, insiders: null, news: null, seasonality: null, ...scores }).map(
          ([k, v]) => [k, { score: v, detail: '', weight: 1 }],
        ),
      ),
    }) as unknown as Prediction
  const win = { excessPct: 5, rawPct: 5, spyPct: 0, stopped: false, hit: true }

  it('updateIcStats books agreement by side', () => {
    let w = initWeights()
    w = updateIcStats(w, pred('long', { technical: 50, news: -10 }), win)
    expect(w.ic.technical.nAgree).toBe(1) // positive score, long side → agrees
    expect(w.ic.news.nDisagree).toBe(1)
    expect(w.ic.momentum.nAgree + w.ic.momentum.nDisagree).toBe(0) // null skipped
    expect(w.gradedSinceNudge).toBe(1)
  })

  it('maybeNudgeWeights: no-op under 15 graded; a TWO-SIDED factor drifts 15%; logs history', () => {
    let w = initWeights()
    // A factor the loop is allowed to act on now needs BOTH columns filled: 20
    // agreements that won big AND 20 disagreements that lost. ic maxes → +15%.
    for (let i = 0; i < 20; i++) {
      w = updateIcStats(w, pred('long', { technical: 50 }), { ...win, excessPct: 20 })
      w = updateIcStats(w, pred('long', { technical: -50 }), { ...win, excessPct: -20 })
    }
    const before = w.current.technical
    w = maybeNudgeWeights(w, '2026-07-01')
    expect(w.current.technical).toBeCloseTo(before * 1.15, 5)
    expect(w.current.technical).toBeLessThanOrEqual(1.5 * w.base.technical)
    expect(w.history).toHaveLength(1)
    expect(w.gradedSinceNudge).toBe(0)
    // under 15 since nudge → untouched
    w = updateIcStats(w, pred('long', { technical: 50 }), win)
    const cur = w.current.technical
    expect(maybeNudgeWeights(w, '2026-07-02').current.technical).toBe(cur)
  })

  it('a persistently wrong factor decays to the 0.5× floor and STOPS — the PRUNE_MIN_N path that crushed technical to 0.079 is gone', () => {
    let w = initWeights()
    const loss = { excessPct: -5, rawPct: -5, spyPct: 0, stopped: true, hit: false }
    for (let round = 0; round < 60; round++) {
      // always wrong, in both columns: agreeing costs, disagreeing pays
      for (let i = 0; i < 15; i++) {
        w = updateIcStats(w, pred('long', { technical: 50 }), loss)
        w = updateIcStats(w, pred('long', { technical: -50 }), win)
      }
      w = maybeNudgeWeights(w, '2026-07-03')
      expect(w.current.technical).toBeGreaterThanOrEqual(0.5 * w.base.technical - 1e-12)
    }
    // far past the retired PRUNE_MIN_N (200) — the floor used to LIFT here
    expect(w.ic.technical.nAgree).toBeGreaterThanOrEqual(900)
    expect(w.current.technical).toBeCloseTo(0.5 * w.base.technical, 9)
  })
})

/** THE BRAKES [stage 3c task 2]. The walk's failure mode, made unfailable.
 *
 * Two mechanisms, and they answer two different questions. The minDisagree floor
 * asks "has this factor ever been measured against itself?" — momentum's pinned
 * 1.8 rested on a mean of FIFTEEN disagreements against 5,697 agreements, which
 * is not an information coefficient, it is a rounding error with a direction. The
 * band asks "how far may the loop move a weight from the vector the owner
 * ratified?" — and it is ABSOLUTE, not a bound on the step, because a stored
 * vector that is already outside it (the gen-2 install: technical 0.0791,
 * momentum at the old 2× cap) would otherwise sit there forever, un-nudgeable
 * precisely because the floor it fails is the one that would have moved it. */
describe('the IC brakes — a nudge needs BOTH columns, and the band is absolute', () => {
  const names = Object.keys(DEFAULT_WEIGHTS) as FactorName[]
  /** A weights state parked one graded row short of nothing: the cadence is
   * satisfied, so every call to maybeNudgeWeights below actually runs the loop. */
  const ready = (): WeightsState => {
    const w = initWeights()
    w.gradedSinceNudge = 15
    return w
  }
  /** ic = clamp((meanAgree − meanDisagree)/10) — `dir` +1 pins it at +1, −1 at −1. */
  const twoSided = (nAgree: number, nDisagree: number, dir: 1 | -1): IcStat => ({
    nAgree,
    sumAgree: dir * 20 * nAgree,
    nDisagree,
    sumDisagree: dir * -20 * nDisagree,
  })

  it('nDisagree 15 NEVER nudges, at any number of agreements — the momentum failure, killed', () => {
    for (const nAgree of [20, 200, 5697]) {
      const w = ready()
      w.ic.momentum = { nAgree, sumAgree: 20 * nAgree, nDisagree: 15, sumDisagree: -20 * 15 }
      const before = w.current.momentum
      const after = maybeNudgeWeights(w, '2026-08-13')
      expect(after.current.momentum).toBe(before)
      expect(after.history[0].changes.momentum).toBeUndefined()
    }
  })

  it('…and the floor is symmetric: 15 agreements against 500 disagreements is equally mute', () => {
    const w = ready()
    w.ic.sector = { nAgree: 15, sumAgree: 300, nDisagree: 500, sumDisagree: -10_000 }
    expect(maybeNudgeWeights(w, '2026-08-13').current.sector).toBe(0.3)
  })

  it('20 AND 20 is the bar, and it is reachable — the brakes are not an off switch', () => {
    const w = ready()
    w.ic.sector = { nAgree: 20, sumAgree: 400, nDisagree: 20, sumDisagree: -400 }
    expect(maybeNudgeWeights(w, '2026-08-13').current.sector).toBeCloseTo(0.3 * 1.15, 12)
  })

  /** THE BOUNDARY, from both sides [fix wave]. `≥ 20 AND ≥ 20` is one line, and
   * an off-by-one on either column would leave the exact failure this floor
   * exists to kill (a mean read off nineteen observations) still nudgeable. 20/20
   * above is the first pass; these two are the last two fails. */
  it('19 agreements against 21 disagreements is mute — the floor is on EACH column, not the pair', () => {
    const w = ready()
    w.ic.sector = twoSided(19, 21, 1)
    const after = maybeNudgeWeights(w, '2026-08-13')
    expect(after.current.sector).toBe(0.3)
    expect(after.history[0].changes.sector).toBeUndefined()
  })

  it('…and 21 against 19 is equally mute — 40 observations between them buys nothing', () => {
    const w = ready()
    w.ic.sector = twoSided(21, 19, 1)
    const after = maybeNudgeWeights(w, '2026-08-13')
    expect(after.current.sector).toBe(0.3)
    expect(after.history[0].changes.sector).toBeUndefined()
  })

  /** WHO DECIDED THE VALUE [fix wave]. `repaired` counts the weights the CLAMP
   * decided, not the weights the IC floor skipped. The two coincided while the
   * only clamped weights were ineligible ones — but an ELIGIBLE factor sitting
   * out of band is nudged out further and clamped back, and the old counter said
   * nothing about the band on the very line that reports it. */
  it('an ELIGIBLE factor whose nudge the band overrules is reported as clamped — the line names what actually happened', () => {
    const w = ready()
    w.current.momentum = 1.8 // out of band (base 0.9 → [0.45, 1.35])
    w.ic.momentum = twoSided(40, 40, 1) // eligible, and pulling further up
    const after = maybeNudgeWeights(w, '2026-08-13')
    expect(after.current.momentum).toBeCloseTo(1.35, 12) // the clamp decided it, not 1.8 × 1.15
    expect(after.history[0].changes.momentum).toEqual({ from: 1.8, to: 1.35, ic: 1 }) // a real IC, overruled
    expect(after.history[0].evidence).toMatch(/1 weight\(s\) clamped into the \[0\.5×, 1\.5×\] band/)
  })

  it('a nudge the band did NOT touch is not reported as clamped', () => {
    const w = ready()
    w.ic.sector = twoSided(40, 40, 1) // 0.3 → 0.345, well inside
    const after = maybeNudgeWeights(w, '2026-08-13')
    expect(after.current.sector).toBeCloseTo(0.345, 12)
    expect(after.history[0].evidence).not.toMatch(/band/)
  })

  it('THE 500-NUDGE PIN: 500 compounding nudges with adversarial IC leave EVERY factor inside [0.5×, 1.5×]', () => {
    const w = ready()
    // the live blob's own out-of-band vector is the starting point, so the loop is
    // asked to hold a band it did not start inside
    w.current.technical = 0.0791
    w.current.momentum = 1.8
    w.current.seasonality = 5.75e-5
    let hi = -Infinity
    let lo = Infinity
    for (let round = 0; round < 500; round++) {
      // every factor pulling as hard as the loop allows, and the whole vector
      // reverses every 50 rounds — the compounding whipsaw the walk produced
      const up = round % 100 < 50
      names.forEach((name, i) => {
        // momentum keeps the fifteen disagreements it pinned itself with: the band
        // must hold for a factor that can never nudge, too
        const nDisagree = name === 'momentum' ? 15 : 40
        w.ic[name] = twoSided(40, nDisagree, (i % 2 === 0) === up ? 1 : -1)
      })
      w.gradedSinceNudge = 15
      maybeNudgeWeights(w, '2026-08-13')
      for (const name of names) {
        expect(w.current[name]).toBeGreaterThanOrEqual(0.5 * w.base[name] - 1e-12)
        expect(w.current[name]).toBeLessThanOrEqual(1.5 * w.base[name] + 1e-12)
      }
      hi = Math.max(hi, w.current.technical)
      lo = Math.min(lo, w.current.technical)
    }
    // …and the loop is not inert under the band: the whipsaw drove technical onto
    // BOTH edges, which is what makes the 500 assertions above a real containment
    // rather than a vector that never moved.
    expect(hi).toBeCloseTo(1.5, 9)
    expect(lo).toBeCloseTo(0.5, 9)
  })

  it('the band is ABSOLUTE, not a bound on the step: an out-of-band vector is repaired even where the floors forbid a nudge', () => {
    const w = ready()
    w.current.technical = 0.0791 // gen-2's crushed #1 factor
    w.current.momentum = 1.8 // the old 2× cap
    w.ic.momentum = { nAgree: 5697, sumAgree: 0, nDisagree: 15, sumDisagree: 0 } // ineligible, forever
    const after = maybeNudgeWeights(w, '2026-08-13')
    expect(after.current.momentum).toBeCloseTo(1.35, 12) // 1.5 × 0.9
    expect(after.current.technical).toBeCloseTo(0.5, 12) // 0.5 × 1.0
    // ic 0 is not a measurement — no IC did this, and the history line says so
    expect(after.history[0].changes.momentum).toEqual({ from: 1.8, to: 1.35, ic: 0 })
    expect(after.history[0].evidence).toMatch(/band/)
  })

  it('an in-band weight the floors skip is left exactly alone — the repair is not a reset', () => {
    const w = ready()
    w.current.technical = 1.07 // a learned drift, inside the band
    w.ic.technical = { nAgree: 900, sumAgree: 900, nDisagree: 3, sumDisagree: -3 }
    const after = maybeNudgeWeights(w, '2026-08-13')
    expect(after.current.technical).toBe(1.07)
    expect(after.history[0].changes).toEqual({})
    expect(after.history[0].evidence).not.toMatch(/band/)
  })
})

/** ZERO IS A READING — for some factors [stage 3c task 2, spec §4.3(b)].
 *
 * The shipped line skipped `score === 0` beside `score == null`, which quietly
 * deleted a whole population from the evidence: `newsFactor` returns 0 for a
 * QUIET TAPE and never returns null at all, so news IC has only ever been
 * measured on days something was written about the name. The split is per factor,
 * and the table (`ZERO_IS_A_READING`, composite.ts) is the adjudication. */
describe('zero is a READING for some factors and a silence for others', () => {
  const at = (side: 'long' | 'short', scores: Partial<Record<FactorName, number | null>>): Prediction =>
    ({
      side,
      factors: Object.fromEntries((Object.keys(DEFAULT_WEIGHTS) as FactorName[]).map(k => [k, { score: scores[k] ?? null, detail: '', weight: 1 }])),
    }) as unknown as Prediction
  const win = { excessPct: 5, rawPct: 5, spyPct: 0, stopped: false, hit: true }
  const booked = (name: FactorName, score: number | null, side: 'long' | 'short' = 'long') => {
    const w = updateIcStats(initWeights(), at(side, { [name]: score }), win)
    return w.ic[name].nAgree + w.ic[name].nDisagree
  }

  it('the table names every factor — a new factor cannot be silently omitted from the adjudication', () => {
    expect(Object.keys(ZERO_IS_A_READING).sort()).toEqual(Object.keys(DEFAULT_WEIGHTS).sort())
  })

  it('news, seasonality and insiders accrue a zero: each has a DELIBERATE zero branch and its own null for "we could not look"', () => {
    for (const name of ['news', 'seasonality', 'insiders'] as FactorName[]) {
      expect(ZERO_IS_A_READING[name]).toBe(true)
      expect(booked(name, 0)).toBe(1)
    }
  })

  it('everything else still skips a zero — a mute factor is not evidence against the call', () => {
    for (const name of ['technical', 'momentum', 'sector', 'social', 'channels', 'smartMoney', 'catalyst'] as FactorName[]) {
      expect(ZERO_IS_A_READING[name]).toBe(false)
      expect(booked(name, 0)).toBe(0)
    }
  })

  it('NULL always skips, whatever the table says — absence of data is never a reading', () => {
    for (const name of Object.keys(DEFAULT_WEIGHTS) as FactorName[]) expect(booked(name, null)).toBe(0)
    // the named pair from the plan, stated the way the plan states it
    expect(booked('seasonality', 0)).toBe(1)
    expect(booked('social', null)).toBe(0)
  })

  /** THE SILENCE SPLIT [fix wave]. `ZERO_IS_A_READING` adjudicates a FACTOR; the
   * flag adjudicates one READING of it. news is the case that forced it: the
   * table admits its zero because of the quiet-tape branch, but the identical 0
   * also falls out of a polarity tie on a loud tape — an arithmetic cancellation,
   * which is a silence by the table's own test. Only the factor knows which
   * happened, so the factor says so and the loop obeys it. */
  const flagged = (name: FactorName, side: 'long' | 'short' = 'long'): Prediction => {
    const p = at(side, { [name]: 0 })
    p.factors[name].silence = true
    return p
  }

  it('a SILENT zero is skipped even where the table admits the factor — a tie is not a reading', () => {
    const w = updateIcStats(initWeights(), flagged('news'), win)
    expect(w.ic.news).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
    expect(ZERO_IS_A_READING.news).toBe(true) // the factor is still admitted — this READING is not
  })

  it('…and the unflagged zero of the same factor still accrues: the quiet tape is the reading the split protects', () => {
    const w = updateIcStats(initWeights(), at('long', { news: 0 }), win)
    expect(w.ic.news.nAgree + w.ic.news.nDisagree).toBe(1)
  })

  it('the flag is a zero-only veto: it never suppresses a scored reading', () => {
    const p = at('long', { news: 40 })
    p.factors.news.silence = true // nonsense a factor never emits — the loop must still book the score
    expect(updateIcStats(initWeights(), p, win).ic.news.nAgree).toBe(1)
  })

  it('the cadence counter is untouched by a skipped reading — a graded row is a graded row', () => {
    expect(updateIcStats(initWeights(), flagged('news'), win).gradedSinceNudge).toBe(1)
  })

  it('an accrued zero books by the SAME side convention as any other score: not-toward-long', () => {
    // `score > 0 === (side === 'long')` is the convention the whole module uses,
    // and a zero is simply not a positive score. So a quiet tape counts AGAINST a
    // long and WITH a short — which is the honest reading of "no upward pressure",
    // and the asymmetry is documented at updateIcStats rather than special-cased.
    const long = updateIcStats(initWeights(), at('long', { news: 0 }), win)
    expect(long.ic.news).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 1, sumDisagree: 5 })
    const short = updateIcStats(initWeights(), at('short', { news: 0 }), win)
    expect(short.ic.news).toEqual({ nAgree: 1, sumAgree: 5, nDisagree: 0, sumDisagree: 0 })
  })
})

describe('migrateWeights', () => {
  // an old snapshot from before smartMoney existed — no key in base/current/ic
  const legacy = (): WeightsState => {
    const eight = { technical: 1, momentum: 0.8, sector: 0.6, social: 0.5, channels: 0.6, insiders: 0.4, news: 0.4, seasonality: 0.3 }
    return {
      base: { ...eight } as Record<FactorName, number>,
      current: { ...eight, technical: 0.92 } as Record<FactorName, number>, // a learned value that must survive
      ic: Object.fromEntries(Object.keys(eight).map(k => [k, { nAgree: 3, sumAgree: 1, nDisagree: 0, sumDisagree: 0 }])) as WeightsState['ic'],
      gradedSinceNudge: 4,
      history: [],
    }
  }

  it('backfills a factor missing from an old snapshot into base/current/ic', () => {
    const w = migrateWeights(legacy())
    expect(w.base.smartMoney).toBe(0.3)
    expect(w.current.smartMoney).toBe(0.3) // NOT silently zeroed
    expect(w.ic.smartMoney).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
  })

  it('leaves already-present (learned) values untouched and is idempotent', () => {
    const once = migrateWeights(legacy())
    expect(once.current.technical).toBe(0.92)
    expect(once.ic.technical.nAgree).toBe(3)
    const twice = migrateWeights(once)
    expect(twice.current.smartMoney).toBe(0.3)
    expect(twice.current.technical).toBe(0.92)
  })

  /** THE BAND HOLDS AT LOAD, NOT ONLY AT THE NUDGE [fix wave]. The band is an
   * invariant on `current`, and `maybeNudgeWeights` was the only thing enforcing
   * it — so a stored out-of-band vector went on SCORING BOARDS for up to fifteen
   * graded predictions before the repair fired. This is the same clamp, applied
   * on the load path that every board goes through, and it is deliberately here
   * rather than beside the nudge: `migrateWeights` is the function whose job is
   * "make a stored blob safe to score with". */
  const outOfBand = (): WeightsState => {
    const w = initWeights()
    w.current.technical = 0.0791 // gen-2's crushed #1 factor (base 1.0 → floor 0.5)
    w.current.momentum = 1.8 // the old 2× cap (base 0.9 → ceiling 1.35)
    w.current.sector = 0.31 // a learned drift, in band — must not move
    return w
  }

  it('clamps an out-of-band stored vector ON LOAD, before any board scores with it', () => {
    const w = migrateWeights(outOfBand(), DEFAULT_WEIGHTS, '2026-08-13')
    expect(w.current.technical).toBeCloseTo(0.5, 12)
    expect(w.current.momentum).toBeCloseTo(1.35, 12)
    expect(w.current.sector).toBe(0.31) // untouched
    expect(w.base).toEqual(DEFAULT_WEIGHTS) // the ratified vector is never rewritten by a repair
  })

  it('logs the repair the way the nudge logs one: what moved, ic 0, and the band named', () => {
    const w = migrateWeights(outOfBand(), DEFAULT_WEIGHTS, '2026-08-13')
    expect(w.history).toHaveLength(1)
    expect(w.history[0].date).toBe('2026-08-13')
    expect(w.history[0].changes).toEqual({
      technical: { from: 0.079, to: 0.5, ic: 0 }, // ic 0 — no measurement did this
      momentum: { from: 1.8, to: 1.35, ic: 0 },
    })
    expect(w.history[0].evidence).toMatch(/2 weight\(s\) clamped into the \[0\.5×, 1\.5×\] band/)
  })

  it('cannot re-fire: a second load finds an in-band vector and writes no second entry', () => {
    const once = migrateWeights(outOfBand(), DEFAULT_WEIGHTS, '2026-08-13')
    const twice = migrateWeights(once, DEFAULT_WEIGHTS, '2026-08-14')
    expect(twice.history).toHaveLength(1)
    expect(twice.current.technical).toBeCloseTo(0.5, 12)
    expect(twice.current.momentum).toBeCloseTo(1.35, 12)
  })

  it('an in-band vector is byte-identical through the load — no entry, no drift', () => {
    const before = migrateWeights(initWeights()) // the backfill pass alone
    const after = migrateWeights(JSON.parse(JSON.stringify(before)) as WeightsState, DEFAULT_WEIGHTS, '2026-08-13')
    expect(after).toEqual(before)
    expect(after.history).toEqual([])
  })

  it('the clamp reads the blob’s OWN base, and only after the backfill has filled it', () => {
    // a legacy blob missing smartMoney entirely, with a current far outside the
    // band of the base that is about to be backfilled for it
    const w = legacy()
    ;(w.current as Record<string, number>).smartMoney = 9
    const out = migrateWeights(w, DEFAULT_WEIGHTS, '2026-08-13')
    expect(out.base.smartMoney).toBe(0.3)
    expect(out.current.smartMoney).toBeCloseTo(0.45, 12) // 1.5 × 0.3, not left at 9
    // and a factor whose stored base differs from DEFAULT_WEIGHTS bands on the
    // stored one — rebaseWeights, not this, is what re-bases a vector
    expect(out.base.momentum).toBe(0.8)
    expect(out.current.momentum).toBe(0.8)
  })
})

// migrateWeights only ever fills nulls — deliberately, so a learned value is
// never clobbered — which is exactly why re-ordering DEFAULT_WEIGHTS would
// otherwise move the tests and the seed and NOTHING in production. This is the
// one path allowed to overwrite a stored vector, and the price of that power is
// that it throws away the evidence gathered under the old one.
describe('rebaseWeights', () => {
  const NEW = { technical: 1, momentum: 0.9, sector: 0.3, social: 0.5, channels: 0.5, insiders: 0.4, news: 0.5, seasonality: 0.3, smartMoney: 0.3, catalyst: 0.6 } as Record<FactorName, number>
  /** The v2-shaped blob production is actually carrying: the old base vector,
   *  a slightly drifted `current` from ~778 graded observations, and IC state. */
  const v2Blob = (): WeightsState => ({
    base: { technical: 1, momentum: 0.8, sector: 0.6, social: 0.5, channels: 0.6, insiders: 0.4, news: 0.4, seasonality: 0.3, smartMoney: 0.3, catalyst: 0.5 } as Record<FactorName, number>,
    current: { technical: 0.99312, momentum: 0.79587, sector: 0.6, social: 0.5, channels: 0.6, insiders: 0.4, news: 0.4, seasonality: 0.3, smartMoney: 0.3, catalyst: 0.5 } as Record<FactorName, number>,
    ic: {
      technical: { nAgree: 778, sumAgree: 240, nDisagree: 0, sumDisagree: 0 },
      momentum: { nAgree: 695, sumAgree: 180, nDisagree: 83, sumDisagree: -40 },
      sector: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
      social: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
      channels: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
      insiders: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
      news: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
      seasonality: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
      smartMoney: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
      catalyst: { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 },
    } as WeightsState['ic'],
    gradedSinceNudge: 7,
    history: [{ date: '2026-08-01', changes: {}, evidence: '15 predictions graded since last nudge' }],
  })

  it('re-bases base AND current onto the new vector — the stored blob is what scores', () => {
    const w = rebaseWeights(v2Blob(), NEW, '2026-08-12')
    expect(w.base).toEqual(NEW)
    expect(w.current).toEqual(NEW) // the 0.99312 drift belonged to the retired model
  })

  it('zeroes the IC state — evidence measured under the old vector cannot steer the new one', () => {
    const w = rebaseWeights(v2Blob(), NEW, '2026-08-12')
    for (const st of Object.values(w.ic)) expect(st).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
    expect(w.gradedSinceNudge).toBe(0) // …and the nudge cadence restarts with the evidence
  })

  it('records what moved, keeping the earlier history', () => {
    const w = rebaseWeights(v2Blob(), NEW, '2026-08-12')
    expect(w.history).toHaveLength(2)
    const entry = w.history[1]
    expect(entry.date).toBe('2026-08-12')
    expect(entry.evidence).toBe('stage-2 re-base to the owner-ordered vector')
    // from = what was actually scoring (current), to = the new vector
    expect(entry.changes.momentum).toEqual({ from: 0.796, to: 0.9, ic: 0 })
    expect(entry.changes.sector).toEqual({ from: 0.6, to: 0.3, ic: 0 })
    expect(entry.changes.technical).toEqual({ from: 0.993, to: 1, ic: 0 }) // drifted, so it moved
    expect(entry.changes.insiders).toBeUndefined() // 0.4 → 0.4 is not a change
  })

  it('fires EXACTLY ONCE against a v2 blob, then is a no-op forever', () => {
    let w = rebaseWeights(v2Blob(), NEW, '2026-08-12')
    // real evidence accrues under the NEW vector…
    w.ic.technical = { nAgree: 5, sumAgree: 12, nDisagree: 1, sumDisagree: -2 }
    w.current.technical = 1.04
    w.gradedSinceNudge = 3
    // …and two further loads must not touch a single field of it
    w = rebaseWeights(w, NEW, '2026-08-13')
    w = rebaseWeights(w, NEW, '2026-08-14')
    expect(w.ic.technical).toEqual({ nAgree: 5, sumAgree: 12, nDisagree: 1, sumDisagree: -2 })
    expect(w.current.technical).toBe(1.04)
    expect(w.gradedSinceNudge).toBe(3)
    expect(w.history).toHaveLength(2) // still just the one re-base entry
  })

  it('an identical base is untouched — a fresh install never loses its learning', () => {
    const fresh = initWeights(NEW)
    fresh.current.technical = 1.11
    fresh.ic.technical = { nAgree: 40, sumAgree: 90, nDisagree: 8, sumDisagree: -10 }
    const w = rebaseWeights(fresh, NEW, '2026-08-12')
    expect(w.current.technical).toBe(1.11)
    expect(w.ic.technical.nAgree).toBe(40)
    expect(w.history).toHaveLength(0)
  })

  it('a single changed key is enough, and a key the vector no longer has is dropped', () => {
    const one = initWeights(NEW)
    one.base.catalyst = 0.5 // one factor re-weighted
    const w = rebaseWeights(one, NEW, '2026-08-12')
    expect(w.base.catalyst).toBe(0.6)
    expect(w.history).toHaveLength(1)

    const stale = initWeights(NEW) as WeightsState & { base: Record<string, number>; current: Record<string, number> }
    stale.base.retired = 0.2
    stale.current.retired = 0.2
    const dropped = rebaseWeights(stale, NEW, '2026-08-12')
    expect(dropped.base).toEqual(NEW)
    expect('retired' in dropped.current).toBe(false)
  })

  it('survives a blob with no history array — this runs against state no test wrote', () => {
    const headless = { ...v2Blob(), history: undefined } as unknown as WeightsState
    const w = rebaseWeights(headless, NEW, '2026-08-12')
    expect(w.history).toHaveLength(1)
    expect(w.base).toEqual(NEW)
  })

  it('composes with migrateWeights: backfill first, then re-base the whole vector', () => {
    const eight = { technical: 1, momentum: 0.8, sector: 0.6, social: 0.5, channels: 0.6, insiders: 0.4, news: 0.4, seasonality: 0.3 }
    const ancient = {
      base: { ...eight } as Record<FactorName, number>,
      current: { ...eight } as Record<FactorName, number>,
      ic: Object.fromEntries(Object.keys(eight).map(k => [k, { nAgree: 3, sumAgree: 1, nDisagree: 0, sumDisagree: 0 }])) as WeightsState['ic'],
      gradedSinceNudge: 4,
      history: [],
    }
    const w = rebaseWeights(migrateWeights(ancient, NEW), NEW, '2026-08-12')
    expect(w.base).toEqual(NEW)
    expect(w.current).toEqual(NEW)
    expect(w.ic.smartMoney).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
    expect(w.ic.technical.nAgree).toBe(0)
  })
})

// A committed seed can be REGENERATED without the outcome definition changing
// (a deeper walk over the same hit rule), and when it is, nothing in the stored
// blob tells the loader that the artefact on disk is the newer one —
// `defVersion` is equal on both sides by construction. `seedGeneration` is that
// missing channel. It only works if "absent" and "1" are the same state rather
// than two, because every blob written before the field existed — the live one
// included — is generation 1: the committed seed of record.
describe('seedGeneration — absence IS generation 1', () => {
  it('migrateCalibration reads a blob written before the field existed as generation 1', () => {
    expect(migrateCalibration({ buckets: {}, brier: [] }).seedGeneration).toBe(1)
  })

  it('migrateCalibration never overwrites a generation the artefact stamped itself', () => {
    expect(migrateCalibration({ buckets: {}, brier: [], seedGeneration: 2 }).seedGeneration).toBe(2)
  })

  it('migrateWeights reads a legacy snapshot as generation 1 and keeps a stamped one', () => {
    expect(migrateWeights(initWeights()).seedGeneration).toBe(1)
    expect(migrateWeights({ ...initWeights(), seedGeneration: 2 }).seedGeneration).toBe(2)
  })

  it('is idempotent on both — a second migrate cannot advance a generation', () => {
    const cal = migrateCalibration(migrateCalibration({ buckets: {}, brier: [], seedGeneration: 2 }))
    expect(cal.seedGeneration).toBe(2)
    expect(migrateWeights(migrateWeights(initWeights())).seedGeneration).toBe(1)
  })
})

describe('updateCalibration + brier', () => {
  it('migrates legacy evidence and tracks future live/shadow/seed provenance separately', () => {
    const cal = migrateCalibration({ buckets: { 'long:green:25-40': { n: 10, hits: 4 } }, brier: [], seeded: true })
    expect(cal.evidence).toEqual({ seed: { n: 10, hits: 4 }, live: { n: 0, hits: 0 }, shadow: { n: 0, hits: 0 } })
    const hit = { excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true }
    updateCalibration(cal, { side: 'long', regime: 'green', composite: 30 }, hit)
    updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, shadow: true }, { ...hit, hit: false })
    updateCalibration(cal, { side: 'long', regime: 'green', composite: 30, provenance: 'seed' }, hit)
    expect(cal.evidence).toEqual({ seed: { n: 11, hits: 5 }, live: { n: 1, hits: 1 }, shadow: { n: 1, hits: 0 } })
  })

  it('books hits into the right bucket', () => {
    let cal = emptyCal()
    cal = updateCalibration(cal, { side: 'long', regime: 'green', composite: 30 }, { excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true })
    cal = updateCalibration(cal, { side: 'long', regime: 'green', composite: 30 }, { excessPct: -2, rawPct: -2, spyPct: 0, stopped: true, hit: false })
    expect(cal.buckets['long:green:25-40']).toEqual({ n: 2, hits: 1 })
  })
  it('brierPoint averages (p − hit)²', () => {
    const preds = [
      { probability: 0.7, outcome10: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true } },
      { probability: 0.7, outcome10: { excessPct: -1, rawPct: -1, spyPct: 0, stopped: false, hit: false } },
    ]
    expect(brierPoint(preds)).toBeCloseTo((0.09 + 0.49) / 2, 5)
    expect(brierPoint([{ probability: 0.5 }])).toBeNull()
  })
})
