import { describe, expect, it } from 'vitest'
import { detectPatterns, zigzagPivots } from './patterns'
import type { Candle } from './types'

// synthetic candles from a close path: enough shape for the close-based detector
const mk = (path: number[]): Candle[] =>
  path.map((c, i) => ({ t: 1_700_000_000 + i * 86_400, o: c, h: c * 1.005, l: c * 0.995, c, v: 1_000_000 }))

// walk from a→b in `steps` closes (exclusive of a, inclusive of b)
const leg = (a: number, b: number, steps: number): number[] =>
  Array.from({ length: steps }, (_, i) => a + ((b - a) * (i + 1)) / steps)

describe('zigzagPivots', () => {
  it('books alternating pivots on clear swings and ends with the live extreme', () => {
    const closes = [...leg(100, 120, 10), ...leg(120, 100, 10), ...leg(100, 118, 10)]
    const piv = zigzagPivots([100, ...closes], 5)
    expect(piv.map(p => p.kind)).toEqual(['low', 'high', 'low', 'high'])
    expect(piv[1].price).toBeCloseTo(120)
    expect(piv[2].price).toBeCloseTo(100)
  })
  it('flat series → no pivots', () => {
    expect(zigzagPivots(Array(50).fill(100), 3)).toEqual([])
  })
})

describe('detectPatterns', () => {
  it('finds a confirmed head & shoulders once the neckline breaks', () => {
    // shoulders ~120, head 135, neckline ~100, then a break to 90
    const path = [
      ...leg(100, 120, 8), ...leg(120, 100, 8), // left shoulder
      ...leg(100, 135, 8), ...leg(135, 101, 8), // head
      ...leg(101, 119, 8), ...leg(119, 90, 10), // right shoulder + break
    ]
    const hits = detectPatterns(mk([100, ...path]))
    const hs = hits.find(x => x.kind === 'head-shoulders')
    expect(hs).toBeDefined()
    expect(hs!.direction).toBe('bearish')
    expect(hs!.status).toBe('confirmed')
    expect(hs!.level).toBeLessThanOrEqual(101)
  })

  it('finds a forming inverse H&S while price is still under the neckline', () => {
    const path = [
      ...leg(100, 80, 8), ...leg(80, 98, 8), // left shoulder
      ...leg(98, 68, 8), ...leg(68, 99, 8), // head
      ...leg(99, 81, 8), ...leg(81, 93, 8), // right shoulder, no break yet
    ]
    const hits = detectPatterns(mk([100, ...path]))
    const ihs = hits.find(x => x.kind === 'inv-head-shoulders')
    expect(ihs).toBeDefined()
    expect(ihs!.direction).toBe('bullish')
    expect(ihs!.status).toBe('forming')
  })

  it('finds a double top with two matched peaks', () => {
    const path = [...leg(100, 125, 10), ...leg(125, 105, 10), ...leg(105, 125.5, 10), ...leg(125.5, 112, 8)]
    const hits = detectPatterns(mk([100, ...path]))
    const dt = hits.find(x => x.kind === 'double-top')
    expect(dt).toBeDefined()
    expect(dt!.status).toBe('forming') // trough ~105 not broken yet
    const broken = detectPatterns(mk([100, ...path, ...leg(112, 100, 6)]))
    expect(broken.find(x => x.kind === 'double-top')?.status).toBe('confirmed')
  })

  it('finds a double bottom', () => {
    const path = [...leg(100, 75, 10), ...leg(75, 92, 10), ...leg(92, 74.5, 10), ...leg(74.5, 85, 8)]
    const dt = detectPatterns(mk([100, ...path])).find(x => x.kind === 'double-bottom')
    expect(dt).toBeDefined()
    expect(dt!.direction).toBe('bullish')
  })

  it('finds an ascending triangle: flat cap, rising lows', () => {
    const path = [
      ...leg(100, 120, 8), ...leg(120, 104, 8),
      ...leg(104, 120.4, 8), ...leg(120.4, 111, 8),
      ...leg(111, 118, 6),
    ]
    const tri = detectPatterns(mk([100, ...path])).find(x => x.kind === 'asc-triangle')
    expect(tri).toBeDefined()
    expect(tri!.direction).toBe('bullish')
    expect(tri!.status).toBe('forming')
  })

  it('a steady trend with no structure reports NOTHING — no pattern spam', () => {
    const path = leg(100, 160, 90)
    expect(detectPatterns(mk([100, ...path]))).toEqual([])
  })

  it('three bumps in a DOWNTREND are not a head & shoulders — a top needs an uptrend to top', () => {
    // the live NNE case: months of decline, then shoulder/head/shoulder-shaped
    // noise on the way down. No prior rise into the left shoulder → no badge.
    const path = [
      ...leg(200, 130, 30), // the downtrend the "pattern" sits in
      ...leg(130, 145, 6), ...leg(145, 128, 6), // "left shoulder"
      ...leg(128, 152, 6), ...leg(152, 127, 6), // "head"
      ...leg(127, 144, 6), ...leg(144, 126, 6), // "right shoulder"
    ]
    const hits = detectPatterns(mk([200, ...path]))
    expect(hits.find(x => x.kind === 'head-shoulders')).toBeUndefined()
    expect(hits.find(x => x.kind === 'double-top')).toBeUndefined()
  })

  it('a break that happened long ago is a SPENT move — no stale confirmed badge', () => {
    // clean double top, neckline breaks, then price keeps falling for ~25 bars:
    // by now the pattern already paid; flagging it "confirmed" is noise
    const path = [
      ...leg(100, 125, 10), ...leg(125, 105, 10), ...leg(105, 125.5, 10),
      ...leg(125.5, 104, 8), // the break
      ...leg(104, 82, 25), // the long-spent aftermath
    ]
    const hits = detectPatterns(mk([100, ...path]))
    expect(hits.find(x => x.kind === 'double-top')).toBeUndefined()
  })

  it('too little history → empty', () => {
    expect(detectPatterns(mk(leg(100, 110, 10)))).toEqual([])
  })
})
