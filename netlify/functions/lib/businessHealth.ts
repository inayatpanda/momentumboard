import { BUSINESS_HEALTH_METRICS, assessBusinessHealth, emptyBusinessHealth, type BusinessHealthEvidence, type BusinessHealthMetric, type BusinessHealthSnapshot } from '../../../shared/businessHealth'
import { REPORT_TREND_METRICS, summarizeReportTrends, type FinancialReportPoint, type ReportPeriodKind, type ReportTrendMetric } from '../../../shared/reportTrends'
import { getCached, setCached } from './cache'
import { resolveSecCompany } from './secFilings'

interface Fact {
  start?: string
  end?: string
  val?: number
  filed?: string
  accn?: string
  form?: string
}
interface CompanyFacts {
  cik?: number
  entityName?: string
  facts?: Record<string, Record<string, { units?: Record<string, Fact[]> }>>
}
type Evidence = BusinessHealthEvidence
const DAY = 86_400
const FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A'])
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
const seconds = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000
const samePeriod = (a: Evidence, b: Evidence) => a.periodStart === b.periodStart && a.periodEnd === b.periodEnd

/** Facts can be restated in later filings. Select only facts known at asOf,
 * using a conservative next-day-noon availability for date-only SEC records. */
function factsFor(body: CompanyFacts, tags: string[], unit: string, asOf: number, duration: 'annual' | 'interim' | false): Evidence[] {
  const all: (Evidence & { rank: number })[] = []
  tags.forEach((tag, rank) => {
    for (const fact of body.facts?.['us-gaap']?.[tag]?.units?.[unit] ?? []) {
      if (!Number.isFinite(fact.val) || !iso(fact.end) || !iso(fact.filed) || !fact.accn || !FORMS.has(fact.form ?? '')) continue
      const availableAt = seconds(fact.filed) + 1.5 * DAY
      if (availableAt > asOf || seconds(fact.end) > asOf || fact.end > fact.filed) continue
      if (duration) {
        if (!iso(fact.start)) continue
        const days = (seconds(fact.end) - seconds(fact.start)) / DAY
        if (duration === 'annual' ? days < 330 || days > 400 : days < 60 || days >= 330) continue
      } else if (fact.start != null) continue
      all.push({ value: fact.val!, periodStart: fact.start ?? null, periodEnd: fact.end, filed: fact.filed,
        availableAt, unit, tags: [`us-gaap:${tag}`], accessions: [fact.accn], rank })
    }
  })
  // A later YTD disclosure cannot replace a known standalone quarter. Pick
  // the shortest period at a given end first, then the latest restatement of
  // that period. Otherwise profitable YTD can hide a loss-making last quarter.
  return all.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) ||
    (duration === 'interim' ? (b.periodStart ?? '').localeCompare(a.periodStart ?? '') : 0) ||
    b.filed.localeCompare(a.filed) || a.rank - b.rank || (b.periodStart ?? '').localeCompare(a.periodStart ?? ''))
    .map(({ rank: _rank, ...evidence }) => evidence)
}

function derive(a: Evidence | undefined, b: Evidence | undefined, fn: (a: number, b: number) => number | null, unit: string): Evidence | undefined {
  if (!a || !b || !samePeriod(a, b) || a.unit !== b.unit) return
  const value = fn(a.value, b.value)
  if (value == null || !Number.isFinite(value)) return
  return { value, periodStart: a.periodStart, periodEnd: a.periodEnd, filed: a.filed > b.filed ? a.filed : b.filed,
    availableAt: Math.max(a.availableAt, b.availableAt), unit,
    tags: [...new Set([...a.tags, ...b.tags])], accessions: [...new Set([...a.accessions, ...b.accessions])] }
}

/** Same-filing, same-concept and equally long prior-year comparison. */
function priorYear(rows: Evidence[], latest: Evidence | undefined, positiveBase = false): Evidence | undefined {
  if (!latest) return
  return rows.find(row => {
    const gap = (seconds(latest.periodEnd) - seconds(row.periodEnd)) / DAY
    const spanDifference = latest.periodStart && row.periodStart
      ? Math.abs((seconds(latest.periodEnd) - seconds(latest.periodStart)) - (seconds(row.periodEnd) - seconds(row.periodStart))) / DAY : Infinity
    return gap >= 330 && gap <= 400 && spanDifference <= 15 && row.tags[0] === latest.tags[0] && row.unit === latest.unit &&
      (!positiveBase || row.value > 0) && row.accessions[0] === latest.accessions[0]
  })
}
function growth(rows: Evidence[], latest: Evidence | undefined): Evidence | undefined {
  const prior = priorYear(rows, latest, true)
  if (!latest || !prior) return
  return { ...latest, value: (latest.value / prior.value - 1) * 100, unit: '%',
    filed: latest.filed > prior.filed ? latest.filed : prior.filed,
    availableAt: Math.max(latest.availableAt, prior.availableAt),
    accessions: [...new Set([...latest.accessions, ...prior.accessions])] }
}

