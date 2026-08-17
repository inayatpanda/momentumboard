import { afterEach, describe, it, expect, vi } from 'vitest'
import { drawableMAs, toCandleSeries, toLocalBars, toVolumeSeries, toLineSeries } from './chartData'
import type { Candle } from '../../shared/types'

const candles: Candle[] = [
  { t: 100, o: 10, h: 12, l: 9, c: 11, v: 500 }, // up bar
  { t: 200, o: 11, h: 11.5, l: 10, c: 10.5, v: 800 }, // down bar
]

describe('toCandleSeries', () => {
  it('maps ohlc with unix times', () => {
    expect(toCandleSeries(candles)[0]).toEqual({ time: 100, open: 10, high: 12, low: 9, close: 11 })
  })
})

describe('toVolumeSeries', () => {
  it('colors up bars green and down bars red', () => {
    const v = toVolumeSeries(candles)
    expect(v[0]).toMatchObject({ time: 100, value: 500 })
    expect(v[0].color).not.toBe(v[1].color)
  })
})

describe('toLineSeries', () => {
  it('drops null values while keeping alignment', () => {
    const line = toLineSeries(candles, [null, 10.75])
    expect(line).toEqual([{ time: 200, value: 10.75 }])
  })
})

// lightweight-charts prints a UTCTimestamp in UTC and offers no timezone. On a
// daily chart that is invisible; on a 1D chart it puts the New York open at
// 13:30 for a London reader whose clock says 14:30. Every bar is shifted by ITS
// OWN offset, so a series that crosses a DST change stays continuous.
describe('toLocalBars', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('shifts each bar onto the reader’s wall clock', () => {
    vi.stubEnv('TZ', 'Europe/London')
    const open = Math.floor(new Date('2026-08-14T13:30:00Z').getTime() / 1000) // 14:30 BST
    const [bar] = toLocalBars([{ t: open, o: 1, h: 1, l: 1, c: 1, v: 1 }])
    expect(new Date(bar.t * 1000).toISOString()).toBe('2026-08-14T14:30:00.000Z')
  })

  it('leaves the bars alone where the clock is UTC, and never touches the prices', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(toLocalBars(candles)).toEqual(candles)
  })

  it('follows each bar’s own offset across a DST boundary rather than shifting the whole series by one', () => {
    vi.stubEnv('TZ', 'Europe/London')
    const bst = Math.floor(new Date('2026-10-24T12:00:00Z').getTime() / 1000) // +1
    const gmt = Math.floor(new Date('2026-10-27T12:00:00Z').getTime() / 1000) // +0
    const [a, b] = toLocalBars([
      { t: bst, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: gmt, o: 1, h: 1, l: 1, c: 1, v: 1 },
    ])
    expect(a.t - bst).toBe(3600)
    expect(b.t - gmt).toBe(0)
  })

  // The autumn clock change repeats an hour of wall-clock time. Per-bar shifting
  // walks a crypto series (which trades through the Sunday it lands on)
  // BACKWARDS across it, and lightweight-charts refuses data that is not
  // strictly ascending — a blank chart, not a wrong label.
  it('keeps the series strictly ascending when the clocks go back mid-series', () => {
    vi.stubEnv('TZ', 'Europe/London')
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
    const raw = ['2026-10-25T00:50:00Z', '2026-10-25T00:55:00Z', '2026-10-25T01:00:00Z', '2026-10-25T01:05:00Z'].map(iso => ({
      t: at(iso),
      o: 1,
      h: 1,
      l: 1,
      c: 1,
      v: 1,
    }))
    const out = toLocalBars(raw)
    expect(out.map(b => b.t)).toEqual([...out.map(b => b.t)].sort((x, y) => x - y))
    expect(new Set(out.map(b => b.t)).size).toBe(out.length)
    // the fallback is the NEWEST bar's offset, applied to all of them (GMT: none)
    expect(out.map((b, i) => b.t - raw[i].t)).toEqual([0, 0, 0, 0])
  })
})

// A legend chip for a line with no points is a lie the reader can't check: 78
// five-minute bars cannot carry an MA200, and the old legend claimed one on
// every chart shorter than 200 sessions.
describe('drawableMAs', () => {
  const styles = [{ period: 20 }, { period: 50 }, { period: 200 }]
  it('keeps only the averages the series has bars for', () => {
    expect(drawableMAs(styles, 78).map(s => s.period)).toEqual([20, 50])
    expect(drawableMAs(styles, 260).map(s => s.period)).toEqual([20, 50, 200])
    expect(drawableMAs(styles, 5)).toEqual([])
  })
})
