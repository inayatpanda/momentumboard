import { describe, expect, it } from 'vitest'
import { buildStockContext, withStockContext, auditContextTrials, STOCK_CONTEXT_VERSION } from './stockContext'
import { LAB_EXECUTION_VERSION, type StrategyLabRecord, type StrategyObservation } from './strategyLab'
import type { MarketPatternsSnapshot } from './marketPatterns'
import type { Candle } from '../types'
const DAY = 86400, now = Date.UTC(2026, 9, 24, 7) / 1000
const dates: number[] = []
for (let t = Date.UTC(2026, 9, 23, 16) / 1000; dates.length < 50; t -= DAY) if (![0, 6].includes(new Date(t * 1000).getUTCDay())) dates.unshift(t)
const tape = (growth: number): Candle[] => dates.map((t, i) => { const c = 100 + i * growth; return { t, o: c, h: c + 1, l: c - 1, c, v: 1000 } })
const patterns: MarketPatternsSnapshot = { version: 1, generatedAt: now - 60, dataFrom: '2006-04-28', dataThrough: '2026-10-23', observations: 5000, digest: 'test', current: [{ symbol: 'SPY', monthPct: 2, quarterPct: 3 }, { symbol: 'USO', monthPct: 2, quarterPct: 3 }, { symbol: 'TLT', monthPct: 1, quarterPct: 3 }], pairs: [], seasonal: [], similar: [{ date: '2020-01-02', endDate: '2020-02-03', returns: [2, 3, 4, 5, 6], distance: 1, precedingReturns: [1, 2, 3, 4, 5] }] }
const input = { symbol: 'MSFT', now, candles: tape(1), spy: tape(.1), sector: { symbol: 'XLK', name: 'Technology', candles: tape(.5) }, patterns, headlines: [{ title: 'Microsoft report', url: 'https://example.com/report', syms: ['MSFT'], at: now - 60, why: 'Results available', score: 75 }] }
const observation = (): StrategyObservation => ({ id: 'o', sym: 'MSFT', sleeve: 'short-horizon', side: 'neutral', state: 'watch', score: 40, entry: 100, stop: null, target: null, detectedAt: now, availableAt: now, reasons: [], risks: [], dataGaps: [], metrics: {}, forecast: { modelVersion: 'baseline-lift-250-session-v4', definition: 'three-session-direction-v1', label: 'Direction', horizonSessions: 3, probabilityUp: .6, probabilityDown: .39, probabilityFlat: .01, calibratedN: 30, provisional: true } })
describe('stock-specific market context', () => {
  it('uses matching dates and keeps market history separate from stock outcomes', () => {
    const c = buildStockContext(input)
    expect(c.status).toBe('supportive')
    expect(c.stockVsSectorPp).toBeGreaterThan(1)
    expect(c.market?.historical).toContain('not MSFT results')
    expect(c.news).toHaveLength(1)
    expect(c.newsView).toBeNull()
    expect(c.trialShift).toBe(.02)
  })
  it('does not invent a sector effect for overseas listings or missing endpoints', () => {
    expect(buildStockContext({ ...input, symbol: 'MSFT.L' }).status).toBe('limited')
    const c = buildStockContext({ ...input, sector: { ...input.sector, candles: input.sector.candles.slice(0, -1) } })
    expect(c.stockVsSectorPp).toBeNull()
    expect(c.trialShift).toBeNull()
  })
  it('drops stale or future history and unlinked, unsafe, duplicate or future news', () => {
    const current = input.headlines[0]
    const c = buildStockContext({ ...input, patterns: { ...patterns, generatedAt: now + 1 }, catalyst: { side: 'long', reason: 'unlinked opinion' }, headlines: [
      { ...current, syms: ['OTHER'] }, { ...current, at: now + 1 }, { ...current, at: now - 4 * DAY }, { ...current, url: 'javascript:alert(1)' },
    ] })
    expect(c.market).toBeNull(); expect(c.news).toHaveLength(0); expect(c.newsView).toBeNull(); expect(c.trialShift).toBeNull()
    expect(buildStockContext({ ...input, headlines: [current, current] }).news).toHaveLength(1)
    expect(buildStockContext({ ...input, patterns: { ...patterns, dataThrough: '2026-09-01' } }).market).toBeNull()
  })
  it('keeps oil pressure conditional and blocks experiments near earnings', () => {
    const c = buildStockContext({ ...input, earningsRisk: true, patterns: { ...patterns, current: patterns.current.map(x => ({ ...x, monthPct: x.symbol === 'SPY' ? -3 : x.symbol === 'USO' ? 10 : 2 })), pairs: [{ a: 'SPY', b: 'USO', recent: -.4, historical: .3, recentN: 252, historicalN: 5000 }] } })
    expect(c.market?.regime).toBe('pressure')
    expect(c.market?.explanation).toContain('not proof')
    expect(c.status).toBe('caution'); expect(c.trialShift).toBeNull()
  })
  it('saves a bounded challenger without changing the original probabilities or trading eligibility', () => {
    const before = observation(), after = withStockContext(before, buildStockContext(input))
    expect(after.forecast).toEqual(before.forecast); expect(after.state).toBe(before.state); expect(after.score).toBe(before.score)
    expect(after.contextTrial?.candidateUp).toBeCloseTo(.62)
    expect(after.contextTrial?.patternDigest).toBe('test')
    expect(withStockContext(before, buildStockContext({ ...input, now: now + 1 }))).toEqual(before)
  })
})
function record(index: number, wins = true): StrategyLabRecord {
  const at = now - (100 - index) * DAY
  const r = withStockContext({ ...observation(), id: `o${index}`, sym: `SYM${index}`, availableAt: at, detectedAt: at }, { ...buildStockContext(input), symbol: `SYM${index}`, generatedAt: at })
  return { ...r, outcome: { entry: 100, exit: wins ? 101 : 99, returnPct: wins ? 1 : -1, sessions: 3, firstBarrier: 'none', targetHit: false, stopHit: false, executionStatus: 'not-applicable', executionVersion: LAB_EXECUTION_VERSION, horizonEndAt: at + 4 * DAY, finishedHigher: wins } }
}
describe('paired context forecast experiment', () => {
  it('requires saved-before-outcome pairs and removes duplicate and overlapping stock campaigns', () => {
    const first = record(0)
    const overlap = { ...record(1), sym: first.sym }
    const invalid = { ...record(2), contextTrial: { ...record(2).contextTrial!, savedAt: now + DAY } }
    const notReady = { ...record(3), outcome: { ...record(3).outcome!, horizonEndAt: now + DAY } }
    const a = auditContextTrials([first, first, overlap, invalid, notReady], now)
    expect(a.completed).toBe(1); expect(a.status).toBe('collecting')
    expect(a.baselineBrier).toBeCloseTo(.16)
    expect(a.candidateBrier).toBeLessThan(a.baselineBrier!)
  })
  it('checks improvement in both chronological halves and never calls it a proven trading advantage', () => {
    const better = auditContextTrials(Array.from({ length: 60 }, (_, i) => record(i)), now)
    expect(better.status).toBe('early-improvement'); expect(better.publicationDays).toBe(60)
    const reverses = auditContextTrials(Array.from({ length: 60 }, (_, i) => record(i, i < 30)), now)
    expect(reverses.status).toBe('no-improvement')
    expect(reverses.recentImprovement).toBeLessThan(0)
    expect(better.version).toBe(STOCK_CONTEXT_VERSION)
  })
})
