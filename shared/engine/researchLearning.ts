import {
  compatibleLabRecords, LAB_EXECUTION_VERSION, QUALITY_DIP_MODEL_VERSION, SHORT_HORIZON_MODEL_VERSION,
  SOCIAL_IGNITION_MODEL_VERSION, type StrategyLabRecord, type StrategyObservation, type StrategySleeve,
} from './strategyLab'

export const RESEARCH_LEARNING_VERSION = 1
export const MIN_PATTERN_N = 20
export const RESEARCH_COMPLETED_LIMIT = 500
export const RESEARCH_REPORT_LIMIT = 90
type LearningStatus = 'collecting' | 'observing'

export interface ResearchLearningStats {
  independentN: number
  filledN: number
  cancelledN: number
  meanNetReturnPct: number | null
  medianNetReturnPct: number | null
  targetHitRate: number | null
  stopHitRate: number | null
  directionN: number
  directionAccuracy: number | null
  brierEvent: 'finished-higher' | 'target-before-stop'
  brierN: number
  brierScore: number | null
  baselinePairedN: number
  baselineBrierScore: number | null
  pairedBrierScore: number | null
  brierSkillScore: number | null
  firstPublicationAt: number | null
  lastOutcomeAt: number | null
}

export interface ResearchChronology {
  status: LearningStatus
  summary: string
  splitPublicationAt: number | null
  older: ResearchLearningStats
  recent: ResearchLearningStats
  returnDifferencePct: number | null
  targetHitDifferencePct: number | null
}

export interface ResearchLearningCondition {
  key: string
  label: string
  status: LearningStatus
  summary: string
  stats: ResearchLearningStats
  chronology: ResearchChronology
  comparison: {
    reference: 'other campaigns in the same strategy'
    referenceN: number
    returnDifferencePct: number | null
    targetHitDifferencePct: number | null
  } | null
}

export interface ResearchLearningStrategy {
  key: StrategySleeve
  label: string
  modelVersion: string
  horizonSessions: number
  status: LearningStatus
  summary: string
  overall: ResearchLearningStats
  chronology: ResearchChronology
  conditions: ResearchLearningCondition[]
}

export interface ResearchLearningSnapshot {
  version: 1
  generatedAt: number
  minimumPatternN: number
  status: LearningStatus
  history: {
    completedLimit: number
    retainedRecordsN: number
    retainedCompletedN: number
    pendingN: number
    eligibleCompletedN: number
    excludedCompletedN: number
    excludedLegacyN: number
    excludedUnavailableN: number
    excludedOverlappingN: number
    oldestPublicationAt: number | null
    latestOutcomeAt: number | null
    atCapacity: boolean
  }
  strategies: ResearchLearningStrategy[]
  caveats: string[]
}

const CONTRACTS = [
  { key: 'short-horizon', label: 'Three-session direction', version: SHORT_HORIZON_MODEL_VERSION, horizon: 3, definition: 'three-session-direction-v1' },
  { key: 'quality-dip', label: 'Quality recovery', version: QUALITY_DIP_MODEL_VERSION, horizon: 63, definition: 'target-before-stop-v1' },
  { key: 'social-ignition', label: 'Social ignition', version: SOCIAL_IGNITION_MODEL_VERSION, horizon: 10, definition: 'target-before-stop-v1' },
] as const
const rounded = (n: number) => Math.round(n * 10_000) / 10_000
const average = (xs: number[]) => xs.length ? rounded(xs.reduce((a, b) => a + b, 0) / xs.length) : null
const probability = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const first = (xs: number[]) => xs.length ? Math.min(...xs) : null
const last = (xs: number[]) => xs.length ? Math.max(...xs) : null
const status = (n: number): LearningStatus => n >= MIN_PATTERN_N ? 'observing' : 'collecting'

