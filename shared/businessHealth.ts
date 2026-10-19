import type { FinancialReportPoint, ReportTrendSummary } from './reportTrends'

/** Reported fundamentals, separate from price behaviour and market size.
 * Annual flows and latest balance-sheet values retain their own periods. */
export const BUSINESS_HEALTH_METRICS = [
  'revenue', 'netIncome', 'operatingCashFlow', 'capitalExpenditure', 'freeCashFlow',
  'totalDebt', 'cash', 'currentAssets', 'currentLiabilities', 'totalEquity', 'totalLiabilities',
  'currentRatio', 'debtToEquity', 'liabilitiesToEquity', 'revenueGrowthPct', 'shareCountChangePct', 'netMarginPct',
  'recentNetIncome', 'recentOperatingCashFlow', 'recentRevenueGrowthPct', 'recentShareCountChangePct',
] as const
export type BusinessHealthMetric = typeof BUSINESS_HEALTH_METRICS[number]

export interface BusinessHealthEvidence {
  value: number
  periodStart: string | null
  periodEnd: string
  filed: string
  /** Conservative availability: noon UTC on the day after the filing date.
   * The SEC facts endpoint supplies dates, not release timestamps. */
  availableAt: number
  unit: string
  tags: string[]
  accessions: string[]
}

export interface BusinessHealthSnapshot {
  sym: string
  company: string | null
  cik: number | null
  source: 'sec-companyfacts'
  sourceUrl: string | null
  asOf: number
  availableAt: number | null
  status: 'available' | 'partial' | 'unavailable' | 'stale'
  periodEnd: string | null
  annualPeriodEnd: string | null
  balancePeriodEnd: string | null
  currency: 'USD' | null
  metrics: Record<BusinessHealthMetric, number | null>
  evidence: Partial<Record<BusinessHealthMetric, BusinessHealthEvidence>>
  gaps: string[]
  warnings: string[]
  /** Frozen at each report’s first known filing cutoff, never retrospectively revised. */
  reportHistory?: FinancialReportPoint[]
  reportTrend?: ReportTrendSummary
}

export function emptyBusinessHealth(sym: string, asOf: number, reason: string): BusinessHealthSnapshot {
  return {
    sym, company: null, cik: null, source: 'sec-companyfacts', sourceUrl: null, asOf,
    availableAt: null, status: 'unavailable', periodEnd: null, annualPeriodEnd: null,
    balancePeriodEnd: null, currency: null,
    metrics: Object.fromEntries(BUSINESS_HEALTH_METRICS.map(key => [key, null])) as Record<BusinessHealthMetric, number | null>,
    evidence: {}, gaps: [reason], warnings: [],
  }
}

export interface BusinessHealthAssessment {
  status: 'healthy' | 'unknown' | 'deteriorating'
  reasons: string[]
  risks: string[]
  gaps: string[]
}

/** A deliberately conservative screen, not a claim about intrinsic value.
 * Banks, high-reinvestment companies and firms with buyback-driven negative
 * equity can require sector-specific review even when perfectly viable. */
