import { describe, expect, it } from 'vitest'
import { pickDiverse, returnCorrelation, MAX_PER_SECTOR } from './select'

// deterministic pseudo-noise so correlated/uncorrelated series are reproducible
const wave = (n: number, phase: number, amp = 1) => Array.from({ length: n }, (_, i) => 100 + amp * Math.sin(i / 3 + phase) + i * 0.05)

describe('returnCorrelation', () => {
  it('identical paths → ~1; opposite paths → ~−1', () => {
    const a = wave(80, 0)
    expect(returnCorrelation(a, a)).toBeCloseTo(1, 5)
    const b = Array.from({ length: 80 }, (_, i) => 200 - (a[i] - 100)) // mirrored moves
    expect(returnCorrelation(a, b)!).toBeLessThan(-0.9)
  })
  it('null when overlapping history is too short', () => {
    expect(returnCorrelation(wave(10, 0), wave(80, 0))).toBeNull()
  })
})

describe('pickDiverse', () => {
  const closes = new Map<string, number[]>([
    ['AAA', wave(80, 0)],
    ['BBB', wave(80, 0.01)], // lockstep with AAA
    ['CCC', wave(80, 2.1)], // different phase → decorrelated
  ])
  const cand = (sym: string, composite: number) => ({ sym, composite })

  it('caps names per sector, taking the highest conviction first', () => {
    const cands = ['A1', 'A2', 'A3', 'A4', 'B1'].map((s, i) => cand(s, 90 - i))
    const { picked, skipped } = pickDiverse(cands, 10, sym => (sym.startsWith('A') ? 'XLK' : 'XLE'), () => null)
    expect(picked.map(p => p.sym)).toEqual(['A1', 'A2', 'A3', 'B1'])
    expect(picked.filter(p => p.sym.startsWith('A'))).toHaveLength(MAX_PER_SECTOR)
    expect(skipped).toEqual([{ sym: 'A4', why: 'sector XLK full' }])
  })

  it('skips a candidate moving in lockstep with an already-picked name', () => {
    const { picked, skipped } = pickDiverse(
      [cand('AAA', 90), cand('BBB', 80), cand('CCC', 70)],
      10,
      () => null,
      sym => closes.get(sym) ?? null,
    )
    expect(picked.map(p => p.sym)).toEqual(['AAA', 'CCC'])
    expect(skipped[0].sym).toBe('BBB')
    expect(skipped[0].why).toContain('AAA')
  })

  it('missing sector or candles never blocks a pick', () => {
    const { picked } = pickDiverse([cand('X', 50), cand('Y', 40)], 10, () => null, () => null)
    expect(picked).toHaveLength(2)
  })

  it('respects the cap', () => {
    const cands = Array.from({ length: 20 }, (_, i) => cand(`S${i}`, 100 - i))
    expect(pickDiverse(cands, 12, () => null, () => null).picked).toHaveLength(12)
  })
})
