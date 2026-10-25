import type { CompanyFacts } from './businessHealth'
import type { BusinessHealthEvidence } from '../../../shared/businessHealth'
import { quarterlyTrend, type FinancialQuarter, type QuarterlyFinancials, type QuarterlyMetric } from '../../../shared/quarterlyFinancials'

const DAY = 86400
const date = (s?: string) => s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) / 1000 : NaN
const tags = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capitalExpenditure: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
}
type Flow = BusinessHealthEvidence & { derived: boolean; rank: number }
const span = (f: BusinessHealthEvidence) => (date(f.periodEnd) - date(f.periodStart ?? undefined)) / DAY + 1
const same = (a: BusinessHealthEvidence, b: BusinessHealthEvidence) => a.periodStart === b.periodStart && a.periodEnd === b.periodEnd
const combine = (a: Flow, b: Flow, value: number): Flow => ({ ...a, value, availableAt: Math.max(a.availableAt, b.availableAt),
  filed: a.filed > b.filed ? a.filed : b.filed, accessions: [...new Set([...a.accessions, ...b.accessions])], tags: [...new Set([...a.tags, ...b.tags])] })

/** Derive Q2/Q3 from consecutive YTD disclosures and Q4 from annual minus
 * nine months. Only the same concept and fiscal-year start may be subtracted.
 * Never sum overlapping YTD/annual totals, or use later filings before release. */
