import type { StrategyObservation } from './strategyLab'

export const HISTORY_VERSION = 'long-history-quarterly-sector-v3'
export const HISTORY_GATED_MODEL = 'baseline-lift-history-gated-v6'
export const HISTORY_CORE_MODEL = 'baseline-lift-250-session-v4'
export interface HistoricalTrade {
  sym: string; signalAt: number; endAt: number; returnPct: number; marketPct: number
  brier?: number; baselineBrier?: number
  sectorPct?: number; sector?: string; filingAt?: number; annualPeriodEnd?: string; annualPE?: number | null; fcfYieldPct?: number | null
}
export interface HistoricalStats {
  n: number; quarters: number; meanReturnPct: number | null; meanMarketPct: number | null
  excessPp: number | null; beatRate: number | null; brier: number | null; baselineBrier: number | null
  uncertaintyPp: [number, number] | null
}
export interface HistoryGate {
  year: number; trainingFrom: number; trainingThrough: number; n: number; months: number
  excessPp: number | null; brierSkill: number | null; allow: boolean
}
export interface HistoricalStrategy {
  key: string; label: string; description: string; horizon: number
  status: 'ahead' | 'behind' | 'uncertain' | 'no-trades'
  stats: HistoricalStats; years: { year: number; stats: HistoricalStats }[]
  cancelledN: number; missingN: number
  sectorStats?: HistoricalStats; sectorStatus?: 'ahead' | 'behind' | 'uncertain' | 'no-trades'; missingSectorN?: number
  financial?: boolean; unknownFinancialN?: number; candidateN?: number
  sectors?: { sector: string; stats: HistoricalStats; sectorStats?: HistoricalStats }[]
  examples?: HistoricalTrade[]
}
export interface HistoricalStudy {
  version: string; coreModel: string; generatedAt: number; dataThrough: number
  dataFrom: number; evaluationFrom: number; symbols: string[]; missingSymbols: string[]
  strategies: HistoricalStrategy[]; gates: HistoryGate[]; liveGate: HistoryGate
  costBpsPerSide: number; dataDigest: string; caveats: string[]
  financialCoverage?: { version: string; symbols: string[]; unavailableSymbols: string[]; snapshots: number; companies?: { sym: string; snapshots: number; firstAvailableAt: number | null; latestAvailableAt: number | null }[] }
  comparisons?: number; confidencePct?: number
  unavailable: { label: string; reason: string }[]
}
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

/** Freeze each year's safety filter BEFORE that year's first signal. Only fully
 * finished trades in the preceding two calendar years may teach it anything. */
export function historyGate(trades: HistoricalTrade[], year: number): HistoryGate {
  const trainingFrom = Date.UTC(year - 2, 0, 1) / 1000
  const trainingThrough = Date.UTC(year, 0, 1) / 1000 - 1
  const prior = trades.filter(t => t.signalAt >= trainingFrom && t.endAt <= trainingThrough)
  const paired = prior.filter(t => t.brier != null && t.baselineBrier != null)
  const brier = mean(paired.map(t => t.brier!)), baseline = mean(paired.map(t => t.baselineBrier!))
  const brierSkill = brier != null && baseline != null && baseline > 0 ? 1 - brier / baseline : null
  const excessPp = mean(prior.map(t => t.returnPct - t.marketPct))
  const months = new Set(prior.map(t => new Date(t.signalAt * 1000).toISOString().slice(0, 7))).size
  return { year, trainingFrom, trainingThrough, n: prior.length, months, excessPp, brierSkill,
    allow: prior.length >= 80 && paired.length >= 80 && months >= 12 && excessPp != null && excessPp > 0 && brierSkill != null && brierSkill > 0 }
}

/** A historical study can veto, never promote or size a trade. Unknown symbols,
 * stale studies and mismatched versions cannot inherit another sample's edge. */
export function applyHistoryGate(observation: StrategyObservation, study: HistoricalStudy | null | undefined, now: number): StrategyObservation {
  if (observation.sleeve !== 'short-horizon') return observation
  const year = new Date(now * 1000).getUTCFullYear()
  const compatible = observation.forecast.modelVersion === HISTORY_CORE_MODEL && observation.metrics.historySessionN === 250 &&
    study?.version === HISTORY_VERSION && study.coreModel === HISTORY_CORE_MODEL &&
    study.generatedAt <= now && now - study.generatedAt <= 45 * 86400 && study.dataThrough <= now &&
    study.liveGate.year === year && study.liveGate.trainingThrough < Date.UTC(year, 0, 1) / 1000 &&
    study.dataThrough >= study.liveGate.trainingThrough - 7 * 86400 && study.generatedAt - study.dataThrough <= 10 * 86400 &&
    study.symbols.includes(observation.sym) && !study.missingSymbols.includes(observation.sym)
  const allowed = Boolean(compatible && study?.liveGate.allow)
  const note = allowed
    ? 'The prior two years passed the historical safety filter. This remains a research forecast, not a proven market-beating signal.'
    : compatible ? 'The prior two years did not support both market outperformance and better probability estimates. Kept on watch.'
      : 'No current, comparable historical safety test covers this stock. Kept on watch until evidence is available.'
  return { ...observation, state: observation.state === 'setup' && !allowed ? 'watch' : observation.state,
    forecast: { ...observation.forecast, modelVersion: HISTORY_GATED_MODEL },
    metrics: { ...observation.metrics, historyGate: allowed ? 'passed' : compatible ? 'not-supported' : 'unavailable', historyGateYear: year },
    risks: [...observation.risks, note] }
}

/** Attach measured research to recovery ideas without importing a simulated
 * probability, score boost or target from a different execution strategy. */
export function withFinancialHistory(observation: StrategyObservation, study: HistoricalStudy | null | undefined, now: number): StrategyObservation {
  if (observation.sleeve !== 'quality-dip') return observation
  const compatible = study?.version === HISTORY_VERSION && study.financialCoverage?.version === 'sec-asof-quarterly-v2' &&
    study.generatedAt <= now && now - study.generatedAt <= 45 * 86400 && study.dataThrough <= now &&
    now - study.dataThrough <= 14 * 86400 && study.financialCoverage.symbols.includes(observation.sym)
  const comparison = compatible ? (study?.strategies.find(s => s.key === 'quarterly-recovery') ?? study?.strategies.find(s => s.key === 'healthy-value-drop')) : undefined
  const excess = comparison?.stats.excessPp
  const detail = comparison && excess != null
    ? `Related ${comparison.label} screen: ${excess >= 0 ? '+' : ''}${excess.toFixed(2)}pp per setup versus SPY across ${comparison.stats.n} historical setups; ${comparison.status === 'ahead' ? 'passed historical consistency checks' : 'no reliable advantage established'}. This fixed-horizon screen does not validate this idea’s catalyst or stop/target scenario.`
    : 'No current comparable financial-history evidence covers this stock. The recovery scenario remains unvalidated.'
  return { ...observation, metrics: { ...observation.metrics, historicalFinancialStatus: comparison?.status ?? 'unavailable',
    historicalFinancialExcessPp: excess ?? null, historicalFinancialSectorExcessPp: comparison?.sectorStats?.excessPp ?? null, historicalFinancialStrategy: comparison?.key ?? null, historicalFinancialSetups: comparison?.stats.n ?? 0 }, risks: [...observation.risks, detail] }
}
