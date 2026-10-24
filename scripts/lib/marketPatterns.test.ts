import { describe, expect, it } from 'vitest'
import { buildMarketPatterns, correlation, parsePatternTape, type PatternTape } from './marketPatterns'
import { PATTERN_ASSETS } from '../../shared/engine/marketPatterns'
const now = Date.UTC(2026, 9, 24) / 1000
const dates: string[] = []
for (let t = Date.UTC(2006, 3, 28); t < now * 1000; t += 86400000) { const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10)) }
const tapes: PatternTape[] = PATTERN_ASSETS.map((a, k) => ({ symbol: a.symbol, rows: dates.map((date, i) => ({ date, close: 100 * Math.exp(.0001 * i + .07 * Math.sin(i / (20 + k * 9)) + .03 * Math.cos(i / 113 + k)) })) }))
const snapshot = buildMarketPatterns(tapes, now, 'fixture')
describe('market context evidence', () => {
  it('calculates correlation of paired changes without pretending constant data has a relationship', () => {
    expect(correlation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1)
    expect(correlation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
    expect(correlation([1, 1, 1], [2, 3, 4])).toBeNull()
    expect(correlation([1, 2], [1])).toBeNull()
  })
  it('uses twenty past calendar years, never this year, with actual next-month endpoints', () => {
    expect(snapshot.seasonal).toHaveLength(20)
    expect(snapshot.seasonal.map(p => p.date.slice(0, 4))).toEqual(Array.from({ length: 20 }, (_, i) => String(2006 + i)))
    for (const p of snapshot.seasonal) {
      const start = dates.indexOf(p.date), end = dates.indexOf(p.endDate)
      expect(end - start).toBe(21)
      expect(p.date.slice(5) >= '10-23' && p.date.slice(5) <= '10-27').toBe(true)
      expect(p.returns[0]).toBeCloseTo((tapes[0].rows[end].close / tapes[0].rows[start].close - 1) * 100)
    }
  })
  it('keeps analogues apart and calculates features entirely before each anchor', () => {
    expect(snapshot.similar).toHaveLength(5)
    for (const p of snapshot.similar) {
      const index = dates.indexOf(p.date)
      expect(dates.length - 1 - index).toBeGreaterThan(63)
      for (const other of snapshot.similar.filter(o => o !== p)) expect(Math.abs(index - dates.indexOf(other.date))).toBeGreaterThanOrEqual(126)
      expect(p.precedingReturns[0]).toBeCloseTo((tapes[0].rows[index].close / tapes[0].rows[index - 21].close - 1) * 100)
    }
    const future = tapes.map(t => ({ ...t, rows: [...t.rows, { date: '2026-10-26', close: 999999 }] }))
    expect(buildMarketPatterns(future, now, 'fixture')).toEqual(snapshot)
  })
  it('refuses incomplete, stale or misaligned panels instead of silently comparing different days', () => {
    expect(() => buildMarketPatterns(tapes.slice(1), now, '')).toThrow('Missing')
    expect(() => buildMarketPatterns(tapes.map((t, i) => i ? t : { ...t, rows: t.rows.filter((_, j) => j !== 1000) }), now, '')).toThrow('align')
    expect(() => buildMarketPatterns(tapes.map(t => ({ ...t, rows: t.rows.slice(0, -20) })), now, '')).toThrow('stale')
  })
  it('reads adjusted values, ignores the unfinished day, and rejects wrong identities', () => {
    const body = { chart: { result: [{ meta: { symbol: 'SPY' }, timestamp: [now - 86400, now], indicators: { adjclose: [{ adjclose: [42, 99] }] } }] } }
    expect(parsePatternTape(body, 'SPY', now).rows).toEqual([{ date: '2026-10-23', close: 42 }])
    expect(() => parsePatternTape(body, 'TLT', now)).toThrow('missing')
  })
})
