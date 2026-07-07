import { describe, expect, it } from 'vitest'
import { flattenLedger, gradeBreakdown, statusOf, summariseLedger } from './ledgerStats'
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
    expect(statusOf(pred({ outcome5: out(3, true) }))).toBe('hit')
    expect(statusOf(pred({ outcome5: out(-2, false) }))).toBe('miss')
    expect(statusOf(pred({ outcome5: out(-5, false, true) }))).toBe('stopped')
  })
})

describe('flattenLedger + summariseLedger', () => {
  const days: LedgerDay[] = [
    { date: '2026-07-02', predictions: [pred({ id: 'a', outcome5: out(4, true) }), pred({ id: 'b', outcome5: out(-3, false, true) })] },
    { date: '2026-07-01', predictions: [pred({ id: 'c', outcome5: out(0.5, false) }), pred({ id: 'd' })] },
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
    expect(s.avgExcess5).toBeCloseTo(0.5, 1)
  })
})

describe('gradeBreakdown', () => {
  const rows = [
    pred({ id: '1', grade: 'B', outcome5: out(4, true) }),
    pred({ id: '2', grade: 'B', outcome5: out(-2, false) }),
    pred({ id: '3', grade: 'C', outcome5: out(2, true) }),
    pred({ id: '4', grade: 'C' }), // open — counted, not scored
    pred({ id: '5', grade: 'C', shadow: true, outcome5: out(-6, false, true) }), // shadow bucket, NOT C
  ]
  it('splits by grade with shadows in their own bucket, scoring only graded rows', () => {
    const b = gradeBreakdown(rows)
    expect(b.map(x => x.key)).toEqual(['B', 'C', 'shadow'])
    const B = b.find(x => x.key === 'B')!
    expect(B).toMatchObject({ n: 2, graded: 2, hits: 1, hitRate: 0.5 })
    expect(B.avgExcess5).toBeCloseTo(1, 1)
    const C = b.find(x => x.key === 'C')!
    expect(C).toMatchObject({ n: 2, graded: 1, hits: 1, hitRate: 1 })
    const sh = b.find(x => x.key === 'shadow')!
    expect(sh).toMatchObject({ n: 1, graded: 1, hits: 0, avgExcess5: -6 })
  })
  it('drops empty buckets', () => {
    expect(gradeBreakdown([]).length).toBe(0)
  })
})
