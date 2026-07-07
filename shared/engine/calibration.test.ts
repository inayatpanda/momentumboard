import { describe, expect, it } from 'vitest'
import {
  bandFor,
  baseHitRate,
  brierPoint,
  gradeFor,
  gradePrediction,
  initWeights,
  maybeNudgeWeights,
  migrateWeights,
  probabilityFor,
  updateCalibration,
  updateIcStats,
  type CalibrationState,
  type WeightsState,
} from './calibration'
import type { Candle } from '../types'
import type { FactorName, Prediction } from './types'

const emptyCal = (): CalibrationState => ({ buckets: {}, brier: [] })

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
  it('maps |composite| to bands', () => {
    expect(bandFor(25)).toBe('25-40')
    expect(bandFor(40)).toBe('40-55')
    expect(bandFor(69.9)).toBe('55-70')
    expect(bandFor(70)).toBe('70+')
  })
})

describe('probabilityFor', () => {
  it('no data → Laplace 0.5, provisional', () => {
    const { p, provisional } = probabilityFor(emptyCal(), 'long', 'green', 30)
    expect(p).toBe(0.5)
    expect(provisional).toBe(true)
  })
  it('uses the regime bucket when it has n≥15, else pools across regimes', () => {
    const cal = emptyCal()
    cal.buckets['long:green:25-40'] = { n: 20, hits: 14 } // (14+2)/(20+4) = 0.667
    cal.buckets['long:red:25-40'] = { n: 10, hits: 2 }
    expect(probabilityFor(cal, 'long', 'green', 30).p).toBeCloseTo(16 / 24, 3)
    expect(probabilityFor(cal, 'long', 'green', 30).provisional).toBe(false)
    // red bucket thin → pooled (30 n, 16 hits) → (16+2)/(30+4)
    expect(probabilityFor(cal, 'long', 'red', 30).p).toBeCloseTo(18 / 34, 3)
    expect(probabilityFor(cal, 'long', 'red', 30).provisional).toBe(false)
  })
})

describe('gradeFor', () => {
  it('with the default 0.5 base: A needs p≥.62, non-provisional AND capacity ≥8; provisional caps at B; <.50 suppressed', () => {
    expect(gradeFor(0.65, false, 10)).toBe('A')
    expect(gradeFor(0.65, false, 7)).toBe('B') // capacity blocks A
    expect(gradeFor(0.65, true, 10)).toBe('B') // provisional caps
    expect(gradeFor(0.56, false, 10)).toBe('B')
    expect(gradeFor(0.52, false, 10)).toBe('C')
    expect(gradeFor(0.49, false, 10)).toBeNull()
  })
  it('grades measure edge over the engine base rate — a 0.47 bucket is a B when the base is 0.37', () => {
    expect(gradeFor(0.47, false, 10, 0.37)).toBe('B')
    expect(gradeFor(0.50, false, 10, 0.37)).toBe('A')
    expect(gradeFor(0.38, false, 10, 0.37)).toBe('C')
    expect(gradeFor(0.36, false, 10, 0.37)).toBeNull()
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

describe('updateCalibration + brier', () => {
  it('books hits into the right bucket', () => {
    let cal = emptyCal()
    cal = updateCalibration(cal, { side: 'long', regime: 'green', composite: 30 }, { excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true })
    cal = updateCalibration(cal, { side: 'long', regime: 'green', composite: 30 }, { excessPct: -2, rawPct: -2, spyPct: 0, stopped: true, hit: false })
    expect(cal.buckets['long:green:25-40']).toEqual({ n: 2, hits: 1 })
  })
  it('brierPoint averages (p − hit)²', () => {
    const preds = [
      { probability: 0.7, outcome5: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true } },
      { probability: 0.7, outcome5: { excessPct: -1, rawPct: -1, spyPct: 0, stopped: false, hit: false } },
    ]
    expect(brierPoint(preds)).toBeCloseTo((0.09 + 0.49) / 2, 5)
    expect(brierPoint([{ probability: 0.5 }])).toBeNull()
  })
})
