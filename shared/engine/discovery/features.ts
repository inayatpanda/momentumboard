// Per-name features for the discovery scan. Pure: candles in, numbers out.
//
// Everything a lens is allowed to know about one name lives here, so a lens is a
// statement about features rather than about bars — which is what makes the
// lenses testable and the scan cheap (one pass per name, seven readings).
//
// Two rules the whole file obeys: every number is rounded to 4dp before it
// leaves (a percentile of raw float noise is noise ranked precisely), and no
// NaN/Infinity ever escapes — an unknown is `null`, because an unknown must
// never pass a gate.

import type { Candle } from '../../types'
import { atr, rsi, swingCapacity } from '../../indicators'
import { HYGIENE, type Features } from './types'

/** The full EMA series. `emaLast` in shared/indicators returns only the tail and
 * we need the slope, so this is the same recurrence (SMA seed, k = 2/(p+1))
 * keeping every step. Byte-compatible with emaLast at the final index. */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null)
  if (values.length < period) return out
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period
  out[period - 1] = e
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    e += k * (values[i] - e)
    out[i] = e
  }
  return out
}

/** 4dp, and an unknown stays unknown. */
const num = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** % change from `k` sessions ago to the last close. */
const retPct = (closes: number[], k: number): number | null => {
  const base = closes[closes.length - 1 - k]
  if (base == null || base <= 0) return null
  return ((closes[closes.length - 1] - base) / base) * 100
}

/** Bollinger(20, 2) width as a fraction of the mid band: 4σ/mid. */
function bbWidths(closes: number[], period = 20): number[] {
  const out: number[] = []
  for (let i = period - 1; i < closes.length; i++) {
    const w = closes.slice(i - period + 1, i + 1)
    const mid = w.reduce((s, v) => s + v, 0) / period
    if (mid <= 0) continue
    const varr = w.reduce((s, v) => s + (v - mid) * (v - mid), 0) / period
    out.push((4 * Math.sqrt(varr)) / mid)
  }
  return out
}

/** Percentile rank of the last value inside its own window, ties averaged. */
const selfPercentile = (window: number[]): number | null => {
  if (window.length < 2) return null
  const today = window[window.length - 1]
  let less = 0
  let equal = 0
  for (const w of window) {
    if (w < today) less++
    else if (w === today) equal++
  }
  return (less + equal / 2) / window.length
}

/** Relative strength vs the index, in percentage points.
 *
 * SPY is aligned BY UTC DAY: a name that did not trade on a US holiday, or an
 * LSE name on a UK-only session, has a different bar count, and subtracting two
 * returns measured over different calendar windows is not relative strength.
 *
 * THE DAY, not the raw stamp, and that is the whole fix. Yahoo stamps a daily
 * bar at the session's OPEN in UTC: 13:30 for SPY (14:30 in winter), 07:00 for a
 * London line. An exact-stamp match therefore NEVER fired for a single LSE name
 * — every one of the seed's 350 UK rows silently fell through to the end-index
 * fallback and had its relative strength measured off SPY's last bar whatever
 * day that was. Comparing `floor(t / 86400)` matches the session both venues
 * traded, and costs one divide.
 *
 * The fallback survives for the case it was written for: no bar of SPY's shares
 * the name's last day at all (a suspended name, a stale tape), where index
 * alignment from the end is at worst a session out. */
const utcDayOf = (t: number): number => Math.floor(t / 86_400)

function spyReturn(spy: Candle[], lastT: number, k: number): number | null {
  if (spy.length <= k) return null
  const day = utcDayOf(lastT)
  let idx = -1
  for (let i = spy.length - 1; i >= 0; i--) {
    if (utcDayOf(spy[i].t) === day) {
      idx = i
      break
    }
  }
  if (idx < 0) idx = spy.length - 1
  const base = spy[idx - k]
  if (base == null || base.c <= 0) return null
  return ((spy[idx].c - base.c) / base.c) * 100
}

