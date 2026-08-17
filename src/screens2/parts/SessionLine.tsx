// THE TIME-AWARENESS LINE (dynamism wave, feature 1).
//
// Every timestamp the API sends was being thrown away unrendered: the board
// carries its own `generatedAt`, and nothing on any screen said whether the US
// market was even open. A reader opening the app on a Saturday saw Friday's
// board with no word that it was Friday's — so the app looked frozen when it
// was merely closed.
//
// One quiet line under the page heading, two halves:
//   · the SESSION, computed client-side from the reader's own clock (the same
//     UTC session windows shared/rvol.ts judges `isMarketOpen` by, exported
//     from there so the two can never drift) crossed with the NYSE holiday
//     calendar (shared/usMarketHolidays.ts).
//   · the BOARD'S OWN STAMP, when the caller has a board slice in hand.
//
// It TICKS: a 30s interval inside this component, cleaned up on unmount. That
// is deliberately here and not in the data layer — src/lib/store.ts and
// src/lib/useSlice.ts are poll-free by test-enforced rule (store.test.ts), and
// this polls no network, only the clock.
//
// The clock and the timezone are both injectable so the tests can pin them: a
// component whose entire job is being right about time must never be tested
// against the machine's own.

import { useEffect, useState } from 'react'
import { isMarketOpen, SESSIONS } from '../../../shared/rvol'
import type { Exchange } from '../../../shared/symbols'
import { isUsMarketHoliday } from '../../../shared/usMarketHolidays'

/** Past this gap the countdown stops being useful — nobody reads "opens in
 * 17h 20m"; they read a day and a time. */
const COUNTDOWN_WINDOW_MS = 12 * 3_600_000
const TICK_MS = 30_000

export type SessionKind = 'open' | 'pre-open' | 'weekend' | 'holiday' | 'closed'
export interface SessionRead {
  kind: SessionKind
  text: string
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const isoOfUtc = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`

/** A fractional UTC hour (13.5) as a real instant on a given UTC calendar day. */
const instantAt = (d: Date, hour: number, dayOffset = 0) =>
  Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset, Math.floor(hour), Math.round((hour % 1) * 60))

/** Wall-clock label in the READER's zone (or an explicit one, for tests). The
 * session windows are UTC; a London reader's market closes at 21:00 in summer
 * and 20:00 in winter, and printing 20:00 all year is simply wrong half the
 * time. */
const hhmm = (ms: number, timeZone?: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(ms))

const weekdayShort = (ms: number, timeZone?: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(new Date(ms))

const isTradingDay = (d: Date, dayOffset = 0): boolean => {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset))
  const dow = day.getUTCDay()
  return dow !== 0 && dow !== 6 && !isUsMarketHoliday(isoOfUtc(day))
}

/** The next opening bell strictly after `nowMs`. Scans forward a fortnight —
 * far more than the longest run of closures the calendar can produce, and
 * bounded so a calendar bug can never spin. */
function nextOpen(now: Date, nowMs: number): number {
  for (let i = 0; i < 14; i++) {
    if (!isTradingDay(now, i)) continue
    const open = instantAt(now, SESSIONS.US.open, i)
    if (open > nowMs) return open
  }
  return instantAt(now, SESSIONS.US.open, 14)
}

const humanGap = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/** Is this exchange trading right now? `isMarketOpen` knows the session hours
 * and weekends; the NYSE calendar knows the rest, and 15:00 UTC on Thanksgiving
 * is mid-session by the hour alone. Crypto is always true and the LSE keeps its
 * own holidays — out of scope until something prices off them, and a live quote
 * labelled "now" on an LSE bank holiday is the mildest wrong this file can be.
 *
 * Exported because the live-quote poller (src/lib/useLiveQuotes.ts) and the
 * call card's own "now / Fri close" label must ask the SAME question. */
export function exchangeOpenNow(exchange: Exchange, nowMs: number): boolean {
  const d = new Date(nowMs)
  if (exchange === 'US' && isUsMarketHoliday(isoOfUtc(d))) return false
  return isMarketOpen(exchange, Math.floor(nowMs / 1000))
}

/** Where the US cash session stands, as the reader would say it. */
export function usSessionRead(nowMs: number, timeZone?: string): SessionRead {
  const now = new Date(nowMs)
  const dow = now.getUTCDay()
  const weekend = dow === 0 || dow === 6
  const holiday = !weekend && isUsMarketHoliday(isoOfUtc(now))
  const closeAt = instantAt(now, SESSIONS.US.close)
  // `exchangeOpenNow` carries the holiday check, which `isMarketOpen` does not:
  // 15:00 UTC on Thanksgiving is mid-session by the clock alone.
  if (exchangeOpenNow('US', nowMs)) {
    return { kind: 'open', text: `US market open · closes ${hhmm(closeAt, timeZone)}` }
  }
  const next = nextOpen(now, nowMs)
  const gap = next - nowMs
  if (gap <= COUNTDOWN_WINDOW_MS) return { kind: 'pre-open', text: `US opens in ${humanGap(gap)}` }
  if (weekend) return { kind: 'weekend', text: 'US closed — weekend' }
  if (holiday) return { kind: 'holiday', text: 'US closed — holiday' }
  return { kind: 'closed', text: `US closed — opens ${weekdayShort(next, timeZone)} ${hhmm(next, timeZone)}` }
}

export function SessionLine({
  now,
  generatedAt,
  timeZone,
}: {
  /** Frozen clock, for tests. Absent = the reader's real clock, ticking. */
  now?: number
  /** The board slice's own `generatedAt` (ms). Absent on screens with no board. */
  generatedAt?: number | null
  /** IANA zone, for tests. Absent = the reader's own zone. */
  timeZone?: string
}) {
  const frozen = now != null
  const [ticked, setTicked] = useState(() => Date.now())
  useEffect(() => {
    if (frozen) return
    const id = setInterval(() => setTicked(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [frozen])

  const read = usSessionRead(frozen ? now : ticked, timeZone)
  const stamp = generatedAt != null && generatedAt > 0 ? ` · board struck ${hhmm(generatedAt, timeZone)}` : ''
  return (
    <p className="session-line" data-session={read.kind}>
      {read.text}
      {stamp}
    </p>
  )
}
