import { describe, expect, it } from 'vitest'
import {
  EARNINGS_FADE_MAX_PER_RUN,
  GAP_TRIGGER_PCT,
  MAX_REACTION_AGE,
  MIN_CANDLES,
  STOP_ATR_MULT,
  TARGET_GAP_MULT,
  classifyEarningsFade,
  earningsFadeCall,
  earningsFadeDisabled,
  reactionOffset,
  type EarningsFadeEvent,
} from './earningsFadeLane'
import { atr } from '../indicators'
import { bannedTokensIn } from './voice'
import type { Candle } from '../types'

// A flat tape with one gap bar bolted on. Flat is deliberate: the lane reads an
// OPEN against the PRIOR CLOSE and nothing else, so any drift in the base would
// only make the fixtures harder to reason about.
const T0 = Date.parse('2025-06-02T00:00:00Z') / 1000
const dateOf = (c: Candle) => new Date(c.t * 1000).toISOString().slice(0, 10)

const flat = (days = 200, price = 100): Candle[] =>
  Array.from({ length: days }, (_, i) => ({ t: T0 + i * 86_400, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000 }))

/** Append a bar that OPENS `gapPct` above the prior close and closes
 * `closeVsOpen`× that open (1 = an inside-day close right at the open). */
const gapBar = (bars: Candle[], gapPct: number, closeVsOpen = 1.0) => {
  const prev = bars[bars.length - 1]
  const o = prev.c * (1 + gapPct / 100)
  const c = o * closeVsOpen
  bars.push({ t: prev.t + 86_400, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 3_000_000 })
  return bars
}

/** A quiet bar that neither gaps nor moves — used to age a reaction. */
const quietBar = (bars: Candle[]) => {
  const prev = bars[bars.length - 1]
  bars.push({ t: prev.t + 86_400, o: prev.c, h: prev.c * 1.005, l: prev.c * 0.995, c: prev.c, v: 1_000_000 })
  return bars
}

const beat = (date: string, time: EarningsFadeEvent['time'] = 'post', surprisePct: number | null = 12.4): EarningsFadeEvent => ({
  date,
  time,
  surprisePct,
})

describe('which bar carries the reaction', () => {
  it('pre-market prints on the print day itself; after-hours and unknown wait a session', () => {
    expect(reactionOffset('pre')).toBe(0)
    expect(reactionOffset('post')).toBe(1)
    // `unknown` is what a row read purely as history looks like (Nasdaq supplies
    // `time` only for future dates). Falling to the after-hours reading is the
    // conservative one: it waits rather than claiming a gap the print could not
    // yet have caused.
    expect(reactionOffset('unknown')).toBe(1)
  })
})

