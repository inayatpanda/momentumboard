// The edition reader, shared by The paper (its home since owner 2026-08-17:
// "a new fresh tab, move… just the Today paper") and anything else that ever
// needs to paint an edition. Moved verbatim out of Intel.tsx — the paper's
// collapsed-summary shell stayed behind and died with Intel's paper section.

import { useSlice } from '../../lib/useSlice'
import { getReportJson, getReportList } from '../../lib/api'

/** One edition, painted from its own slice: `reports` for the latest,
 * `reports:${date}` for an archive pick — so a cached past edition still
 * paints instantly and never blocks on the network. */
export function EditionFrame({ date }: { date?: string }) {
  const { data } = useSlice(date ? `reports:${date}` : 'reports', () => getReportJson(date))
  if (!data) return <div className="skeleton" style={{ height: '70vh' }} />
  return (
    <>
      <div className="itl-edition-pill-row">
        <span className="pill">{data.date}</span>
      </div>
      {/* sandbox="" is deliberate: no scripts, no navigation, no same-origin — the
          edition can only ever paint, never act. */}
      <iframe className="itl-frame" sandbox="" srcDoc={data.html} title="Today's paper" />
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
