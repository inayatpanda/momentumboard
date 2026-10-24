import { describe, it, expect } from 'vitest'
import { emptyBusinessHealth, type BusinessHealthSnapshot } from '../businessHealth'
import { REPORT_TREND_METRICS, type FinancialReportPoint } from '../reportTrends'
import type { Candle } from '../types'
import { buildStockContext } from './stockContext'
import { buildDropCheck, stockChanges, snapshotStock, retainStockDays, londonDay } from './stockUpdates'
const DAY = 86400
const NOW = Date.parse('2026-10-24T18:00:00Z') / 1000
const tape = (end = 80): Candle[] => Array.from({length: 90}, (_, i) => { const c = i === 89 ? end : 100; return { t: NOW - (90 - i) * DAY, o: c, h: c, l: c, c, v: 1000 } })
function health(sym: string): BusinessHealthSnapshot {
  const value: BusinessHealthSnapshot = {
    ...emptyBusinessHealth(sym, NOW, ''), status: 'available', availableAt: NOW - 30 * DAY,
    annualPeriodEnd: '2025-12-31', balancePeriodEnd: '2026-06-30', periodEnd: '2026-06-30', currency: 'USD', gaps: [],
  }
  Object.assign(value.metrics, { revenue: 1000, netIncome: 100, operatingCashFlow: 140, capitalExpenditure: 50, freeCashFlow: 90,
    currentRatio: 2, cash: 100, totalDebt: 180, currentLiabilities: 200, totalEquity: 600, debtToEquity: 0.3, revenueGrowthPct: 10, shareCountChangePct: 0,
    recentNetIncome: 20, recentOperatingCashFlow: 40, recentRevenueGrowthPct: 5, recentShareCountChangePct: 0 })
  for (const [name, n] of Object.entries(value.metrics)) {
    if (n == null) continue
    value.evidence[name as keyof typeof value.metrics] = { value: n, periodStart: name.startsWith('recent') ? '2026-04-01' : '2025-01-01',
      periodEnd: (name.startsWith('recent') || ['cash','totalDebt','currentLiabilities','totalEquity','currentRatio','debtToEquity'].includes(name)) ? '2026-06-30' : '2025-12-31', filed: '2026-08-01', availableAt: NOW - 30 * DAY, unit: 'USD', tags: [], accessions: [] }
  }
  value.reportHistory = ['2025-12-31', '2026-03-31', '2026-06-30'].map((periodEnd, i): FinancialReportPoint => ({
    periodStart: null, periodEnd, periodKind: 'quarter', durationDays: 90, cashFlowPeriodStart: null,
    cashFlowPeriodKind: 'quarter', filed: '2026-08-01', availableAt: NOW - (120 - 30 * i) * DAY,
    accession: `report-${i}`, financialHealth: 'healthy', healthAssessment: { status: 'healthy', reasons: [], risks: [], gaps: [] },
    annualPeriodEnd: '2025-12-31', balancePeriodEnd: periodEnd, coverageStatus: 'available', gaps: [], evidence: {},
    metrics: { ...Object.fromEntries(REPORT_TREND_METRICS.map(key => [key, null])), revenueGrowthPct: 10,
      netMarginChangePp: 2, operatingCashFlowMarginChangePp: 2, shareCountChangePct: 0, operatingCashFlow: 40 } as FinancialReportPoint['metrics'],
  }))
  return value
}

