import { describe, expect, it } from 'vitest'
import {
  catalystFactor,
  channelsFactor,
  bandwidthFactor,
  BANDWIDTH_MIN_BARS,
  insiderFactor,
  momentumFactor,
  newsFactor,
  seasonalityFactor,
  sectorFactor,
  smartMoneyFactor,
  socialFactor,
  technicalFactor,
} from './factors'
import type { SeasonalitySummary } from '../seasonality'
import type { Stage } from '../technicals'
import type { Candle } from '../types'

/** v2 shape: neither of the two new legs is known. Every one of these numbers is
 *  the number the factor printed before the stack and the thrust existed — a
 *  chart the engine cannot read the timeframes on must score exactly as it did. */
const v2 = (stage: Stage, volumeConfirmed: boolean, rvol: number | null) => ({ stage, volumeConfirmed, rvol, emaStack: null, volThrust: null })

describe('technicalFactor', () => {
  it('scores early-reversal high and boosts volume confirmation', () => {
    expect(technicalFactor(v2('early-reversal', true, 2.1)).score).toBe(84) // 70 × 1.2
  })
  it('damps an UNCONFIRMED early reversal — a turn with no volume behind it is a guess', () => {
    const f = technicalFactor(v2('early-reversal', false, 0.8))
    expect(f.score).toBe(49) // 70 × 0.7
    expect(f.detail).toContain('unconfirmed')
    // other stages are NOT damped by missing volume
    expect(technicalFactor(v2('pullback', false, null)).score).toBe(55)
  })
  it('scores exhausted deeply negative and knife as wait (0)', () => {
    expect(technicalFactor(v2('exhausted', false, null)).score).toBe(-70)
    expect(technicalFactor(v2('falling-knife', true, 3)).score).toBe(0)
  })
  it('null read → null score', () => {
    expect(technicalFactor(null).score).toBeNull()
  })
  it('unknown legs leave the v2 score untouched, stage by stage', () => {
    // the whole enum, so the widening can never silently move a single stage
    const stages: Stage[] = ['early-reversal', 'pullback', 'basing', 'trending', 'weak', 'extended', 'exhausted', 'falling-knife']
    const v2Scores = [49, 55, 25, 15, -30, -45, -70, 0] // early-reversal is 70 × 0.7 — unconfirmed here
    stages.forEach((stage, i) => {
      expect(technicalFactor(v2(stage, false, null)).score).toBe(v2Scores[i])
      // a stack object whose verdict is unknown is still an absence of evidence
      expect(technicalFactor({ ...v2(stage, false, null), emaStack: { aligned: null } }).score).toBe(v2Scores[i])
    })
  })
})

// The stage says where the chart is; the stack says whether every horizon agrees
// about it, and the thrust says whether the crowd has been arriving all week.
// Both are read AFTER the stage and BEFORE the long-only volume amplifier —
// see the pipeline docblock on technicalFactor.
describe('technicalFactor v3 — the EMA stack bonus', () => {
  const read = (stage: Stage, aligned: 'bull' | 'bear' | 'mixed' | null) => technicalFactor({ stage, volumeConfirmed: false, rvol: null, emaStack: { aligned }, volThrust: null })

  it('an aligned bull stack adds 15, an aligned bear stack subtracts 15', () => {
    expect(read('pullback', 'bull').score).toBe(70) // 55 + 15
    expect(read('pullback', 'bear').score).toBe(40) // 55 − 15
    expect(read('weak', 'bear').score).toBe(-45) // −30 − 15: agreement DEEPENS a short
    expect(read('weak', 'bull').score).toBe(-15) // …and disagreement lifts it toward no-edge
  })

  it('mixed and unknown are both worth nothing — disorder is not a vote, and neither is an absence', () => {
    expect(read('pullback', 'mixed').score).toBe(55)
    expect(read('pullback', null).score).toBe(55)
  })

  it('the bonus is applied AFTER the unconfirmed-turn damp — the volume of one session cannot discount fifty', () => {
    // 70 × 0.7 = 49, then +15 = 64. Damping the bonus too would give 59.5, i.e.
    // today's quiet tape shrinking a statement about the last fifty sessions.
    expect(technicalFactor({ stage: 'early-reversal', volumeConfirmed: false, rvol: 0.8, emaStack: { aligned: 'bull' }, volThrust: null }).score).toBe(64)
  })

  it('a bull stack under a bearish stage can neutralise it, and 0 is not amplified into anything', () => {
    const f = technicalFactor({ stage: 'trending', volumeConfirmed: true, rvol: 2, emaStack: { aligned: 'bear' }, volThrust: 3 })
    expect(f.score).toBe(0) // 15 − 15: the chart says up, every horizon says down → no edge
  })
})

