import { assessBusinessValuation } from '../../../shared/businessValuation'
import { describe, expect, it, vi } from 'vitest'
import { assessBusinessHealth } from '../../../shared/businessHealth'
import { fetchBusinessHealth, parseBusinessHealthFacts } from './businessHealth'

const NOW = Date.parse('2026-10-19T12:00:00Z') / 1000
type FixtureFact = { val: number; end: string; start?: string; filed: string; form: string; accn: string }
function fixture() {
  const facts: Record<string, { units: Record<string, FixtureFact[]> }> = {}
  const annual = (tag: string, latest: number, prior?: number, unit = 'USD') => {
    const common = { filed: '2026-02-15', form: '10-K', accn: '0001-26-000001' }
    facts[tag] = { units: { [unit]: [{ ...common, start: '2025-01-01', end: '2025-12-31', val: latest },
      ...(prior == null ? [] : [{ ...common, start: '2024-01-01', end: '2024-12-31', val: prior }])] } }
  }
  const balance = (tag: string, val: number) => {
    facts[tag] = { units: { USD: [{ val, end: '2026-06-30', filed: '2026-08-01', form: '10-Q', accn: '0001-26-000002' }] } }
  }
  annual('RevenueFromContractWithCustomerExcludingAssessedTax', 1000, 900)
  annual('NetIncomeLoss', 100)
  annual('NetCashProvidedByUsedInOperatingActivities', 140)
  annual('PaymentsToAcquirePropertyPlantAndEquipment', 50)
  annual('WeightedAverageNumberOfDilutedSharesOutstanding', 100, 100, 'shares')
  facts.WeightedAverageNumberOfDilutedSharesOutstanding.units.shares.push(
    { val: 100, start: '2026-04-01', end: '2026-06-30', filed: '2026-08-01', form: '10-Q', accn: '0001-26-000002' },
    { val: 100, start: '2025-04-01', end: '2025-06-30', filed: '2026-08-01', form: '10-Q', accn: '0001-26-000002' },
  )
  const interim = (tag: string, val: number, prior?: number) => {
    const common = { filed: '2026-08-01', form: '10-Q', accn: '0001-26-000002' }
    facts[tag].units.USD.push({ ...common, start: '2026-04-01', end: '2026-06-30', val })
    if (prior != null) facts[tag].units.USD.push({ ...common, start: '2025-04-01', end: '2025-06-30', val: prior })
  }
  interim('NetIncomeLoss', 20)
  interim('NetCashProvidedByUsedInOperatingActivities', 40)
  interim('RevenueFromContractWithCustomerExcludingAssessedTax', 250, 225)
  balance('CashAndCashEquivalentsAtCarryingValue', 100)
  balance('AssetsCurrent', 400)
  balance('LiabilitiesCurrent', 200)
  balance('StockholdersEquity', 600)
  balance('Liabilities', 400)
  balance('DebtCurrent', 60)
  balance('LongTermDebtNoncurrent', 120)
  return { cik: 1, entityName: 'Example plc', facts: { 'us-gaap': facts } }
}

