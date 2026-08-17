// The chart's range switcher (owner: "in charts, can i have 1 day and 1 week,
// 1 month views as well rather than starting with 3 months").
//
// `id` is Yahoo's own range word — it is what getCandles sends, what the server
// whitelists (netlify/functions/lib/yahoo.ts, CANDLE_RANGES) and what the slice
// key carries, so a reader switching ranges never overwrites another range's
// cache. `label` is the reader's word for it: nobody asks for "5d".
//
// The default is ONE MONTH, deliberately the shortest range that still shows a
// swing: the quarter the page used to open on answered a question the reader
// had not asked yet, and the choice they DO make is remembered from then on.

export const CHART_RANGES = [
  { id: '1d', label: '1D', bars: '5-minute bars', intraday: true },
  { id: '5d', label: '1W', bars: '15-minute bars', intraday: true },
  { id: '1mo', label: '1M', bars: 'daily bars', intraday: false },
  { id: '3mo', label: '3M', bars: 'daily bars', intraday: false },
  { id: '6mo', label: '6M', bars: 'daily bars', intraday: false },
  { id: '1y', label: '1Y', bars: 'daily bars', intraday: false },
] as const

export type ChartRange = (typeof CHART_RANGES)[number]
export type ChartRangeId = ChartRange['id']

export const DEFAULT_CHART_RANGE: ChartRangeId = '1mo'

export const CHART_RANGE_KEY = 'mb-chart-range'

export const chartRangeOf = (id: ChartRangeId): ChartRange => CHART_RANGES.find(r => r.id === id) ?? CHART_RANGES[2]

/** The reader's last choice, applied on every stock page they open next.
 * Storage can throw outright (Safari private browsing) and can hold anything at
 * all (it is the reader's own disk) — either way the answer is a range. */
export function readChartRange(): ChartRangeId {
  try {
    const saved = localStorage.getItem(CHART_RANGE_KEY)
    return CHART_RANGES.some(r => r.id === saved) ? (saved as ChartRangeId) : DEFAULT_CHART_RANGE
  } catch {
    return DEFAULT_CHART_RANGE
  }
}

export function writeChartRange(id: ChartRangeId): void {
  try {
    localStorage.setItem(CHART_RANGE_KEY, id)
  } catch {
    // a reader with storage denied still gets the switcher, just not the memory
  }
}
