import { describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import { appendSocialHistory, buildEngineLab, calibrateLabObservations, gradeStrategyObservation, qualityDipObservations, shortHorizonObservations, socialIgnitionObservations, type StrategyObservation } from './strategyLab'

const candles = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: 1_700_000_000 + i * 86_400, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }))

describe('visible strategy lab', () => {
  it('builds a three-session analogue forecast with explicit up/down odds and range', () => {
    const trend = candles(Array.from({ length: 180 }, (_, i) => 100 * Math.pow(1.003, i)))
    const [goog] = shortHorizonObservations([{ sym: 'GOOG', candles: trend }], 2_000_000_000, ['GOOG'])
    expect(goog.sym).toBe('GOOG')
    expect(goog.forecast.definition).toBe('three-session-direction-v1')
    expect(goog.forecast.horizonSessions).toBe(3)
    expect(goog.forecast.probabilityUp).toBeGreaterThan(0.9)
    expect(goog.forecast.probabilityDown).toBeLessThan(0.1)
    expect(goog.forecast.expectedLowPct).not.toBeNull()
    expect(goog.side).toBe('long')
    expect(goog.state).toBe('setup')
  })

  it('shows no edge instead of forcing a direction when the tape is flat', () => {
    const [googl] = shortHorizonObservations([{ sym: 'GOOGL', candles: candles(Array(180).fill(100)) }], 2_000_000_000, ['GOOGL'])
    expect(googl.side).toBe('neutral')
    expect(googl.state).toBe('watch')
    expect(googl.stop).toBeNull()
    expect((googl.forecast.probabilityUp ?? 0) + (googl.forecast.probabilityDown ?? 0) + (googl.forecast.probabilityFlat ?? 0)).toBeCloseTo(1, 1)
    expect(googl.risks.join(' ')).toMatch(/neither direction clears/)
  })

  it('recognises a quality drawdown only after price begins to stabilise', () => {
    const spy = candles(Array.from({ length: 90 }, (_, i) => 100 + i * 0.1))
    const series = [...Array.from({ length: 70 }, (_, i) => 100 + i * 0.3), ...Array.from({ length: 17 }, (_, i) => 121 - i * 1.1), 103, 101, 104]
    const rows = qualityDipObservations([{ sym: 'GOOD', candles: candles(series), qualityProxy: true, capUsdM: 25_000 }], spy, 2_000_000_000)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('setup')
    expect(rows[0].forecast.probabilityTarget).toBeNull()
    expect(rows[0].dataGaps.join(' ')).toMatch(/cash flow/)
  })

  it('requires cross-platform acceleration for a social setup and flags extreme promotion risk', () => {
    const history = [{ observedAt: 100, rows: [{ sym: 'EARLY', redditMentions: 10, sources: 1 }] }]
    const [early, risky] = socialIgnitionObservations([
      { sym: 'EARLY', redditMentions: 25, surgeMultiple: 2.5, sources: 2, stocktwits: true, channelNet: 2, capUsdM: 2_000 },
      { sym: 'RISKY', redditMentions: 100, surgeMultiple: 8, sources: 1, stocktwits: false, channelNet: 1, capUsdM: 100 },
    ], history, 200)
    expect(early.state).toBe('setup')
    expect(early.metrics.scanVelocity).toBe(2.5)
    expect(risky.state).toBe('avoid')
    expect(risky.risks.join(' ')).toMatch(/pump risk/)
  })

  it('publishes sleeve status and retains bounded timestamped pulse history', () => {
    let history = appendSocialHistory([], [{ sym: 'ABC', redditMentions: 4, surgeMultiple: 1, sources: 1, stocktwits: false, channelNet: null }], 100)
    history = appendSocialHistory(history, [{ sym: 'ABC', redditMentions: 8, surgeMultiple: 2, sources: 2, stocktwits: true, channelNet: 1 }], 200)
    expect(history.map(h => h.observedAt)).toEqual([100, 200])
    const lab = buildEngineLab({ date: '2026-08-21', nowSec: 200, quality: [], social: [], compositeEvidenceN: 78 })
    expect(lab.sleeves.find(s => s.key === 'composite-control')?.evidenceN).toBe(78)
    expect(lab.sleeves.find(s => s.key === 'macro-event')?.status).toBe('collecting')
  })

  it('grades target-before-stop from the next open and resolves an ambiguous bar stop-first', () => {
    const obs: StrategyObservation = {
      id: 'q', sleeve: 'quality-dip', sym: 'Q', side: 'long', state: 'setup', score: 80,
      entry: 100, stop: 95, target: 110, detectedAt: 99, availableAt: 99, reasons: [], risks: [], dataGaps: [], metrics: {},
      forecast: { definition: 'target-before-stop-v1', label: 'test', horizonSessions: 2, calibratedN: 0, provisional: true },
    }
    const cs = candles([100, 100, 100])
    cs[0].t = 90
    cs[1] = { ...cs[1], t: 100, o: 100, h: 111, l: 94 }
    cs[2].t = 101
    expect(gradeStrategyObservation(obs, cs)?.firstBarrier).toBe('stop')

    const records = Array.from({ length: 15 }, (_, i) => ({ ...obs, id: `q${i}`, outcome: { entry: 100, exit: i < 9 ? 110 : 95, firstBarrier: i < 9 ? 'target' as const : 'stop' as const, targetHit: i < 9, stopHit: i >= 9, returnPct: i < 9 ? 10 : -5, sessions: 2 } }))
    const calibrated = calibrateLabObservations([obs], records)[0]
    expect(calibrated.forecast.calibratedN).toBe(15)
    expect(calibrated.forecast.probabilityTarget).not.toBeNull()
  })

  it('grades a no-edge short-horizon forecast after three full sessions', () => {
    const obs: StrategyObservation = {
      id: 'short', sleeve: 'short-horizon', sym: 'GOOG', side: 'neutral', state: 'watch', score: 50,
      entry: 100, stop: null, target: null, detectedAt: 99, availableAt: 99, reasons: [], risks: [], dataGaps: [], metrics: {},
      forecast: { definition: 'three-session-direction-v1', label: 'test', horizonSessions: 3, probabilityUp: 0.55, probabilityDown: 0.45, calibratedN: 60, provisional: true },
    }
    const cs = candles([100, 101, 102, 104])
    cs[0].t = 90
    cs[1].t = 100
    cs[2].t = 101
    cs[3].t = 102
    const outcome = gradeStrategyObservation(obs, cs)
    expect(outcome?.finishedHigher).toBe(true)
    expect(outcome?.directionHit).toBe(true)
    expect(outcome?.sessions).toBe(3)
    expect(outcome?.firstBarrier).toBe('none')
  })

  it('keeps analogue evidence separate from forward accuracy and Brier calibration', () => {
    const [obs] = shortHorizonObservations([{ sym: 'GOOG', candles: candles(Array.from({ length: 180 }, (_, i) => 100 * Math.pow(1.003, i))) }], 2_000_000_000, ['GOOG'])
    const records = Array.from({ length: 10 }, (_, i) => ({
      ...obs,
      id: `short${i}`,
      outcome: { entry: 100, exit: 102, firstBarrier: 'none' as const, targetHit: false, stopHit: false, returnPct: 0, sessions: 3, closeReturnPct: 2, finishedHigher: true, directionHit: true },
    }))
    const calibrated = calibrateLabObservations([obs], records)[0]
    expect(calibrated.forecast.calibratedN).toBe(60)
    expect(calibrated.forecast.liveN).toBe(10)
    expect(calibrated.forecast.directionAccuracy).not.toBeNull()
    expect(calibrated.forecast.brierScore).not.toBeNull()
  })
})