function summarize(rows: StrategyLabRecord[], short: boolean): ResearchLearningStats {
  const filled = rows.filter(r => r.outcome?.executionStatus === 'filled' && finite(r.outcome.returnPct))
  const returns = filled.map(r => r.outcome!.returnPct).sort((a, b) => a - b)
  const middle = Math.floor(returns.length / 2)
  const direction = rows.filter(r => typeof r.outcome?.directionHit === 'boolean')
  const forecasts = (short ? rows : filled).flatMap(r => {
    const p = short ? r.forecast.probabilityUp : r.forecast.probabilityTarget
    const outcome = short ? r.outcome?.finishedHigher : r.outcome?.targetHit
    return probability(p) && typeof outcome === 'boolean' ? [{ p, outcome: outcome ? 1 : 0, baseline: short ? r.forecast.baselineProbabilityUp : r.forecast.pooledProbabilityTarget }] : []
  })
  const paired = forecasts.filter(r => probability(r.baseline))
  const baselineBrier = average(paired.map(r => (r.baseline! - r.outcome) ** 2))
  const pairedBrier = average(paired.map(r => (r.p - r.outcome) ** 2))
  return {
    independentN: rows.length, filledN: filled.length,
    cancelledN: rows.filter(r => r.outcome?.executionStatus === 'cancelled-gap').length,
    meanNetReturnPct: average(returns),
    medianNetReturnPct: returns.length ? rounded(returns.length % 2 ? returns[middle] : (returns[middle - 1] + returns[middle]) / 2) : null,
    targetHitRate: filled.length ? rounded(filled.filter(r => r.outcome?.targetHit).length / filled.length) : null,
    stopHitRate: filled.length ? rounded(filled.filter(r => r.outcome?.stopHit).length / filled.length) : null,
    directionN: direction.length,
    directionAccuracy: direction.length ? rounded(direction.filter(r => r.outcome?.directionHit).length / direction.length) : null,
    brierEvent: short ? 'finished-higher' : 'target-before-stop', brierN: forecasts.length,
    brierScore: average(forecasts.map(r => (r.p - r.outcome) ** 2)),
    baselinePairedN: paired.length, baselineBrierScore: baselineBrier, pairedBrierScore: pairedBrier,
    brierSkillScore: paired.length >= MIN_PATTERN_N && baselineBrier != null && baselineBrier > 0 && pairedBrier != null
      ? rounded(1 - pairedBrier / baselineBrier) : null,
    firstPublicationAt: first(rows.map(r => r.availableAt)),
    lastOutcomeAt: last(rows.map(r => r.outcome!.horizonEndAt!)),
  }
}

function differences(a: ResearchLearningStats, b: ResearchLearningStats) {
  const enough = a.filledN >= MIN_PATTERN_N && b.filledN >= MIN_PATTERN_N
  return {
    returnDifferencePct: enough && a.meanNetReturnPct != null && b.meanNetReturnPct != null ? rounded(a.meanNetReturnPct - b.meanNetReturnPct) : null,
    targetHitDifferencePct: enough && a.targetHitRate != null && b.targetHitRate != null ? rounded((a.targetHitRate - b.targetHitRate) * 100) : null,
  }
}

function chronology(rows: StrategyLabRecord[], short: boolean): ResearchChronology {
  const sorted = [...rows].sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))
  // One scan can publish many symbols. Never manufacture an earlier/recent
  // contrast by splitting that same timestamp according to symbol or ID order.
  const boundaries = sorted.flatMap((row, index) => index > 0 && row.availableAt > sorted[index - 1].availableAt ? [index] : [])
  const split = boundaries.sort((a, b) => Math.abs(a - sorted.length / 2) - Math.abs(b - sorted.length / 2) || a - b)[0] ?? 0
  const older = summarize(sorted.slice(0, split), short)
  const recent = summarize(sorted.slice(split), short)
  const ready = older.independentN >= MIN_PATTERN_N && recent.independentN >= MIN_PATTERN_N
  return {
    status: ready ? 'observing' : 'collecting', older, recent,
    splitPublicationAt: split > 0 ? sorted[split]?.availableAt ?? null : null,
    summary: ready
      ? 'Earlier and recent campaigns can be compared descriptively; this chronological split is not held-out validation.'
      : `Collecting chronological evidence: earlier ${older.independentN}/${MIN_PATTERN_N}, recent ${recent.independentN}/${MIN_PATTERN_N}.`,
    ...(ready ? differences(recent, older) : { returnDifferencePct: null, targetHitDifferencePct: null }),
  }
}

