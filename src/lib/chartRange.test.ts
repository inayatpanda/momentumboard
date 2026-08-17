import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHART_RANGES, CHART_RANGE_KEY, DEFAULT_CHART_RANGE, chartRangeOf, readChartRange, writeChartRange } from './chartRange'

beforeEach(() => localStorage.clear())

describe('the chart ranges', () => {
  it('offers a day, a week, a month, a quarter, a half year and a year — labelled the reader’s way', () => {
    expect(CHART_RANGES.map(r => r.label)).toEqual(['1D', '1W', '1M', '3M', '6M', '1Y'])
    // the ids are Yahoo's own words: they ride into getCandles and into the slice key
    expect(CHART_RANGES.map(r => r.id)).toEqual(['1d', '5d', '1mo', '3mo', '6mo', '1y'])
  })

  it('opens on the month, not the quarter', () => {
    expect(DEFAULT_CHART_RANGE).toBe('1mo')
    expect(readChartRange()).toBe('1mo')
  })

  it('marks exactly the two ranges whose bars are hours, not days', () => {
    expect(CHART_RANGES.filter(r => r.intraday).map(r => r.id)).toEqual(['1d', '5d'])
    expect(chartRangeOf('1d').bars).toBe('5-minute bars')
    expect(chartRangeOf('5d').bars).toBe('15-minute bars')
  })
})

describe('remembering the reader’s choice', () => {
  it('round-trips through localStorage under mb-chart-range', () => {
    writeChartRange('1d')
    expect(localStorage.getItem(CHART_RANGE_KEY)).toBe('1d')
    expect(readChartRange()).toBe('1d')
  })

  it('ignores a stored value that is not a range', () => {
    localStorage.setItem(CHART_RANGE_KEY, '10y')
    expect(readChartRange()).toBe('1mo')
    localStorage.setItem(CHART_RANGE_KEY, '{"nope":1}')
    expect(readChartRange()).toBe('1mo')
  })

  it('survives storage being denied outright (private browsing)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readChartRange()).toBe('1mo')
    expect(() => writeChartRange('3mo')).not.toThrow()
    vi.restoreAllMocks()
  })
})
