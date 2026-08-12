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
  it('shrinks each band toward the rung’s POOLED rate by n/(n+25) — a thin band barely speaks', () => {
    // 25-40: n=100 hits=30 → (30+2)/104 = 0.3076923
    // 55-70: n=5   hits=4  → (4+2)/9     = 0.6666667   (already monotone: PAVA is the identity)
    // rung pool: n=105 hits=34 → 36/109 = 0.3302752
    //   25-40 w = 100/125 = 0.8       → 0.8×0.3076923      + 0.2×0.3302752       = 0.3122089
    //   55-70 w = 5/30   = 0.1666667  → 0.1666667×0.6666667 + 0.8333333×0.3302752 = 0.3863405
    const c = curveFor(calOf({ 'long:green:25-40': [100, 30], 'long:green:55-70': [5, 4] }), 'long', 'any', 'green')
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({ mid: 32.5, n: 100 })
    expect(c[0].p).toBeCloseTo(0.3122089, 6)
    expect(c[1]).toMatchObject({ mid: 62.5, n: 5 })
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
    // the identity. Rung pool n=243 hits=97 → 99/247 = 0.4008097.
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
})

describe('probabilityFor — a continuous read over the band midpoints', () => {
  // The fixture for the geometry tests:
  //   25-40 n=100 hits=30 → 32/104 = 0.3076923
  //   55-70 n=100 hits=60 → 62/104 = 0.5961538
  //   rung pool n=200 hits=90 → 92/204 = 0.4509804 ; both w = 100/125 = 0.8
  //   shrunk 32.5 → 0.8×0.3076923 + 0.2×0.4509804 = 0.3363499
  //   shrunk 62.5 → 0.8×0.5961538 + 0.2×0.4509804 = 0.5671192
  const twoBand = () => calOf({ 'long:green:25-40': [100, 30], 'long:green:55-70': [100, 60] })
  const LO = 0.3363499
  const HI = 0.5671192

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
    // 25-40 n=100 hits=30 (0.3076923) + 55-70 n=5 hits=4 (0.6666667): the outer
    // point shrinks to 0.3863405, so 75 — beyond every midpoint — reads THAT,
    // not the five-observation 0.667 the band on its own would claim.
    const cal = calOf({ 'long:green:25-40': [100, 30], 'long:green:55-70': [5, 4] })
    expect(probabilityFor(cal, 'long', 'green', 75).p).toBeCloseTo(0.3863405, 6)
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
    const r = probabilityFor(cal, 'long', 'green', 30, 'large')
    // one band → a one-point curve, flat everywhere; the rung's pooled rate IS
    // that band, so the shrinkage toward it is the identity.
    expect(r.p).toBeCloseTo(16 / 24, 6)
    expect(r.provisional).toBe(false)
    expect(r.nEff).toBe(20)
  })

  it('rung 2 — an EMPTY cohort+regime rung falls through to the cohort pooled across regimes', () => {
    const cal = emptyCal()
    cal.buckets['large:long:red:25-40'] = { n: 20, hits: 12 } // (12+2)/(20+4) = 0.5833333
    const r = probabilityFor(cal, 'long', 'green', 30, 'large') // nothing green at all
    expect(r.p).toBeCloseTo(14 / 24, 6)
    expect(r.provisional).toBe(false)
    expect(r.nEff).toBe(20)
  })

  it('THE RULE CHANGE — a thin rung is still the rung; thinness is reported by nEff, not fixed by borrowing another population', () => {
    // Before: a bucket under MIN_BUCKET_N was skipped and the read silently came
    // from a DIFFERENT population (all regimes pooled), arriving non-provisional.
    // Now the read stays where its evidence is and declares how much there is.
    const cal = calOf({ 'long:green:25-40': [20, 14], 'long:red:25-40': [10, 2] })
    const red = probabilityFor(cal, 'long', 'red', 30)
    expect(red.p).toBeCloseTo(4 / 14, 6) // (2+2)/(10+4) — red's own ten observations…
    expect(red.nEff).toBe(10)
    expect(red.provisional).toBe(true) // …and they are declared thin (was: 18/34, non-provisional)
    const green = probabilityFor(cal, 'long', 'green', 30)
    expect(green.p).toBeCloseTo(16 / 24, 6)
    expect(green.provisional).toBe(false)
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
    const cal = calOf({ 'long:green:25-40': [100, 30], 'short:red:25-40': [100, 44] })
    const r = probabilityFor(cal, 'long', 'green', 75, 'large')
    expect(r.p).toBeCloseTo(32 / 104, 6) // (30+2)/(100+4), the long/green band itself
    expect(r.nEff).toBe(100)
    expect(r.provisional).toBe(false)
    expect(r.p).not.toBeCloseTo(baseHitRate(cal).rate, 3) // …and NOT the base rate it used to return
  })

  it('a KNOWN cohort prefers its own bucket; an UNKNOWN cap skips rungs 1–2 and pools everything', () => {
    const cal = emptyCal()
    cal.buckets['large:long:green:25-40'] = { n: 20, hits: 20 } // large cohort: strong
    cal.buckets['long:green:25-40'] = { n: 20, hits: 4 } // cohortless: weak
    // large call reads its own bucket (0.9166667), NOT the weak cohortless one
    expect(probabilityFor(cal, 'long', 'green', 30, 'large').p).toBeCloseTo(22 / 24, 6)
    // unknown-cap call was never guessed into large → pools all (large+cohortless)
    const u = probabilityFor(cal, 'long', 'green', 30, 'unknown')
    expect(u.p).toBeCloseTo((24 + 2) / (40 + 4), 6) // (20+4)/(20+20) hits over n
    expect(u.provisional).toBe(false)
    expect(u.nEff).toBe(40)
  })

  it('the default cohort arg is unknown → behaves like the old regime-pool for legacy callers', () => {
    const cal = emptyCal()
    cal.buckets['long:green:25-40'] = { n: 20, hits: 14 }
    // no cohort passed → unknown → rung 3 pools the cohortless bucket, same p as before
    expect(probabilityFor(cal, 'long', 'green', 30).p).toBeCloseTo(16 / 24, 3)
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
  /** The committed seed's buckets verbatim (shared/engine/seed.json @ 01a6549):
   *  778 observations, 285 hits, baseHitRate (285+2)/(778+4) = 0.3670077. */
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

  it('the seed’s base rate is unchanged — the gate is about evidence, not about moving the bar', () => {
    expect(baseHitRate(seedShape()).rate).toBeCloseTo(287 / 782, 7) // 0.3670077
    expect(baseHitRate(seedShape()).n).toBe(778)
  })

  it('a 55-70 SHORT in red — the band that actually holds the eight observations — is not a B', () => {
    // rung 3 (all cohorts, regime red): 25-40 147/48 → 50/151 = 0.3311258
    //                                   40-55  31/7  → 9/35   = 0.2571429   ← inversion
    //                                   55-70   8/4  → 6/12   = 0.5
    // PAVA pools the first two: (0.3311258×147 + 0.2571429×31)/178 = 0.3182412
    // rung pool n=186 hits=59 → 61/190 = 0.3210526
    //   32.5 w=147/172=0.8546512 → 0.3186500
    //   47.5 w= 31/56 =0.5535714 → 0.3194964
    //   62.5 w=  8/33 =0.2424242 → 0.3644337
    // read at |composite| 60: t = (60−47.5)/15 = 0.8333333
    //   p = 0.3194964 + 0.8333333×(0.3644337 − 0.3194964) = 0.3569441
    //   nEff = min(31, 8) = 8
    const r = probabilityFor(seedShape(), 'short', 'red', 60, 'large')
    expect(r.p).toBeCloseTo(0.3569441, 6)
    expect(r.nEff).toBe(8) // …and NOT the 178 the pooled PAVA block would have claimed
    expect(r.provisional).toBe(true)
    const g = gradeFor(r.p, r.nEff, baseHitRate(seedShape()).rate)
    expect(g).toBeNull() // 0.357 < base 0.367: below the engine's own rate → a shadow
  })

  it('…and even at the OLD read of 0.5, eight observations grade C — nEff is the thing that kills the B', () => {
    // This is the arithmetic in one line. The old gradeFor took (0.5, provisional
    // true, capacity ≥ 0) and returned B because its B rung tested neither.
    expect(gradeFor(0.5, 8, 0.3670077)).toBe('C')
    expect(gradeFor(0.5, 15, 0.3670077)).toBe('B') // fifteen and it may speak
  })

  it('no regime lets a 55-70 short reach B — green and amber are checked too', () => {
    const base = baseHitRate(seedShape()).rate
    for (const regime of ['green', 'amber', 'red']) {
      for (const x of [56, 60, 65, 69.9]) {
        const r = probabilityFor(seedShape(), 'short', regime, x, 'large')
        const g = gradeFor(r.p, r.nEff, base)
        expect(g === 'A' || g === 'B').toBe(false)
      }
    }
  })

  it('the 70+ short — the very top of the engine’s conviction — is honest rather than flattering', () => {
    // Flat extension from 55-70, so it can never fall below it, and it is still
    // the eight-observation read: C at most, and here below base → shadow.
    const r = probabilityFor(seedShape(), 'short', 'red', 80, 'large')
    expect(r.p).toBeCloseTo(0.3644337, 6)
    expect(r.p).toBeGreaterThanOrEqual(probabilityFor(seedShape(), 'short', 'red', 69.9, 'large').p)
    expect(r.nEff).toBe(8)
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
