import { describe, expect, it } from 'vitest'
import { credibilityOf, gradeChannelStances, type ChannelCredState } from './channelCred'
import type { Candle } from '../types'

const DAY = 86_400
const NOW = Date.parse('2026-07-01') / 1000

const mkCandles = (startClose: number, slope: number, days = 40): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = startClose + slope * i
    return { t: NOW - (days - i) * DAY, o: c, h: c + 1, l: c - 1, c, v: 1_000_000 }
  })

describe('credibilityOf', () => {
  it('empty state → prior only: favourites 0.6, others 0.5', () => {
    expect(credibilityOf({}, 'Stocks with Josh', ['Stocks with Josh'])).toBeCloseTo(0.6, 5)
    expect(credibilityOf({}, 'Random', ['Stocks with Josh'])).toBeCloseTo(0.5, 5)
  })
  it('evidence dominates the prior as calls accumulate', () => {
    const state: ChannelCredState = { Josh: { graded: 20, hits: 16, sumExcess: 40, recent: [] } }
    // (16 + 0.5×8)/(20+8) = 20/28
    expect(credibilityOf(state, 'Josh', [])).toBeCloseTo(20 / 28, 4)
    expect(credibilityOf(state, 'Josh', ['Josh'])).toBeCloseTo((16 + 0.6 * 8) / 28, 4)
  })
})

describe('gradeChannelStances', () => {
  const spy = mkCandles(500, 0)
  const extract = (at: number, stance: 'bull' | 'bear' | 'neutral', sym = 'TSLA') => ({
    url: `https://yt/v${at}`,
    channel: 'Stocks with Josh',
    at,
    tickers: [{ sym, stance }],
  })

  it('grades a matured bull call against a rising tape as a hit', () => {
    const candles = new Map([['TSLA', mkCandles(100, 2)]])
    const { state, graded } = gradeChannelStances([extract(NOW - 20 * DAY, 'bull')], candles, spy, {}, NOW)
    expect(graded).toBe(1)
    expect(state['Stocks with Josh'].hits).toBe(1)
  })

  it('bear stance flips the sign', () => {
    const candles = new Map([['TSLA', mkCandles(100, -2)]])
    const { state } = gradeChannelStances([extract(NOW - 20 * DAY, 'bear')], candles, spy, {}, NOW)
    expect(state['Stocks with Josh'].hits).toBe(1)
  })

  it('dedupes on rerun, skips neutral and too-fresh videos', () => {
    const candles = new Map([['TSLA', mkCandles(100, 2)]])
    const first = gradeChannelStances([extract(NOW - 20 * DAY, 'bull')], candles, spy, {}, NOW)
    const rerun = gradeChannelStances([extract(NOW - 20 * DAY, 'bull')], candles, spy, first.state, NOW)
    expect(rerun.graded).toBe(0)
    expect(gradeChannelStances([extract(NOW - 20 * DAY, 'neutral')], candles, spy, {}, NOW).graded).toBe(0)
    expect(gradeChannelStances([extract(NOW - 2 * DAY, 'bull')], candles, spy, {}, NOW).graded).toBe(0)
  })
})
