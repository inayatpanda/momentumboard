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

/** THE INTRADAY CLOCK. lightweight-charts renders a UTCTimestamp in UTC and
 * has no timezone setting, so a 1D chart of a US name labels the open 13:30 for
 * a London reader whose own clock says 14:30. Shifting every bar by its OWN
 * offset moves the axis onto the reader's wall clock, and a series spanning a
 * clock change stays correct on both sides of it. Display only — nothing
 * derived from these bars is stored, and the daily ranges, which show no times
 * at all, skip it.
 *
 * THE AUTUMN TRAP. When the clocks go BACK, an hour of wall-clock time repeats,
 * so per-bar shifting walks the series backwards across the change — and
 * lightweight-charts rejects data that is not strictly ascending, which is a
 * blank chart, not a wrong label. Equities never meet it (the change lands
 * inside a Sunday), but crypto trades straight through, twice a year. So the
 * moment the shift would break the order, the whole series takes the NEWEST
 * bar's offset instead: one hour wrong at the far end of a 1W crypto chart for
 * a few days a year, rather than no chart at all. */
export function toLocalBars(candles: Candle[]): Candle[] {
  const offsetOf = (t: number) => -new Date(t * 1000).getTimezoneOffset() * 60
  const shifted = candles.map(c => ({ ...c, t: c.t + offsetOf(c.t) }))
  for (let i = 1; i < shifted.length; i++) {
    if (shifted[i].t <= shifted[i - 1].t) {
      const flat = offsetOf(candles[candles.length - 1].t)
      return candles.map(c => ({ ...c, t: c.t + flat }))
    }
  }
  return shifted
}

/** Which moving averages this many bars can actually DRAW. An MA200 needs 200
 * of them, so on 78 five-minute bars it is an empty line — and a legend chip
 * naming a line that isn't there is a claim the reader cannot check. */
export function drawableMAs<T extends { period: number }>(styles: readonly T[], barCount: number): T[] {
  return styles.filter(s => barCount >= s.period)
}

export function toLineSeries(candles: Candle[], values: (number | null)[]) {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (let i = 0; i < candles.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: candles[i].t as UTCTimestamp, value: v })
  }
  return out
}
