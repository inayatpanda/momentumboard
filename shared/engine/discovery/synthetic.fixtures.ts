// TEST-ONLY synthetic tapes. Nothing in the engine imports this file.
//
// Hand-built shapes beat recorded ones here: a lens is a claim about a SHAPE,
// so the fixture that proves it has to be the shape and nothing else — no
// survivorship, no "it worked on AAPL last March".

import type { Candle } from '../../types'
import type { Features, Percentiles, UniverseMember } from './types'

export const DAY = 86_400
/** A Tuesday. Only the spacing matters. */
export const LAST_T = 1_758_499_200

export interface Bar {
  c: number
  v?: number
  o?: number
  h?: number
  l?: number
}

/** Bars → candles, stamped so the LAST bar is `lastT` and each step is a day. */
export function tape(bars: Bar[], lastT = LAST_T): Candle[] {
  const n = bars.length
  return bars.map((b, i) => {
    const o = b.o ?? b.c
    return {
      t: lastT - (n - 1 - i) * DAY,
      o,
      h: b.h ?? Math.max(o, b.c),
      l: b.l ?? Math.min(o, b.c),
      c: b.c,
      v: b.v ?? 1_000_000,
    }
  })
}

/** A bar with a real intraday range — a perfectly flat tape has ATR 0, which
 * makes every ATR-relative feature null and every ATR-gated lens untestable. */
const ranged = (c: number, v = 1_000_000, range = 1): Bar => ({ c, v, o: c, h: c + range, l: c - range })

/** Sideways, with a normal daily range. */
export const flatBars = (n: number, price = 100, v = 1_000_000): Bar[] => Array.from({ length: n }, () => ranged(price, v))

/** Compounding drift. `dailyPct` of +0.15 is a leader; −0.4 is a decliner. */
export function trendBars(n: number, start: number, dailyPct: number, v = 1_000_000): Bar[] {
  const out: Bar[] = []
  let p = start
  for (let i = 0; i < n; i++) {
    p *= 1 + dailyPct / 100
    out.push(ranged(Math.round(p * 100) / 100, v, Math.max(0.5, p * 0.01)))
  }
  return out
}

/** Steady 0.15%/day leader: above a rising 50-EMA, under 2 ATR of the 21-EMA. */
export const trendTape = (n = 140) => tape(trendBars(n, 100, 0.15))

/** The same leader, then three quiet sessions back to the 21-EMA. */
export const pullbackTape = (n = 140) => {
  const bars = trendBars(n, 100, 0.15)
  const last = bars[bars.length - 1].c
  bars.push(ranged(last * 0.988, 700_000, last * 0.01))
  bars.push(ranged(last * 0.982, 600_000, last * 0.01))
  bars.push(ranged(last * 0.984, 550_000, last * 0.01))
  return tape(bars)
}

/** A violent year, then a tight coil, then one paid break of the highs.
 * The volatile stretch is what makes today's Bollinger width a LOW percentile
 * despite the break — "compressed base" is a claim about the year, not the day. */
export function breakoutTape(): Candle[] {
  const bars: Bar[] = []
  for (let i = 0; i < 175; i++) bars.push(ranged(i % 2 ? 93 : 107, 1_000_000, 3))
  for (let i = 0; i < 25; i++) bars.push(ranged(100 + (i % 2 ? 0.3 : -0.3), 1_000_000, 0.4))
  bars.push({ c: 106, o: 100.5, h: 106.5, l: 100.2, v: 3_400_000 })
  return tape(bars)
}

/** Slide to 85 and a volume-paid reclaim — the dip lane's own holding shape. */
export const dipTape = () => tape([...flatBars(60, 100), ranged(94), ranged(90), ranged(87), { c: 85, o: 86, h: 86, l: 84.5, v: 1_000_000 }, ranged(85.5), { c: 88, o: 86, h: 88.5, l: 85.8, v: 1_700_000 }])

/** Still falling: no reclaim, new lows every session. */
export const knifeTape = () => tape([...flatBars(60, 100), ranged(94), ranged(90), ranged(87), ranged(84), ranged(81)])

/** Five up days, stretched miles above the 21-EMA, crowd already leaving. */
export const blowOffTape = () => tape([...flatBars(60, 100), ranged(103, 600_000, 2), ranged(106, 580_000, 2), ranged(109, 560_000, 2), ranged(113, 540_000, 2), ranged(117, 520_000, 2)])

/** −0.4%/day for half a year: under a falling 50-EMA, each rally lower. */
export const weakTape = (n = 140) => tape(trendBars(n, 140, -0.4))


/** A name with a REAL typical move: a ±3% swing every four weeks, so
 * `typicalMove10` lands near 6% instead of at the 1% floor. */
export function wiggleBars(n: number, price = 100, amp = 3, period = 20, v = 1_000_000): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const p = price * (1 + (amp / 100) * Math.sin((2 * Math.PI * i) / period))
    return ranged(Math.round(p * 100) / 100, v, Math.max(0.5, p * 0.015))
  })
}

/** …and then one session several times that swing, on heavy volume. */
export function shockTape(dir: 1 | -1 = 1): Candle[] {
  const bars = wiggleBars(140)
  const last = bars[bars.length - 1].c
  bars.push(ranged(Math.round(last * (1 + dir * 0.065) * 100) / 100, 2_500_000, 2))
  return tape(bars)
}

/** SPY going nowhere, stamped on the same sessions. */
export const spyFlat = (n = 260) => tape(flatBars(n, 500))

export const member = (over: Partial<UniverseMember> = {}): UniverseMember => ({
  sym: 'TEST',
  exchange: 'US',
  capBand: 'large',
  sector: 'Technology',
  index: ['sp500'],
  currency: 'USD',
  origins: ['seed:sp500'],
  lastSeen: '2026-09-22',
  ...over,
})

/** Mid-field percentiles; override only what the test is about. Three fields,
 * because three is what any lens reads (see PERCENTILE_FIELDS). */
export const percentiles = (over: Partial<Percentiles> = {}): Percentiles => ({
  rsSpy20: 0.5,
  rsSpy60: 0.5,
  unusual: 0.5,
  ...over,
})

/** A Features row with every field known and unremarkable. */
export const features = (over: Partial<Features> = {}): Features => ({
  sym: 'TEST',
  bars: 140,
  lastT: LAST_T,
  close: 100,
  ret1: 0.5,
  ret5: 1,
  ret10: 2,
  ret20: 3,
  ret60: 6,
  gapPct: 0,
  atrPct14: 2,
  typicalMove10: 6,
  rvol: 1,
  dollarVol20: 50_000_000,
  ema8: 99.5,
  ema21: 99,
  ema50: 97,
  ema50Slope20: 3,
  distEma21Atr: 0.5,
  rsi14: 55,
  ddFrom20dHigh: -1,
  ddFrom60dHigh: -3,
  distTo52wHigh: -5,
  upDays5: 3,
  upDays10: 6,
  broke20dHigh: false,
  broke60dHigh: false,
  broke20dLow: false,
  bbWidthPctl120: 0.5,
  rsSpy20: 3,
  rsSpy60: 6,
  volTrend5: 1,
  lowerHighs: false,
  ...over,
})