const CONDITIONS: { key: string; label: string; matches: (r: StrategyLabRecord) => boolean; known: (r: StrategyLabRecord) => boolean }[] = [
  ...(['improving', 'stable', 'deteriorating', 'insufficient'] as const).map(value => ({ key: `reports:${value}`, label: `Financial reports: ${value}`, matches: (r: StrategyLabRecord) => r.metrics.reportTrend === value,
    known: (r: StrategyLabRecord) => ['improving', 'stable', 'deteriorating', 'insufficient'].includes(String(r.metrics.reportTrend)) })),
  ...([true, false] as const).map(value => ({ key: `chart:${value ? 'confirmed' : 'unconfirmed'}`, label: `Chart recovery ${value ? 'confirmed' : 'unconfirmed'}`, matches: (r: StrategyLabRecord) => r.metrics.stabilising === value,
    known: (r: StrategyLabRecord) => typeof r.metrics.stabilising === 'boolean' })),
  ...(['in', 'out', 'flat'] as const).map(value => ({ key: `sector:${value}`, label: `Sector rotation: ${value}`, matches: (r: StrategyLabRecord) => r.metrics.sectorRotation === value,
    known: (r: StrategyLabRecord) => ['in', 'out', 'flat'].includes(String(r.metrics.sectorRotation)) })),
  ...(['risk-on', 'risk-off', 'mixed'] as const).map(value => ({ key: `world:${value}`, label: `International markets: ${value}`, matches: (r: StrategyLabRecord) => r.metrics.worldTone === value,
    known: (r: StrategyLabRecord) => ['risk-on', 'risk-off', 'mixed'].includes(String(r.metrics.worldTone)) })),
]

/** Read only information available at evaluation time. Model versions, execution
 * contracts and symbol horizons are never pooled. Missing context is not backfilled. */
export function buildResearchLearning(records: StrategyLabRecord[], nowSec: number): ResearchLearningSnapshot {
  const completed = records.filter(r => r.outcome)
  let excludedLegacyN = 0
  let excludedUnavailableN = 0
  let eligibleCompletedN = 0
  const supported = completed.filter(r => {
    const contract = CONTRACTS.find(c => c.key === r.sleeve)
    const valid = contract && r.forecast.modelVersion === contract.version && r.forecast.horizonSessions === contract.horizon &&
      r.forecast.definition === contract.definition && r.outcome?.executionVersion === LAB_EXECUTION_VERSION
    if (!valid) excludedLegacyN++
    return valid
  }).filter(r => {
    const o = r.outcome!
    const valid = finite(r.availableAt) && finite(o.horizonEndAt) && o.horizonEndAt > r.availableAt && o.horizonEndAt <= nowSec &&
      ['filled', 'cancelled-gap', 'not-applicable'].includes(o.executionStatus ?? '') &&
      (o.executionStatus !== 'filled' || (finite(o.returnPct) && finite(o.sessions) && o.sessions > 0))
    if (!valid) excludedUnavailableN++
    return valid
  })
  const eligible: StrategyLabRecord[] = []
  const strategies = CONTRACTS.map(contract => {
    const candidates = supported.filter(r => r.sleeve === contract.key)
    const rows = candidates.length ? compatibleLabRecords({ ...candidates[0], availableAt: nowSec + 1 }, candidates) : []
    eligibleCompletedN += rows.length
    eligible.push(...rows)
    const short = contract.key === 'short-horizon'
    const overall = summarize(rows, short)
    return {
      key: contract.key, label: contract.label, modelVersion: contract.version, horizonSessions: contract.horizon,
      status: status(rows.length), overall, chronology: chronology(rows, short),
      summary: rows.length < MIN_PATTERN_N ? `${rows.length}/${MIN_PATTERN_N} independent completed campaigns; collecting evidence.`
        : `${rows.length} independent completed campaigns; observed outcomes are descriptive, not proof of a predictive edge.`,
      conditions: CONDITIONS.flatMap(condition => {
        const matches = rows.filter(condition.matches)
        if (!matches.length) return []
        const remainder = rows.filter(r => condition.known(r) && !condition.matches(r))
        const stats = summarize(matches, short)
        const reference = summarize(remainder, short)
        const comparable = matches.length >= MIN_PATTERN_N && remainder.length >= MIN_PATTERN_N
        return [{
          key: condition.key, label: condition.label, status: status(matches.length), stats,
          chronology: chronology(matches, short),
          summary: matches.length < MIN_PATTERN_N ? `${matches.length}/${MIN_PATTERN_N} campaigns with this saved context; collecting evidence.`
            : comparable ? 'Observed association versus other recorded values of this context in the same strategy; not a causal effect.'
              : 'At least 20 campaigns have this context, but fewer than 20 comparison campaigns are available.',
          comparison: comparable ? { reference: 'other campaigns in the same strategy' as const, referenceN: remainder.length, ...differences(stats, reference) } : null,
        }]
      }),
    }
  })
  return {
    version: RESEARCH_LEARNING_VERSION, generatedAt: nowSec, minimumPatternN: MIN_PATTERN_N,
    status: eligibleCompletedN >= MIN_PATTERN_N && strategies.some(s => s.status === 'observing') ? 'observing' : 'collecting',
    history: {
      completedLimit: RESEARCH_COMPLETED_LIMIT, retainedRecordsN: records.length, retainedCompletedN: completed.length,
      pendingN: records.length - completed.length, eligibleCompletedN, excludedCompletedN: completed.length - eligibleCompletedN,
      excludedLegacyN, excludedUnavailableN, excludedOverlappingN: supported.length - eligibleCompletedN,
      oldestPublicationAt: first(completed.map(r => r.availableAt).filter(finite)),
      latestOutcomeAt: last(eligible.map(r => r.outcome!.horizonEndAt!)), atCapacity: completed.length >= RESEARCH_COMPLETED_LIMIT,
    },
    strategies,
    caveats: [
      'Rolling history retains up to 500 completed campaigns plus every pending campaign; this is not a lifetime performance record.',
      'Same-symbol overlapping campaigns, incompatible model/execution versions and outcomes unavailable at evaluation time are excluded.',
      'Returns include the execution contract’s 0.1% slippage at entry and exit; commissions, borrowing costs and market impact are not modeled.',
      'Context is frozen at publication. Missing financial, sector or market context is never reconstructed from later reports.',
      'At least 20 independent campaigns are required for a pattern statement; chronological comparisons need 20 in each half and do not establish out-of-sample validity.',
      'Context groups overlap and are observational. Counts and mean returns do not establish causation or justify automatic tuning or position sizing.',
      'Brier baselines use probabilities saved with the original forecast on the same paired rows. An unavailable baseline is not reconstructed from later outcomes.',
      'The campaign ledger has no saved passive-benchmark return; price-return comparisons against a passive benchmark remain unavailable.',
    ],
  }
}