describe('technicalFactor v3 — the volume thrust modifier', () => {
  const read = (stage: Stage, volThrust: number | null) => technicalFactor({ stage, volumeConfirmed: false, rvol: null, emaStack: null, volThrust })

  it('scales conviction in BOTH directions — thrust is participation, not a side', () => {
    // 55 × 1.15 is 63.2499…93 in doubles, not 63.25 — round1 works on the real
    // product, so the printed number is 63.2. Pinned as it actually computes.
    expect(read('pullback', 2).score).toBe(63.2)
    expect(read('exhausted', 2).score).toBe(-80.5) // −70 × 1.15: a short gets deeper, not weaker
    expect(read('pullback', 0.4).score).toBe(46.8) // 55 × 0.85 = 46.75 → 46.8
    expect(read('exhausted', 0.4).score).toBe(-59.5) // −70 × 0.85
  })

  it('the boundaries are inclusive, and the middle does nothing', () => {
    expect(read('pullback', 1.5).score).toBe(63.2)
    expect(read('pullback', 0.6).score).toBe(46.8)
    expect(read('pullback', 1.49).score).toBe(55)
    expect(read('pullback', 0.61).score).toBe(55)
    expect(read('pullback', 1).score).toBe(55)
    expect(read('pullback', null).score).toBe(55)
  })

  it('cannot conjure a score out of nothing — a knife is 0 however loud the week', () => {
    expect(read('falling-knife', 3).score).toBe(0)
    expect(read('falling-knife', 0.1).score).toBe(0)
  })
})

describe('technicalFactor v3 — the whole pipeline', () => {
  it('stacks stage → damp → stack → thrust → long-only amplify, and clamps at 100', () => {
    // 70 (early-reversal) + 15 (bull) = 85 → ×1.15 (thrust) = 97.75 → ×1.2
    // (confirmed long) = 117.3 → clamped. The clamp is now REACHABLE; under v2
    // the ceiling was 84.
    expect(technicalFactor({ stage: 'early-reversal', volumeConfirmed: true, rvol: 2.1, emaStack: { aligned: 'bull' }, volThrust: 2.2 }).score).toBe(100)
    // 55 + 15 = 70 → ×1.2 = 84
    expect(technicalFactor({ stage: 'pullback', volumeConfirmed: true, rvol: 1.4, emaStack: { aligned: 'bull' }, volThrust: null }).score).toBe(84)
    // and the floor: −70 − 15 = −85 → ×1.15 = −97.7499…9 in doubles, still inside the clamp
    expect(technicalFactor({ stage: 'exhausted', volumeConfirmed: false, rvol: null, emaStack: { aligned: 'bear' }, volThrust: 1.8 }).score).toBe(-97.7)
  })

  it('the amplifier stays long-only even when the stack has flipped the sign', () => {
    // trending +15 with a bear stack = 0; weak −30 with a bull stack = −15 — a
    // negative score never gets the ×1.2, whatever built it.
    const short = (volumeConfirmed: boolean) => technicalFactor({ stage: 'weak', volumeConfirmed, rvol: volumeConfirmed ? 1.8 : null, emaStack: { aligned: 'bull' }, volThrust: null }).score
    expect(short(true)).toBe(short(false))
    expect(short(true)).toBe(-15)
  })

  it('names the stack and the thrust in plain words — no field names reach the reader', () => {
    const bull = technicalFactor({ stage: 'pullback', volumeConfirmed: true, rvol: 1.9, emaStack: { aligned: 'bull' }, volThrust: 2 })
    expect(bull.detail).toContain('every timeframe pointing up')
    expect(bull.detail).toContain('a week of building participation')
    expect(bull.detail).toContain('RVOL 1.9')
    expect(bull.detail).not.toMatch(/emaStack|volThrust|aligned|ema\d/i)
    const bear = technicalFactor({ stage: 'weak', volumeConfirmed: false, rvol: null, emaStack: { aligned: 'bear' }, volThrust: 0.3 })
    expect(bear.detail).toContain('every timeframe pointing down')
    expect(bear.detail).toContain('a week of thinning participation')
    const mixed = technicalFactor({ stage: 'basing', volumeConfirmed: false, rvol: null, emaStack: { aligned: 'mixed' }, volThrust: 1 })
    expect(mixed.detail).toContain('timeframes disagree')
    // an unknown stack says NOTHING — silence, not a claim of disorder
    const quiet = technicalFactor(v2('basing', false, null))
    expect(quiet.detail).toBe('basing')
  })
})

