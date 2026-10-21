import { describe, expect, it } from 'vitest'
import { buildMarketComparison } from './marketComparison'
import { gradeStrategyObservation, LAB_EXECUTION_VERSION, SHORT_HORIZON_MODEL_VERSION, type StrategyLabRecord } from './strategyLab'
import type { Candle } from '../types'
const at = (s: string) => Date.parse(s) / 1000
const now = at('2026-10-10T12:00:00Z')
const tape = (values: number[]): Candle[] => values.map((c, i) => ({ t: at(`2026-10-0${5+i}T13:30:00Z`), o: c, c, h: c + .1, l: c - .1, v: 1000 }))
const spy = tape([100, 100, 102, 105])
const record = (over: Partial<StrategyLabRecord> = {}): StrategyLabRecord => {
  const r: StrategyLabRecord = { id: 'a', sym: 'AAPL', sleeve: 'short-horizon', side: 'long', state: 'setup', score: 70,
    entry: 100, stop: 95, target: 110, availableAt: at('2026-10-05T22:00:00Z'), detectedAt: at('2026-10-05T22:00:00Z'), reasons: [], risks: [], dataGaps: [], metrics: {},
    forecast: { definition: 'three-session-direction-v1', label: 'test', modelVersion: SHORT_HORIZON_MODEL_VERSION, horizonSessions: 3, calibratedN: 0, provisional: true }, ...over }
  r.outcome = gradeStrategyObservation(r, tape([100, 100, 94, 100]), now) ?? undefined
  return r
}
describe('published forecast market test', () => {
  it('keeps a stopped loss and benchmarks the full horizon after costs on both legs', () => {
    const r = record(), result = buildMarketComparison([r], spy, now)
    expect(r.outcome?.executionVersion).toBe(LAB_EXECUTION_VERSION)
    const c = result.cohorts[0]
    expect(c.matchedN).toBe(1)
    expect(c.meanReturnPct).toBeLessThan(-6)
    expect(c.meanMarketPct).toBeCloseTo((105 * .999 / 100.1 - 1) * 100)
    expect(c.meanExcessPp).toBeCloseTo(c.meanReturnPct! - c.meanMarketPct!)
    expect(c.status).toBe('behind')
    expect(c.beatRate).toBe(0)
  })
  it('never fills missing benchmark dates, future outcomes or old execution conventions with zero', () => {
    const r = record()
    expect(buildMarketComparison([r], spy.slice(0, 3), now).cohorts[0]).toMatchObject({ matchedN: 0, missingBenchmarkN: 1, meanExcessPp: null })
    expect(buildMarketComparison([{ ...r, outcome: { ...r.outcome!, executionVersion: undefined } }], spy, now).excludedUnverifiableN).toBe(1)
    expect(buildMarketComparison([r], spy, at('2026-10-07T12:00:00Z')).excludedUnverifiableN).toBe(1)
  })
  it('separates model revisions and counts repeated/overlapping campaigns once', () => {
    const r = record(), other = record({ id: 'b', sym: 'MSFT' }), duplicate = { ...r, id: 'again', availableAt: r.availableAt + 1 }
    const old = record({ id: 'old', forecast: { ...r.forecast, modelVersion: 'older' } })
    const result = buildMarketComparison([r, r, duplicate, other, old], spy, now)
    expect(result.cohorts).toHaveLength(2)
    expect(result.cohorts[0]).toMatchObject({ current: true, matchedN: 2, overlappingN: 2, publicationDays: 1, independentWindows: 1 })
    expect(result.cohorts[1]).toMatchObject({ current: false, matchedN: 1 })
  })
  it('counts gap cancellations separately and excludes watch-only and foreign-market returns', () => {
    const gap = record({ target: 99 })
    expect(buildMarketComparison([gap], spy, now).cohorts[0]).toMatchObject({ matchedN: 0, cancelledN: 1, meanExcessPp: null })
    const r = record()
    const result = buildMarketComparison([{ ...r, state: 'watch' }, { ...r, sym: 'HSBA.L' }], spy, now)
    expect(result.cohorts).toHaveLength(0)
    expect(result.excludedUnsupportedN).toBe(1)
  })
})
