import { describe, expect, it } from 'vitest'
import { bbWidths, computeFeatures, emaSeries, selfPercentile } from './features'
import { emaLast, swingCapacity } from '../../indicators'
import * as F from './synthetic.fixtures'
import { HYGIENE, type Features } from './types'

const spy = F.spyFlat(300)
/** 60 flat sessions at 100, then whatever the test is about. */
const after = (...bars: F.Bar[]) => F.tape([...F.flatBars(60, 100), ...bars])

describe('emaSeries', () => {
  it('agrees with emaLast at the final index', () => {
    const closes = F.wiggleBars(80).map(b => b.c)
    for (const p of [8, 21, 50]) expect(emaSeries(closes, p)[closes.length - 1]).toBe(emaLast(closes, p))
  })
  it('is null until the period is filled', () => {
    const s = emaSeries([1, 2, 3, 4, 5], 3)
    expect(s.slice(0, 2)).toEqual([null, null])
    expect(s[2]).toBe(2)
  })
})

describe('computeFeatures', () => {
  it('returns null below the minimum bar count', () => {
    expect(computeFeatures('X', F.tape(F.flatBars(HYGIENE.minBars - 1)), spy)).toBeNull()
    expect(computeFeatures('X', F.tape(F.flatBars(HYGIENE.minBars)), spy)).not.toBeNull()
  })

  it('known answers: ret1/ret5/ret10 off a flat base', () => {
    const f = computeFeatures('X', after({ c: 110 }), spy)!
    expect(f.ret1).toBe(10)
    expect(f.ret5).toBe(10)
    expect(f.ret10).toBe(10)
    expect(f.close).toBe(110)
    expect(f.bars).toBe(61)
  })

  it('known answer: gapPct is the open against yesterday, not the close', () => {
    const f = computeFeatures('X', after({ c: 105, o: 90, h: 106, l: 89 }), spy)!
    expect(f.gapPct).toBe(-10)
    expect(f.ret1).toBe(5)
  })

  it('known answer: upDays5 / upDays10 count rising closes', () => {
    const f = computeFeatures('X', after({ c: 101 }, { c: 102 }, { c: 101 }, { c: 103 }, { c: 104 }), spy)!
    expect(f.upDays5).toBe(4)
    expect(f.upDays10).toBe(4)
  })

  it('known answer: broke20dHigh compares against the PRIOR 20 sessions', () => {
    expect(computeFeatures('X', after({ c: 101 }), spy)!.broke20dHigh).toBe(true)
    expect(computeFeatures('X', after({ c: 100 }), spy)!.broke20dHigh).toBe(false)
    expect(computeFeatures('X', after({ c: 99 }), spy)!.broke20dLow).toBe(true)
  })

  it('known answer: rvol is today against the prior 20 sessions median', () => {
    const f = computeFeatures('X', after({ c: 100, v: 3_000_000 }), spy)!
    expect(f.rvol).toBe(3)
  })

  it('ema stack and slope: a rising tape stacks 8 > 21 > 50 with a positive slope', () => {
    const f = computeFeatures('X', F.trendTape(), spy)!
    expect(f.ema8!).toBeGreaterThan(f.ema21!)
    expect(f.ema21!).toBeGreaterThan(f.ema50!)
    expect(f.ema50Slope20!).toBeGreaterThan(0)
    expect(computeFeatures('X', F.weakTape(), spy)!.ema50Slope20!).toBeLessThan(0)
  })

  it('typicalMove10 is swingCapacity of the closes, unchanged', () => {
    const t = F.tape(F.wiggleBars(140))
    expect(computeFeatures('X', t, spy)!.typicalMove10).toBe(swingCapacity(t.map(c => c.c)))
  })

  // Yahoo stamps a daily bar at the session's OPEN: 13:30Z for SPY, 07:00Z for a
  // London line. An exact-stamp match therefore never fired for a single one of
  // the seed's 350 UK names — every one fell through to the end-index fallback
  // and was measured against whatever SPY's last bar happened to be.
  it('rsSpy aligns SPY BY UTC DAY, so an LSE tape stamped at 07:00 still matches SPY at 13:30', () => {
    // SPY runs two sessions PAST the name and rises 2% in them, so reading off
    // the tail is worth −2pp and reading the matching DAY is worth 0.
    const spyBars = [...F.flatBars(120, 500), { c: 505 }, { c: 510 }]
    const spyUsHours = F.tape(spyBars, F.LAST_T + 2 * F.DAY + 13.5 * 3600)
    const londonOpen = F.tape(F.flatBars(80, 100), F.LAST_T + 7 * 3600)
    const f = computeFeatures('BP.L', londonOpen, spyUsHours)!
    expect(f.rsSpy20).toBe(0)
    expect(f.rsSpy60).toBe(0)
  })

  it('…and falls back to the tail only when no SPY bar shares the day at all', () => {
    // SPY stops a fortnight before the name's last bar: nothing to match, so the
    // end-index fallback is the only honest answer left.
    const spyOld = F.tape(F.flatBars(120, 500), F.LAST_T - 14 * F.DAY)
    const f = computeFeatures('X', F.tape(F.flatBars(80, 100)), spyOld)!
    expect(f.rsSpy20).toBe(0) // flat against flat, read off the tail
  })

  it('rsSpy aligns SPY BY TIMESTAMP, not by tail position', () => {
    // SPY trades two sessions past our name's last bar and rallies in them. Read
    // off the tail, rsSpy20 would be ~−2pp; read off the matching stamp it is 0.
    const spyBars = [...F.flatBars(120, 500), { c: 505 }, { c: 510 }]
    const spyLate = F.tape(spyBars, F.LAST_T + 2 * F.DAY)
    const f = computeFeatures('X', F.tape(F.flatBars(80, 100)), spyLate)!
    expect(f.rsSpy20).toBe(0)
    expect(f.rsSpy60).toBe(0)
  })

  it('falls back to tail alignment when no stamp lines up', () => {
    // Same bars, every stamp shifted by an hour: nothing matches, so the last
    // SPY bar is used and the rally shows up in the relative strength.
    const spyBars = [...F.flatBars(120, 500), { c: 505 }, { c: 510 }]
    const offset = F.tape(spyBars, F.LAST_T + 3600)
    const f = computeFeatures('X', F.tape(F.flatBars(80, 100)), offset)!
    expect(f.rsSpy20).toBeCloseTo(-2, 1)
  })

  it('no SPY at all leaves relative strength unknown rather than zero', () => {
    const f = computeFeatures('X', F.tape(F.flatBars(80, 100)), null)!
    expect(f.rsSpy20).toBeNull()
    expect(f.rsSpy60).toBeNull()
  })

  it('bbWidthPctl120 is 0–1 and reads a coil as compressed', () => {
    const coiled = computeFeatures('X', F.breakoutTape(), spy)!.bbWidthPctl120!
    expect(coiled).toBeGreaterThanOrEqual(0)
    expect(coiled).toBeLessThanOrEqual(0.3)
    expect(computeFeatures('X', F.dipTape(), spy)!.bbWidthPctl120!).toBeGreaterThan(0.5)
  })

  // TODAY IS NOT IN ITS OWN COMPARISON GROUP. Ranking today inside a window that
  // contains it floors the answer at 1/(2n) and caps it at 1 − 1/(2n): at n=120
  // the tightest base a name can print read 0.004 and the widest 0.996, so a
  // bandwidth score of exactly 0 was unreachable and the silence adjudication for
  // it (ZERO_IS_A_READING.bandwidth) described a state the arithmetic forbade.
  it('selfPercentile ranks today against the PRIOR readings, so 0 and 1 are both reachable', () => {
    expect(selfPercentile([5, 4, 3, 2, 1])).toBe(0) // strictly the tightest it has been
    expect(selfPercentile([1, 2, 3, 4, 5])).toBe(1) // strictly the widest
    expect(selfPercentile([1, 3, 2])).toBe(0.5) // one below, one above
    expect(selfPercentile([2, 2, 2])).toBe(0.5) // a plateau sits in the middle of itself
    expect(selfPercentile([1, 2])).toBe(1)
    expect(selfPercentile([7])).toBeNull() // no prior is not a comparison
    expect(selfPercentile([])).toBeNull()
  })

  it('…and a real tightest-in-120 tape therefore percentiles to exactly 0', () => {
    // A width series that narrows monotonically: today IS the tightest reading,
    // and the honest answer to "where does it sit in its own history" is the floor.
    const widths = Array.from({ length: 120 }, (_, i) => 1 - i * 0.001)
    expect(widths[widths.length - 1]).toBeLessThan(widths[0])
    expect(selfPercentile(widths)).toBe(0)
    // and bbWidths feeds exactly this shape of series
    expect(bbWidths([100, 101, 102]).length).toBe(0) // under one period: nothing to rank
  })

  it('lowerHighs compares the two most recent 10-session windows', () => {
    expect(computeFeatures('X', F.weakTape(), spy)!.lowerHighs).toBe(true)
    expect(computeFeatures('X', F.trendTape(), spy)!.lowerHighs).toBe(false)
  })

  it('volTrend5 is the last week against the prior month', () => {
    const t = F.tape([...F.flatBars(60, 100, 1_000_000), ...F.flatBars(5, 100, 500_000)])
    expect(computeFeatures('X', t, spy)!.volTrend5).toBe(0.5)
  })

  it('every number is finite and rounded to 4dp — never NaN, never Infinity', () => {
    const tapes = [F.trendTape(), F.pullbackTape(), F.breakoutTape(), F.dipTape(), F.knifeTape(), F.blowOffTape(), F.weakTape(), F.shockTape(1), F.tape(F.flatBars(140))]
    for (const t of tapes) {
      const f = computeFeatures('X', t, spy)!
      for (const [key, v] of Object.entries(f) as [keyof Features, unknown][]) {
        if (typeof v !== 'number') continue
        expect(Number.isFinite(v), `${key}`).toBe(true)
        if (key !== 'lastT') expect(Math.round(v * 10_000) / 10_000, `${key}`).toBe(v)
      }
    }
  })

  it('a zero-volume tape yields unknowns, not Infinity', () => {
    const f = computeFeatures('X', F.tape(F.flatBars(70, 100, 0)), spy)!
    expect(f.rvol).toBeNull()
    expect(f.dollarVol20).toBe(0)
    expect(f.volTrend5).toBeNull()
  })
})
