import type { Candle } from './types'

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null)
  if (closes.length <= period) return out
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d
    else avgLoss -= d
  }
  avgGain /= period
  avgLoss /= period
  const toRsi = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l))
  out[period] = toRsi(avgGain, avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = toRsi(avgGain, avgLoss)
  }
  return out
}

export function atr(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = candles.map(() => null)
  if (candles.length < period + 1) return out
  const tr = (i: number) => {
    const c = candles[i]
    if (i === 0) return c.h - c.l
    const pc = candles[i - 1].c
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc))
  }
  let a = 0
  for (let i = 0; i < period; i++) a += tr(i)
  a /= period
  out[period - 1] = a
  for (let i = period; i < candles.length; i++) {
    a = (a * (period - 1) + tr(i)) / period
    out[i] = a
  }
  return out
}

/** Historical capacity to move: 80th percentile of absolute N-session returns
 * over the lookback. A swing candidate should demonstrably be ABLE to travel —
 * a 4% p80 name cannot deliver a 10%-in-two-weeks call, whatever the story. */
export function swingCapacity(closes: number[], window = 10, lookback = 250): number | null {
  const usable = closes.slice(-lookback - window)
  if (usable.length < window + 30) return null
  const moves: number[] = []
  for (let i = window; i < usable.length; i++) {
    moves.push(Math.abs((usable[i] - usable[i - window]) / usable[i - window]) * 100)
  }
  moves.sort((a, b) => a - b)
  return Math.round(moves[Math.floor(moves.length * 0.8)] * 10) / 10
}
