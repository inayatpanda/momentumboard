import { describe, expect, it } from 'vitest'
import { parseQuarterlyFinancials } from './quarterlyFinancials'
import type { CompanyFacts } from './businessHealth'

const at = (s: string) => Date.parse(s) / 1000
export function quarterlyFixture(): CompanyFacts {
  const facts: NonNullable<CompanyFacts['facts']>['us-gaap'] = {}
  for (const [tag, ratio] of [['Revenues',1],['NetIncomeLoss',.1],['NetCashProvidedByUsedInOperatingActivities',.2],['PaymentsToAcquirePropertyPlantAndEquipment',.05]] as const) {
    const rows = []
    for (const year of [2023,2024]) for (let q=0;q<4;q++) {
      const ends = ['03-31','06-30','09-30','12-31'], filings = [`${year}-05-15`,`${year}-08-15`,`${year}-11-15`,`${year+1}-02-15`]
      const sum = [100,120,140,160].slice(0,q+1).reduce((a,b)=>a+b,0)*(year===2024?1.1:1)
      rows.push({start:`${year}-01-01`,end:`${year}-${ends[q]}`,filed:filings[q],accn:`${year}-${q}`,form:q===3?'10-K':'10-Q',val:sum*ratio})
    }
    facts[tag]={units:{USD:rows}}
  }
  return {facts:{'us-gaap':facts}}
}
describe('standalone quarterly financials', () => {
  it('subtracts consecutive YTD amounts and derives Q4 without double-counting the year', () => {
    const result=parseQuarterlyFinancials(quarterlyFixture(),at('2025-02-17'))
    expect(result.quarters).toHaveLength(8)
    expect(result.quarters.at(-1)!.values.revenue).toBeCloseTo(176)
    expect(result.quarters.at(-1)!.values.operatingCashFlow).toBeCloseTo(35.2)
    expect(result.trailingYear!.values.revenue).toBeCloseTo(572)
    expect(result.trailingYear!.values.freeCashFlow).toBeCloseTo(85.8)
    expect(result.quarters.at(-1)!.revenueGrowthPct).toBeCloseTo(10)
    expect(result.status).toBe('stable')
  })
  it('does not see a later annual filing or future restatement before disclosure', () => {
    const body=quarterlyFixture(), cutoff=at('2024-11-17')
    const before=parseQuarterlyFinancials(body,cutoff)
    body.facts!['us-gaap'].Revenues.units!.USD.push({start:'2024-01-01',end:'2024-09-30',filed:'2025-03-01',accn:'amended',form:'10-Q/A',val:99999})
    expect(parseQuarterlyFinancials(body,cutoff)).toEqual(before)
    expect(before.quarters.at(-1)!.end).toBe('2024-09-30')
  })
  it('leaves missing quarters and cash flows unknown instead of treating YTD as a quarter', () => {
    const body=quarterlyFixture()
    for (const concept of Object.values(body.facts!['us-gaap'])) concept.units!.USD=concept.units!.USD.filter(f=>f.end!=='2024-06-30')
    const result=parseQuarterlyFinancials(body,at('2025-02-17'))
    expect(result.trailingYear).toBeNull()
    expect(result.quarters.some(q=>q.end==='2024-09-30')).toBe(false)
    delete body.facts!['us-gaap'].NetCashProvidedByUsedInOperatingActivities
    expect(parseQuarterlyFinancials(body,at('2025-02-17')).quarters.at(-1)!.values.freeCashFlow).toBeNull()
  })
  it('rejects conflicting contexts and stale financial trends', () => {
    const body=quarterlyFixture(), rows=body.facts!['us-gaap'].Revenues.units!.USD
    rows.push({...rows.at(-1)!,val:999})
    expect(parseQuarterlyFinancials(body,at('2025-02-17')).quarters.at(-1)!.values.revenue).toBeNull()
    expect(parseQuarterlyFinancials(quarterlyFixture(),at('2026-01-01')).status).toBe('insufficient')
  })
})