export function parseQuarterlyFinancials(body: CompanyFacts, asOf: number): QuarterlyFinancials {
  const series: Record<string, Flow[]> = {}
  for (const [metric, concepts] of Object.entries(tags)) {
    const all: Flow[] = []
    concepts.forEach((tag, rank) => {
      const raw = body.facts?.['us-gaap']?.[tag]?.units?.USD ?? []
      const valid = raw.filter(f => Number.isFinite(f.val) && f.accn && /^(10-[KQ]|20-F|40-F)(\/A)?$/.test(f.form ?? '') &&
        Number.isFinite(date(f.start)) && Number.isFinite(date(f.end)) && Number.isFinite(date(f.filed)) && f.end! <= f.filed! && date(f.filed) + 1.5 * DAY <= asOf)
      const conflicts = new Map<string, Set<number>>()
      for (const f of valid) { const k = `${f.accn}:${f.start}:${f.end}`; const set = conflicts.get(k) ?? new Set<number>(); set.add(f.val!); conflicts.set(k, set) }
      for (const f of valid) {
        // Conflicting contexts cannot silently select a favourable amount.
        if (conflicts.get(`${f.accn}:${f.start}:${f.end}`)!.size > 1) continue
        all.push({ value: f.val!, periodStart: f.start!, periodEnd: f.end!, filed: f.filed!, availableAt: date(f.filed) + 1.5 * DAY,
          unit: 'USD', tags: [`us-gaap:${tag}`], accessions: [f.accn!], derived: false, rank })
      }
    })
    const known = [...new Map(all.sort((a, b) => a.availableAt - b.availableAt).map(f => [`${f.tags[0]}:${f.periodStart}:${f.periodEnd}`, f])).values()]
    const quarters = known.filter(f => span(f) >= 60 && span(f) <= 115)
    for (const f of known.filter(f => span(f) >= 150 && span(f) <= 400)) {
      const prior = known.filter(p => p.tags[0] === f.tags[0] && p.periodStart === f.periodStart &&
        date(f.periodEnd) - date(p.periodEnd) >= 60 * DAY && date(f.periodEnd) - date(p.periodEnd) <= 115 * DAY)
        .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0]
      if (!prior) continue
      const q = combine(f, prior, f.value - prior.value)
      q.periodStart = new Date((date(prior.periodEnd) + DAY) * 1000).toISOString().slice(0, 10)
      q.derived = true
      quarters.push(q)
    }
    // Prefer the freshest disclosed basis, then a direct standalone quarter,
    // then the documented concept preference. Keep only one value per window.
    series[metric] = [...new Map(quarters.sort((a, b) => b.availableAt - a.availableAt || Number(a.derived) - Number(b.derived) || a.rank - b.rank)
      .map(q => [`${q.periodStart}:${q.periodEnd}`, q] as const).reverse()).values()]
  }
  const anchors = [...new Map([...(series.revenue ?? []), ...(series.netIncome ?? []), ...(series.operatingCashFlow ?? [])]
    .sort((a, b) => a.rank - b.rank).map(q => [`${q.periodStart}:${q.periodEnd}`, q] as const).reverse()).values()]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
  // Different fiscal starts for the same quarter end are ambiguous.
  const rows: FinancialQuarter[] = anchors.filter(a => !anchors.some(b => a.periodEnd === b.periodEnd && a.periodStart !== b.periodStart)).map(anchor => {
    const evidence: FinancialQuarter['evidence'] = {}
    let derived = false
    for (const metric of Object.keys(tags) as (keyof typeof tags)[]) {
      const f = series[metric].find(q => same(q, anchor))
      if (f) { evidence[metric] = f; derived ||= f.derived }
    }
    const cash = evidence.operatingCashFlow, cap = evidence.capitalExpenditure
    if (cash && cap && cap.value >= 0) evidence.freeCashFlow = combine(cash as Flow, cap as Flow, cash.value - cap.value)
    const values = Object.fromEntries(['revenue', 'netIncome', 'operatingCashFlow', 'capitalExpenditure', 'freeCashFlow'].map(k => [k, evidence[k as QuarterlyMetric]?.value ?? null])) as FinancialQuarter['values']
    const margin = (v: number | null) => v != null && values.revenue != null && values.revenue > 0 ? v / values.revenue * 100 : null
    return { start: anchor.periodStart!, end: anchor.periodEnd, availableAt: Math.max(...Object.values(evidence).map(e => e!.availableAt)), values, evidence,
      derived, revenueGrowthPct: null, netMarginPct: margin(values.netIncome), netMarginChangePp: null,
      freeCashFlowMarginPct: margin(values.freeCashFlow), freeCashFlowMarginChangePp: null }
  })
  for (const q of rows) {
    const prior = rows.find(p => date(q.end) - date(p.end) >= 330 * DAY && date(q.end) - date(p.end) <= 400 * DAY &&
      Math.abs((date(q.end) - date(q.start)) - (date(p.end) - date(p.start))) <= 15 * DAY)
    if (!prior) continue
    if (q.values.revenue != null && prior.values.revenue != null && prior.values.revenue > 0 && q.evidence.revenue?.tags[0] === prior.evidence.revenue?.tags[0]) q.revenueGrowthPct = (q.values.revenue / prior.values.revenue - 1) * 100
    if (q.netMarginPct != null && prior.netMarginPct != null) q.netMarginChangePp = q.netMarginPct - prior.netMarginPct
    if (q.freeCashFlowMarginPct != null && prior.freeCashFlowMarginPct != null) q.freeCashFlowMarginChangePp = q.freeCashFlowMarginPct - prior.freeCashFlowMarginPct
  }
  const last = rows.slice(-4)
  const contiguous = last.length === 4 && last.every((q, i) => i === 0 || date(q.start) - date(last[i - 1].end) === DAY)
    && date(last[3].end) - date(last[0].start) >= 330 * DAY && date(last[3].end) - date(last[0].start) <= 400 * DAY
  const trailingYear = contiguous ? { start: last[0].start, end: last[3].end, availableAt: Math.max(...last.map(q => q.availableAt)),
    values: Object.fromEntries(Object.keys(last[0].values).map(k => [k, last.every(q => q.values[k as QuarterlyMetric] != null)
      ? last.reduce((n, q) => n + q.values[k as QuarterlyMetric]!, 0) : null])) as FinancialQuarter['values'] } : null
  const gaps = []
  if (!trailingYear) gaps.push('Four consecutive, non-overlapping quarters are needed for a trailing-year total.')
  else if (Object.values(trailingYear.values).some(v => v == null)) gaps.push('Some trailing-year measures are missing; absent values are not estimated.')
  if (!rows.length || asOf - date(rows.at(-1)!.end) > 180 * DAY) gaps.push('Recent quarterly evidence is missing or more than 180 days old.')
  return { version: 'quarterly-asof-v1', asOf, quarters: rows.slice(-12), trailingYear, status: quarterlyTrend(rows, asOf), gaps }
}
