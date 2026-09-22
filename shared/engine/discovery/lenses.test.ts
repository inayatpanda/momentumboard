import { describe, expect, it } from 'vitest'
import { computeFeatures } from './features'
import { breakoutLens, climaxLens, dipLens, pullbackLens, rsLeaderLens, runLenses, unusualLens, weakLens } from './lenses'
import * as F from './synthetic.fixtures'
import type { Features } from './types'

const spy = F.spyFlat(300)
const feat = (candles: ReturnType<typeof F.tape>, over: Partial<Features> = {}): Features => ({ ...computeFeatures('TEST', candles, spy)!, ...over })
const flat = () => feat(F.tape(F.flatBars(140)))
/** Every reason has to carry the numbers that fired it. */
const hasNumber = (s: string) => expect(s).toMatch(/\d/)

describe('unusualLens', () => {
  const leader = F.percentiles({ unusual: 0.96 })
  it('fires on a session several times the name own typical day, with no side', () => {
    const hit = unusualLens(feat(F.shockTape(1)), leader)!
    expect(hit.lens).toBe('unusual')
    expect(hit.side).toBeNull()
    hasNumber(hit.reason)
    expect(hit.reason).toContain('up')
  })
  it('fires the same way on a fall — the side is composeCall to decide', () => {
    expect(unusualLens(feat(F.shockTape(-1)), leader)!.reason).toContain('down')
  })
  it('null on an ordinary session even at a high percentile', () => {
    expect(unusualLens(feat(F.tape(F.wiggleBars(140))), leader)).toBeNull()
  })
  it('null when the move is not extreme across the universe', () => {
    expect(unusualLens(feat(F.shockTape(1)), F.percentiles({ unusual: 0.5 }))).toBeNull()
  })
  // unusualRatio divides by max(typicalMove10/√10, 1) — so a name with a 0.3%
  // typical day is scored against 1%. Printing the RAW figure made the sentence
  // contradict its own multiple: "3× its typical 0.3% day" is not 3×, it is 9×.
  it('prints the typical day the ratio was actually divided by, floor included', () => {
    const hit = unusualLens(F.features({ ret1: 3, typicalMove10: 1 }), leader)!
    expect(hit.reason).toContain('3× its typical 1% day')
    expect(hit.reason).not.toContain('0.3% day')
    // …and above the floor the printed figure is the real one (6/√10 = 1.9).
    expect(unusualLens(F.features({ ret1: 6, typicalMove10: 6 }), leader)!.reason).toContain('typical 1.9% day')
  })

  it('score rises with the size of the move', () => {
    const small = unusualLens(F.features({ ret1: 6, typicalMove10: 6 }), leader)!
    const big = unusualLens(F.features({ ret1: 12, typicalMove10: 6 }), leader)!
    expect(big.score).toBeGreaterThan(small.score)
    expect(big.score).toBeLessThanOrEqual(1)
  })
})

describe('rsLeaderLens', () => {
  const top = F.percentiles({ rsSpy20: 0.95, rsSpy60: 0.95 })
  it('fires long on a steady runner under a rising 50-EMA', () => {
    const hit = rsLeaderLens(feat(F.trendTape()), top)!
    expect(hit.side).toBe('long')
    hasNumber(hit.reason)
  })
  it('null outside the top decile', () => {
    expect(rsLeaderLens(feat(F.trendTape()), F.percentiles({ rsSpy20: 0.85, rsSpy60: 0.95 }))).toBeNull()
  })
  it('null when already extended 2 ATR above the 21-EMA', () => {
    expect(rsLeaderLens(feat(F.trendTape(), { distEma21Atr: 2.4 }), top)).toBeNull()
  })
  it('null on a flat tape', () => expect(rsLeaderLens(flat(), top)).toBeNull())
  it('score falls as the name gets more extended', () => {
    const base = { close: 100, ema50: 95, ema50Slope20: 4 }
    const near = rsLeaderLens(F.features({ ...base, distEma21Atr: 0.2 }), top)!
    const far = rsLeaderLens(F.features({ ...base, distEma21Atr: 1.8 }), top)!
    expect(near.score).toBeGreaterThan(far.score)
  })
})

describe('pullbackLens', () => {
  const leader = F.percentiles({ rsSpy60: 0.92 })
  it('fires long when a leader comes back to the 21-EMA on fading volume', () => {
    const hit = pullbackLens(feat(F.pullbackTape()), leader)!
    expect(hit.side).toBe('long')
    hasNumber(hit.reason)
  })
  it('null while the leader is still running (volume not fading)', () => {
    expect(pullbackLens(feat(F.trendTape()), leader)).toBeNull()
  })
  it('null when the name is not a leader', () => {
    expect(pullbackLens(feat(F.pullbackTape()), F.percentiles({ rsSpy60: 0.5 }))).toBeNull()
  })
  it('null on a flat tape', () => expect(pullbackLens(flat(), leader)).toBeNull())
  it('score rises as the pullback gets quieter', () => {
    const base = { close: 100, ema50: 95, ema50Slope20: 4, distEma21Atr: -0.2 }
    const quiet = pullbackLens(F.features({ ...base, volTrend5: 0.5 }), leader)!
    const busy = pullbackLens(F.features({ ...base, volTrend5: 0.95 }), leader)!
    expect(quiet.score).toBeGreaterThan(busy.score)
  })
})