export function computeFeatures(sym: string, candles: Candle[], spyCandles: Candle[] | null): Features | null {
  if (candles.length < HYGIENE.minBars) return null
  const n = candles.length
  const last = candles[n - 1]
  const prev = candles[n - 2]
  const closes = candles.map(c => c.c)
  const vols = candles.map(c => c.v)
  const close = last.c

  const atr14 = atr(candles, 14)[n - 1]
  const rsi14 = rsi(closes, 14)[n - 1]

  const ema8s = emaSeries(closes, 8)
  const ema21s = emaSeries(closes, 21)
  const ema50s = emaSeries(closes, 50)
  const ema8 = ema8s[n - 1]
  const ema21 = ema21s[n - 1]
  const ema50 = ema50s[n - 1]
  const ema50Prior = ema50s[n - 21] ?? null
  const ema50Slope20 = ema50 != null && ema50Prior != null && ema50 > 0 ? ((ema50 - ema50Prior) / ema50) * 100 : null

  // RVOL baseline EXCLUDES today — the same trailing convention the dip lane and
  // technicals use. Dividing today by a median it is itself inside flattens the
  // very spike the number exists to report.
  const volMed20 = median(vols.slice(-21, -1))
  const rvol = volMed20 != null && volMed20 > 0 ? last.v / volMed20 : null
  const dollarVol20 = median(candles.slice(-20).map(c => c.c * c.v))

  const high20 = Math.max(...closes.slice(-20))
  const high60 = Math.max(...closes.slice(-60))
  const high52w = Math.max(...closes.slice(-250))
  const prior20 = closes.slice(-21, -1)
  const prior60 = closes.slice(-61, -1)

  const upDays = (k: number): number | null => {
    if (n < k + 1) return null
    let up = 0
    for (let i = n - k; i < n; i++) if (closes[i] > closes[i - 1]) up++
    return up
  }

  const widths = bbWidths(closes)
  const bbWidthPctl120 = selfPercentile(widths.slice(-120))

  const spyRet = (k: number) => (spyCandles && spyCandles.length ? spyReturn(spyCandles, last.t, k) : null)
  const rel = (k: number): number | null => {
    const own = retPct(closes, k)
    const bench = spyRet(k)
    return own != null && bench != null ? own - bench : null
  }

  const vol5 = vols.slice(-5)
  const vol20Prior = vols.slice(-25, -5)
  const mean5 = vol5.length ? vol5.reduce((s, v) => s + v, 0) / vol5.length : null
  const meanPrior = vol20Prior.length ? vol20Prior.reduce((s, v) => s + v, 0) / vol20Prior.length : null
  const volTrend5 = mean5 != null && meanPrior != null && meanPrior > 0 ? mean5 / meanPrior : null

  // Two most recent NON-OVERLAPPING 10-session windows. Descending highs is the
  // cheapest honest reading of "the sellers are showing up earlier each time".
  const swingHigh = (from: number, to: number): number | null => {
    const w = candles.slice(from, to)
    return w.length ? Math.max(...w.map(c => c.h)) : null
  }
  const h1 = swingHigh(n - 10, n)
  const h2 = swingHigh(n - 20, n - 10)
  const lowerHighs = h1 != null && h2 != null ? h1 < h2 : null

  return {
    sym,
    bars: n,
    lastT: last.t,
    close: num(close) ?? 0,
    ret1: num(retPct(closes, 1)),
    ret5: num(retPct(closes, 5)),
    ret10: num(retPct(closes, 10)),
    ret20: num(retPct(closes, 20)),
    ret60: num(retPct(closes, 60)),
    gapPct: num(prev && prev.c > 0 ? ((last.o - prev.c) / prev.c) * 100 : null),
    atrPct14: num(atr14 != null && close > 0 ? (atr14 / close) * 100 : null),
    typicalMove10: num(swingCapacity(closes)),
    rvol: num(rvol),
    dollarVol20: num(dollarVol20),
    ema8: num(ema8),
    ema21: num(ema21),
    ema50: num(ema50),
    ema50Slope20: num(ema50Slope20),
    distEma21Atr: num(ema21 != null && atr14 != null && atr14 > 0 ? (close - ema21) / atr14 : null),
    rsi14: num(rsi14),
    ddFrom20dHigh: num(high20 > 0 ? ((close - high20) / high20) * 100 : null),
    ddFrom60dHigh: num(high60 > 0 ? ((close - high60) / high60) * 100 : null),
    distTo52wHigh: num(high52w > 0 ? ((close - high52w) / high52w) * 100 : null),
    upDays5: upDays(5),
    upDays10: upDays(10),
    broke20dHigh: prior20.length ? close > Math.max(...prior20) : null,
    broke60dHigh: prior60.length ? close > Math.max(...prior60) : null,
    broke20dLow: prior20.length ? close < Math.min(...prior20) : null,
    bbWidthPctl120: num(bbWidthPctl120),
    rsSpy20: num(rel(20)),
    rsSpy60: num(rel(60)),
    volTrend5: num(volTrend5),
    lowerHighs,
  }
}
