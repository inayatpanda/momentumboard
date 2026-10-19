import { describe, expect, it } from 'vitest'
import { appendResearchReport, buildResearchLearning } from './researchLearning'
import { LAB_EXECUTION_VERSION, QUALITY_DIP_MODEL_VERSION, SHORT_HORIZON_MODEL_VERSION, type StrategyLabRecord } from './strategyLab'

const DAY = 86_400
const NOW = 1_000_000_000
function record(i: number, quality = false): StrategyLabRecord {
  const availableAt = 100_000 + i * DAY
  return {
    id: `call-${i}`, sym: `SYM${i}`, sleeve: quality ? 'quality-dip' : 'short-horizon', side: 'long', state: 'setup',
    score: 75, entry: 100, stop: 90, target: 120, detectedAt: availableAt, availableAt,
    reasons: [], risks: [], dataGaps: [], metrics: {},
    forecast: { definition: quality ? 'target-before-stop-v1' : 'three-session-direction-v1',
      modelVersion: quality ? QUALITY_DIP_MODEL_VERSION : SHORT_HORIZON_MODEL_VERSION,
      label: 'Saved forecast', horizonSessions: quality ? 63 : 3, probabilityUp: quality ? null : 0.8,
      probabilityTarget: quality ? 0.75 : null, baselineProbabilityUp: quality ? null : 0.5,
      calibratedN: 50, provisional: true },
    outcome: { entry: 100.1, exit: 103.1, returnPct: 3, sessions: quality ? 63 : 3, firstBarrier: 'target',
      targetHit: true, stopHit: false, directionHit: true, finishedHigher: true, executionStatus: 'filled',
      executionVersion: LAB_EXECUTION_VERSION, horizonEndAt: availableAt + (quality ? 90 : 3) * DAY },
  }
}

