import type { Candle } from '../../shared/types'

export interface ComparisonInput { symbol: string; label: string; candles: Candle[] }
/** Compare the same observed daily dates, never unmatched start/end points. */
export function compareDailyPrices(inputs: ComparisonInput[], now = Date.now() / 1000) {
  const maps = inputs.map(input => new Map([...input.candles]
    .filter(c => Number.isFinite(c.t) && c.t > 0 && c.t <= now && Number.isFinite(c.c) && c.c > 0)
    .sort((a, b) => a.t - b.t)
    .map(c => [new Date(c.t * 1000).toISOString().slice(0, 10), c.c])))
  const dates = [...(maps[0]?.keys() ?? [])].filter(date => maps.every(m => m.has(date))).sort()
  if (dates.length < 2) return null
  return { dates, series: inputs.map((input, i) => ({ symbol: input.symbol, label: input.label,
    values: dates.map(date => (maps[i].get(date)! / maps[i].get(dates[0])! - 1) * 100),
  })) }
}