describe('momentumFactor', () => {
  const flat = Array.from({ length: 30 }, () => 100)
  it('scores 21d relative strength vs SPY, ×4', () => {
    const up = Array.from({ length: 30 }, (_, i) => (i >= 8 ? 100 * (1 + (0.1 * (i - 8)) / 21) : 100)) // +10% over last 21
    const { score } = momentumFactor(up, flat)
    expect(score).toBeCloseTo(40, 0)
  })
  it('clamps at ±80 and passes null through', () => {
    const rocket = Array.from({ length: 30 }, (_, i) => (i >= 8 ? 100 * (1 + (0.3 * (i - 8)) / 21) : 100))
    expect(momentumFactor(rocket, flat).score).toBe(80)
    expect(momentumFactor(null, flat).score).toBeNull()
    expect(momentumFactor(flat.slice(0, 10), flat).score).toBeNull()
  })
})

describe('momentumFactor — the 60-session leg and the RS-leader flag', () => {
  const spy = Array.from({ length: 200 }, () => 100)
  /** A clean linear leader: `drift` per bar off a flat SPY, no noise, so every leg
   * of the gate is arithmetic rather than luck. */
  const ramp = (drift: number, n = 200) => Array.from({ length: n }, (_, i) => 100 * (1 + drift * i))
  const candlesOf = (closes: number[]): Candle[] =>
    closes.map((c, i) => ({ t: 1_700_000_000 + i * 86_400, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }))

  it('a tape too short for 60 sessions scores EXACTLY what it always did — one leg, one sentence', () => {
    const short = ramp(0.005, 40)
    const f = momentumFactor(short, spy.slice(0, 40), candlesOf(short))
    expect(f.detail).toMatch(/^21d RS vs SPY \+\d/)
    expect(f.detail).not.toContain('60d')
    // the pin: the 21-session leg is still rs × 4 and nothing else
    const rs = ((short[39] - short[18]) / short[18]) * 100
    expect(f.score).toBeCloseTo(Math.round(rs * 4 * 10) / 10, 1)
  })

  it('adds the 60-session leg at 0.35 pt/pp — a quarter of the short leg at equal drift', () => {
    const xs = ramp(0.005)
    const f = momentumFactor(xs, spy, candlesOf(xs))
    const rs21 = ((xs[199] - xs[178]) / xs[178]) * 100
    const rs60 = ((xs[199] - xs[139]) / xs[139]) * 100
    expect(f.score).toBeCloseTo(Math.round((rs21 * 4 + rs60 * 0.35) * 10) / 10, 1)
    expect(f.detail).toContain('60d +')
  })

  it('flags an RS leader: ahead on both windows, above a rising 50-EMA, not extended', () => {
    const xs = ramp(0.005)
    expect(momentumFactor(xs, spy, candlesOf(xs)).detail).toContain('RS leader')
  })

  it('…and refuses the flag on every leg it fails', () => {
    // ahead on 21 sessions but not 60 — a one-month wonder, which is exactly what
    // the long window is here to tell apart from a leader
    const lateRun = Array.from({ length: 200 }, (_, i) => (i < 179 ? 100 : 100 * (1 + 0.004 * (i - 179))))
    expect(momentumFactor(lateRun, spy, candlesOf(lateRun)).detail).not.toContain('RS leader')
    // a leader you would have to CHASE: today gaps 10% clear of the 21-EMA, well
    // past 2 ATR, which is a climax setup wearing a leader's clothes
    const ext = ramp(0.006).map((c, i) => (i === 199 ? c * 1.1 : c))
    expect(momentumFactor(ext, spy, candlesOf(ext)).detail).not.toContain('RS leader')
    expect(momentumFactor(ext, spy, candlesOf(ext)).score).toBeGreaterThan(0) // the SCORE is untouched
    // and a leg it cannot MEASURE is a refusal, never a pass: no candles, no ATR,
    // no extension read
    expect(momentumFactor(ramp(0.005), spy).detail).not.toContain('RS leader')
    // a laggard is never a leader, however the rest of the gate reads
    const down = ramp(-0.002)
    expect(momentumFactor(down, spy, candlesOf(down)).detail).not.toContain('RS leader')
  })

  it('the flag pays NOTHING — leadership buys attention in discovery, not conviction here', () => {
    const xs = ramp(0.005)
    const withFlag = momentumFactor(xs, spy, candlesOf(xs))
    const withoutTheExtensionRead = momentumFactor(xs, spy) // same tape, no candles → no flag
    expect(withFlag.detail).toContain('RS leader')
    expect(withoutTheExtensionRead.detail).not.toContain('RS leader')
    expect(withFlag.score).toBe(withoutTheExtensionRead.score)
  })
})

