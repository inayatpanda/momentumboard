import type { Candle, RegimeColor } from '../types'
import { atr, sma } from '../indicators'
import { swingCapacity } from '../indicators'
import { technicalStage } from '../technicals'
import { refineRegime, regimeFromCandles } from '../setups'
import { seasonalitySummary } from '../seasonality'
import { compressionFactor, momentumFactor, seasonalityFactor, technicalFactor } from './factors'
import { composeCall, DEFAULT_WEIGHTS } from './composite'
import {
  CALIB_DEF_VERSION,
  HIT_EXCESS_MIN,
  initWeights,
  maybeNudgeWeights,
  updateCalibration,
  updateIcStats,
  type CalibrationState,
  type WeightsState,
} from './calibration'
import { isRejection, round1, type FactorName, type FactorScore, type Prediction } from './types'

// Pre-seeds the engine from candle history: only the factors computable from
// bars alone (technical, momentum, compression, seasonality) replay; the rest start at
// neutral prior weight and learn live. Weekly sampling (step 5) keeps the seed
// sample count up; at the 10-session horizon adjacent windows now overlap ~1wk,
// which mildly correlates neighbouring outcomes but is fine for a PRIOR (live
// grading is non-overlapping). Deterministic by construction — no clocks, no RNG.
// The replay regime matches the live engine's: SPY+QQQ slope, refined by
// universe breadth and the VIX level (both optional — omitted, the base
// SPY-slope read stands alone, as before).
//
// GATES: this replay passes no `gates`, so composeCall applies MODERATE_GATES —
// whatever those are on the day the seeder runs. The eligibility floor became
// the EXPECTED MOVE (catalyst.ts `minExpectedMovePct`) rather than a flat
// capacity threshold, so every FUTURE regeneration samples a different
// population from the committed `seed.json`, which was replayed under the old
// flat capacity floors. That is a scoring-epoch difference, not a hit-definition
// one: CALIB_DEF_VERSION stays 3 (the seed's buckets still measure the same
// 10-session excess) and the two epochs are distinguished by
// ENGINE_MODEL_VERSION on the rows they produce. Do not mix a regenerated seed
// with the committed one — regenerate whole.

const STEP = 5
const WARMUP = 80
// the CALIBRATED horizon — reader holds 1-2wk+, so a hit is the 10-session
// excess vs SPY (matches gradePrediction's 10d lens + CALIB_DEF_VERSION v3)
const HORIZON = 10

const nullFactors = (): Record<FactorName, FactorScore> => ({
  technical: { score: null, detail: '' },
  momentum: { score: null, detail: '' },
  compression: { score: null, detail: '' },
  sector: { score: null, detail: '' },
  social: { score: null, detail: '' },
  channels: { score: null, detail: '' },
  insiders: { score: null, detail: '' },
  news: { score: null, detail: '' },
  seasonality: { score: null, detail: '' },
  smartMoney: { score: null, detail: '' },
  catalyst: { score: null, detail: '' }, // news catalysts aren't replayable from bars — neutral in seeding, learned live
})