export function assessBusinessHealth(snapshot: BusinessHealthSnapshot | null | undefined, nowSec: number): BusinessHealthAssessment {
  const result: BusinessHealthAssessment = { status: 'unknown', reasons: [], risks: [], gaps: [] }
  if (!snapshot || snapshot.status === 'unavailable') {
    result.gaps.push('Reported business fundamentals are unavailable; a large price fall does not establish quality.')
    return result
  }
  const s = snapshot
  const m = s.metrics
  const ageDays = (day: string | null) => day ? (nowSec - Date.parse(`${day}T00:00:00Z`) / 1000) / 86_400 : Infinity
  // Retrieval time is not publication time. A run may fetch a snapshot a few
  // seconds after its fixed observation clock; every used filing must instead
  // have been available on that clock.
  if (s.availableAt == null || s.availableAt > nowSec) result.gaps.push('Fundamentals were not available at this observation time.')
  if (!s.annualPeriodEnd || ageDays(s.annualPeriodEnd) > 550 || ageDays(s.annualPeriodEnd) < 0) result.gaps.push('Annual operating results are missing or older than 550 days.')
  if (!s.balancePeriodEnd || ageDays(s.balancePeriodEnd) > 180 || ageDays(s.balancePeriodEnd) < 0) result.gaps.push('Balance-sheet evidence is missing or older than 180 days.')
  if (result.gaps.length) return result
  for (const key of ['netIncome', 'operatingCashFlow', 'freeCashFlow', 'currentRatio', 'revenueGrowthPct', 'shareCountChangePct'] as const) {
    if (m[key] == null || !Number.isFinite(m[key])) result.gaps.push(`${key}: no comparable reported value.`)
    const evidence = s.evidence[key]
    if (m[key] != null && (!evidence || evidence.availableAt > nowSec)) result.gaps.push(`${key}: filing availability is unverified.`)
  }
  if (s.balancePeriodEnd && s.annualPeriodEnd && s.balancePeriodEnd > s.annualPeriodEnd) {
    for (const key of ['recentNetIncome', 'recentOperatingCashFlow', 'recentRevenueGrowthPct', 'recentShareCountChangePct'] as const) {
      const evidence = s.evidence[key]
      if (m[key] == null || !Number.isFinite(m[key]) || !evidence || evidence.periodEnd !== s.balancePeriodEnd || evidence.availableAt > nowSec) {
        result.gaps.push(`${key}: the newer balance sheet needs matching interim operating evidence.`)
      }
    }
  }
  for (const [key, label] of [['netIncome', 'annual profit'], ['operatingCashFlow', 'operating cash flow'], ['freeCashFlow', 'free cash flow']] as const) {
    if (m[key] == null || !Number.isFinite(m[key]) || !s.evidence[key] || s.evidence[key]!.availableAt > nowSec) continue
    if (m[key]! > 0) result.reasons.push(`Positive ${label}.`)
    else result.risks.push(`Non-positive ${label}; fails this conservative recovery screen.`)
  }
  // Interim facts retain their actual quarter/YTD duration. A positive annual
  // report cannot override more recent reported losses or cash burn.
  for (const [key, label] of [['recentNetIncome', 'recent interim profit'], ['recentOperatingCashFlow', 'recent interim operating cash flow'], ['recentRevenueGrowthPct', 'recent comparable interim revenue growth']] as const) {
    const evidence = s.evidence[key]
    if (m[key] != null && evidence && evidence.availableAt <= nowSec && ageDays(evidence.periodEnd) <= 180 && evidence.periodEnd > (s.annualPeriodEnd ?? '')) {
      if (m[key]! < 0) result.risks.push(`Negative ${label}; recent deterioration overrides the older annual result.`)
      else result.reasons.push(`Non-negative ${label}.`)
    }
  }
  if (m.revenueGrowthPct != null && Number.isFinite(m.revenueGrowthPct) && s.evidence.revenueGrowthPct && s.evidence.revenueGrowthPct.availableAt <= nowSec) {
    if (m.revenueGrowthPct >= 0) result.reasons.push('Annual revenue is not shrinking against the comparable prior year.')
    else result.risks.push('Annual revenue declined against the comparable prior year.')
  }
  if (m.shareCountChangePct != null && Number.isFinite(m.shareCountChangePct) && s.evidence.shareCountChangePct && s.evidence.shareCountChangePct.availableAt <= nowSec) {
    if (m.shareCountChangePct > 10) result.risks.push('Comparable annual diluted share count grew more than 10%.')
    else result.reasons.push('Comparable annual diluted share-count growth is at most 10%.')
  }
  const recentShares = s.evidence.recentShareCountChangePct
  if (m.recentShareCountChangePct != null && Number.isFinite(m.recentShareCountChangePct) && recentShares &&
    recentShares.availableAt <= nowSec && ageDays(recentShares.periodEnd) <= 180 && recentShares.periodEnd > (s.annualPeriodEnd ?? '')) {
    if (m.recentShareCountChangePct > 10) result.risks.push('Comparable recent interim diluted share count grew more than 10%; recent dilution overrides the older annual comparison.')
    else result.reasons.push('Comparable recent interim diluted share-count growth is at most 10%.')
  }
  if (m.totalEquity == null || !Number.isFinite(m.totalEquity) || m.totalEquity <= 0) result.gaps.push('Positive book equity is unverified; sector or buyback review is required.')
  const leverage = m.debtToEquity ?? m.liabilitiesToEquity
  const leverageKey = m.debtToEquity != null ? 'debtToEquity' : 'liabilitiesToEquity'
  if (leverage == null || !Number.isFinite(leverage) || !s.evidence[leverageKey] || s.evidence[leverageKey]!.availableAt > nowSec) result.gaps.push('Leverage cannot be established from comparable reported balances.')
  else if (leverage > 1.5 || leverage < 0) result.gaps.push('Leverage needs sector-specific review; the conservative 1.5× ceiling is not met.')
  else result.reasons.push(m.debtToEquity != null ? 'Reported debt is at most 1.5× equity.' : 'Total liabilities are at most 1.5× equity; this conservatively bounds debt.')
  if (m.currentRatio != null && Number.isFinite(m.currentRatio) && s.evidence.currentRatio && s.evidence.currentRatio.availableAt <= nowSec) {
    if (m.currentRatio < 1) result.gaps.push('Current assets do not cover current liabilities; liquidity needs sector-specific review.')
    else result.reasons.push('Current assets cover current liabilities.')
  }
  if (result.risks.length) {
    result.status = 'deteriorating'
    result.risks.push('A failed conservative screen does not establish insolvency or permanent business impairment.')
  } else if (!result.gaps.length) result.status = 'healthy'
  return result
}