/** THE BANDWIDTH FACTOR (2026-09-22 walk-forward study, direction adjudicated for
 * the study's decile table on the same day). Wide bands score high and the trend
 * says which way, so every case below is a pair: where the bands sit inside the
 * name's own 120 sessions, and what the chart is doing. */
describe('bandwidthFactor', () => {
  /** 200 closes drifting at `drift`, oscillating ±0.05 for all but the last 30
   * bars and ±6 after that: a chart whose bands have BLOWN OUT, whichever way it
   * is travelling. Flip the amplitudes and the same tape has coiled instead. */
  const widened = (drift: number, n = 200) => Array.from({ length: n }, (_, i) => 100 * (1 + drift * i) + (i < n - 30 ? 0.05 : 6) * Math.sin(i))
  const coiled = (drift: number, n = 200) => Array.from({ length: n }, (_, i) => 100 * (1 + drift * i) + (i < n - 30 ? 6 : 0.05) * Math.sin(i))

  it('wide bands in an uptrend are a LONG, near the full ±50', () => {
    const f = bandwidthFactor(widened(0.004))
    expect(f.score).toBeGreaterThan(40)
    expect(f.detail).toContain('of its own 120 sessions')
    expect(f.detail).toContain('signed by a 50-EMA rising')
  })

  it('…and the identical width in a downtrend is a SHORT — the bands have no side of their own', () => {
    const f = bandwidthFactor(widened(-0.002))
    expect(f.score).toBeLessThan(-40)
    expect(f.detail).toContain('signed by a 50-EMA falling')
  })

  it('a COILED base scores ~0 either way — the study\'s weak end, not its strong one', () => {
    expect(Math.abs(bandwidthFactor(coiled(0.004)).score!)).toBeLessThan(5)
    expect(Math.abs(bandwidthFactor(coiled(-0.002)).score!)).toBeLessThan(5)
    expect(bandwidthFactor(coiled(0.004)).score).toBeGreaterThanOrEqual(0) // …and it still carries the sign
    expect(bandwidthFactor(coiled(-0.002)).score).toBeLessThanOrEqual(0)
  })

  it('is monotone in the width — wider bands always score more of the same sign', () => {
    // one tape family, one knob: 170 bars oscillating ±3, then thirty bars at
    // amplitude `a`. The percentile is a reading of today's width against the
    // name's OWN last 120, so `a` walks it from the bottom of that distribution to
    // the top — 0.05 → p0, 3 → p23, 9 → p97 — and the score walks with it.
    const at = (a: number) => bandwidthFactor(Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.004 * i) + (i < 170 ? 3 : a) * Math.sin(i))).score!
    expect(at(9)).toBeGreaterThan(at(6))
    expect(at(6)).toBeGreaterThan(at(3))
    expect(at(3)).toBeGreaterThan(at(1))
    expect(at(1)).toBeGreaterThan(at(0.05))
  })

  it('a tape under 140 closes is NULL — the percentile needs 20 bars for a width and 120 widths to rank it', () => {
    expect(bandwidthFactor(widened(0.004, BANDWIDTH_MIN_BARS - 1)).score).toBeNull()
    expect(bandwidthFactor(widened(0.004, BANDWIDTH_MIN_BARS - 1)).detail).toContain('insufficient history')
    expect(bandwidthFactor(widened(0.004, BANDWIDTH_MIN_BARS)).score).not.toBeNull()
    expect(bandwidthFactor(null).score).toBeNull()
  })

  it('falls back to the 20-session return when the 50-EMA is FLAT, and says which it used', () => {
    // wide for 110 bars, then dead level, then one 1% session: the 50-EMA has moved
    // 0.035% in twenty sessions (flat) while the 20-session return is a clean +1%.
    const settled = (last: number) => Array.from({ length: 200 }, (_, i) => (i < 110 ? 100 + 3 * Math.sin(i) : i === 199 ? last : 100))
    const up = bandwidthFactor(settled(101))
    expect(up.score).toBeGreaterThan(0)
    expect(up.detail).toContain('signed by a 20-session return of +1%')
    expect(bandwidthFactor(settled(99)).score).toBeLessThan(0)
  })

  it('a chart going NOWHERE is null, not a zero — there is no direction to lend it', () => {
    const f = bandwidthFactor(Array.from({ length: 200 }, () => 100))
    expect(f.score).toBeNull()
    expect(f.detail).toContain('nothing to sign it with')
  })
})