describe('breakoutLens', () => {
  const p = F.percentiles()
  it('fires long out of a coil on 2x+ volume', () => {
    const hit = breakoutLens(feat(F.breakoutTape()), p)!
    expect(hit.side).toBe('long')
    expect(hit.reason).toMatch(/volume/)
    hasNumber(hit.reason)
  })
  it('null without the volume', () => {
    expect(breakoutLens(feat(F.breakoutTape(), { rvol: 1.6 }), p)).toBeNull()
  })
  it('null when the base was not compressed', () => {
    expect(breakoutLens(feat(F.breakoutTape(), { bbWidthPctl120: 0.55 }), p)).toBeNull()
  })
  it('null when nothing broke', () => expect(breakoutLens(flat(), p)).toBeNull())
  it('score rises with volume', () => {
    const base = { broke20dHigh: true, bbWidthPctl120: 0.1 }
    const thin = breakoutLens(F.features({ ...base, rvol: 2 }), p)!
    const heavy = breakoutLens(F.features({ ...base, rvol: 5 }), p)!
    expect(heavy.score).toBeGreaterThan(thin.score)
  })
})

describe('dipLens', () => {
  it('fires long on a holding dip in a quality name', () => {
    const candles = F.dipTape()
    const hit = dipLens(feat(candles), F.member(), candles)!
    expect(hit.side).toBe('long')
    expect(hit.lens).toBe('dip')
    hasNumber(hit.reason)
  })
  it('null while the knife is still falling', () => {
    const candles = F.knifeTape()
    expect(dipLens(feat(candles), F.member(), candles)).toBeNull()
  })
  it('null on a small cap — the lane is for names worth catching', () => {
    const candles = F.dipTape()
    expect(dipLens(feat(candles), F.member({ capBand: 'small' }), candles)).toBeNull()
  })
  it('null without the tape', () => expect(dipLens(feat(F.dipTape()), F.member(), null)).toBeNull())
  it('score rises with the participation behind the turn', () => {
    const candles = F.dipTape()
    const quiet = dipLens(feat(candles, { rvol: 1 }), F.member(), candles)!
    const loud = dipLens(feat(candles, { rvol: 3 }), F.member(), candles)!
    expect(loud.score).toBeGreaterThan(quiet.score)
    expect(loud.score).toBeLessThanOrEqual(1)
  })
})

describe('weakLens', () => {
  const bottom = F.percentiles({ rsSpy20: 0.05, rsSpy60: 0.04 })
  it('fires short on a bottom-decile downtrend making lower highs', () => {
    const hit = weakLens(feat(F.weakTape()), bottom)!
    expect(hit.side).toBe('short')
    hasNumber(hit.reason)
  })
  it('null outside the bottom decile', () => {
    expect(weakLens(feat(F.weakTape()), F.percentiles({ rsSpy20: 0.2, rsSpy60: 0.04 }))).toBeNull()
  })
  it('null when the name is above its 50-EMA', () => {
    expect(weakLens(feat(F.trendTape()), bottom)).toBeNull()
  })
  it('null on a flat tape', () => expect(weakLens(flat(), bottom)).toBeNull())
  it('score rises as the 50-EMA falls faster', () => {
    const base = { close: 90, ema50: 100, lowerHighs: true, rsSpy20: -10, rsSpy60: -20 }
    const slow = weakLens(F.features({ ...base, ema50Slope20: -2 }), bottom)!
    const fast = weakLens(F.features({ ...base, ema50Slope20: -9 }), bottom)!
    expect(fast.score).toBeGreaterThan(slow.score)
  })
})

describe('climaxLens', () => {
  const p = F.percentiles()
  it('fires short on a stretched run with volume already fading', () => {
    const hit = climaxLens(feat(F.blowOffTape()), p)!
    expect(hit.side).toBe('short')
    hasNumber(hit.reason)
  })
  it('null when the run is not extended', () => {
    expect(climaxLens(feat(F.blowOffTape(), { distEma21Atr: 2.2 }), p)).toBeNull()
  })
  it('null while volume is still building', () => {
    expect(climaxLens(feat(F.blowOffTape(), { volTrend5: 1.3 }), p)).toBeNull()
  })
  it('null on a flat tape', () => expect(climaxLens(flat(), p)).toBeNull())
  it('score rises with the extension', () => {
    const base = { upDays5: 5, volTrend5: 0.6 }
    const near = climaxLens(F.features({ ...base, distEma21Atr: 3.2 }), p)!
    const far = climaxLens(F.features({ ...base, distEma21Atr: 5.5 }), p)!
    expect(far.score).toBeGreaterThan(near.score)
  })
})

describe('runLenses', () => {
  it('returns every reading, best score first', () => {
    const candles = F.blowOffTape()
    const hits = runLenses(feat(candles), F.percentiles({ unusual: 0.97 }), F.member(), candles)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1)
      hasNumber(h.reason)
    }
  })
  it('a flat tape at mid-field percentiles fires nothing', () => {
    const candles = F.tape(F.flatBars(140))
    expect(runLenses(feat(candles), F.percentiles(), F.member(), candles)).toEqual([])
  })
  it('without candles the dip lens cannot fire', () => {
    const candles = F.dipTape()
    const withTape = runLenses(feat(candles), F.percentiles(), F.member(), candles)
    const without = runLenses(feat(candles), F.percentiles(), F.member())
    expect(withTape.some(h => h.lens === 'dip')).toBe(true)
    expect(without.some(h => h.lens === 'dip')).toBe(false)
  })
})