export function seedFromHistory(
  bySym: Map<string, Candle[]>,
  spy: Candle[],
  qqq?: Candle[],
  vix?: Candle[],
  /** Optional lower bound on the sampled sessions, added for stage 2b's REFERENCE
   * SWEEP (spec §9). The reference base a grade is anchored to has to be measured
   * over the same window as the walk whose buckets it grades — an unbounded sweep
   * over the whole 5y cache would anchor a 2024-2026 board to a 2021 market. The
   * UPPER bound is the candle set itself: the caller truncates every series to the
   * bars the walk's last morning could see, so no sample and no outcome can reach
   * past it. Read on the ENTRY session (bar i+1), because that is the session the
   * walk's board of date D actually buys — which makes "the same window" mean the
   * same thing on both sides. Absent → every session from WARMUP on, exactly as
   * before, so `scripts/seed-engine.ts` and every existing caller is untouched. */
  window?: { fromISO?: string },
): { weights: WeightsState; calibration: CalibrationState } {
  const sinceSec = window?.fromISO ? Date.parse(`${window.fromISO}T00:00:00Z`) / 1000 : null
  let weights = initWeights()
  const calibration: CalibrationState = { buckets: {}, brier: [], seeded: true, defVersion: CALIB_DEF_VERSION }
  const spyIdxByT = new Map(spy.map((c, i) => [c.t, i]))
  const spyCloses = spy.map(c => c.c)

  // point-in-time context, precomputed once per date rather than per (sym, date)
  const qqqIdxByT = qqq ? new Map(qqq.map((c, i) => [c.t, i])) : null
  const vixCloseByT = vix ? new Map(vix.map(c => [c.t, c.c])) : null
  // breadth: per date, the share of the universe above its 50-SMA (each series'
  // SMA uses only bars up to that date — no lookahead)
  const breadthByT = new Map<number, { above: number; total: number }>()
  for (const candles of bySym.values()) {
    const closes = candles.map(c => c.c)
    const s50 = sma(closes, 50)
    for (let k = 49; k < candles.length; k++) {
      const m = s50[k]
      if (m == null) continue
      const cell = breadthByT.get(candles[k].t) ?? { above: 0, total: 0 }
      cell.total++
      if (closes[k] > m) cell.above++
      breadthByT.set(candles[k].t, cell)
    }
  }
  const regimeCache = new Map<number, RegimeColor>()
  const regimeAt = (j: number): RegimeColor => {
    const hit = regimeCache.get(j)
    if (hit) return hit
    const t = spy[j].t
    const spySlice = spy.slice(0, j + 1)
    const jq = qqqIdxByT?.get(t)
    const qqqSlice = qqq && jq != null ? qqq.slice(0, jq + 1) : spySlice
    const cell = breadthByT.get(t)
    const breadth = cell && cell.total >= 10 ? cell.above / cell.total : null
    const r = refineRegime(regimeFromCandles(spySlice, qqqSlice), breadth, vixCloseByT?.get(t) ?? null)
    regimeCache.set(j, r)
    return r
  }

  for (const [sym, candles] of [...bySym.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const closes = candles.map(c => c.c)
    for (let i = WARMUP; i + 1 + HORIZON < candles.length; i += STEP) {
      // the window bound, before any work: the entry session must land inside it
      if (sinceSec != null && candles[i + 1].t < sinceSec) continue
      const slice = candles.slice(0, i + 1)
      const sliceCloses = closes.slice(0, i + 1)
      const read = technicalStage(sym, slice)
      if (!read) continue
      const j = spyIdxByT.get(candles[i].t)
      if (j == null || j + 1 + HORIZON >= spy.length) continue

      const factors = nullFactors()
      factors.technical = technicalFactor(read)
      factors.momentum = momentumFactor(sliceCloses, spyCloses.slice(0, j + 1), slice)
      // replayable from bars, so the walk scores it — the same rule that admits
      // technical, momentum and seasonality here and keeps sector, news and the
      // social reads out. Null until the slice holds 140 closes, which is honest:
      // the early samples of a walk genuinely could not read a 120-session width.
      factors.compression = compressionFactor(sliceCloses)
      if (slice.length >= 500) {
        const month = new Date(candles[i].t * 1000).getUTCMonth() + 1
        factors.seasonality = seasonalityFactor(seasonalitySummary(slice), month)
      }

      const regime = regimeAt(j)
      // composeCall now names the gate that refused (types.ts). The walk does not
      // read gates — it is scoring outcomes, not auditing the funnel — so the only
      // change here is `isRejection` where `!call` used to be. Same rows, same skips.
      const call = composeCall({
        sym,
        factors,
        weights: DEFAULT_WEIGHTS,
        regime,
        capacityPct: swingCapacity(sliceCloses),
        atr: atr(slice)[slice.length - 1],
        lastClose: closes[i],
        entryQuality: read.entryQuality,
        stage: read.stage,
        earningsWithinHorizon: false,
        capUsdM: null,
        volumeConfirmed: read.volumeConfirmed,
        breadthKnown: (breadthByT.get(candles[i].t)?.total ?? 0) >= 10,
      })
      if (isRejection(call)) continue

      // outcome: entry session is bar i+1; graded at the close of bar i+1+HORIZON.
      // grading measures the capturable move from the first tradeable print — the
      // base is the OPEN of the entry session (bar i+1), not the prior close, so
      // the untradeable overnight gap is never scored (mirrors gradePrediction()).
      const base = candles[i + 1].o
      const rawPct = ((closes[i + 1 + HORIZON] - base) / base) * 100
      const spyPct = ((spy[j + 1 + HORIZON].c - spy[j + 1].o) / spy[j + 1].o) * 100
      // close-based stop check — must match gradePrediction() exactly so the
      // seeded calibration and live grading measure the same thing
      let stopped = false
      for (let k = i + 1; k <= i + 1 + HORIZON; k++) {
        if (call.side === 'long' ? candles[k].c <= call.stop : candles[k].c >= call.stop) {
          stopped = true
          break
        }
      }
      const sign = call.side === 'short' ? -1 : 1
      const excessPct = round1(sign * (rawPct - spyPct))
      // hit rule mirrors gradePrediction(): a win must clear HIT_EXCESS_MIN
      const outcome = { excessPct, rawPct: round1(rawPct), spyPct: round1(spyPct), stopped, hit: !stopped && excessPct >= HIT_EXCESS_MIN }

      // `accrual: 'sized'` is the provenance stamp [stage 3c]: this walk has no
      // board, no risk ladder and no shadow concept — none of the three pre-grade
      // shadow causes can even arise here — so the whole population is SIZED and
      // no shadow sub-count is written. Absent, the partition would read these
      // rows as "never partitioned", which is the same number by accident rather
      // than by statement; the sweep this feeds (replay-window's referenceBase) is
      // unconditional by definition and must not acquire a shadow slice.
      // `riskPct: 1` rides along so the legacy fallback answers identically if the
      // stamp is ever dropped — the same statement in both dialects.
      updateCalibration(calibration, { side: call.side, regime, composite: call.composite, setup: call.setup, provenance: 'seed', accrual: 'sized', riskPct: 1 }, outcome)
      weights = updateIcStats(weights, { side: call.side, factors: call.factors } as Prediction, outcome)
    }
  }

  const lastDate = new Date(spy[spy.length - 1].t * 1000).toISOString().slice(0, 10)
  weights = maybeNudgeWeights({ ...weights, gradedSinceNudge: Math.max(weights.gradedSinceNudge, 15) }, lastDate)
  return { weights, calibration }
}