describe('reported business health', () => {
  it('reads productive investment and explicit lease-inclusive debt without assuming missing borrowing is zero', () => {
    const body = fixture()
    const facts = body.facts['us-gaap']
    facts.PaymentsToAcquireProductiveAssets = facts.PaymentsToAcquirePropertyPlantAndEquipment
    delete facts.PaymentsToAcquirePropertyPlantAndEquipment
    facts.LongTermDebtAndCapitalLeaseObligations = facts.LongTermDebtNoncurrent
    delete facts.LongTermDebtNoncurrent
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.freeCashFlow).toBe(90)
    expect(value.evidence.freeCashFlow?.tags).toContain('us-gaap:PaymentsToAcquireProductiveAssets')
    expect(value.metrics.totalDebt).toBe(180)
    delete facts.DebtCurrent
    expect(parseBusinessHealthFacts(body, 'TEST', NOW).metrics.totalDebt).toBeNull()
  })

  it('does not add current maturities twice to total long-term debt or combine different balance dates', () => {
    const body = fixture()
    const facts = body.facts['us-gaap']
    facts.LongTermDebt = facts.LongTermDebtNoncurrent
    delete facts.LongTermDebtNoncurrent
    facts.ShortTermBorrowings = { units: { USD: [{ ...facts.DebtCurrent.units.USD[0], val: 20 }] } }
    expect(parseBusinessHealthFacts(body, 'TEST', NOW).metrics.totalDebt).toBe(140)
    facts.ShortTermBorrowings.units.USD[0].end = '2026-03-31'
    expect(parseBusinessHealthFacts(body, 'TEST', NOW).metrics.totalDebt).toBeNull()
  })

  it('builds matched annual flows, balance ratios and filing provenance', () => {
    const value = parseBusinessHealthFacts(fixture(), 'TEST', NOW)
    expect(value.metrics).toMatchObject({ revenue: 1000, freeCashFlow: 90, totalDebt: 180, currentRatio: 2, debtToEquity: 0.3, shareCountChangePct: 0, netMarginPct: 10 })
    expect(value.metrics.revenueGrowthPct).toBeCloseTo(11.111)
    expect(value.metrics.recentShareCountChangePct).toBe(0)
    expect(value.annualPeriodEnd).toBe('2025-12-31')
    expect(value.balancePeriodEnd).toBe('2026-06-30')
    expect(value.evidence.freeCashFlow).toMatchObject({ periodStart: '2025-01-01', periodEnd: '2025-12-31', filed: '2026-02-15', unit: 'USD' })
    expect(value.evidence.freeCashFlow?.tags).toHaveLength(2)
    expect(value.status).toBe('available')
    expect(assessBusinessHealth(value, NOW).status).toBe('healthy')
  })

  it('does not leak a later restatement into a historical observation', () => {
    const body = fixture()
    const rows = body.facts['us-gaap'].NetIncomeLoss.units.USD
    rows.push({ ...rows[0], filed: '2026-11-01', val: -900, accn: 'future-amendment', form: '10-K/A' })
    expect(parseBusinessHealthFacts(body, 'TEST', NOW).metrics.netIncome).toBe(100)
    expect(parseBusinessHealthFacts(body, 'TEST', Date.parse('2026-11-03T12:00:00Z') / 1000).metrics.netIncome).toBe(-900)
  })

  it('does not use a date-only filing before its conservative availability time', () => {
    const value = parseBusinessHealthFacts(fixture(), 'TEST', Date.parse('2026-08-01T23:00:00Z') / 1000)
    expect(value.metrics.currentRatio).toBeNull()
    expect(value.balancePeriodEnd).toBeNull()
    expect(assessBusinessHealth(value, NOW).status).toBe('unknown')
  })

  it('does not subtract capex from a different annual period or treat nine-month YTD as annual', () => {
    const body = fixture()
    body.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD[0].start = '2025-04-01'
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.capitalExpenditure).toBeNull()
    expect(value.metrics.freeCashFlow).toBeNull()
    expect(assessBusinessHealth(value, NOW).status).toBe('unknown')
  })

  it('never fills an absent debt component with zero; uses a named conservative liabilities bound', () => {
    const body = fixture()
    delete body.facts['us-gaap'].DebtCurrent
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.totalDebt).toBeNull()
    expect(value.metrics.debtToEquity).toBeNull()
    const assessed = assessBusinessHealth(value, NOW)
    expect(assessed.status).toBe('healthy')
    expect(assessed.reasons.join(' ')).toContain('Total liabilities')
  })

  it('refuses to infer zero dilution from incompatible filings', () => {
    const body = fixture()
    body.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares[1].accn = 'older-filing'
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.shareCountChangePct).toBeNull()
    expect(assessBusinessHealth(value, NOW).status).toBe('unknown')
  })

  it('keeps foreign currency and unsupported taxonomy data unavailable', () => {
    const body = fixture()
    for (const concept of Object.values(body.facts['us-gaap'])) {
      if (concept.units.USD) { concept.units.EUR = concept.units.USD; delete concept.units.USD }
    }
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.status).toBe('unavailable')
    expect(value.metrics.revenue).toBeNull()
    expect(value.currency).toBeNull()
  })

  it('does not combine stale good balances with a newer incomplete balance', () => {
    const body = fixture()
    const cash = body.facts['us-gaap'].CashAndCashEquivalentsAtCarryingValue.units.USD
    cash.push({ ...cash[0], end: '2026-09-30', filed: '2026-10-10', val: 10, accn: 'new-quarter' })
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.balancePeriodEnd).toBe('2026-09-30')
    expect(value.metrics.cash).toBe(10)
    expect(value.metrics.currentRatio).toBeNull()
    expect(assessBusinessHealth(value, NOW).status).toBe('unknown')
  })

  it('requires current operating and balance-sheet evidence before calling a business healthy', () => {
    const value = parseBusinessHealthFacts(fixture(), 'TEST', NOW)
    expect(assessBusinessHealth(value, NOW + 200 * 86_400).status).toBe('unknown')
    expect(assessBusinessHealth(value, value.availableAt! - 1).status).toBe('unknown')
    expect(assessBusinessHealth(value, NOW - 1).status).toBe('healthy') // retrieval can follow the run clock
    expect(assessBusinessHealth(null, NOW).status).toBe('unknown')
  })

  it('labels negative cash flow as a failed screen without claiming business failure', () => {
    const body = fixture()
    body.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD[0].val = -20
    const assessed = assessBusinessHealth(parseBusinessHealthFacts(body, 'TEST', NOW), NOW)
    expect(assessed.status).toBe('deteriorating')
    expect(assessed.risks.join(' ')).toContain('does not establish insolvency')
  })

  it('still flags known cash burn when another metric is unavailable', () => {
    const body = fixture()
    body.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD[0].val = -20
    delete body.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding
    const assessed = assessBusinessHealth(parseBusinessHealthFacts(body, 'TEST', NOW), NOW)
    expect(assessed.status).toBe('deteriorating')
    expect(assessed.gaps.join(' ')).toContain('shareCountChangePct')
    expect(assessed.reasons.join(' ')).not.toContain('share-count growth')
  })

  it('lets a recent quarterly loss veto an older healthy annual report even when YTD remains positive', () => {
    const body = fixture()
    const income = body.facts['us-gaap'].NetIncomeLoss.units.USD
    income[1].val = -20
    income.push({ ...income[1], start: '2026-01-01', val: 50 })
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.netIncome).toBe(100)
    expect(value.metrics.recentNetIncome).toBe(-20)
    expect(value.evidence.recentNetIncome?.periodStart).toBe('2026-04-01')
    const assessed = assessBusinessHealth(value, NOW)
    expect(assessed.status).toBe('deteriorating')
    expect(assessed.risks.join(' ')).toContain('recent deterioration overrides')
  })

  it('never compares a recent quarter with a prior-year nine-month revenue total', () => {
    const body = fixture()
    const revenue = body.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD
    revenue[3].start = '2024-10-01'
    expect(parseBusinessHealthFacts(body, 'TEST', NOW).metrics.recentRevenueGrowthPct).toBeNull()
  })

  it('does not call an annual profit healthy when a newer quarter lacks operating evidence', () => {
    const body = fixture()
    body.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD.pop()
    const assessed = assessBusinessHealth(parseBusinessHealthFacts(body, 'TEST', NOW), NOW)
    expect(assessed.status).toBe('unknown')
    expect(assessed.gaps.join(' ')).toContain('newer balance sheet needs matching interim')
  })

  it('cannot turn declining annual revenue into growth by mixing a later prior-year restatement', () => {
    const body = fixture()
    const revenue = body.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD
    revenue[1].val = 1100
    revenue.push({ ...revenue[1], val: 900, filed: '2026-09-01', accn: 'unmatched-restatement', form: '10-Q' })
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.revenueGrowthPct).toBeCloseTo(-9.0909)
    expect(value.evidence.revenueGrowthPct?.accessions).toEqual(['0001-26-000001'])
    expect(assessBusinessHealth(value, NOW).status).toBe('deteriorating')
  })

  it('requires the current and prior-year interim revenues to use the same filing basis', () => {
    const body = fixture()
    const revenue = body.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD
    revenue[3].accn = 'incompatible-quarter'
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.recentRevenueGrowthPct).toBeNull()
    expect(assessBusinessHealth(value, NOW).status).toBe('unknown')
  })

  it('cannot hide a known standalone-quarter loss with a later-filed profitable YTD value', () => {
    const body = fixture()
    const income = body.facts['us-gaap'].NetIncomeLoss.units.USD
    income[1].val = -20
    income.push({ ...income[1], start: '2026-01-01', val: 50, filed: '2026-08-02', accn: 'later-ytd', form: '10-Q/A' })
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.recentNetIncome).toBe(-20)
    expect(value.evidence.recentNetIncome?.periodStart).toBe('2026-04-01')
    expect(assessBusinessHealth(value, NOW).status).toBe('deteriorating')
    // A real amendment of the same quarter still supersedes the original.
    income.push({ ...income[1], val: 25, filed: '2026-08-03', accn: 'corrected-quarter', form: '10-Q/A' })
    expect(parseBusinessHealthFacts(body, 'TEST', NOW).metrics.recentNetIncome).toBe(25)
  })

  it('lets fresh dilution veto an older stable annual share-count comparison', () => {
    const body = fixture()
    const shares = body.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares
    shares[2].val = 200
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.shareCountChangePct).toBe(0)
    expect(value.metrics.recentShareCountChangePct).toBe(100)
    expect(value.evidence.recentShareCountChangePct?.periodEnd).toBe('2026-06-30')
    const assessed = assessBusinessHealth(value, NOW)
    expect(assessed.status).toBe('deteriorating')
    expect(assessed.risks.join(' ')).toContain('recent dilution overrides')
  })

  it('does not fill missing or incompatible interim share comparisons with annual stability', () => {
    const body = fixture()
    const shares = body.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares
    shares[3].accn = 'older-share-basis'
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.metrics.shareCountChangePct).toBe(0)
    expect(value.metrics.recentShareCountChangePct).toBeNull()
    expect(assessBusinessHealth(value, NOW).status).toBe('unknown')
  })

  it('asks for sector review for negative-equity and highly leveraged companies', () => {
    const body = fixture()
    body.facts['us-gaap'].StockholdersEquity.units.USD[0].val = -50
    const assessed = assessBusinessHealth(parseBusinessHealthFacts(body, 'TEST', NOW), NOW)
    expect(assessed.status).toBe('unknown')
    expect(assessed.gaps.join(' ')).toContain('sector or buyback review')
  })

  it('fetches SEC facts with an identifying header and returns explicit unavailable on failure', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('User-Agent')).toContain('StreetSignal')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify(String(input).includes('company_tickers')
        ? { 0: { cik_str: 1, ticker: 'TEST', title: 'Example plc' } } : fixture()))
    })
    expect((await fetchBusinessHealth('TEST', fetcher as typeof fetch, NOW)).metrics.freeCashFlow).toBe(90)
    expect((await fetchBusinessHealth('TEST', async () => new Response('', { status: 503 }), NOW)).status).toBe('unavailable')
    expect((await fetchBusinessHealth('VOD.L', fetcher as typeof fetch, NOW)).status).toBe('unavailable')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('company report history known at publication', () => {
  it('does not turn comparative figures or later amendments into extra historical reports', () => {
    const body = fixture()
    const before = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(before.reportHistory?.map(p => p.periodEnd)).toEqual(['2025-12-31', '2026-06-30'])
    const income = body.facts['us-gaap'].NetIncomeLoss.units.USD
    income.push({ ...income[0], val: -900, filed: '2026-09-01', accn: 'restated-annual', form: '10-K/A' })
    const after = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(after.metrics.netIncome).toBe(-900)
    expect(after.reportHistory).toEqual(before.reportHistory)
    expect(after.reportHistory?.[0].metrics.netIncome).toBe(100)
    expect(after.reportTrend?.status).toBe('insufficient')
  })

  it('freezes each report at its own conservative availability rather than using today’s richer facts', () => {
    const body = fixture()
    const annualAt = Date.parse('2026-02-16T12:00:00Z') / 1000
    const annual = parseBusinessHealthFacts(body, 'TEST', annualAt)
    const today = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(annual.reportHistory).toHaveLength(1)
    expect(today.reportHistory?.[0]).toEqual(annual.reportHistory?.[0])
    expect(today.reportHistory?.[0].availableAt).toBe(annualAt)
    expect(today.reportHistory?.[0].balancePeriodEnd).toBeNull()
    expect(today.reportHistory?.[0].financialHealth).toBe('unknown')
    expect(parseBusinessHealthFacts(body, 'TEST', annualAt - 1).reportHistory).toHaveLength(0)
    for (const point of today.reportHistory ?? []) {
      expect(Object.values(point.evidence).every(e => e.availableAt <= point.availableAt)).toBe(true)
    }
  })

  it('uses YTD revenue for YTD cash margins while retaining standalone-quarter profit comparisons', () => {
    const body = fixture()
    const facts = body.facts['us-gaap']
    const reported = { filed: '2026-08-01', form: '10-Q', accn: '0001-26-000002' }
    facts.NetCashProvidedByUsedInOperatingActivities.units.USD[1].start = '2026-01-01'
    facts.NetCashProvidedByUsedInOperatingActivities.units.USD.push({ ...reported, start: '2025-01-01', end: '2025-06-30', val: 20 })
    facts.RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.push(
      { ...reported, start: '2026-01-01', end: '2026-06-30', val: 500 },
      { ...reported, start: '2025-01-01', end: '2025-06-30', val: 400 },
    )
    facts.NetIncomeLoss.units.USD.push({ ...reported, start: '2025-04-01', end: '2025-06-30', val: 10 })
    facts.PaymentsToAcquirePropertyPlantAndEquipment.units.USD.push(
      { ...reported, start: '2026-01-01', end: '2026-06-30', val: 10 },
      { ...reported, start: '2025-01-01', end: '2025-06-30', val: 5 },
    )
    const latest = parseBusinessHealthFacts(body, 'TEST', NOW).reportHistory!.at(-1)!
    expect(latest.periodKind).toBe('quarter')
    expect(latest.cashFlowPeriodKind).toBe('year-to-date')
    expect(latest.cashFlowPeriodStart).toBe('2026-01-01')
    expect(latest.metrics.operatingCashFlowMarginPct).toBe(8)
    expect(latest.metrics.operatingCashFlowMarginChangePp).toBe(3)
    expect(latest.metrics.freeCashFlowMarginPct).toBe(6)
    expect(latest.metrics.freeCashFlowMarginChangePp).toBe(2.25)
    expect(latest.metrics.netMarginPct).toBe(8)
    expect(latest.metrics.netMarginChangePp).toBeCloseTo(8 - 10 / 225 * 100)
    expect(latest.evidence.operatingCashFlowMarginPct?.periodStart).toBe('2026-01-01')
    expect(latest.evidence.netMarginPct?.periodStart).toBe('2026-04-01')
  })

  it('leaves cash-flow margins missing when only mismatched quarterly revenue exists', () => {
    const body = fixture()
    body.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD[1].start = '2026-01-01'
    const latest = parseBusinessHealthFacts(body, 'TEST', NOW).reportHistory!.at(-1)!
    expect(latest.metrics.operatingCashFlow).toBe(40)
    expect(latest.metrics.operatingCashFlowMarginPct).toBeNull()
    expect(latest.metrics.operatingCashFlowMarginChangePp).toBeNull()
    expect(latest.gaps.join(' ')).toContain('operatingCashFlowMarginChangePp')
  })

  it('bounds history to twelve unique periods and roughly three years without recursive snapshots', () => {
    const body = fixture()
    const income = body.facts['us-gaap'].NetIncomeLoss.units.USD
    // Extra report periods stress the bound independently of normal quarterly cadence.
    for (let i = 0; i < 18; i++) {
      const end = new Date(Date.UTC(2024, i + 1, 0))
      const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), end.getUTCDate() + 1))
      income.push({ val: 50, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
        filed: new Date(end.getTime() + 10 * 86_400_000).toISOString().slice(0, 10), form: '10-K', accn: `report-${i}` })
    }
    income.push({ val: 5, start: '2019-01-01', end: '2019-12-31', filed: '2020-02-01', form: '10-K', accn: 'too-old' })
    const value = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(value.reportHistory).toHaveLength(12)
    expect(new Set(value.reportHistory?.map(p => p.periodEnd)).size).toBe(12)
    expect(value.reportHistory?.every(p => p.periodEnd >= '2023-10-17')).toBe(true)
    expect(value.reportHistory?.some(p => 'reportHistory' in p)).toBe(false)
    expect(JSON.parse(JSON.stringify(value)).reportHistory).toHaveLength(12)
  })
})