describe('sectorFactor', () => {
  it('maps rank percentile to ±40', () => {
    expect(sectorFactor(1).score).toBe(40)
    expect(sectorFactor(0).score).toBe(-40)
    expect(sectorFactor(0.5).score).toBe(0)
    expect(sectorFactor(null).score).toBeNull()
  })
})

describe('socialFactor', () => {
  it('caps at 60 and halves when RSI > 70 (crowded and hot)', () => {
    const row = { redditRank: 1, surgeMultiple: 3, sources: 2 }
    expect(socialFactor(row, 55).score).toBe(60) // 20+24+20=64 → cap 60
    expect(socialFactor(row, 75).score).toBe(30)
    expect(socialFactor(null, 50).score).toBeNull()
  })
})

describe('channelsFactor', () => {
  it('weights stances by channel credibility', () => {
    const cred = (ch: string) => (ch === 'Stocks with Josh' ? 0.9 : 0.3)
    const { score } = channelsFactor(
      [
        { channel: 'Stocks with Josh', stance: 'bull' },
        { channel: 'RandomChannel', stance: 'bear' },
      ],
      cred,
    )
    // (+1×1.8 − 1×0.6) × 18 = 21.6 — the credible bull outweighs the weak bear
    expect(score).toBeCloseTo(21.6, 1)
  })
  it('neutral-only → null', () => {
    expect(channelsFactor([{ channel: 'X', stance: 'neutral' }], () => 0.5).score).toBeNull()
  })
})

