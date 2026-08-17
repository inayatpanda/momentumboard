// The event radar (owner iteration 2) — the dated binaries already on the
// engine's calendar, on the home screen.
//
// Explicitly NOT calls: the engine refuses to bet a print (earningsRisk still
// shadows those trades). The radar exists so a 26%-overnight surprise is never
// a name the reader had never heard of — which only works if it is somewhere
// the reader actually looks. The board slice has carried it since the radar
// shipped and no v2 screen read a character of it.
//
// Nearest print first, six at most, no skeleton (secondary — see
// OpenCallsStrip's header for the rule).
//
// CLIENT TRUTH (dynamism wave, feature 5). `daysToPrint` is BAKED INTO THE
// BLOB by the morning run and goes stale the moment the day turns: Friday's
// blob, read on Saturday, said "reports today" about a print that happened
// yesterday. The distance is recomputed here on every render, from the entry's
// own date against the reader's clock — the server's number survives only as a
// fallback for an entry whose date will not parse.

import { Link } from 'wouter'
import type { EventRadarEntry } from '../../lib/api'
import { shortDateWithWeekday } from '../../lib/format'
import { daysBetweenIso, londonToday } from '../../lib/londonDay'

const RADAR_CAP = 6

/** Whole days from the reader's today to the print, on the LONDON calendar the
 * engine dates everything by. Falls back to the blob's own number only when
 * the entry has no readable date. */
export function radarDays(entry: Pick<EventRadarEntry, 'date' | 'daysToPrint'>, nowMs: number): number {
  return daysBetweenIso(londonToday(nowMs), entry.date) ?? entry.daysToPrint
}

/** "in 3d" is only true for a future print; a date already past is a print
 * whose READ has not landed yet — the engine grades it in a later pass — and
 * saying "reports today" about it is simply false. */
export function whenWord(days: number): string {
  if (days < 0) return "reported — awaiting the print's read"
  if (days === 0) return 'reports today'
  if (days === 1) return 'reports tomorrow'
  return `reports in ${days}d`
}

export function EventRadarStrip({ radar, now }: { radar: { entries: EventRadarEntry[] } | null | undefined; now?: number }) {
  const entries = radar?.entries ?? []
  if (entries.length === 0) return null
  const nowMs = now ?? Date.now()
  const dated = entries.map(e => ({ e, days: radarDays(e, nowMs) }))
  // Nearest FUTURE print first; the ones already reported fall to the back,
  // most recent first. A print that has happened is not the thing the reader
  // is waiting on.
  const nearest = dated
    .sort((a, b) => {
      const ahead = (d: number) => (d >= 0 ? 0 : 1)
      if (ahead(a.days) !== ahead(b.days)) return ahead(a.days) - ahead(b.days)
      return a.days >= 0 ? a.days - b.days : b.days - a.days
    })
    .slice(0, RADAR_CAP)
  return (
    <section className="er-strip" aria-label="Event radar">
      <p className="sec-label">The event radar — dated prints, never calls</p>
      <div className="card er-list">
        {nearest.map(({ e, days }) => (
          <div className="er-row" key={`${e.sym}-${e.date}`}>
            <Link href={`/stock/${e.sym}`} className="er-sym">
              {e.sym}
            </Link>
            <span className="er-when">{whenWord(days)}</span>
            <span className="num er-date">{shortDateWithWeekday(e.date)}</span>
            {e.stage && <span className="pill er-stage">{e.stage}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}