const current = () => buildStockContext({ symbol: 'MSFT', now: NOW, candles: tape(), spy: [], sector: null, headlines: [], patterns: null })
describe('business check after a large drop', () => {
  it('requires both current healthy figures and stable or improving report history', () => {
    const h = health('MSFT')
    const result = buildDropCheck({ symbol: 'MSFT', now: NOW, candles: tape(), health: h, sector: 'XLK' })
    expect(result).toMatchObject({ status: 'holding-up', health: 'healthy', trend: 'improving' })
    expect(result.drawdownPct).toBeCloseTo(-20)
    expect(result.summary).toContain('not proven')
    h.reportHistory = []
    expect(buildDropCheck({ symbol: 'MSFT', now: NOW, candles: tape(), health: h, sector: 'XLK' }).status).toBe('unclear')
  })
  it('prioritises newer losses and worsening reports over an old healthy annual result', () => {
    const h = health('MSFT'); h.metrics.recentNetIncome = -20
    const result = buildDropCheck({symbol: 'MSFT', now: NOW, candles: tape(), health: h, sector: 'XLK', news: { verdict: 'transient', reason: 'Analyst downgrade' }})
    expect(result.status).toBe('weakening')
    expect(result.facts.join(' ')).toContain('recent interim profit')
  })
  it('keeps stale, future, wrong-company, specialist and absent evidence uncertain', () => {
    for (const h of [undefined, {...health('MSFT'), status: 'stale' as const}, {...health('MSFT'), availableAt: NOW + 1}, health('OTHER')]) {
      expect(buildDropCheck({ symbol:'MSFT', now:NOW, candles:tape(), health:h, sector:'XLK' }).status).toBe('unclear')
    }
    expect(buildDropCheck({ symbol:'MSFT', now:NOW, candles:tape(), health:health('MSFT'), sector:'XLF' }).status).toBe('unclear')
    expect(buildDropCheck({ symbol:'MSFT.L', now:NOW, candles:tape(), health:health('MSFT') }).status).toBe('not-applicable')
  })
  it('does not turn negative headlines into proven damage or a positive headline into proof of recovery', () => {
    const result = buildDropCheck({ symbol:'MSFT', now:NOW, candles:tape(), health:health('MSFT'), sector:'XLK', news:{verdict:'structural',reason:'Guidance cut in linked title'} })
    expect(result.status).toBe('unclear')
    expect(result.summary).toContain('possible lasting problem')
    expect(buildDropCheck({symbol:'MSFT',now:NOW,candles:tape(),news:{verdict:'transient',reason:'Downgrade'}}).status).toBe('unclear')
  })
  it('uses completed fresh prices and distinguishes a small drop from a large one', () => {
    expect(buildDropCheck({symbol:'MSFT',now:NOW,candles:tape(98)}).status).toBe('no-large-drop')
    expect(buildDropCheck({symbol:'MSFT',now:NOW + 10 * DAY,candles:tape()}).drawdownPct).toBeNull()
    const future = { ...tape()[0], t: NOW + DAY, c: 200 }
    expect(buildDropCheck({symbol:'MSFT',now:NOW,candles:[...tape(),future]}).drawdownPct).toBeCloseTo(-20)
  })
})
describe('saved daily changes', () => {
  it('compares against yesterday, never the previous intraday refresh', () => {
    const c = current(), old = snapshotStock({...c, generatedAt: NOW - DAY, status:'supportive', sectorVsMarketPp:3})
    const intraday = snapshotStock({...c,generatedAt:NOW - 60})
    const changes = stockChanges({...c,sectorVsMarketPp:0},tape(),[old,intraday])
    expect(changes.baselineAt).toBe(old.at)
    expect(changes.heading).toBe('What changed since yesterday?')
    expect(changes.lines.join(' ')).toContain('shrank by 3.0')
    expect(changes.session).toContain('2026-10-23')
  })
  it('labels first-day tracking and older comparisons without inventing yesterday', () => {
    const c = current()
    expect(stockChanges(c,tape(),[snapshotStock({...c,generatedAt:NOW - 60})]).lines[0]).toContain('tracking has started')
    expect(stockChanges(c,tape(),[snapshotStock({...c,generatedAt:NOW - 3 * DAY})]).heading).toContain('2026-10-21')
  })
  it('deduplicates daily snapshots and retains past dates across midnight and DST', () => {
    const c = current(), before = snapshotStock({...c,generatedAt:NOW - DAY}), a=snapshotStock({...c,generatedAt:NOW - 60}), b=snapshotStock(c)
    const history = retainStockDays([before,a], [b, {...b, at:NOW + 1},snapshotStock({...c,generatedAt:NOW - 10 * DAY})],NOW)
    expect(history).toEqual([before,b])
    expect(londonDay(Date.parse('2026-10-24T23:30:00Z')/1000)).toBe('2026-10-25')
    expect(londonDay(Date.parse('2026-10-25T23:30:00Z')/1000)).toBe('2026-10-25')
  })
  it('only calls previously unseen and newly collected news new; reports missing days honestly', () => {
    const c = current(), news = {title:'Report',url:'https://example.com/a',collectedAt:NOW - DAY - 10,interpretation:''}
    const prev=snapshotStock({...c,generatedAt:NOW-DAY,news:[news]})
    const result=stockChanges({...c,news:[{...news,collectedAt:NOW}, {...news,url:'https://example.com/b',collectedAt:NOW}, {...news,url:'https://example.com/old'}]},tape(),[prev])
    expect(result.lines.join(' ')).toContain('1 newly collected company headline')
    expect(result.lines.join(' ')).toContain('No new completed trading session')
  })
})
