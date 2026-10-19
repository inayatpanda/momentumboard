import { describe, expect, it } from 'vitest'
import { conditionRecoveryForecast } from './researchConditioning'
import { LAB_EXECUTION_VERSION, QUALITY_DIP_MODEL_VERSION, type StrategyLabRecord, type StrategyObservation } from './strategyLab'

const DAY = 86_400
const NOW = 1_000_000_000
function record(i: number): StrategyLabRecord {
  const availableAt = 100_000 + i * 100 * DAY
  const improves = i % 2 === 0
  return {
    id: `call-${i}`, sym: `SYM${i}`, sleeve: 'quality-dip', side: 'long', state: 'setup', score: 75,
    entry: 100, stop: 90, target: 120, detectedAt: availableAt, availableAt, reasons: [], risks: [], dataGaps: [],
    metrics: { reportTrend: improves ? 'improving' : 'stable' },
    forecast: { definition: 'target-before-stop-v1', modelVersion: QUALITY_DIP_MODEL_VERSION,
      label: 'Saved recovery', horizonSessions: 63, probabilityTarget: 0.5, probabilityStop: 0.4, calibratedN: 50, provisional: true },
    outcome: { entry: 100.1, exit: improves ? 120 : 90, returnPct: improves ? 19.8 : -10.2, sessions: 63,
      firstBarrier: improves ? 'target' : 'stop', targetHit: improves, stopHit: !improves,
      executionStatus: 'filled', executionVersion: LAB_EXECUTION_VERSION, horizonEndAt: availableAt + 90 * DAY },
  }
}
function current(): StrategyObservation {
  const { outcome: _, ...observation } = record(0)
  return { ...observation, id: 'current', sym: 'CURRENT', detectedAt: NOW, availableAt: NOW,
    forecast: { ...observation.forecast, probabilityTarget: 0.49, probabilityStop: 0.49 } }
}

describe('prequential report-trend conditioning', () => {
  it('updates one coherent target/stop/neither distribution only after qualified chronological validation', () => {
    const rows = Array.from({ length: 80 }, (_, i) => record(i))
    const result = conditionRecoveryForecast(current(), rows)
    const f = result.forecast
    expect(f).toMatchObject({ calibrationBasis: 'validated-report-trend', conditioningStatus: 'validated',
      conditioningN: 40, conditioningPooledN: 80, conditioningValidationN: 20,
      conditioningBrierMetric: 'three-class-target-stop-neither', pooledProbabilityTarget: 0.49, pooledProbabilityStop: 0.49,
      provisional: true })
    expect(f.probabilityTarget).toBeGreaterThan(0.8)
    expect(f.conditioningBrierSkillScore).toBeGreaterThan(0.01)
    expect(f.probabilityTarget! + f.probabilityStop! + f.probabilityNeither!).toBeCloseTo(1, 8)
    expect(result.state).toBe('setup')
    expect(result.entry).toBe(current().entry)
    expect(result.stop).toBe(current().stop)
  })

  it('does not use later-completed outcomes to manufacture historical training evidence', () => {
    const rows = Array.from({ length: 80 }, (_, i) => record(i))
    for (const row of rows) row.outcome!.horizonEndAt = NOW - DAY
    const f = conditionRecoveryForecast(current(), rows).forecast
    expect(f).toMatchObject({ conditioningStatus: 'collecting', conditioningN: 40, conditioningPooledN: 80, conditioningValidationN: 0,
      probabilityTarget: 0.49, probabilityStop: 0.49, conditioningBrierScore: null })
  })

  it('requires twenty paired validation calls, and never creates probabilities without an established baseline', () => {
    const rows = Array.from({ length: 78 }, (_, i) => record(i))
    const f = conditionRecoveryForecast(current(), rows).forecast
    expect(f).toMatchObject({ conditioningStatus: 'collecting', conditioningValidationN: 19, probabilityTarget: 0.49 })
    const obs = current()
    obs.forecast.probabilityTarget = null
    obs.forecast.probabilityStop = null
    const unpriced = conditionRecoveryForecast(obs, Array.from({ length: 80 }, (_, i) => record(i))).forecast
    expect(unpriced).toMatchObject({ conditioningStatus: 'collecting', probabilityTarget: null, probabilityStop: null })
    expect(unpriced.conditioningReason).toContain('cannot create an estimate')
  })

  it('keeps the pooled estimates when contextual conditioning fails its paired probability-score test', () => {
    const rows = Array.from({ length: 80 }, (_, i) => {
      const row = record(i)
      const target = Math.floor(i / 2) % 2 === 0
      Object.assign(row.outcome!, { firstBarrier: target ? 'target' : 'stop', targetHit: target, stopHit: !target })
      return row
    })
    const f = conditionRecoveryForecast(current(), rows).forecast
    expect(f).toMatchObject({ conditioningStatus: 'no-improvement', calibrationBasis: 'pooled-forward-campaigns', conditioningValidationN: 20,
      probabilityTarget: 0.49, probabilityStop: 0.49 })
    expect(f.conditioningBrierSkillScore).toBeLessThan(0.01)
  })

  it('rejects legacy versions, cancelled entries, future outcomes and overlapping repeated calls', () => {
    const rows = Array.from({ length: 80 }, (_, i) => record(i))
    const legacy = { ...record(80), forecast: { ...record(80).forecast, modelVersion: 'old' } }
    const cancelled = record(81)
    Object.assign(cancelled.outcome!, { executionStatus: 'cancelled-gap', sessions: 0 })
    const future = record(82)
    future.outcome!.horizonEndAt = NOW + DAY
    const duplicate = { ...rows[0], id: 'duplicate', availableAt: rows[0].availableAt + DAY }
    const f = conditionRecoveryForecast(current(), [...rows, legacy, cancelled, future, duplicate]).forecast
    expect(f).toMatchObject({ conditioningN: 40, conditioningPooledN: 80, conditioningValidationN: 20 })
  })

  it('uses only the context saved with each published call and does not modify input records', () => {
    const rows = Array.from({ length: 80 }, (_, i) => record(i))
    const original = JSON.stringify(rows)
    const obs = current()
    delete obs.metrics.reportTrend
    const f = conditionRecoveryForecast(obs, rows).forecast
    expect(f).toMatchObject({ conditioningContext: null, conditioningStatus: 'collecting', conditioningN: 0, probabilityTarget: 0.49 })
    expect(JSON.stringify(rows)).toBe(original)
  })
})
