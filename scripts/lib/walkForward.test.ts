import { describe, expect, it } from 'vitest'
import type { Candle } from '../../shared/types'
import {
  DAY_SEC,
  benchReturnPct,
  decilesOf,
  excessPp,
  featuresAtDay,
  forwardOutcome,
  isHit,
  lastIndexAtOrBefore,
  rankAvgTies,
  spearman,
  tStat,
} from './walkForward'

/** A tape whose closes are given and whose open/high/low are derived, so the
 * arithmetic under test is visible in the fixture rather than hidden in it. */
const tape = (closes: number[], opts: { opens?: number[]; lows?: number[]; startDay?: number } = {}): Candle[] =>
  closes.map((c, i) => ({
    t: ((opts.startDay ?? 20_000) + i) * DAY_SEC + 13.5 * 3600,
    o: opts.opens?.[i] ?? c,
    h: Math.max(c, opts.opens?.[i] ?? c),
    l: opts.lows?.[i] ?? Math.min(c, opts.opens?.[i] ?? c),
    c,
    v: 1_000_000,
  }))

describe('forwardOutcome', () => {
  it('enters at the NEXT session open and exits 10 sessions later', () => {
    // 13 bars: signal on index 0, entry on index 1's open, exit on index 11's close.
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]
    const opens = closes.map((_, i) => (i === 1 ? 50 : 999)) // only the entry open may be read
    const bars = tape(closes, { opens })
    const out = forwardOutcome(bars, 0, 10)!
    expect(out.entryIdx).toBe(1)
    expect(out.entry).toBe(50) // bars[1].o — NOT bars[0].c
    expect(out.exit).toBe(111) // bars[11].c — 10 sessions after the entry bar
    expect(out.retPct).toBeCloseTo((111 / 50 - 1) * 100, 10)
  })

  it('refuses a window the tape does not fully carry', () => {
    const bars = tape([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) // 12 bars
    expect(forwardOutcome(bars, 0, 10)).not.toBeNull() // needs index 11 — present
    expect(forwardOutcome(bars, 1, 10)).toBeNull() // would need index 12
    expect(forwardOutcome(bars, bars.length - 1, 10)).toBeNull()
  })

  it('reports max adverse excursion against the ENTRY price, not the signal close', () => {
    const closes = Array.from({ length: 13 }, () => 100)
    const opens = closes.map((_, i) => (i === 1 ? 100 : 100))
    const lows = closes.map((_, i) => (i === 5 ? 80 : 99))
    const out = forwardOutcome(tape(closes, { opens, lows }), 0, 10)!
    expect(out.maePct).toBeCloseTo(-20, 10)
  })

  it('ignores lows BEFORE the entry bar', () => {
    const closes = Array.from({ length: 13 }, () => 100)
    const lows = closes.map((_, i) => (i === 0 ? 10 : 99)) // the signal bar itself crashed
    const out = forwardOutcome(tape(closes, { lows }), 0, 10)!
    expect(out.maePct).toBeCloseTo(-1, 10)
  })
})

describe('excess and the hit rule', () => {
  it('is the name minus the benchmark in pp, and signs correctly', () => {
    expect(excessPp(5, 2)).toBeCloseTo(3, 10)
    expect(excessPp(-5, 2)).toBeCloseTo(-7, 10)
    expect(excessPp(-2, -5)).toBeCloseTo(3, 10) // down less than SPY is a WIN
  })

  it('hits at exactly +1pp and not a hair below', () => {
    expect(isHit(1)).toBe(true)
    expect(isHit(1.0001)).toBe(true)
    expect(isHit(0.9999)).toBe(false)
    expect(isHit(-3)).toBe(false)
  })

  it('a short lens wins when the name falls: −excess crosses the same bar', () => {
    const short = -excessPp(-6, -1) // name −6%, SPY −1% → excess −5pp → short +5pp
    expect(short).toBeCloseTo(5, 10)
    expect(isHit(short)).toBe(true)
  })
})

describe('benchReturnPct', () => {
  const spyCloses = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]
  const spy = tape(spyCloses, { opens: spyCloses.map((c, i) => (i === 1 ? 100 : c - 0.5)) })

  it('measures SPY over the same calendar window, open to close', () => {
    const entryDay = 20_001
    const exitDay = 20_011
    expect(benchReturnPct(spy, entryDay, exitDay)).toBeCloseTo((111 / 100 - 1) * 100, 10)
  })

  it('tolerates a venue holiday: the name entered on a day SPY did not trade', () => {
    const gapped = spy.filter((_, i) => i !== 1) // SPY has no bar on day 20_001
    const got = benchReturnPct(gapped, 20_001, 20_011)
    expect(got).not.toBeNull() // falls forward to SPY's next session
    expect(Number.isFinite(got!)).toBe(true)
  })
})

describe('no look-ahead', () => {
  // A tape with a violent, unmissable future: if any feature peeked past the
  // signal day the two reads could not agree.
  const closes: number[] = []
  for (let i = 0; i < 160; i++) closes.push(100 + Math.sin(i / 7) * 8 + i * 0.05)
  for (let i = 120; i < 160; i++) closes[i] = closes[i] * 3 // the future, tripled
  const bars = tape(closes)
  const spy = tape(closes.map((_, i) => 400 + i * 0.1))

  it('features on day t are identical whether or not future bars exist in the array', () => {
    const day = Math.floor(bars[119].t / DAY_SEC)
    const withFuture = featuresAtDay('TEST', bars, spy, day)!
    const withoutFuture = featuresAtDay('TEST', bars.slice(0, 120), spy.slice(0, 120), day)!
    expect(withFuture.idx).toBe(119)
    expect(withoutFuture.idx).toBe(119)
    expect(withFuture.features).not.toBeNull()
    expect(withFuture.features).toEqual(withoutFuture.features)
  })

  it('refuses a day with too little history behind it', () => {
    const day = Math.floor(bars[50].t / DAY_SEC)
    expect(featuresAtDay('TEST', bars, spy, day, 100)).toBeNull()
  })

  it('lastIndexAtOrBefore lands on the session, not the next one', () => {
    expect(lastIndexAtOrBefore(bars, Math.floor(bars[42].t / DAY_SEC))).toBe(42)
    expect(lastIndexAtOrBefore(bars, Math.floor(bars[0].t / DAY_SEC) - 1)).toBe(-1)
  })
})

describe('statistics helpers', () => {
  it('ranks ties by their average', () => {
    expect(rankAvgTies([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4])
  })

  it('spearman is +1 on a monotone pair and −1 reversed', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10)
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10)
  })

  it('deciles span 1..10 and put the biggest value on top', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const d = decilesOf(xs)
    expect(d[0]).toBe(1)
    expect(d[99]).toBe(10)
    expect(new Set(d).size).toBe(10)
  })

  it('tStat is zero for a zero-mean series', () => {
    expect(tStat([-1, 1, -1, 1])).toBeCloseTo(0, 10)
  })
})