describe('sector financial checks and valuation', () => {
  it('assesses buyback-heavy consumer businesses by dated cash capacity, not a universal equity ratio', () => {
    const body = fixture(), f = body.facts['us-gaap']
    f.StockholdersEquity.units.USD[0].val = -20
    f.AssetsCurrent.units.USD[0].val = 100
    const snapshot = parseBusinessHealthFacts(body, 'TEST', NOW)
    expect(assessBusinessHealth(snapshot, NOW).status).toBe('unknown')
    expect(assessBusinessHealth(snapshot, NOW, 'XLY').status).toBe('healthy')
    const result = assessBusinessHealth(snapshot, NOW, 'XLY')
    expect(result.reasons.join(' ')).toContain('annual operating cash flow')
    expect(result.reasons.join(' ')).toContain('current liabilities 1.2×')
  })
  it('uses stricter leverage limits for cyclical businesses and refuses unknown or future debt evidence', () => {
    const snapshot = parseBusinessHealthFacts(fixture(), 'TEST', NOW)
    snapshot.metrics.totalDebt = 450
    snapshot.evidence.totalDebt!.value = 450
    expect(assessBusinessHealth(snapshot, NOW, 'XLI').status).toBe('healthy')
    expect(assessBusinessHealth(snapshot, NOW, 'XLE').status).toBe('unknown')
    snapshot.evidence.totalDebt!.availableAt = NOW + 1
    snapshot.metrics.totalLiabilities = null
    expect(assessBusinessHealth(snapshot, NOW, 'XLI').status).toBe('unknown')
    snapshot.metrics.recentNetIncome = -20
    expect(assessBusinessHealth(snapshot, NOW, 'XLI').status).toBe('deteriorating')
  })
  it('does not certify banks, insurers, REITs or utilities with industrial metrics', () => {
    const snapshot = parseBusinessHealthFacts(fixture(), 'TEST', NOW)
    for (const sector of ['XLF', 'XLRE', 'XLU']) {
      const result = assessBusinessHealth(snapshot, NOW, sector)
      expect(result.status).toBe('unknown')
      expect(result.gaps.join(' ')).toMatch(/review/)
    }
  })
})

