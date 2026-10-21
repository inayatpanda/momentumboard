import { describe, expect, it } from 'vitest'
import { buildFinancialPanel, financialPointAt, historicalFinancialState } from './historicalFundamentals'
import type { CompanyFacts } from '../../netlify/functions/lib/businessHealth'
import { buildHistoricalStudy, type HistoryTape } from './longHistory'

const at = (date: string) => Date.parse(date) / 1000
function facts(): CompanyFacts {
  const rows: NonNullable<CompanyFacts['facts']>[string] = {}
  const base = { filed: '2020-02-15', form: '10-K', accn: 'original', end: '2019-12-31' }
  const flow = (tag: string, val: number, prior?: number, unit = 'USD') => {
    rows[tag] = { units: { [unit]: [{ ...base, start: '2019-01-01', val }, ...(prior == null ? [] : [{ ...base, start: '2018-01-01', end: '2018-12-31', val: prior }])] } }
  }
  flow('Revenues', 1000, 900); flow('NetIncomeLoss', 100)
  flow('NetCashProvidedByUsedInOperatingActivities', 140); flow('PaymentsToAcquirePropertyPlantAndEquipment', 40)
  flow('WeightedAverageNumberOfDilutedSharesOutstanding', 100, 100, 'shares')
  for (const [tag, val] of Object.entries({ CashAndCashEquivalentsAtCarryingValue: 100, AssetsCurrent: 400, LiabilitiesCurrent: 200, StockholdersEquity: 600, Liabilities: 400, DebtCurrent: 60, LongTermDebtNoncurrent: 120 })) rows[tag] = { units: { USD: [{ ...base, val }] } }
  rows.CommonStockSharesOutstanding = { units: { shares: [{ ...base, val: 100 }] } }
  return { cik: 1, facts: { 'us-gaap': rows } }
}
describe('historical financial evidence', () => {
  it('waits for filing availability, and later restatements never change earlier decisions', () => {
    const raw = facts(), end = at('2021-01-01')
    const panel = buildFinancialPanel(raw, 'AAPL', end)
    expect(financialPointAt(panel, at('2020-02-16T11:59:59Z'))).toBeNull()
    const before = financialPointAt(panel, at('2020-02-16T12:00:00Z'))!
    raw.facts!['us-gaap'].NetIncomeLoss.units!.USD.push({ ...raw.facts!['us-gaap'].NetIncomeLoss.units!.USD[0], filed: '2020-05-15', accn: 'amended', form: '10-K/A', val: -100 })
    const revised = buildFinancialPanel(raw, 'AAPL', end)
    expect(financialPointAt(revised, at('2020-03-01'))).toEqual(before)
    expect(financialPointAt(revised, at('2020-05-17'))?.snapshot.metrics.netIncome).toBe(-100)
  })
  it('does not mistake a quarterly or YTD amount for annual profit or combine currency units', () => {
    const raw = facts(), node = raw.facts!['us-gaap'].NetIncomeLoss.units!
    node.USD.push({ ...node.USD[0], start: '2019-10-01', val: 99999 })
    node.EUR = [{ ...node.USD[0], val: 99999 }]
    expect(financialPointAt(buildFinancialPanel(raw, 'AAPL', at('2020-03-01')), at('2020-03-01'))?.snapshot.metrics.netIncome).toBe(100)
  })
  it('matches split-adjusted prices with dated shares, and does not call missing or expired evidence healthy', () => {
    const panel = buildFinancialPanel(facts(), 'AAPL', at('2020-03-01'))
    const splits = [{ at: at('2020-08-01'), ratio: 4 }]
    const state = historicalFinancialState(panel, 'AAPL', at('2020-03-01'), 5, splits)
    expect(state.health.status).toBe('healthy')
    expect(state.valuation).toMatchObject({ status: 'supported', pe: 20, fcfYieldPct: 5 })
    expect(historicalFinancialState(panel, 'AAPL', at('2021-03-01'), 5, splits).health.status).toBe('unknown')
    expect(historicalFinancialState(panel, 'MSFT', at('2020-03-01'), 5, splits).health.status).toBe('unknown')
    expect(historicalFinancialState(panel, 'AAPL', at('2020-03-01'), 5, undefined).valuation.status).toBe('unknown')
    expect(historicalFinancialState(panel, 'AAPL', at('2020-03-01'), 5, [{ at: at('2020-01-15'), ratio: 4 }]).valuation.status).toBe('unknown')
  })
  it('rejects ambiguous share counts and specialist sector comparisons', () => {
    const raw = facts(), shares = raw.facts!['us-gaap'].CommonStockSharesOutstanding.units!.shares
    shares.push({ ...shares[0], val: 500 })
    const panel = buildFinancialPanel(raw, 'AAPL', at('2020-03-01'))
    expect(historicalFinancialState(panel, 'AAPL', at('2020-03-01'), 20, []).valuation.status).toBe('unknown')
    const bank = buildFinancialPanel(facts(), 'JPM', at('2020-03-01'))
    expect(historicalFinancialState(bank, 'JPM', at('2020-03-01'), 20, []).health.status).toBe('unknown')
  })
  it('runs financial strategies only after disclosure, settles after the signal and excludes future filings', () => {
    const days: number[] = []
    for (let t = at('2018-01-01'); days.length < 670; t += 86400) if (![0, 6].includes(new Date(t * 1000).getUTCDay())) days.push(t + 14 * 3600)
    const tape = (sym: string, growth: number): HistoryTape => ({ sym, fetchedAt: at('2021-01-01'), adjustment: days.map(() => 1), splits: [],
      candles: days.map((t, i) => { const c = 10 * growth ** i; return { t, o: c, h: c * 1.01, l: c * .99, c, v: 1000000 } }) })
    const stock = tape('AAPL', 1.0005), spy = tape('SPY', 1.0001), raw = facts(), now = at('2021-01-01')
    const run = () => buildHistoricalStudy([stock], spy, now, 'test', () => {}, [buildFinancialPanel(raw, 'AAPL', now)])
    const original = run().strategies.find(s => s.key === 'quality-value')!
    expect(original.stats.n).toBeGreaterThan(0)
    expect(original.stats.meanReturnPct).toBeCloseTo((1.0005 ** 62 * .999 / 1.001 - 1) * 100)
    for (const trade of original.examples!) {
      expect(trade.filingAt).toBeLessThanOrEqual(trade.signalAt)
      expect(trade.signalAt).toBeGreaterThanOrEqual(at('2020-02-16T12:00:00Z'))
      expect(trade.endAt).toBeGreaterThan(trade.signalAt)
    }
    raw.facts!['us-gaap'].NetIncomeLoss.units!.USD.push({ ...raw.facts!['us-gaap'].NetIncomeLoss.units!.USD[0], filed: '2022-01-01', val: -10000 })
    expect(run().strategies.find(s => s.key === 'quality-value')).toEqual(original)
    const absent = buildHistoricalStudy([stock], spy, now, 'test').strategies.find(s => s.key === 'quality-value')!
    expect(absent.stats.n).toBe(0)
    expect(absent.unknownFinancialN).toBeGreaterThan(0)
  })
})
