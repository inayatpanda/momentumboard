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

import { Link } from 'wouter'
import type { EventRadarEntry } from '../../lib/api'
import { shortDateWithWeekday } from '../../lib/format'

const RADAR_CAP = 6

/** "in 3d" is only true for a future print; the pass can leave a same-day or
 * just-passed row on the blob, and "in 0d"/"in −1d" is not English. */
function whenWord(days: number): string {
  if (days <= 0) return days === 0 ? 'reports today' : 'reported'
  if (days === 1) return 'reports tomorrow'
  return `reports in ${days}d`
}

export function EventRadarStrip({ radar }: { radar: { entries: EventRadarEntry[] } | null | undefined }) {
  const entries = radar?.entries ?? []
  if (entries.length === 0) return null
  const nearest = [...entries].sort((a, b) => a.daysToPrint - b.daysToPrint).slice(0, RADAR_CAP)
  return (
    <section className="er-strip" aria-label="Event radar">
      <p className="sec-label">The event radar — dated prints, never calls</p>
      <div className="card er-list">
        {nearest.map(e => (
          <div className="er-row" key={`${e.sym}-${e.date}`}>
            <Link href={`/stock/${e.sym}`} className="er-sym">
              {e.sym}
            </Link>
            <span className="er-when">{whenWord(e.daysToPrint)}</span>
            <span className="num er-date">{shortDateWithWeekday(e.date)}</span>
            {e.stage && <span className="pill er-stage">{e.stage}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}
