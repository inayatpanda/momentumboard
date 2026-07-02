import type { Candle } from './types'

export function avgDailyVolume(candles: Candle[], days = 30): number | null {
  const completed = candles.slice(0, -1)
  if (completed.length < 5) return null
  const window = completed.slice(-days)
  return window.reduce((s, c) => s + c.v, 0) / window.length
}

// UTC approximations: US cash session 13:30–20:00, LSE 08:00–16:30.
// Off by one hour around DST switches — acceptable for a badge, documented in UI.
const SESSIONS = { US: { open: 13.5, close: 20 }, LSE: { open: 8, close: 16.5 } } as const

export function sessionElapsedFraction(exchange: 'US' | 'LSE', nowUtcSec: number): number {
  const d = new Date(nowUtcSec * 1000)
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  const { open, close } = SESSIONS[exchange]
  // Outside the session the last bar is a COMPLETE day, so compare against a
  // full average day (fraction 1) — a small fraction here inflates RVOL ~20x.
  if (hours < open || hours >= close) return 1
  return Math.max(0.05, (hours - open) / (close - open))
}

export function relativeVolume(todayVolume: number, avgVol: number, elapsedFraction: number): number {
  return todayVolume / (avgVol * elapsedFraction)
}

export function isMarketOpen(exchange: 'US' | 'LSE', nowUtcSec: number): boolean {
  const d = new Date(nowUtcSec * 1000)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  const { open, close } = SESSIONS[exchange]
  return hours >= open && hours < close
}
