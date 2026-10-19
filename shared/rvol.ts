import type { Candle } from './types'
import type { Exchange } from './symbols'

export function avgDailyVolume(candles: Candle[], days = 30): number | null {
  const completed = candles.slice(0, -1)
  if (completed.length < 5) return null
  const window = completed.slice(-days)
  return window.reduce((s, c) => s + c.v, 0) / window.length
}

// Sessions are fixed in the exchange's LOCAL clock, not UTC. The US and UK
// switch daylight saving on different dates; these hours also gate alerts,
// quote polling and RVOL, so a fixed UTC approximation changes signal inputs.
const SESSIONS = {
  US: { open: 9.5, close: 16, zone: 'America/New_York' },
  LSE: { open: 8, close: 16.5, zone: 'Europe/London' },
} as const
const CLOCKS = Object.fromEntries(Object.entries(SESSIONS).map(([exchange, session]) => [
  exchange, new Intl.DateTimeFormat('en-GB', { timeZone: session.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
])) as Record<'US' | 'LSE', Intl.DateTimeFormat>

/** UTC hours for the given day's regular session, shared with the UI clock.
 * Noon UTC lies on the same calendar day at both venues and after either
 * daylight-saving transition; the next session must use its OWN date. */
export function sessionUtcHours(exchange: 'US' | 'LSE', nowUtcSec: number): { open: number; close: number } {
  const day = new Date(nowUtcSec * 1000)
  const noon = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12))
  const parts = CLOCKS[exchange].formatToParts(noon)
  const localHour = Number(parts.find(p => p.type === 'hour')!.value) + Number(parts.find(p => p.type === 'minute')!.value) / 60
  const offset = localHour - 12
  return { open: SESSIONS[exchange].open - offset, close: SESSIONS[exchange].close - offset }
}

export function sessionElapsedFraction(exchange: Exchange, nowUtcSec: number): number {
  const d = new Date(nowUtcSec * 1000)
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  // Crypto trades continuously; Yahoo's daily bar runs midnight-to-midnight UTC.
  if (exchange === 'CRYPTO') return Math.max(0.05, hours / 24)
  const { open, close } = sessionUtcHours(exchange, nowUtcSec)
  // Outside the session the last bar is a COMPLETE day, so compare against a
  // full average day (fraction 1) — a small fraction here inflates RVOL ~20x.
  if (hours < open || hours >= close) return 1
  return Math.max(0.05, (hours - open) / (close - open))
}

export function relativeVolume(todayVolume: number, avgVol: number, elapsedFraction: number): number {
  return todayVolume / (avgVol * elapsedFraction)
}

export function isMarketOpen(exchange: Exchange, nowUtcSec: number): boolean {
  if (exchange === 'CRYPTO') return true // 24/7, weekends included
  const d = new Date(nowUtcSec * 1000)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  const { open, close } = sessionUtcHours(exchange, nowUtcSec)
  return hours >= open && hours < close
}