describe('insiderFactor', () => {
  it('cluster 45, single buy 20, none 0, unchecked null', () => {
    expect(insiderFactor({ isCluster: true, buyers: ['a', 'b'] }).score).toBe(45)
    expect(insiderFactor({ isCluster: false, buyers: ['a'] }).score).toBe(20)
    expect(insiderFactor(null).score).toBe(0)
    expect(insiderFactor(undefined).score).toBeNull()
  })
})

describe('smartMoneyFactor', () => {
  it('scores a tracked-fund buy +25, an exit −20, and notes the 13F staleness', () => {
    const buy = smartMoneyFactor({ bought: ['Berkshire Hathaway'], exited: [], filedAt: '2026-05-15' })
    expect(buy.score).toBe(25)
    expect(buy.detail).toContain('Berkshire Hathaway')
    expect(buy.detail).toContain('2026-05-15')
    expect(buy.detail).toContain('45d lag')
    expect(smartMoneyFactor({ bought: [], exited: ['Scion Asset Management'], filedAt: '2026-05-15' }).score).toBe(-20)
  })
  it('clamps at ±30 across multiple funds; a mixed signal nets out', () => {
    expect(smartMoneyFactor({ bought: ['A', 'B'], exited: [], filedAt: '2026-05-15' }).score).toBe(30) // 50 → 30
    expect(smartMoneyFactor({ bought: [], exited: ['A', 'B'], filedAt: '2026-05-15' }).score).toBe(-30)
    expect(smartMoneyFactor({ bought: ['A'], exited: ['B'], filedAt: '2026-05-15' }).score).toBe(5) // 25 − 20
  })
  it('no confident match → null (renormalises away, never a fake 0)', () => {
    expect(smartMoneyFactor(null).score).toBeNull()
    expect(smartMoneyFactor({ bought: [], exited: [], filedAt: '' }).score).toBeNull()
  })
})

describe('newsFactor', () => {
  it('reads polarity from headlines', () => {
    expect(newsFactor(['Nvidia beats estimates, shares surge']).score).toBe(40) // net +2, hits 2
    expect(newsFactor(['DOJ probe widens, lawsuit filed']).score).toBe(-40)
    expect(newsFactor([]).score).toBe(0)
  })

  /** THE ZERO HAS TWO CAUSES, and the learning loop must be able to tell them
   * apart [stage 3c task 2 fix wave]. `ZERO_IS_A_READING.news` is true for the
   * QUIET TAPE — its own deliberate branch, and the reason the flag exists — but
   * the same 0 also comes out of a polarity TIE on a loud tape, which is the
   * arithmetic cancellation the zero table calls a SILENCE everywhere else
   * (channels, smartMoney). The score is identical either way; the flag is the
   * only thing that separates them, and it is set at the factor because the
   * factor is the only place that still knows which happened. */
  it('a polarity TIE on a loud tape is a silence — same 0, flagged', () => {
    const tie = newsFactor(['Nvidia beats estimates', 'Nvidia misses guidance']) // +1 then −1, hits 2
    expect(tie.score).toBe(0)
    expect(tie.silence).toBe(true)
    expect(tie.detail).toBe('2 headline(s), polarity +0')
  })

  it('the quiet tape keeps its zero UNFLAGGED — it is the reading the table admits', () => {
    const quiet = newsFactor([])
    expect(quiet.score).toBe(0)
    expect(quiet.silence).toBeUndefined()
  })

  it('headlines that score NOTHING are a reading too — nobody wrote a polarity word, which is the quiet tape by another route', () => {
    const nothing = newsFactor(['Company files routine 8-K'])
    expect(nothing.score).toBe(0)
    expect(nothing.silence).toBeUndefined() // hits 0 — no votes to cancel
  })

  it('a scored read never carries the flag, either way', () => {
    expect(newsFactor(['Nvidia beats estimates, shares surge']).silence).toBeUndefined()
    expect(newsFactor(['DOJ probe widens, lawsuit filed']).silence).toBeUndefined()
  })

  it('the flag changes NO score — every headline set reads exactly what it read before', () => {
    const pins: [string[], number][] = [
      [[], 0],
      [['Nvidia beats estimates, shares surge'], 40],
      [['DOJ probe widens, lawsuit filed'], -40],
      [['Nvidia beats estimates', 'Nvidia misses guidance'], 0],
      [['Company files routine 8-K'], 0],
      [['Nvidia beats estimates and tops guidance', 'Rival plunges'], 30], // net +1, hits 3
    ]
    for (const [headlines, score] of pins) expect(newsFactor(headlines).score).toBe(score)
  })
})

