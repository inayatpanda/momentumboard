// onDemandVerdict (PWA rebuild, plan Task 6 + amendment DS-24): the "ask about
// any stock" engine read. PURE — candles in, verdict out, reusing the very same
// factor/composite functions buildBoard calls, so the on-demand read can never
// fork from the board's arithmetic. The tests assert STRUCTURAL honesty (which
// factors computed vs null, determinism, no invented grades) rather than
// predicting composite signs from a fabricated tape.

import { describe, expect, it } from 'vitest'
import type { Candle } from '../../../shared/types'
import { onDemandVerdict } from './onDemandVerdict'

/** A gentle 60-bar uptrend with volume — enough history for every price factor. */
function trendCandles(n = 60, start = 100, dailyGain = 0.6): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * dailyGain
    return { t: 1_700_000_000 + i * 86_400, o: c - 0.3, h: c + 0.8, l: c - 0.9, c, v: 1_000_000 }
  })
}
const flatSpy = (n = 60): Candle[] => trendCandles(n, 100, 0)

// Momentum-only weights make the composite's SIGN follow relative strength
// alone — the one thing the fixture genuinely controls.
const MOMENTUM_ONLY = { technical: 0, momentum: 2, sector: 0, seasonality: 0, social: 0, channels: 0, insiders: 0, news: 0, smartMoney: 0, catalyst: 0 }

const deps = (candles: Candle[] | null, spy: Candle[] | null = flatSpy()) => ({
  candles: async (sym: string) => (sym === 'SPY' ? spy : candles),
})

describe('onDemandVerdict', () => {
  it('computes the price factors, names the rest as nulls, and leans with the core', async () => {
    const v = await onDemandVerdict('TREND', deps(trendCandles()), { weights: MOMENTUM_ONLY, regime: 'green' })
    expect(v.unavailable).toBeUndefined()
    if (v.unavailable) throw new Error('unreachable')
    expect(v.onDemand).toBe(true)
    expect(v.sym).toBe('TREND')
    const computed = Object.fromEntries(v.computed.map(f => [f.name, f]))
    expect(computed.technical.score).not.toBeNull()
    expect(computed.momentum.score).toBeGreaterThan(0) // outran a flat SPY by construction
    expect(v.nulls.sort()).toEqual(['catalyst', 'channels', 'insiders', 'news', 'seasonality', 'sector', 'smartMoney', 'social'])
    expect(v.core).not.toBeNull()
    expect(v.core!).toBeGreaterThan(0)
    expect(v.lean).toBe('long')
    expect(v.stage).toBeTruthy()
    expect(v.lastClose).toBeCloseTo(trendCandles().at(-1)!.c, 2)
    expect(v.atr).toBeGreaterThan(0)
    expect(v.note.startsWith('On-demand read — not one of today’s calls')).toBe(true)
  })

  it('never invents a grade or a probability', async () => {
    const v = await onDemandVerdict('TREND', deps(trendCandles()), { weights: MOMENTUM_ONLY, regime: 'green' })
    expect(v).not.toHaveProperty('grade')
    expect(v).not.toHaveProperty('probability')
  })

  it('is deterministic — same tape, same verdict (the clock stamp aside)', async () => {
    const a = await onDemandVerdict('TREND', deps(trendCandles()), { weights: MOMENTUM_ONLY, regime: 'green' })
    const b = await onDemandVerdict('TREND', deps(trendCandles()), { weights: MOMENTUM_ONLY, regime: 'green' })
    expect({ ...a, at: null }).toEqual({ ...b, at: null })
  })

  it('degrades honestly on a short tape: technical goes null, momentum still reads', async () => {
    const v = await onDemandVerdict('YOUNG', deps(trendCandles(25)), { weights: MOMENTUM_ONLY, regime: 'green' })
    if (v.unavailable) throw new Error('should not be unavailable')
    const computed = Object.fromEntries(v.computed.map(f => [f.name, f]))
    expect(computed.technical.score).toBeNull() // <30 candles → no chart read
    expect(computed.momentum.score).not.toBeNull() // 25 closes ≥ 22 → RS computes
    expect(v.nulls).toContain('technical')
    expect(v.stage).toBeNull()
  })

  it('reports unavailable when the tape cannot be fetched at all', async () => {
    const v = await onDemandVerdict('GONE', deps(null), { weights: MOMENTUM_ONLY, regime: 'green' })
    expect(v).toMatchObject({ sym: 'GONE', unavailable: true })
  })

  it('a missing weights table yields a null core and a "none" lean — never a guess', async () => {
    const v = await onDemandVerdict('TREND', deps(trendCandles()), { weights: null, regime: 'green' })
    if (v.unavailable) throw new Error('should not be unavailable')
    expect(v.core).toBeNull()
    expect(v.lean).toBe('none')
  })
})