describe('classifyEarningsFade — the positive read', () => {
  it('an after-hours beat whose NEXT open gapped 6% is a fade read', () => {
    const bars = gapBar(flat(), 6)
    const printDay = dateOf(bars[bars.length - 2]) // the session the company reported after
    const read = classifyEarningsFade(bars, beat(printDay, 'post'))!
    expect(read).not.toBeNull()
    expect(read.gapPct).toBe(6)
    expect(read.surprisePct).toBe(12.4)
    expect(read.reactionAgo).toBe(0) // the latest bar
    expect(read.reactionDate).toBe(dateOf(bars[bars.length - 1]))
    expect(read.timing).toBe('post')
    expect(read.reactionHigh).toBeCloseTo(bars[bars.length - 1].h, 1)
    expect(read.detail).toContain('gapped +6')
  })

  it('a PRE-MARKET beat gaps on the print day itself — one bar earlier', () => {
    const bars = gapBar(flat(), 6)
    const gapDay = dateOf(bars[bars.length - 1])
    // Same tape, same gap; the ONLY change is which session the calendar says the
    // print landed in, and it has to move the reaction bar by exactly one.
    expect(classifyEarningsFade(bars, beat(gapDay, 'pre'))!.gapPct).toBe(6)
    // …and reading that same date as after-hours finds no closed reaction bar yet
    expect(classifyEarningsFade(bars, beat(gapDay, 'post'))).toBeNull()
  })

  it('an unknown session timing reads as after-hours and says so', () => {
    const bars = gapBar(flat(), 6)
    const printDay = dateOf(bars[bars.length - 2])
    const read = classifyEarningsFade(bars, beat(printDay, 'unknown'))!
    expect(read.gapPct).toBe(6)
    expect(read.timing).toBe('unknown')
    expect(read.detail).toContain('session timing unknown')
  })

  it('a reaction one or two sessions old is still this trade; three is not', () => {
    const one = quietBar(gapBar(flat(), 6))
    const printOne = dateOf(one[one.length - 3])
    expect(classifyEarningsFade(one, beat(printOne, 'post'))!.reactionAgo).toBe(1)

    const two = quietBar(quietBar(gapBar(flat(), 6)))
    const printTwo = dateOf(two[two.length - 4])
    expect(classifyEarningsFade(two, beat(printTwo, 'post'))!.reactionAgo).toBe(MAX_REACTION_AGE)

    const three = quietBar(quietBar(quietBar(gapBar(flat(), 6))))
    const printThree = dateOf(three[three.length - 5])
    expect(classifyEarningsFade(three, beat(printThree, 'post'))).toBeNull()
  })
})

describe('classifyEarningsFade — every refusal', () => {
  const bars = gapBar(flat(), 6)
  const printDay = dateOf(bars[bars.length - 2])

  it('refuses a print that was not a BEAT — and a missing surprise is not a zero', () => {
    expect(classifyEarningsFade(bars, beat(printDay, 'post', null))).toBeNull()
    expect(classifyEarningsFade(bars, beat(printDay, 'post', 0))).toBeNull() // ties fail, exactly as the study filtered
    expect(classifyEarningsFade(bars, beat(printDay, 'post', -8))).toBeNull()
    expect(classifyEarningsFade(bars, beat(printDay, 'post', Number.NaN))).toBeNull()
  })

  it('refuses a gap the market did not pay up for', () => {
    const shallow = gapBar(flat(), GAP_TRIGGER_PCT - 0.5)
    expect(classifyEarningsFade(shallow, beat(dateOf(shallow[shallow.length - 2]), 'post'))).toBeNull()
    // …and takes one exactly ON the trigger
    const exact = gapBar(flat(), GAP_TRIGGER_PCT)
    expect(classifyEarningsFade(exact, beat(dateOf(exact[exact.length - 2]), 'post'))!.gapPct).toBe(GAP_TRIGGER_PCT)
    // a gap DOWN on a beat is not this cohort either
    const down = gapBar(flat(), -6)
    expect(classifyEarningsFade(down, beat(dateOf(down[down.length - 2]), 'post'))).toBeNull()
  })

  it('refuses a print the tape never covered, and a tape too short to read', () => {
    expect(classifyEarningsFade(bars, beat('1999-01-04', 'post'))).toBeNull()
    expect(classifyEarningsFade(bars, beat('2099-01-04', 'post'))).toBeNull()
    expect(classifyEarningsFade(gapBar(flat(MIN_CANDLES - 4), 6), beat(printDay, 'post'))).toBeNull()
    expect(classifyEarningsFade(bars, { date: '', time: 'post', surprisePct: 12 })).toBeNull()
  })
})

