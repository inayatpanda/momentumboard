import type { Candle } from '../types'
import { atr } from '../indicators'
import { swingCapacity } from '../indicators'
import { technicalStage } from '../technicals'
import { regimeFromCandles } from '../setups'
import { seasonalitySummary } from '../seasonality'
import { momentumFactor, seasonalityFactor, technicalFactor } from './factors'
import { composeCall, DEFAULT_WEIGHTS } from './composite'
import { initWeights, maybeNudgeWeights, updateCalibration, updateIcStats, type CalibrationState, type WeightsState } from './calibration'
import { round1, type FactorName, type FactorScore, type Prediction } from './types'

// Pre-seeds the engine from candle history: only the factors computable from
// bars alone (technical, momentum, seasonality) replay; the rest start at
// neutral prior weight and learn live. Weekly sampling (step 5) decorrelates
// overlapping windows. Deterministic by construction — no clocks, no RNG.

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
})

export function seedFromHistory(bySym: Map<string, Candle[]>, spy: Candle[]): { weights: WeightsState; calibration: CalibrationState } {
  let weights = initWeights()
  const calibration: CalibrationState = { buckets: {}, brier: [], seeded: true }
  const spyIdxByT = new Map(spy.map((c, i) => [c.t, i]))
  const spyCloses = spy.map(c => c.c)

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

      const spySlice = spy.slice(0, j + 1)
      const call = composeCall({
        sym,
        factors,
        weights: DEFAULT_WEIGHTS,
        regime: regimeFromCandles(spySlice, spySlice),
        capacityPct: swingCapacity(sliceCloses),
        atr: atr(slice)[slice.length - 1],
        lastClose: closes[i],
        entryQuality: read.entryQuality,
        stage: read.stage,
        earningsWithinHorizon: false,
        capUsdM: null,
      })
      if (!call) continue

      // outcome: entry session is bar i+1; graded at the close of bar i+1+HORIZON
      const price = closes[i]
      const rawPct = ((closes[i + 1 + HORIZON] - price) / price) * 100
      const spyPct = ((spy[j + 1 + HORIZON].c - spy[j].c) / spy[j].c) * 100
      let stopped = false
      for (let k = i + 1; k <= i + 1 + HORIZON; k++) {
        if (call.side === 'long' ? candles[k].l <= call.stop : candles[k].h >= call.stop) {
          stopped = true
          break
        }
      }
      const sign = call.side === 'short' ? -1 : 1
      const excessPct = round1(sign * (rawPct - spyPct))
      const outcome = { excessPct, rawPct: round1(rawPct), spyPct: round1(spyPct), stopped, hit: !stopped && excessPct > 0 }

      const regime = regimeFromCandles(spySlice, spySlice)
      updateCalibration(calibration, { side: call.side, regime, composite: call.composite }, outcome)
      weights = updateIcStats(weights, { side: call.side, factors: call.factors } as Prediction, outcome)
    }
  }

  const lastDate = new Date(spy[spy.length - 1].t * 1000).toISOString().slice(0, 10)
  weights = maybeNudgeWeights({ ...weights, gradedSinceNudge: Math.max(weights.gradedSinceNudge, 15) }, lastDate)
  return { weights, calibration }
}
