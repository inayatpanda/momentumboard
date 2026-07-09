import type { Candle, RegimeColor } from '../types'
import { atr, sma } from '../indicators'
import { swingCapacity } from '../indicators'
import { technicalStage } from '../technicals'
import { refineRegime, regimeFromCandles } from '../setups'
import { seasonalitySummary } from '../seasonality'
import { momentumFactor, seasonalityFactor, technicalFactor } from './factors'
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
import { round1, type FactorName, type FactorScore, type Prediction } from './types'

// Pre-seeds the engine from candle history: only the factors computable from
// bars alone (technical, momentum, seasonality) replay; the rest start at
// neutral prior weight and learn live. Weekly sampling (step 5) decorrelates
// overlapping windows. Deterministic by construction — no clocks, no RNG.
// The replay regime matches the live engine's: SPY+QQQ slope, refined by
// universe breadth and the VIX level (both optional — omitted, the base
// SPY-slope read stands alone, as before).

const STEP = 5
const WARMUP = 80
const HORIZON = 5

const nullFactors = (): Record<FactorName, FactorScore> => ({
  technical: { score: null, detail: '' },
  momentum: { score: null, detail: '' },
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
): { weights: WeightsState; calibration: CalibrationState } {
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
      const slice = candles.slice(0, i + 1)
      const sliceCloses = closes.slice(0, i + 1)
      const read = technicalStage(sym, slice)
      if (!read) continue
      const j = spyIdxByT.get(candles[i].t)
      if (j == null || j + 1 + HORIZON >= spy.length) continue

      const factors = nullFactors()
      factors.technical = technicalFactor(read)
      factors.momentum = momentumFactor(sliceCloses, spyCloses.slice(0, j + 1))
      if (slice.length >= 500) {
        const month = new Date(candles[i].t * 1000).getUTCMonth() + 1
        factors.seasonality = seasonalityFactor(seasonalitySummary(slice), month)
      }

      const regime = regimeAt(j)
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
      })
      if (!call) continue

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

      updateCalibration(calibration, { side: call.side, regime, composite: call.composite }, outcome)
      weights = updateIcStats(weights, { side: call.side, factors: call.factors } as Prediction, outcome)
    }
  }

  const lastDate = new Date(spy[spy.length - 1].t * 1000).toISOString().slice(0, 10)
  weights = maybeNudgeWeights({ ...weights, gradedSinceNudge: Math.max(weights.gradedSinceNudge, 15) }, lastDate)
  return { weights, calibration }
}
