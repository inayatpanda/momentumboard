import { describe, expect, it } from 'vitest'
import { capClassBreakdown, flattenLedger, gradeBreakdown, statusOf, summariseLedger } from './ledgerStats'
import type { LedgerDay, LedgerPrediction } from './api'

const pred = (over: Partial<LedgerPrediction>): LedgerPrediction =>
  ({
    id: 'x', date: '2026-07-01', sym: 'AAA', side: 'long', grade: 'C', probability: 0.4, provisional: false,
    shadow: false, composite: 30, entry: 100, stop: 95, target: 110, expectedMovePct: 5, stage: null,
    regime: 'amber', earningsRisk: false, instrument: null, paperOnly: false, note: '', ...over,
  }) as LedgerPrediction

const out = (excessPct: number, hit: boolean, stopped = false) => ({ excessPct, rawPct: excessPct, spyPct: 0, stopped, hit })

describe('statusOf', () => {
  it('open until graded; then stopped > hit > miss', () => {
    expect(statusOf(pred({}))).toBe('open')
    expect(statusOf(pred({ outcome10: out(3, true) }))).toBe('hit')
    expect(statusOf(pred({ outcome10: out(-2, false) }))).toBe('miss')
    expect(statusOf(pred({ outcome10: out(-5, false, true) }))).toBe('stopped')
  })
})

describe('flattenLedger + summariseLedger', () => {
  const days: LedgerDay[] = [
    { date: '2026-07-02', predictions: [pred({ id: 'a', outcome10: out(4, true) }), pred({ id: 'b', outcome10: out(-3, false, true) })] },
    { date: '2026-07-01', predictions: [pred({ id: 'c', outcome10: out(0.5, false) }), pred({ id: 'd' })] },
  ]
  it('flattens newest-first and honours the cap', () => {
    expect(flattenLedger(days).map(p => p.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(flattenLedger(days, 3)).toHaveLength(3)
  })
  it('summarises only graded rows', () => {
    const s = summariseLedger(flattenLedger(days))
    expect(s.total).toBe(4)
    expect(s.open).toBe(1)
    expect(s.graded).toBe(3)
    expect(s.hits).toBe(1)
    expect(s.stopped).toBe(1)
    expect(s.hitRate).toBeCloseTo(0.33, 2)
    expect(s.avgExcess10).toBeCloseTo(0.5, 1)
  })
})

describe('gradeBreakdown', () => {
  const rows = [
    pred({ id: '1', grade: 'B', outcome10: out(4, true) }),
    pred({ id: '2', grade: 'B', outcome10: out(-2, false) }),
    pred({ id: '3', grade: 'C', outcome10: out(2, true) }),
    pred({ id: '4', grade: 'C' }), // open — counted, not scored
    pred({ id: '5', grade: 'C', shadow: true, outcome10: out(-6, false, true) }), // shadow bucket, NOT C
  ]
  it('splits by grade with shadows in their own bucket, scoring only graded rows', () => {
    const b = gradeBreakdown(rows)
    expect(b.map(x => x.key)).toEqual(['B', 'C', 'shadow'])
    const B = b.find(x => x.key === 'B')!
    expect(B).toMatchObject({ n: 2, graded: 2, hits: 1, hitRate: 0.5 })
    expect(B.avgExcess10).toBeCloseTo(1, 1)
    const C = b.find(x => x.key === 'C')!
    expect(C).toMatchObject({ n: 2, graded: 1, hits: 1, hitRate: 1 })
    const sh = b.find(x => x.key === 'shadow')!
    expect(sh).toMatchObject({ n: 1, graded: 1, hits: 0, avgExcess10: -6 })
  })
  it('drops empty buckets', () => {
    expect(gradeBreakdown([]).length).toBe(0)
  })
})

describe('capClassBreakdown', () => {
  const rows = [
    pred({ id: '1', capUsdM: 5000, outcome10: out(4, true) }), // large
    pred({ id: '2', capUsdM: 2000, outcome10: out(-2, false) }), // large (boundary)
    pred({ id: '3', capUsdM: 1999, outcome10: out(2, true) }), // small (boundary)
    pred({ id: '4', capUsdM: 500 }), // small, open — counted, not scored
    pred({ id: '5', capUsdM: null, outcome10: out(-6, false, true) }), // unknown
  ]
  it('splits by cap cohort, scoring only graded rows', () => {
    const b = capClassBreakdown(rows)
    expect(b.map(x => x.key)).toEqual(['Large-cap', 'Small-cap', 'Unknown'])
    const large = b.find(x => x.key === 'Large-cap')!
    expect(large).toMatchObject({ n: 2, graded: 2, hits: 1, hitRate: 0.5 })
    expect(large.avgExcess10).toBeCloseTo(1, 1)
    const small = b.find(x => x.key === 'Small-cap')!
    expect(small).toMatchObject({ n: 2, graded: 1, hits: 1, hitRate: 1 })
    const unknown = b.find(x => x.key === 'Unknown')!
    expect(unknown).toMatchObject({ n: 1, graded: 1, hits: 0, avgExcess10: -6 })
  })
  it('drops empty cohorts', () => {
    expect(capClassBreakdown([]).length).toBe(0)
  })
})
