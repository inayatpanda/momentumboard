import {
  compatibleLabRecords, LAB_EXECUTION_VERSION, QUALITY_DIP_MODEL_VERSION,
  type StrategyLabRecord, type StrategyObservation,
} from './strategyLab'

export const CONDITIONING_VERSION = 'report-trend-dirichlet-prequential-v1'
const MIN_POOLED = 40
const MIN_COHORT = 20
const MIN_VALIDATION = 20
const PRIOR_WEIGHT = 20
const MIN_SKILL = 0.01
const r4 = (value: number) => Math.round(value * 10_000) / 10_000
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const probability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1
const knownContext = (value: unknown): value is string => typeof value === 'string' && ['improving', 'stable', 'deteriorating', 'insufficient'].includes(value)
type Distribution = [number, number, number]

function event(row: StrategyLabRecord): 0 | 1 | 2 {
  return row.outcome!.firstBarrier === 'target' ? 0 : row.outcome!.firstBarrier === 'stop' ? 1 : 2
}

function distributions(pooled: StrategyLabRecord[], cohort: StrategyLabRecord[]): { pooled: Distribution; conditioned: Distribution } {
  const count = (rows: StrategyLabRecord[], outcome: number) => rows.filter(row => event(row) === outcome).length
  const baseline = [0, 1, 2].map(outcome => (count(pooled, outcome) + 1) / (pooled.length + 3)) as Distribution
  return { pooled: baseline,
    conditioned: [0, 1, 2].map(outcome => (count(cohort, outcome) + PRIOR_WEIGHT * baseline[outcome]) / (cohort.length + PRIOR_WEIGHT)) as Distribution }
}

function completedBefore(observation: StrategyObservation, records: StrategyLabRecord[]): StrategyLabRecord[] {
  const known = records.filter(row => {
    const o = row.outcome
    return row.side === observation.side && o?.executionVersion === LAB_EXECUTION_VERSION && o.executionStatus === 'filled' &&
      finite(o.sessions) && o.sessions > 0 && finite(o.returnPct) && finite(o.horizonEndAt) &&
      o.horizonEndAt > row.availableAt && o.horizonEndAt < observation.availableAt &&
      ['target', 'stop', 'none'].includes(o.firstBarrier) &&
      o.targetHit === (o.firstBarrier === 'target') && o.stopHit === (o.firstBarrier === 'stop')
  })
  return compatibleLabRecords(observation, known)
}

const brier = (distribution: Distribution, actual: number) => distribution.reduce((sum, p, i) => sum + (p - (i === actual ? 1 : 0)) ** 2, 0)

/** Fixed, declared report cohorts only. Every historical prediction is rebuilt
 * from outcomes already resolved before its publication, including the full
 * 63-session delay. No parameter or threshold is selected from these results. */
export function conditionRecoveryForecast(observation: StrategyObservation, records: StrategyLabRecord[]): StrategyObservation {
  if (observation.sleeve !== 'quality-dip' || observation.forecast.modelVersion !== QUALITY_DIP_MODEL_VERSION ||
    observation.forecast.definition !== 'target-before-stop-v1' || observation.forecast.horizonSessions !== 63) return observation
  const context = knownContext(observation.metrics.reportTrend) ? observation.metrics.reportTrend : null
  const pooled = completedBefore(observation, records)
  const cohort = context == null ? [] : pooled.filter(row => row.metrics.reportTrend === context)
  const validation: { baseline: number; conditioned: number }[] = []
  // Evaluate only this predeclared cohort, on paired predictions made from the
  // same historical information set. The tested call never trains itself.
  for (const heldOut of cohort) {
    const prior = completedBefore(heldOut, pooled)
    const sameContext = prior.filter(row => row.metrics.reportTrend === context)
    if (prior.length < MIN_POOLED || sameContext.length < MIN_COHORT) continue
    const estimates = distributions(prior, sameContext)
    validation.push({ baseline: brier(estimates.pooled, event(heldOut)), conditioned: brier(estimates.conditioned, event(heldOut)) })
  }
  const baseline = validation.length ? validation.reduce((sum, row) => sum + row.baseline, 0) / validation.length : null
  const score = validation.length ? validation.reduce((sum, row) => sum + row.conditioned, 0) / validation.length : null
  const skill = baseline != null && baseline > 0 && score != null ? 1 - score / baseline : null
  const baseExists = probability(observation.forecast.probabilityTarget) && probability(observation.forecast.probabilityStop)
  const enough = context != null && baseExists && pooled.length >= MIN_POOLED && cohort.length >= MIN_COHORT && validation.length >= MIN_VALIDATION
  const qualified = enough && skill != null && skill >= MIN_SKILL
  const forecast: StrategyObservation['forecast'] = {
    ...observation.forecast,
    calibrationBasis: qualified ? 'validated-report-trend' as const : 'pooled-forward-campaigns' as const,
    conditioningVersion: CONDITIONING_VERSION,
    conditioningContext: context,
    conditioningStatus: qualified ? 'validated' as const : enough ? 'no-improvement' as const : 'collecting' as const,
    conditioningReason: qualified
      ? 'Fixed report-trend cohort improved paired chronological three-category Brier by at least 1%; still a shadow estimate.'
      : !context ? 'No saved comparable report-trend context; retain the pooled forecast.'
        : !baseExists ? 'No established pooled target/stop probabilities; conditioning cannot create an estimate.'
          : !enough ? `Collecting: need ${MIN_POOLED} completed pooled campaigns, ${MIN_COHORT} in this cohort and ${MIN_VALIDATION} eligible chronological validation calls.`
            : 'The report-trend cohort did not improve paired chronological three-category Brier by at least 1%; retain pooled estimates.',
    conditioningN: cohort.length, conditioningPooledN: pooled.length, conditioningValidationN: validation.length,
    conditioningBrierMetric: 'three-class-target-stop-neither' as const,
    conditioningBrierScore: score == null ? null : r4(score),
    conditioningBaselineBrierScore: baseline == null ? null : r4(baseline),
    conditioningBrierSkillScore: validation.length >= MIN_VALIDATION && skill != null ? r4(skill) : null,
    pooledProbabilityTarget: observation.forecast.probabilityTarget ?? null,
    pooledProbabilityStop: observation.forecast.probabilityStop ?? null,
  }
  if (!qualified) return { ...observation, forecast }
  const current = distributions(pooled, cohort).conditioned
  const target = r4(current[0])
  const stop = r4(current[1])
  return { ...observation, forecast: { ...forecast, probabilityTarget: target, probabilityStop: stop,
    probabilityNeither: r4(1 - target - stop), provisional: true } }
}
