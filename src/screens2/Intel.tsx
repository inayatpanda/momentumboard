// Intel (plan Task 19; CX-19) — the paper + news + social feeds. This is
// news's ONLY home in the app (spec §3.5): a side dish, never the meal, so
// the three sections below sit as three independent cards — nothing here
// competes with a call card for attention.
//
// Three stacked sections, each its own `useSlice` + skeleton: one section's
// failure (a rejected fetch, or simply not yet cached) must never blank the
// other two. `useSlice` already never throws into render — a failed fetch
// just flips `offline` and leaves `data` at whatever was cached (null on a
// cold slice) — so this file needs no error boundary of its own.
//
// The paper renders INLINE via the /report?format=json envelope
// (netlify/functions/report.mts; report.format.test.ts), dropped into a
// SANDBOXED srcDoc iframe (sandbox="" — no scripts, no navigation, no
// same-origin) rather than an iframe `src` navigation, which the report
// route's own X-Frame-Options would block outright.

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { getNewsDesk, getReportJson, getReportList, getSocialPulse } from '../lib/api'

const PAGE = 30

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** One edition, painted from its own slice: `reports` for the latest,
 * `reports:${date}` for an archive pick — so a cached past edition still
 * paints instantly and never blocks on the network. */
function EditionFrame({ date }: { date?: string }) {
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

/** The archive: mounted only once the reader opens the <details> — so a
 * reader who never taps it never pays for the report-list fetch either. */
function ArchiveList({ activeDate, onPick }: { activeDate: string | null; onPick: (date: string) => void }) {
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

function PaperSection() {
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)

  return (
    <section className="card itl-section">
      <h2 className="sec-label">Today's paper</h2>
      <EditionFrame key={openDate ?? 'latest'} date={openDate ?? undefined} />
      <details className="itl-archive" open={archiveOpen}>
        <summary
          onClick={e => {
            e.preventDefault()
            setArchiveOpen(v => !v)
          }}
        >
          Archive
        </summary>
        {archiveOpen && <ArchiveList activeDate={openDate} onPick={setOpenDate} />}
      </details>
    </section>
  )
}

function NewsSection() {
  const { data } = useSlice('intel:news', getNewsDesk)
  const [visible, setVisible] = useState(PAGE)

  return (
    <section className="card itl-section">
      <h2 className="sec-label">News desk</h2>
      {!data ? (
        <div className="skeleton" style={{ height: 160 }} />
      ) : data.length === 0 ? (
        <p className="cc-reason">Nothing fresh right now.</p>
      ) : (
        <>
          <div className="itl-news-list">
            {data.slice(0, visible).map(item => (
              <div key={item.url} className="itl-news-row">
                <a className="itl-news-title" href={item.url} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
                <div className="itl-news-meta">
                  <span className="itl-news-host">{hostOf(item.url)}</span>
                  {item.syms.map(s => (
                    <Link key={s} href={`/stock/${s}`} className="pill">
                      {s}
                    </Link>
                  ))}
                  <span className="pill accent num">{item.score}</span>
                </div>
              </div>
            ))}
          </div>
          {visible < data.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(data.length)}>
              Show more ({data.length - visible})
            </button>
          )}
        </>
      )}
    </section>
  )
}

function SocialSection() {
  const { data } = useSlice('intel:social', getSocialPulse)
  const [visible, setVisible] = useState(PAGE)
  const rows = data?.pulse ?? []

  return (
    <section className="card itl-section">
      <h2 className="sec-label">Social pulse</h2>
      {!data ? (
        <div className="skeleton" style={{ height: 160 }} />
      ) : rows.length === 0 && data.alsoLoud.length === 0 && data.discoveries.length === 0 ? (
        <p className="cc-reason">Nothing loud enough to show right now.</p>
      ) : (
        <>
          {data.alsoLoud.length > 0 && (
            <div className="itl-loud-row">
              <span>Also loud:</span>
              {data.alsoLoud.map(s => (
                <Link key={s} href={`/stock/${s}`} className="pill">
                  {s}
                </Link>
              ))}
            </div>
          )}
          {data.discoveries.length > 0 && (
            <div className="itl-discoveries">
              {data.discoveries.slice(0, 5).map(d => (
                <Link key={d.sym} href={`/stock/${d.sym}`} className="card pressable itl-discovery">
                  <span className="itl-pulse-sym">{d.sym}</span>
                  {d.companyName && <span className="itl-pulse-name">{d.companyName}</span>}
                  {d.opinion && <p className="cc-reason">{d.opinion}</p>}
                </Link>
              ))}
            </div>
          )}
          <div className="itl-pulse-list">
            {rows.slice(0, visible).map(r => (
              <Link key={r.sym} href={`/stock/${r.sym}`} className="card pressable itl-pulse-row">
                <span className="itl-pulse-sym">{r.sym}</span>
                {r.name && <span className="itl-pulse-name">{r.name}</span>}
                <span className="itl-pulse-meta">
                  {r.redditMentions != null && <span className="num">{r.redditMentions} mentions</span>}
                  {r.surging && <span className="pill accent">surging{r.surgeMultiple != null ? ` ${r.surgeMultiple.toFixed(1)}x` : ''}</span>}
                </span>
              </Link>
            ))}
          </div>
          {visible < rows.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(rows.length)}>
              Show more ({rows.length - visible})
            </button>
          )}
        </>
      )}
    </section>
  )
}

export default function Intel() {
  return (
    <div className="itl">
      <h1>Intel</h1>
      <PaperSection />
      <NewsSection />
      <SocialSection />
    </div>
  )
}