/** The parser deliberately covers standard US-GAAP USD facts. Unsupported
 * taxonomies/currencies stay missing rather than being silently converted. */
function parseBusinessHealthSnapshot(body: CompanyFacts, sym: string, asOf: number): BusinessHealthSnapshot {
  const out = emptyBusinessHealth(sym, asOf, '')
  out.gaps = []
  out.company = typeof body.entityName === 'string' ? body.entityName : null
  out.cik = Number.isInteger(body.cik) && body.cik! > 0 ? body.cik! : null
  out.sourceUrl = out.cik ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(out.cik).padStart(10, '0')}.json` : null
  const annual = (tags: string[], unit = 'USD') => factsFor(body, tags, unit, asOf, 'annual')
  const interim = (tags: string[], unit = 'USD') => factsFor(body, tags, unit, asOf, 'interim')
  const balance = (tags: string[]) => factsFor(body, tags, 'USD', asOf, false)
  const revenue = annual(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'])
  const profit = annual(['NetIncomeLoss', 'ProfitLoss'])
  const ocf = annual(['NetCashProvidedByUsedInOperatingActivities'])
  const capex = annual(['PaymentsToAcquirePropertyPlantAndEquipment'])
  const annualEnd = [revenue[0], profit[0], ocf[0]].filter(Boolean).map(e => e.periodEnd).sort().at(-1) ?? null
  out.annualPeriodEnd = annualEnd
  const sameAnnual = (rows: Evidence[]) => rows.find(e => e.periodEnd === annualEnd)
  const e = out.evidence
  const add = (key: BusinessHealthMetric, value: Evidence | undefined) => { if (value) e[key] = value }
  add('revenue', sameAnnual(revenue))
  add('netIncome', sameAnnual(profit))
  add('operatingCashFlow', sameAnnual(ocf))
  add('capitalExpenditure', sameAnnual(capex))
  add('freeCashFlow', derive(e.operatingCashFlow, e.capitalExpenditure, (a, b) => b >= 0 ? a - b : null, 'USD'))
  add('netMarginPct', derive(e.netIncome, e.revenue, (a, b) => b > 0 ? a / b * 100 : null, '%'))

  const candidates = {
    cash: balance(['CashAndCashEquivalentsAtCarryingValue']),
    currentAssets: balance(['AssetsCurrent']), currentLiabilities: balance(['LiabilitiesCurrent']),
    totalEquity: balance(['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']),
    totalLiabilities: balance(['Liabilities']), debtCurrent: balance(['DebtCurrent']),
    debtNoncurrent: balance(['LongTermDebtNoncurrent']), debtLongCurrent: balance(['LongTermDebtCurrent']),
    shortBorrowing: balance(['ShortTermBorrowings']),
  }
  // Anchor to the newest balance, so an older good balance cannot quietly
  // fill holes in a newly filed but incompletely standardized statement.
  const balanceEnd = Object.values(candidates).flatMap(rows => rows[0] ? [rows[0].periodEnd] : []).sort().at(-1) ?? null
  out.balancePeriodEnd = balanceEnd
  const sameBalance = (rows: Evidence[]) => rows.find(row => row.periodEnd === balanceEnd)
  for (const key of ['cash', 'currentAssets', 'currentLiabilities', 'totalEquity', 'totalLiabilities'] as const) add(key, sameBalance(candidates[key]))
  const noncurrent = sameBalance(candidates.debtNoncurrent)
  const current = sameBalance(candidates.debtCurrent)
  // DebtCurrent already includes short-term borrowing/current maturities.
  // Without it, all three pieces must be explicit; absent borrowing != zero.
  const currentParts = derive(sameBalance(candidates.debtLongCurrent), sameBalance(candidates.shortBorrowing), (a, b) => a >= 0 && b >= 0 ? a + b : null, 'USD')
  add('totalDebt', derive(current ?? currentParts, noncurrent, (a, b) => a >= 0 && b >= 0 ? a + b : null, 'USD'))
  add('currentRatio', derive(e.currentAssets, e.currentLiabilities, (a, b) => a >= 0 && b > 0 ? a / b : null, 'ratio'))
  add('debtToEquity', derive(e.totalDebt, e.totalEquity, (a, b) => a >= 0 && b > 0 ? a / b : null, 'ratio'))
  add('liabilitiesToEquity', derive(e.totalLiabilities, e.totalEquity, (a, b) => a >= 0 && b > 0 ? a / b : null, 'ratio'))

  // Comparatives must share a filing: mixing a newly reclassified prior year
  // with an older current-year basis can reverse the sign of reported growth.
  add('revenueGrowthPct', growth(revenue, e.revenue))
  // A same-filing comparative diluted share series is normally restated for
  // splits. Never compare raw point-in-time shares from different filings.
  const shares = annual(['WeightedAverageNumberOfDilutedSharesOutstanding'], 'shares')
  add('shareCountChangePct', growth(shares, sameAnnual(shares)))
  const recentProfit = interim(['NetIncomeLoss', 'ProfitLoss'])
  const recentCash = interim(['NetCashProvidedByUsedInOperatingActivities'])
  const recentRevenue = interim(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'])
  const recent = (rows: Evidence[]) => annualEnd == null ? undefined
    : rows.find(row => row.periodEnd > annualEnd && asOf - seconds(row.periodEnd) <= 180 * DAY)
  add('recentNetIncome', recent(recentProfit))
  add('recentOperatingCashFlow', recent(recentCash))
  add('recentRevenueGrowthPct', growth(recentRevenue, recent(recentRevenue)))
  const recentShares = interim(['WeightedAverageNumberOfDilutedSharesOutstanding'], 'shares')
  add('recentShareCountChangePct', growth(recentShares, recent(recentShares)))
  out.warnings.push('Annual flows are not trailing-twelve-month estimates. Interim evidence retains its reported quarter or year-to-date period; missing interim data cannot rule out recent deterioration.')
  out.warnings.push('Business health is a conservative accounting screen, not a valuation or a guarantee of recovery; sector-specific review still matters.')
  out.warnings.push('Share-count comparisons use the same filing; acquisitions, capital actions and split restatements can still affect them.')
  for (const key of BUSINESS_HEALTH_METRICS) {
    out.metrics[key] = e[key]?.value ?? null
    if (!e[key]) out.gaps.push(`${key}: comparable reported US-GAAP/USD data unavailable.`)
  }
  const used = Object.values(e)
  out.currency = used.length ? 'USD' : null
  out.availableAt = used.length ? Math.max(...used.map(row => row.availableAt)) : null
  out.periodEnd = [annualEnd, balanceEnd].filter((day): day is string => day != null).sort().at(-1) ?? null
  const stale = (annualEnd != null && asOf - seconds(annualEnd) > 550 * DAY) || (balanceEnd != null && asOf - seconds(balanceEnd) > 180 * DAY)
  out.status = !used.length ? 'unavailable' : stale ? 'stale' : out.gaps.length ? 'partial' : 'available'
  return out
}

const REVENUE_TAGS = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']
const PROFIT_TAGS = ['NetIncomeLoss', 'ProfitLoss']
const CASH_TAGS = ['NetCashProvidedByUsedInOperatingActivities']
const CAPEX_TAGS = ['PaymentsToAcquirePropertyPlantAndEquipment']
const SHARE_TAGS = ['WeightedAverageNumberOfDilutedSharesOutstanding']
const periodKind = (e: Evidence | undefined): ReportPeriodKind | null => {
  if (!e?.periodStart) return null
  const days = (seconds(e.periodEnd) - seconds(e.periodStart)) / DAY
  return days >= 330 ? 'annual' : days <= 115 ? 'quarter' : 'year-to-date'
}

/** First actual filing for each reporting period. Comparative prior-year rows
 * inside a later filing cannot fabricate an earlier publication. Amendments
 * change today's snapshot, never these frozen original report observations. */
function reportPublications(body: CompanyFacts, asOf: number) {
  const filings = new Map<string, { accession: string; periodEnd: string; filed: string; availableAt: number; form: string }>()
  for (const tag of [...REVENUE_TAGS, ...PROFIT_TAGS, ...CASH_TAGS]) {
    for (const fact of body.facts?.['us-gaap']?.[tag]?.units?.USD ?? []) {
      if (!Number.isFinite(fact.val) || !iso(fact.start) || !iso(fact.end) || !iso(fact.filed) || !fact.accn || !FORMS.has(fact.form ?? '')) continue
      const duration = (seconds(fact.end) - seconds(fact.start)) / DAY
      const availableAt = seconds(fact.filed) + 1.5 * DAY
      if (duration < 60 || duration > 400 || availableAt > asOf || fact.end > fact.filed) continue
      const current = filings.get(fact.accn)
      if (!current || fact.end > current.periodEnd) filings.set(fact.accn, {
        accession: fact.accn, periodEnd: fact.end, filed: fact.filed, availableAt, form: fact.form!,
      })
    }
  }
  const periods = new Map<string, ReturnType<typeof filings.get>>()
  for (const filing of [...filings.values()].sort((a, b) => a.availableAt - b.availableAt || a.accession.localeCompare(b.accession))) {
    if (!periods.has(filing.periodEnd)) periods.set(filing.periodEnd, filing)
  }
  return [...periods.values()].filter((p): p is NonNullable<typeof p> => p != null && seconds(p.periodEnd) >= asOf - 3 * 366 * DAY)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(-12)
}

function reportPoint(body: CompanyFacts, sym: string, publication: ReturnType<typeof reportPublications>[number]): FinancialReportPoint {
  const cutoff = publication.availableAt
  const snapshot = parseBusinessHealthSnapshot(body, sym, cutoff)
  const healthAssessment = assessBusinessHealth(snapshot, cutoff)
  const duration = /^(10-K|20-F|40-F)/.test(publication.form) ? 'annual' : 'interim'
  const rows = (tags: string[], unit = 'USD') => factsFor(body, tags, unit, cutoff, duration)
  const revenue = rows(REVENUE_TAGS)
  const profit = rows(PROFIT_TAGS)
  const cash = rows(CASH_TAGS)
  const capex = rows(CAPEX_TAGS)
  const shares = rows(SHARE_TAGS, 'shares')
  const current = (values: Evidence[]) => values.find(e => e.periodEnd === publication.periodEnd && e.accessions[0] === publication.accession)
  const matching = (values: Evidence[], reference: Evidence | undefined) => reference
    ? values.find(e => samePeriod(e, reference) && e.accessions[0] === publication.accession) : undefined
  const rev = current(revenue)
  const income = matching(profit, rev) ?? (rev ? undefined : current(profit))
  const ocf = current(cash)
  const cashRevenue = matching(revenue, ocf)
  const cap = matching(capex, ocf)
  const base = rev ?? income ?? ocf
  const evidence: Partial<Record<ReportTrendMetric, Evidence>> = {}
  const add = (key: ReportTrendMetric, value: Evidence | undefined) => { if (value) evidence[key] = value }
  const margin = (a: Evidence | undefined, b: Evidence | undefined) => derive(a, b, (x, y) => y > 0 ? x / y * 100 : null, '%')
  const marginChange = (latest: Evidence | undefined, prior: Evidence | undefined): Evidence | undefined => {
    if (!latest || !prior) return
    return { ...latest, value: latest.value - prior.value, unit: 'pp',
      filed: latest.filed > prior.filed ? latest.filed : prior.filed,
      availableAt: Math.max(latest.availableAt, prior.availableAt),
      tags: [...new Set([...latest.tags, ...prior.tags])], accessions: [...new Set([...latest.accessions, ...prior.accessions])] }
  }
  add('revenue', rev)
  add('netIncome', income)
  add('operatingCashFlow', ocf)
  add('capitalExpenditure', cap)
  add('freeCashFlow', derive(ocf, cap, (x, y) => y >= 0 ? x - y : null, 'USD'))
  add('revenueGrowthPct', growth(revenue, rev))
  add('netMarginPct', margin(income, rev))
  add('netMarginChangePp', marginChange(evidence.netMarginPct, margin(priorYear(profit, income), priorYear(revenue, rev, true))))
  add('operatingCashFlowMarginPct', margin(ocf, cashRevenue))
  add('operatingCashFlowMarginChangePp', marginChange(evidence.operatingCashFlowMarginPct, margin(priorYear(cash, ocf), priorYear(revenue, cashRevenue, true))))
  add('freeCashFlowMarginPct', margin(evidence.freeCashFlow, cashRevenue))
  const priorFcf = derive(priorYear(cash, ocf), priorYear(capex, cap), (x, y) => y >= 0 ? x - y : null, 'USD')
  add('freeCashFlowMarginChangePp', marginChange(evidence.freeCashFlowMarginPct, margin(priorFcf, priorYear(revenue, cashRevenue, true))))
  add('shareCountChangePct', growth(shares, matching(shares, base)))
  for (const key of ['currentRatio', 'debtToEquity', 'liabilitiesToEquity'] as const) {
    if (snapshot.evidence[key]?.periodEnd === publication.periodEnd) add(key, snapshot.evidence[key])
  }
  const metrics = Object.fromEntries(REPORT_TREND_METRICS.map(key => [key, evidence[key]?.value ?? null])) as Record<ReportTrendMetric, number | null>
  const gaps = ['revenueGrowthPct', 'netMarginChangePp', 'operatingCashFlowMarginChangePp', 'freeCashFlowMarginChangePp', 'shareCountChangePct']
    .filter(key => metrics[key as ReportTrendMetric] == null).map(key => `${key}: a matched same-filing prior-year comparison is unavailable.`)
  return {
    periodStart: base?.periodStart ?? null, periodEnd: publication.periodEnd,
    periodKind: periodKind(base) ?? (duration === 'annual' ? 'annual' : 'quarter'),
    durationDays: base?.periodStart ? (seconds(base.periodEnd) - seconds(base.periodStart)) / DAY : null,
    cashFlowPeriodStart: ocf?.periodStart ?? null, cashFlowPeriodKind: periodKind(ocf),
    filed: publication.filed, availableAt: cutoff, accession: publication.accession,
    financialHealth: healthAssessment.status, healthAssessment, annualPeriodEnd: snapshot.annualPeriodEnd,
    balancePeriodEnd: snapshot.balancePeriodEnd, coverageStatus: snapshot.status, metrics, evidence, gaps,
  }
}

/** Current facts and original-publication history share the same cutoff-aware
 * parser. History never calls this wrapper, so it cannot recurse or repeatedly
 * append snapshots. The provider is fetched only once. */
export function parseBusinessHealthFacts(body: CompanyFacts, sym: string, asOf: number): BusinessHealthSnapshot {
  const snapshot = parseBusinessHealthSnapshot(body, sym, asOf)
  snapshot.reportHistory = reportPublications(body, asOf).map(publication => reportPoint(body, sym, publication))
  snapshot.reportTrend = summarizeReportTrends(snapshot.reportHistory, asOf)
  return snapshot
}

export async function fetchBusinessHealth(sym: string, fetchFn: typeof fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<BusinessHealthSnapshot> {
  const symbol = sym.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || symbol.endsWith('.L') || symbol.endsWith('-USD')) return emptyBusinessHealth(symbol, nowSec, 'No supported SEC US-GAAP listing coverage for this symbol.')
  const userAgent = process.env.SEC_USER_AGENT ?? 'StreetSignal thestreetsignal.rqai.co.uk'
  // One deadline covers both ticker resolution and company facts.
  const signal = AbortSignal.timeout(12_000)
  const bounded: typeof fetch = (input, init) => fetchFn(input, { ...init, signal })
  try {
    const company = await resolveSecCompany(symbol, bounded, userAgent)
    if (!company) return emptyBusinessHealth(symbol, nowSec, 'No matching SEC reporting company was found.')
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(company.cik_str).padStart(10, '0')}.json`
    const response = await bounded(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } })
    if (!response.ok) return { ...emptyBusinessHealth(symbol, nowSec, `SEC fundamentals are unavailable (HTTP ${response.status}).`), company: company.title, cik: company.cik_str, sourceUrl: url }
    const body = await response.json() as CompanyFacts
    if (!body || typeof body !== 'object' || !body.facts) return emptyBusinessHealth(symbol, nowSec, 'SEC returned an incomplete fundamentals response.')
    return parseBusinessHealthFacts({ ...body, cik: company.cik_str }, symbol, nowSec)
  } catch {
    return emptyBusinessHealth(symbol, nowSec, 'SEC fundamentals could not be retrieved; retry later.')
  }
}

const pending = new Map<string, Promise<BusinessHealthSnapshot>>()
export async function cachedBusinessHealth(sym: string): Promise<BusinessHealthSnapshot> {
  const symbol = sym.trim().toUpperCase()
  const key = `business-health:v2:${symbol}`
  const cached = await getCached<BusinessHealthSnapshot>(key)
  if (cached) return cached
  const existing = pending.get(key)
  if (existing) return existing
  const request = fetchBusinessHealth(symbol).then(async value => {
    // Short negative caching avoids pounding an unavailable provider.
    await setCached(key, value, value.status === 'unavailable' ? 900 : 6 * 3600)
    return value
  }).finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}
