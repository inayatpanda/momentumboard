import { describe, expect, it } from 'vitest'
import type { Candle } from './types'
import { EQUITY_TECH_WINDOWS, technicalStage } from './technicals'
import { EQUITY_INDEX_WINDOWS, EQUITY_SETUP_WINDOWS, detectSetups, regimeFromCandles } from './setups'

// THE BAR WINDOWS ARE DATA NOW (Stage 1c Phase B, Task B2) — and the equity
// profile is still the only thing any equity caller ever sees.
//
// The whole suite is the byte-parity proof (every other technicals/setups test
// calls these functions with no window argument). What THIS file pins is the
// three claims that suite cannot make about itself: that the omitted argument
// really is the equity profile, that the numbers in it are the numbers that were
// hard-coded before it existed, and that handing a DIFFERENT profile actually
// changes the read — otherwise the parameter is decoration and the crypto lane
// would be reading equity spans while believing otherwise.

const T0 = Date.parse('2025-01-01') / 1000
const tape = (fn: (i: number) => number, n = 300): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.02, l: c * 0.98, c, v: 1_000_000 + (i % 7) * 50_000 }
  })

/** A tape that rose for a year and has been falling for two months — enough
 * structure that widening every window visibly moves the read. */
const rollover = tape(i => (i < 220 ? 100 + i * 0.8 : 276 - (i - 220) * 1.4))

describe('the equity profile is the default, and it is what the code used to hard-code', () => {
  it('names the numbers that were literals before this table existed', () => {
    expect(EQUITY_TECH_WINDOWS).toMatchObject({
      sma20: 20, sma50: 50, atr: 14, rsi: 14, range: 60, rvolBaseline: 20,
      ema8: 8, ema21: 21, ema50: 50, thrustRecent: 5, thrustBase: 20, minHistory: 30,
    })
    expect(EQUITY_SETUP_WINDOWS).toMatchObject({
      sma20: 20, sma50: 50, sma200: 200, atr: 14, rsi: 14,
      baseSessions: 10, basePrior: 30, basingMinHistory: 40, divergenceLookback: 40,
      knifeWindow: 20, pullbackHigh: 20, breakoutWatch: 15, rvolBaseline: 20, minHistory: 25,
    })
    expect(EQUITY_INDEX_WINDOWS).toEqual({ sma20: 20, sma50: 50, slopeLag: 5 })
    expect(EQUITY_TECH_WINDOWS.setups).toBe(EQUITY_SETUP_WINDOWS)
  })

  it('reads identically whether the profile is omitted or passed explicitly — the omission IS the equity profile', () => {
    expect(technicalStage('X', rollover)).toEqual(technicalStage('X', rollover, EQUITY_TECH_WINDOWS))
    expect(detectSetups(rollover, 1.4)).toEqual(detectSetups(rollover, 1.4, EQUITY_SETUP_WINDOWS))
    expect(regimeFromCandles(rollover, rollover)).toBe(regimeFromCandles(rollover, rollover, EQUITY_INDEX_WINDOWS))
  })
})

describe('a different profile is a different read — the parameter is load-bearing, not decoration', () => {
  it('moves the technical read when the spans widen', () => {
    const wide = { ...EQUITY_TECH_WINDOWS, sma20: 28, sma50: 70, atr: 20, range: 84, rvolBaseline: 28, ema8: 11, ema21: 29, ema50: 70, thrustRecent: 7, thrustBase: 28, minHistory: 42 }
    const base = technicalStage('X', rollover)!
    const other = technicalStage('X', rollover, wide)!
    expect(other.pctFrom20d).not.toBe(base.pctFrom20d)
    expect(other.pctFrom50d).not.toBe(base.pctFrom50d)
    expect(other.emaStack.e8).not.toBe(base.emaStack.e8)
    expect(other.emaStack.e50).not.toBe(base.emaStack.e50)
    // …and the RSI is the one number that must NOT move: its period is fixed in
    // both profiles by design (CRYPTO_LOOKBACKS.rsi14).
    expect(other.rsi).toBe(base.rsi)
  })

  it('refuses a tape shorter than the profile’s own minimum history', () => {
    // 30 bars of straight decline into a volume spike — a falling knife on the
    // equity floor (25) and nothing at all once the floor widens past the tape.
    const knife = tape(i => 100 - i, 30).map((c, i, a) => (i === a.length - 1 ? { ...c, v: 5_000_000 } : c))
    expect(technicalStage('X', knife)).not.toBeNull() // 30 = the equity floor
    expect(technicalStage('X', knife, { ...EQUITY_TECH_WINDOWS, minHistory: 42 })).toBeNull()
    expect(detectSetups(knife, 1)).toEqual(['fallingKnife'])
    expect(detectSetups(knife, 1, { ...EQUITY_SETUP_WINDOWS, minHistory: 40 })).toEqual([])
  })

  it('moves the index read when the windows widen — the two profiles disagree on a real tape', () => {
    // A year-long rise with a five-bar dip at the end. The equity profile
    // (20/50, lag 5) sees the dip break its 20-SMA test and says AMBER; the
    // crypto profile (28/70, lag 7) still sees an intact uptrend and says
    // GREEN. If the parameter were decoration both calls would return the
    // same colour and this pin — the one that guards CRYPTO_INDEX_WINDOWS
    // actually deciding the cohort's regime — would fail.
    const dipped = tape(i => (i < 295 ? 100 + i : 100 + 295 - (i - 295) * 2), 300)
    expect(regimeFromCandles(dipped, dipped)).toBe('amber')
    expect(regimeFromCandles(dipped, dipped, { sma20: 28, sma50: 70, slopeLag: 7 })).toBe('green')
  })
})
