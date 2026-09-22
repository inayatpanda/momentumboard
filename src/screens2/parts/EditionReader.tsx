// The edition reader, shared by The paper (its home since owner 2026-08-17:
// "a new fresh tab, move… just the Today paper") and anything else that ever
// needs to paint an edition. Moved verbatim out of Intel.tsx — the paper's
// collapsed-summary shell stayed behind and died with Intel's paper section.

import { useState } from 'react'
import { useSlice } from '../../lib/useSlice'
import {
  getBulletinJson,
  getBulletins,
  getReportJson,
  getReportList,
  type BulletinKind,
} from '../../lib/api'

const editionTime = (at: number) =>
  new Date(at * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  })

/** One edition, painted from its own slice: `reports` for the latest,
 * `reports:${date}` for an archive pick — so a cached past edition still
 * paints instantly and never blocks on the network. */
export function EditionFrame({ date }: { date?: string }) {
  const { data } = useSlice(date ? `reports:${date}` : 'reports', () => getReportJson(date))
  if (!data) return <div className="skeleton" style={{ height: '70vh' }} />
  return (
    <>
      <div className="itl-edition-pill-row">
        <span className="pill accent">Morning</span>
        <span className="pill">{data.date}</span>
        <span className="itl-published">Published {editionTime(data.at)} UK</span>
      </div>
      {/* sandbox="" is deliberate: no scripts, no navigation, no same-origin — the
          edition can only ever paint, never act. */}
      <iframe className="itl-frame" sandbox="" srcDoc={data.html} title="Today's paper" />
    </>
  )
}

function BulletinFrame({ date, kind }: { date: string; kind: BulletinKind }) {
  const { data } = useSlice(`reports:${kind}:${date}`, () => getBulletinJson(date, kind))
  const label = kind === 'premarket' ? 'Pre-market' : 'Evening'
  if (!data) return <div className="skeleton" style={{ height: '70vh' }} />
  return (
    <>
      <div className="itl-edition-pill-row">
        <span className="pill accent">{label}</span>
        <span className="pill">{data.date}</span>
        <span className="itl-published">Published {editionTime(data.at)} UK</span>
      </div>
      <iframe className="itl-frame" sandbox="" srcDoc={data.html} title={`${label} report`} />
    </>
  )
}

/** Pre-market and evening editions share one index, then filter it before
 * painting their own archive. The selected edition is therefore never mixed
 * with the other bulletin type even when both published on the same date. */
export function BulletinReader({ kind }: { kind: BulletinKind }) {
  const { data: entries } = useSlice('bulletins:list', getBulletins)
  const [picked, setPicked] = useState<string | null>(null)
  if (!entries) return <div className="skeleton" style={{ height: '70vh' }} />
  const dates = [...new Set(entries.filter(entry => entry.kind === kind).map(entry => entry.date))]
  const activeDate = picked && dates.includes(picked) ? picked : dates[0]
  const label = kind === 'premarket' ? 'pre-market brief' : 'evening report'
  if (!activeDate) {
    return <p className="cc-reason itl-edition-empty">No {label} has been published yet.</p>
  }
  return (
    <>
      <BulletinFrame key={`${kind}:${activeDate}`} date={activeDate} kind={kind} />
      <details className="itl-archive">
        <summary>Archive · {dates.length} {dates.length === 1 ? 'edition' : 'editions'}</summary>
        <div className="itl-archive-list">
          {dates.map(date => (
            <button key={date} type="button" className={`pill${date === activeDate ? ' accent' : ''}`} onClick={() => setPicked(date)}>
              {date}
            </button>
          ))}
        </div>
      </details>
    </>
  )
}

/** The archive: mounted only when its <details> opens — a reader who never
 * taps it never pays for the report-list fetch either. */
export function ArchiveList({ activeDate, onPick }: { activeDate: string | null; onPick: (date: string) => void }) {
  const { data: dates } = useSlice('reports:list', getReportList)
  if (!dates) return <div className="skeleton" style={{ height: 32, marginTop: 8 }} />
  if (dates.length === 0) return <p className="cc-reason">No past editions yet.</p>
  return (
    <div className="itl-archive-list">
      {dates.map(d => (
        <button key={d} type="button" className={`pill${d === activeDate ? ' accent' : ''}`} onClick={() => onPick(d)}>
          {d}
        </button>
      ))}
    </div>
  )
}
