// THE WEEK AHEAD — Sunday's edition previews the coming Monday-to-Friday.
//
// It replaces the old "Week-Ahead Preview" cloud routine, which wrote a
// free-hand article against the Netlify site and died with it at the Cloudflare
// cutover. This is the in-pipeline version: the Sunday paper already runs (the
// weekend edition), and on that one day it gains a day-by-day table and a
// written preview.
//
// Same discipline as the Tape: every fact the writer may quote — the dates, the
// weekdays, the events, who reports when, where the indices closed against their
// averages — is computed HERE and handed over as finished fragments. The writer
// interprets; it never works out a weekday or a level for itself.
//
// Deliberately NOT here: the publisher's own positions. The paper reaches other
// readers, so the personal book stays out of it (the 2026-07-15 rule).

import type { Candle } from '../../../shared/types'
import type { CalendarRow } from './newspaper'
import type { EarningsTime, NasdaqEarningsRow } from './nasdaqEarnings'
import { tapeEventLines, type TapeEvent } from './paperFacts'
import { reportStockName } from './reportStockNames'

const LONDON = 'Europe/London'

/** The London calendar date of an instant, YYYY-MM-DD. */
export const londonISO = (sec: number): string => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: LONDON })

const addDaysISO = (iso: string, days: number): string => {
  const d = new Date(`${iso}T12:00:00Z`) // noon UTC: no DST edge can move the date
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Sunday in LONDON is week-ahead day. UTC would be wrong for the hour after
 * midnight in BST, and the paper is dated in London everywhere else. */
export function isWeekAheadDay(nowSec: number): boolean {
  return new Date(nowSec * 1000).toLocaleDateString('en-GB', { weekday: 'long', timeZone: LONDON }) === 'Sunday'
}

/** The five trading dates the preview covers: the Monday after `nowSec` (London)
 * through that Friday. Called on a Sunday that is tomorrow…+5. US holidays stay
 * IN the window — a shut Thursday is itself worth a line in a preview. */
export function weekAheadDates(nowSec: number): string[] {
  const today = londonISO(nowSec)
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay() // 0 = Sunday
  const toMonday = ((8 - dow) % 7) || 7
  return [0, 1, 2, 3, 4].map(i => addDaysISO(today, toMonday + i))
}

/** Earnings worth a line in a week preview. The calendar holds ~100 US names a
 * day, so only the market-movers and the reader's own names make it: anything
 * at or above `minCapUsdM` (default $100B — the prints that move the index),
 * plus every watchlist name at any size. Biggest first within the cap. */
export function weekAheadEarnings(
  rows: readonly NasdaqEarningsRow[],
  dates: readonly string[],
  watchlist: readonly string[] = [],
  opts: { minCapUsdM?: number; max?: number } = {},
): NasdaqEarningsRow[] {
  const minCap = opts.minCapUsdM ?? 100_000
  const max = opts.max ?? 16
  const inWeek = new Set(dates)
  const watched = new Set(watchlist.map(s => s.toUpperCase()))
  const seen = new Set<string>()
  return rows
    .filter(r => inWeek.has(r.date) && ((r.marketCapUsdM ?? 0) >= minCap || watched.has(r.sym.toUpperCase())))
    .sort((a, b) => (b.marketCapUsdM ?? 0) - (a.marketCapUsdM ?? 0))
    .filter(r => (seen.has(r.sym) ? false : (seen.add(r.sym), true)))
    .slice(0, max)
}

/** Economic events inside the window, High impact first, then Medium up to the
 * cap — and back into time order for the table. */
export function weekAheadEvents(events: readonly CalendarRow[], dates: readonly string[], max = 14): CalendarRow[] {
  const inWeek = new Set(dates)
  const rows = events.filter(e => inWeek.has(londonISO(e.at)))
  const high = rows.filter(e => e.impact === 'High')
  const rest = rows.filter(e => e.impact !== 'High')
  return [...high, ...rest].slice(0, max).sort((a, b) => a.at - b.at)
}

export interface WeekAheadEarning {
  sym: string
  name?: string | null
  time: EarningsTime
}

export interface WeekAheadDay {
  date: string // YYYY-MM-DD
  label: string // 'Monday 2 November' — London, rendered once, here
  events: CalendarRow[]
  earnings: WeekAheadEarning[]
  /** False when the SOURCE never reached this week (a feed that had not rolled
   * over, a snapshot that went stale) — so an empty day reads "not published",
   * never "nothing on". A quiet day and a missing calendar are different facts. */
  eventsKnown: boolean
  earningsKnown: boolean
}

/** Does a source reach the week at all? Any row dated inside it, at any size or
 * impact, proves the calendar was read for these days; none proves it was not. */
export function coversWeek(rowDates: Iterable<string>, dates: readonly string[]): boolean {
  const inWeek = new Set(dates)
  for (const d of rowDates) if (inWeek.has(d)) return true
  return false
}

const TIME_WORDS: Record<EarningsTime, string> = { pre: 'before the open', post: 'after the close', unknown: 'time not confirmed' }
export const earningsTimeWords = (t: EarningsTime): string => TIME_WORDS[t] ?? TIME_WORDS.unknown

/** The table's rows: one per date, events and earnings bucketed by London date.
 * A day with nothing on it still gets its row — "nothing scheduled" is the
 * honest content of a quiet Monday. */
export function weekAheadDays(
  dates: readonly string[],
  events: readonly CalendarRow[],
  earnings: readonly NasdaqEarningsRow[],
  names: ReadonlyMap<string, string> = new Map(),
  known: { events: boolean; earnings: boolean } = { events: true, earnings: true },
): WeekAheadDay[] {
  return dates.map(date => ({
    eventsKnown: known.events,
    earningsKnown: known.earnings,
    date,
    label: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    events: events.filter(e => londonISO(e.at) === date),
    // the register first, then the app's own static names — never a bare ticker where a name exists
    earnings: earnings.filter(r => r.date === date).map(r => ({ sym: r.sym, name: reportStockName(r.sym, names.get(r.sym)), time: r.time })),
  }))
}

/** The schedule as fragments, in the Tape's own format, so `correctTapeWeekdays`
 * can hold the written preview to the table exactly as it holds the Tape. */
export function weekAheadEventLines(days: readonly WeekAheadDay[]): TapeEvent[] {
  return tapeEventLines(days.flatMap(d => d.events), Number.MAX_SAFE_INTEGER)
}

/** The day-by-day facts block the writer is handed — one line per day. */
export function weekAheadScheduleBlock(days: readonly WeekAheadDay[]): string {
  const lines = days.map(d => {
    const ev = tapeEventLines(d.events, Number.MAX_SAFE_INTEGER).map(e => e.line)
    const er = d.earnings.map(e => `${e.name ? `${e.name} (${e.sym})` : e.sym} ${earningsTimeWords(e.time)}`)
    const parts = [
      ev.length ? `events: ${ev.join(' | ')}` : d.eventsKnown ? 'no high- or medium-impact US/UK data' : 'economic calendar NOT AVAILABLE — say so, never call the day quiet',
      er.length ? `reporting: ${er.join('; ')}` : d.earningsKnown ? 'no major earnings' : 'earnings calendar NOT AVAILABLE — say so, never call the day quiet',
    ]
    return `- ${d.label}: ${parts.join(' · ')}`
  })
  return `THE WEEK'S SCHEDULE — computed from the calendars, one line per day. Weave in the parts you preview VERBATIM (weekday, time, name, forecast vs previous); never restate a weekday, a time or a number from memory, and never move an event to another day:\n${lines.join('\n')}`
}

const sma = (closes: readonly number[], n: number): number | null =>
  closes.length >= n ? closes.slice(-n).reduce((s, c) => s + c, 0) / n : null

const r2 = (n: number) => Math.round(n * 100) / 100

/** Where an index closed against its 20- and 50-day averages, as one finished
 * sentence. Null when there is not enough history to say it honestly. */
export function indexLevelLine(label: string, candles: readonly Candle[] | null | undefined): string | null {
  const closes = (candles ?? []).map(c => c.c).filter(c => Number.isFinite(c))
  const last = closes.at(-1)
  const m20 = sma(closes, 20)
  const m50 = sma(closes, 50)
  if (last == null || m20 == null || m50 == null) return null
  const side = (avg: number) => (last >= avg ? 'above' : 'below')
  return `${label} last closed at ${r2(last)}, ${side(m20)} its 20-day average (${r2(m20)}) and ${side(m50)} its 50-day average (${r2(m50)})`
}

/** Everything the week-ahead writer may not derive, in one block. */
export function weekAheadFacts(days: readonly WeekAheadDay[], levels: readonly (string | null)[]): string {
  const lv = levels.filter((l): l is string => !!l)
  return [
    weekAheadScheduleBlock(days),
    lv.length ? `WHERE THE INDICES CLOSED THE WEEK — quote these levels exactly, never round or recompute them:\n${lv.map(l => `- ${l}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