describe('dated valuation inputs', () => {
  const cap = { sym: 'TEST', marketCapUsdM: .002, observedAt: NOW - 60, currency: 'USD' as const, source: 'finnhub-profile' as const }
  it('calculates annual multiples and applies sector research limits', () => {
    const snapshot = parseBusinessHealthFacts(fixture(), 'TEST', NOW)
    expect(assessBusinessValuation(snapshot, cap, 'XLK', NOW)).toMatchObject({ status: 'supported', pe: 20, fcfYieldPct: 4.5 })
    expect(assessBusinessValuation(snapshot, cap, 'XLE', NOW).status).toBe('demanding')
    expect(assessBusinessValuation(snapshot, { ...cap, marketCapUsdM: .02 }, 'XLK', NOW).status).toBe('demanding')
  })
  it('rejects stale, future and mismatched capitalizations and missing or negative earnings', () => {
    const snapshot = parseBusinessHealthFacts(fixture(), 'TEST', NOW)
    for (const bad of [{ ...cap, observedAt: NOW + 1 }, { ...cap, observedAt: NOW - 90000 }, { ...cap, sym: 'OTHER' }]) {
      expect(assessBusinessValuation(snapshot, bad, 'XLK', NOW)).toMatchObject({ status: 'unknown', pe: null })
    }
    snapshot.metrics.netIncome = -100
    expect(assessBusinessValuation(snapshot, cap, 'XLK', NOW)).toMatchObject({ status: 'unknown', pe: null })
    snapshot.metrics.netIncome = 100
    snapshot.evidence.netIncome!.availableAt = NOW + 1
    expect(assessBusinessValuation(snapshot, cap, 'XLK', NOW)).toMatchObject({ status: 'unknown', pe: null })
  })
})
