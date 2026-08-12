import { describe, expect, it } from 'vitest'
import {
  bandFor,
  baseHitRate,
  brierPoint,
  curveFor,
  gradeFor,
  gradePrediction,
  initWeights,
  isotonicFit,
  maybeNudgeWeights,
  migrateCalibration,
  migrateWeights,
  probabilityFor,
  rebaseWeights,
  updateCalibration,
  updateIcStats,
  type Band,
  type CalibrationState,
  type WeightsState,
} from './calibration'
import type { Candle } from '../types'
import type { FactorName, Prediction } from './types'

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

  it('maybeNudgeWeights: no-op under 15 graded; clamps within [0.4×, 2×] base; logs history', () => {
    let w = initWeights()
    // factor that always agrees and wins big → ic maxed → weight rises 15%
    for (let i = 0; i < 25; i++) w = updateIcStats(w, pred('long', { technical: 50 }), { ...win, excessPct: 20 })
    const before = w.current.technical
    w = maybeNudgeWeights(w, '2026-07-01')
    expect(w.current.technical).toBeCloseTo(before * 1.15, 5)
    expect(w.current.technical).toBeLessThanOrEqual(2 * w.base.technical)
    expect(w.history).toHaveLength(1)
    expect(w.gradedSinceNudge).toBe(0)
    // under 15 since nudge → untouched
    w = updateIcStats(w, pred('long', { technical: 50 }), win)
    const cur = w.current.technical
    expect(maybeNudgeWeights(w, '2026-07-02').current.technical).toBe(cur)
  })

  it('the 0.4× floor holds while evidence is thin, then lifts at 200 observations — a persistently wrong factor decays toward zero', () => {
    let w = initWeights()
    const loss = { excessPct: -5, rawPct: -5, spyPct: 0, stopped: true, hit: false }
    // young factor: 30 graded, always agreeing and losing → floor still protects it
    for (let i = 0; i < 30; i++) w = updateIcStats(w, pred('long', { technical: 50 }), loss)
    w = maybeNudgeWeights(w, '2026-07-01')
    let rounds = 0
    while (rounds++ < 8 && w.ic.technical.nAgree < 200) {
      for (let i = 0; i < 30; i++) w = updateIcStats(w, pred('long', { technical: 50 }), loss)
      w = maybeNudgeWeights(w, '2026-07-02')
      if (w.ic.technical.nAgree < 200) expect(w.current.technical).toBeGreaterThanOrEqual(0.4 * w.base.technical)
    }
    // mature factor, still wrong: keep grading — the floor is gone, decay continues
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 15; i++) w = updateIcStats(w, pred('long', { technical: 50 }), loss)
      w = maybeNudgeWeights(w, '2026-07-03')
    }
    expect(w.ic.technical.nAgree).toBeGreaterThanOrEqual(200)
    expect(w.current.technical).toBeLessThan(0.4 * w.base.technical) // pruned below the old floor
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