describe('research learning memory', () => {
  it('excludes future, incompatible and overlapping receipts with explicit counts', () => {
    const base = record(0)
    const overlap = { ...record(1), sym: base.sym }
    const duplicate = { ...base }
    const legacy = { ...record(3), forecast: { ...base.forecast, modelVersion: 'previous-version' } }
    const future = { ...record(4), outcome: { ...record(4).outcome!, horizonEndAt: NOW + DAY } }
    const noExecution = { ...record(5), outcome: { ...record(5).outcome!, executionVersion: undefined } }
    const pending = { ...record(6), outcome: undefined }
    const snapshot = buildResearchLearning([base, overlap, duplicate, legacy, future, noExecution, pending], NOW)
    expect(snapshot.history).toMatchObject({ retainedRecordsN: 7, retainedCompletedN: 6, pendingN: 1,
      eligibleCompletedN: 1, excludedCompletedN: 5, excludedLegacyN: 2, excludedUnavailableN: 1, excludedOverlappingN: 2 })
    expect(snapshot.strategies[0].overall.independentN).toBe(1)
    expect(snapshot.strategies[0].summary).toContain('collecting evidence')
  })

  it('uses cost-adjusted filled returns and excludes cancelled entries from barrier results', () => {
    const rows = Array.from({ length: 20 }, (_, i) => {
      const r = record(i, true)
      if (i >= 10) Object.assign(r.outcome!, { returnPct: -1, targetHit: false, stopHit: true, firstBarrier: 'stop' })
      return r
    })
    const cancelled = record(21, true)
    Object.assign(cancelled.outcome!, { executionStatus: 'cancelled-gap', returnPct: 99, sessions: 0 })
    const quality = buildResearchLearning([...rows, cancelled], NOW).strategies[1]
    expect(quality.overall).toMatchObject({ independentN: 21, filledN: 20, cancelledN: 1,
      meanNetReturnPct: 1, medianNetReturnPct: 1, targetHitRate: 0.5, stopHitRate: 0.5,
      brierN: 20, brierScore: 0.3125, baselinePairedN: 0, baselineBrierScore: null, brierSkillScore: null })
  })

  it('compares probability errors to saved baselines on exactly the same paired forecasts', () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
      const r = record(i)
      if (i >= 20) Object.assign(r.forecast, { probabilityUp: 0.1, baselineProbabilityUp: null })
      return r
    })
    expect(buildResearchLearning(rows, NOW).strategies[0].overall).toMatchObject({
      brierN: 40, brierScore: 0.425, baselinePairedN: 20, pairedBrierScore: 0.04, baselineBrierScore: 0.25, brierSkillScore: 0.84,
    })
    expect(buildResearchLearning(rows.slice(0, 19), NOW).strategies[0].overall.brierSkillScore).toBeNull()
  })

  it('audits conditioned recovery probabilities against the pooled target probability saved at publication', () => {
    const rows = Array.from({ length: 20 }, (_, i) => {
      const r = record(i, true)
      r.outcome!.targetHit = i < 10
      r.forecast.probabilityTarget = i < 10 ? 0.8 : 0.2
      r.forecast.pooledProbabilityTarget = 0.5
      return r
    })
    expect(buildResearchLearning(rows, NOW).strategies[1].overall).toMatchObject({ brierEvent: 'target-before-stop',
      brierN: 20, brierScore: 0.04, baselinePairedN: 20, baselineBrierScore: 0.25, brierSkillScore: 0.84 })
  })

  it('requires twenty campaigns in both context groups and never invents missing context', () => {
    const rows = Array.from({ length: 70 }, (_, i) => {
      const r = record(i, true)
      if (i < 40) r.metrics = { reportTrend: i < 20 ? 'improving' : 'stable', stabilising: true, worldTone: 'risk-off' }
      r.outcome!.returnPct = i < 20 ? 2 : i < 40 ? -2 : 99
      return r
    })
    const quality = buildResearchLearning(rows, NOW).strategies[1]
    const improving = quality.conditions.find(c => c.key === 'reports:improving')!
    expect(improving.status).toBe('observing')
    expect(improving.comparison).toMatchObject({ referenceN: 20, returnDifferencePct: 4 })
    expect(quality.conditions.find(c => c.key === 'chart:confirmed')?.comparison).toBeNull()
    const small = buildResearchLearning(rows.slice(0, 19), NOW).strategies[1].conditions[0]
    expect(small.status).toBe('collecting')
    expect(small.comparison).toBeNull()
  })

  it('detects chronological weakening only after each half has twenty independent campaigns', () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
      const r = record(i)
      r.outcome!.returnPct = i < 20 ? 3 : -3
      return r
    })
    const drift = buildResearchLearning(rows, NOW).strategies[0].chronology
    expect(drift).toMatchObject({ status: 'observing', returnDifferencePct: -6, older: { independentN: 20 }, recent: { independentN: 20 } })
    expect(drift.summary).toContain('not held-out validation')
    expect(buildResearchLearning(rows.slice(0, 39), NOW).strategies[0].chronology).toMatchObject({ status: 'collecting', returnDifferencePct: null })
  })

  it('does not invent chronological drift between calls published in the same scan', () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
      const r = record(i)
      r.availableAt = 100_000
      r.outcome!.returnPct = i < 20 ? 10 : -10
      return r
    })
    expect(buildResearchLearning(rows, NOW).strategies[0].chronology).toMatchObject({ status: 'collecting',
      older: { independentN: 0 }, recent: { independentN: 40 }, returnDifferencePct: null })
  })

  it('preserves distinct immutable report receipts and links refreshed rows to one open campaign', () => {
    const campaign = { ...record(1), outcome: undefined }
    const learning = buildResearchLearning([campaign], NOW)
    const args = { date: '2026-10-19', nowSec: NOW, observations: [campaign], records: [campaign], learning }
    const first = appendResearchReport([], args)
    const saved = JSON.stringify(first[0])
    campaign.metrics.reportTrend = 'deteriorating'
    campaign.forecast.probabilityUp = 0.1
    expect(JSON.stringify(first[0])).toBe(saved)
    expect(appendResearchReport(first, args)).toBe(first)
    const refresh = { ...campaign, id: 'refresh', availableAt: NOW + 10 }
    const second = appendResearchReport(first, { ...args, nowSec: NOW + 10, observations: [refresh] })
    expect(second).toHaveLength(2)
    expect(second[1].decisions[0].campaignId).toBe(campaign.id)
    expect(JSON.stringify(second[0])).toBe(saved)
    expect(appendResearchReport(second, { ...args, nowSec: NOW + 20 }, 2).map(r => r.generatedAt)).toEqual([NOW + 10, NOW + 20])
  })

  it('discloses the retained rolling window and keeps old-version evidence separate', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ ...record(i), forecast: { ...record(i).forecast, modelVersion: 'legacy' } }))
    const snapshot = buildResearchLearning(rows, NOW)
    expect(snapshot.history).toMatchObject({ atCapacity: true, completedLimit: 500, retainedCompletedN: 500, eligibleCompletedN: 0, excludedLegacyN: 500, oldestPublicationAt: 100_000 })
    expect(snapshot.status).toBe('collecting')
    expect(snapshot.strategies.every(s => s.overall.independentN === 0)).toBe(true)
  })
})