describe('earningsFadeCall — the levels', () => {
  const bars = gapBar(flat(), 6, 0.99) // closes just under the open, so entry < the bar's high
  const read = classifyEarningsFade(bars, beat(dateOf(bars[bars.length - 2]), 'post'))!
  const call = earningsFadeCall('ZZA', bars, read, 40_000)!

  it('is a SHORT with a negative composite inside the calibrated bands', () => {
    expect(call.side).toBe('short')
    expect(call.composite).toBeLessThan(0)
    expect(Math.abs(call.composite)).toBeGreaterThanOrEqual(25)
    expect(Math.abs(call.composite)).toBeLessThanOrEqual(55)
    expect(call.setup).toBe('fade') // already in the SetupFamily union — shorts into strength
    expect(call.stage).toBe('extended')
    expect(call.smallCap).toBe(false)
    expect(call.earningsRisk).toBe(false) // the calendar is applied at integration, never here
  })

  it('hides the stop above the reaction bar high plus half an ATR', () => {
    const series = atr(bars)
    const atrNow = series[series.length - 1]!
    expect(call.stop).toBeCloseTo(Math.round((read.reactionHigh + STOP_ATR_MULT * atrNow) * 100) / 100, 2)
    expect(call.stop).toBeGreaterThan(call.entry) // a short's stop is ABOVE it
    expect(call.stop).toBeGreaterThan(read.reactionHigh) // …and above the level that falsifies the read
  })

  it('targets twice the gap back, and says so in the expected move', () => {
    expect(call.target).toBeCloseTo(Math.round(call.entry * (1 - (TARGET_GAP_MULT * read.gapPct) / 100) * 100) / 100, 2)
    expect(call.target).toBeLessThan(call.entry)
    expect(call.expectedMovePct).toBeCloseTo(TARGET_GAP_MULT * read.gapPct, 0)
  })

  it('states the shadow disclosure in the row s own words and leaks no field name', () => {
    expect(call.thesis).toContain('post-earnings pop')
    expect(call.thesis).toContain('Shadow only until n≥40 campaigns')
    expect(call.falsifier).toBe(`Wrong if it closes above ${call.stop}.`)
    expect(call.thesis!.endsWith(call.falsifier!)).toBe(true)
    expect(bannedTokensIn(call.thesis!), call.thesis).toEqual([])
    expect(bannedTokensIn(call.falsifier!), call.falsifier).toEqual([])
  })

  it('gives no factor a vote — the composite is constructed, not scored', () => {
    const weights = Object.values(call.factors).map(f => f.weight)
    expect(weights.every(w => w === 0)).toBe(true)
    expect(Object.values(call.factors).filter(f => f.score != null).length).toBe(1)
  })

  it('refuses a shape it could not grade honestly', () => {
    // the pop was two sessions ago and the name has run HARD since, so the stop
    // (above the old reaction high) now sits under the entry: not a stop at all.
    const ran = gapBar(flat(), 6)
    const printDay = dateOf(ran[ran.length - 2])
    for (const px of [130, 140]) {
      const prev = ran[ran.length - 1]
      ran.push({ t: prev.t + 86_400, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1_000_000 })
    }
    const runRead = classifyEarningsFade(ran, beat(printDay, 'post'))!
    expect(runRead.reactionAgo).toBe(2) // still inside the window…
    expect(earningsFadeCall('ZZA', ran, runRead, 40_000)).toBeNull() // …and still refused
  })

  it('a small cap is flagged as one', () => {
    expect(earningsFadeCall('ZZA', bars, read, 300)!.smallCap).toBe(true)
    expect(earningsFadeCall('ZZA', bars, read, null)!.smallCap).toBe(false) // unknown is never guessed small
  })
})

describe('the lane s own guard rails', () => {
  it('caps the run at three rows', () => {
    expect(EARNINGS_FADE_MAX_PER_RUN).toBe(3)
  })

  it('EARNINGS_FADE=off is the lever, and nothing else turns it on or off', () => {
    const prev = process.env.EARNINGS_FADE
    try {
      delete process.env.EARNINGS_FADE
      expect(earningsFadeDisabled()).toBe(false)
      process.env.EARNINGS_FADE = 'on'
      expect(earningsFadeDisabled()).toBe(false)
      process.env.EARNINGS_FADE = 'off'
      expect(earningsFadeDisabled()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.EARNINGS_FADE
      else process.env.EARNINGS_FADE = prev
    }
  })
})