export interface ResearchReportSnapshot {
  version: 1
  id: string
  date: string
  generatedAt: number
  learningStatus: LearningStatus
  completedN: number
  pendingN: number
  decisions: (StrategyObservation & { campaignId: string | null })[]
}

/** Each scan is an immutable report receipt. Reports never count as additional
 * outcomes: only independent campaigns in the lab ledger train the summaries. */
export function appendResearchReport(history: ResearchReportSnapshot[], args: {
  date: string; nowSec: number; observations: StrategyObservation[]; records: StrategyLabRecord[]; learning: ResearchLearningSnapshot
}, limit = RESEARCH_REPORT_LIMIT): ResearchReportSnapshot[] {
  const id = `research-v1:${args.nowSec}`
  if (history.some(report => report.id === id)) return history
  const decisions = args.observations.map(observation => {
    const campaign = [...args.records].reverse().find(r => r.sleeve === observation.sleeve && r.sym === observation.sym &&
      r.forecast.modelVersion === observation.forecast.modelVersion && (r.sleeve === 'short-horizon' || r.side === observation.side) &&
      r.availableAt <= observation.availableAt && (!r.outcome || (r.outcome.horizonEndAt ?? 0) >= observation.availableAt))
    return { ...observation, campaignId: campaign?.id ?? null }
  })
  const report: ResearchReportSnapshot = {
    version: 1, id, date: args.date, generatedAt: args.nowSec, learningStatus: args.learning.status,
    completedN: args.learning.history.eligibleCompletedN, pendingN: args.learning.history.pendingN,
    decisions: JSON.parse(JSON.stringify(decisions)) as ResearchReportSnapshot['decisions'],
  }
  return [...history, report].sort((a, b) => a.generatedAt - b.generatedAt).slice(-limit)
}
