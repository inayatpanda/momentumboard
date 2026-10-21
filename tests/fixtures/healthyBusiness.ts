import { emptyBusinessHealth } from '../../shared/businessHealth'

/** Explicit, date-aligned fundamentals for engine tests of other gates. */
export function healthyBusiness(sym: string, now: number) {
  const value = emptyBusinessHealth(sym, now, '')
  const period = new Date((now - 60 * 86_400) * 1000).toISOString().slice(0, 10)
  Object.assign(value, { status: 'available', availableAt: now - 30 * 86_400, annualPeriodEnd: period, balancePeriodEnd: period, periodEnd: period, gaps: [] })
  Object.assign(value.metrics, { netIncome: 100, operatingCashFlow: 140, freeCashFlow: 90, currentRatio: 2,
    totalEquity: 600, debtToEquity: 0.3, revenueGrowthPct: 10, shareCountChangePct: 0 })
  for (const [name, n] of Object.entries(value.metrics)) {
    if (n != null) value.evidence[name as keyof typeof value.metrics] = {
      value: n, periodStart: null, periodEnd: period, filed: period, availableAt: now - 30 * 86_400,
      unit: 'USD', tags: ['test-fixture'], accessions: ['test-fixture'],
    }
  }
  return value
}
