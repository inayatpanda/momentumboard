// THREE HEADLINES ON TODAY (dynamism wave, feature 6).
//
// News has one home in this app — Intel (spec §3.5: a side dish, never the
// meal) — and that rule stands. What it cost was motion: the home screen was
// the same six cards from 06:42 until the next morning's run, while the desk
// underneath it took in a headline an hour. Three lines fix that without
// making Today a feed: the newest three, stamped, and every one of them a door
// into the desk itself rather than out to a publisher.
//
// Reads the SAME `intel:news` slice Intel's own news section reads, so
// arriving on Intel from here paints instantly from Dexie — no second trip.
//
// SECONDARY-SECTION RULE (OpenCallsStrip's header states it): no skeleton, and
// no bytes means no section at all. A home screen must never show a grey box
// where a thing it could not fetch would have been.

import { Link } from 'wouter'
import { getNewsDesk } from '../../lib/api'
import { decodeEntities, relativeStamp } from '../../lib/format'
import { useSlice } from '../../lib/useSlice'

const HEADLINE_CAP = 3

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function TodayHeadlines({ now }: { now?: number }) {
  const { data } = useSlice('intel:news', getNewsDesk)
  // NEWEST FIRST, asserted rather than assumed of the server — the same guard
  // Intel's news section states: a re-triaged or merged feed can arrive out of
  // order, and an out-of-order dated list is worse than an undated one.
  const rows = data ? [...data].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, HEADLINE_CAP) : []
  if (rows.length === 0) return null
  return (
    <section className="th-strip" aria-label="Headlines">
      <p className="sec-label">Headlines — the desk's newest</p>
      <div className="card th-list">
        {rows.map((item, i) => (
          <Link key={`${item.url}-${i}`} href="/intel#news" className="th-row">
            <span className="th-title">{decodeEntities(item.title)}</span>
            <span className="th-meta">
              <span className="th-at">{relativeStamp(item.at, now)}</span>
              <span className="th-src">{item.source ?? hostOf(item.url)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}
