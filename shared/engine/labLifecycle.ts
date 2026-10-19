import { compatibleLabRecords, LAB_EXECUTION_VERSION, QUALITY_DIP_MODEL_VERSION, SHORT_HORIZON_MODEL_VERSION, SOCIAL_IGNITION_MODEL_VERSION, type StrategyLabRecord, type StrategySleeve } from './strategyLab'

/** Longer recovery campaigns must not monopolise the grading budget before
 * their horizon can finish. Failed feeds rotate behind unattempted records. */
export function labGradingQueue(records: StrategyLabRecord[], nowSec: number, limit = 60): StrategyLabRecord[] {
  return records.filter(row => !row.outcome && nowSec - row.availableAt >= Math.max(0, row.forecast.horizonSessions - 1) * 86_400)
    .sort((a, b) => (a.lastGradeAttemptAt ?? 0) - (b.lastGradeAttemptAt ?? 0) || a.availableAt - b.availableAt)
    .slice(0, limit)
}

export function retainLabRecords(records: StrategyLabRecord[], completedLimit = 500): StrategyLabRecord[] {
  const completed = records.filter(row => row.outcome).sort((a, b) => a.availableAt - b.availableAt).slice(-completedLimit)
  return [...records.filter(row => !row.outcome), ...completed].sort((a, b) => a.availableAt - b.availableAt)
}

/** The summary counts the same model and independent campaigns as its cards. */
export function labEvidenceCount(records: StrategyLabRecord[], sleeve: StrategySleeve, nowSec: number): number {
  const versions: Partial<Record<StrategySleeve, string>> = {
    'short-horizon': SHORT_HORIZON_MODEL_VERSION,
    'quality-dip': QUALITY_DIP_MODEL_VERSION,
    'social-ignition': SOCIAL_IGNITION_MODEL_VERSION,
  }
  const example = records.find(row => row.sleeve === sleeve && row.forecast.modelVersion === versions[sleeve])
  if (!example || !versions[sleeve]) return 0
  const compatible = compatibleLabRecords({ ...example, availableAt: nowSec + 1 }, records)
  return sleeve === 'short-horizon' ? compatible.filter(row => typeof row.outcome?.finishedHigher === 'boolean').length
    : compatible.filter(row => row.outcome?.executionVersion === LAB_EXECUTION_VERSION && row.outcome.executionStatus === 'filled').length
}
