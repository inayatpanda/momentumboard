import type { UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../../shared/types'

const UP = 'rgba(34, 201, 141, 0.45)'
const DOWN = 'rgba(255, 93, 115, 0.45)'

export function toCandleSeries(candles: Candle[]) {
  return candles.map(c => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c }))
}

export function toVolumeSeries(candles: Candle[]) {
  return candles.map(c => ({ time: c.t as UTCTimestamp, value: c.v, color: c.c >= c.o ? UP : DOWN }))
}

export function toLineSeries(candles: Candle[], values: (number | null)[]) {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (let i = 0; i < candles.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: candles[i].t as UTCTimestamp, value: v })
  }
  return out
}
