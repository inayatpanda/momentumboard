import type { BusinessHealthEvidence } from './businessHealth'

export type QuarterlyMetric = 'revenue' | 'netIncome' | 'operatingCashFlow' | 'capitalExpenditure' | 'freeCashFlow'
export interface FinancialQuarter {
  start: string; end: string; availableAt: number
  values: Record<QuarterlyMetric, number | null>
  evidence: Partial<Record<QuarterlyMetric, BusinessHealthEvidence>>
  revenueGrowthPct: number | null; netMarginPct: number | null; netMarginChangePp: number | null
  freeCashFlowMarginPct: number | null; freeCashFlowMarginChangePp: number | null
  derived: boolean
}
export interface QuarterlyFinancials {
  version: 'quarterly-asof-v1'; asOf: number; status: 'improving' | 'stable' | 'deteriorating' | 'insufficient'
  quarters: FinancialQuarter[]
  trailingYear: { start: string; end: string; availableAt: number; values: Record<QuarterlyMetric, number | null> } | null
  gaps: string[]
}

/** One vote per operating family. Missing quarters never become healthy. */
export function quarterlyTrend(quarters: FinancialQuarter[], asOf: number): QuarterlyFinancials['status'] {
  const recent = quarters.filter(q => q.availableAt <= asOf && Date.parse(q.end) / 1000 <= asOf).sort((a,b) => a.end.localeCompare(b.end)).slice(-3)
  if (recent.length < 3 || recent.some((q,i) => i > 0 && Date.parse(q.start) - Date.parse(recent[i-1].end) !== 86400000) || asOf - Date.parse(recent[2].end) / 1000 > 180 * 86400) return 'insufficient'
  const states = recent.map(q => {
    const values = [q.revenueGrowthPct, q.netMarginChangePp, q.freeCashFlowMarginChangePp]
    if (values.filter(v => v != null).length < 2) return 'insufficient'
    const thresholds = [2, 1, 1]
    if (values.filter((v, i) => v != null && v < -thresholds[i]).length >= 2) return 'deteriorating'
    if (values.filter((v, i) => v != null && v > thresholds[i]).length >= 2) return 'improving'
    return 'stable'
  })
  if (states.includes('insufficient')) return 'insufficient'
  const last = states.at(-1)!
  return last !== 'stable' && states.filter(s => s === last).length >= 2 ? last : 'stable'
}