describe('seasonalityFactor', () => {
  const summary = (reliable: boolean, avgPct: number): SeasonalitySummary => ({
    dow: [],
    months: [{ month: 7, name: 'Jul', n: 4, winRate: 0.75, avgPct }],
    bestMonth: null,
    worstMonth: null,
    strongestDay: null,
    weakestDay: null,
    reliable,
  })
  it('null below the reliability gate; clamps at ±15', () => {
    expect(seasonalityFactor(summary(false, 5), 7).score).toBeNull()
    expect(seasonalityFactor(summary(true, 5), 7).score).toBe(15) // 20 clamped
    expect(seasonalityFactor(summary(true, -1.2), 7).score).toBeCloseTo(-4.8, 1)
    expect(seasonalityFactor(summary(true, 2), 3).score).toBeNull() // no read for March
    expect(seasonalityFactor(null, 7).score).toBeNull()
  })
})

describe('catalystFactor', () => {
  it('no catalyst → null (renormalises away)', () => {
    expect(catalystFactor(null).score).toBeNull()
    expect(catalystFactor(undefined).score).toBeNull()
  })
  it('no clean side → null vote but flags "in play" (the gate relaxation keys off presence, not this)', () => {
    const f = catalystFactor({ kind: 'news', side: null, reason: 'sector in focus', strength: 60 })
    expect(f.score).toBeNull()
    expect(f.detail).toContain('in play')
  })
  it('sided vote: long positive, short negative, strength-scaled and capped ±90', () => {
    expect(catalystFactor({ kind: 'news', side: 'long', reason: 'oil spike', strength: 80 }).score).toBeCloseTo(72, 1) // 80×0.9
    expect(catalystFactor({ kind: 'news', side: 'short', reason: 'sanctioned', strength: 50 }).score).toBeCloseTo(-45, 1)
    expect(catalystFactor({ kind: 'event', side: 'long', reason: 'x', strength: 200 }).score).toBe(90) // clamped
    expect(catalystFactor({ kind: 'news', side: 'long', reason: 'x', strength: 80 }).detail).toContain('news')
  })
})

// Measured over 96 live shorts (2026-07-28): weakness WITHOUT volume confirmation
// hit 65.3% for +4.31% average excess; weakness WITH it hit 47.6% for -1.97%.
// The x1.2 boost was raising conviction on the worse group. Heavy volume into
// weakness is usually capitulation — a bounce setup — not continuation, so the
// confirmation boost is long-only. Bearish stages keep their base score.
describe('volume confirmation is a LONG-side amplifier', () => {
  const read = (stage: Stage, vol: boolean) => technicalFactor({ stage, volumeConfirmed: vol, rvol: vol ? 1.8 : null, emaStack: null, volThrust: null })

  it('still boosts a confirmed bullish stage', () => {
    expect(read('pullback', true).score!).toBeGreaterThan(read('pullback', false).score!)
  })

  it('does NOT deepen a bearish stage on volume', () => {
    expect(read('weak', true).score).toBe(read('weak', false).score)
    expect(read('exhausted', true).score).toBe(read('exhausted', false).score)
  })

  it('still reports the volume it saw, so the reader is not misled', () => {
    expect(read('weak', true).detail).toContain('RVOL')
  })
})
