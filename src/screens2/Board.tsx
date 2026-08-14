// Board (plan Task 14) — the whole engine's mind as one conviction-ranked
// scroll (brainstorm/67693-1786687483/content/home-layout.html, option B
// "Ranked board"): sized calls as full CallCards, then developing/watch as
// thinner ranked rows, then observations/nearest-misses each with their own
// one-line reason (same taxonomy Today's CountsRail and the old
// src/components/EngineBoard.tsx:70-121 use — new presentation, same
// meanings), ending with "The engine said no": every candidate a gate
// refused today.
//
// DATA (two slices, amendment-gated):
//   `board` — same slice Today reads, paints from Dexie first.
//   `funnel:${board.date}` — the day's refusal trace, fetched ONLY once the
//   board's date is known (never `funnel:latest`, DS-17), and only mounted
//   once `blob` resolves — the amendment overriding the original brief's
//   `funnel:latest` fetch. The "engine said no" <details> starts collapsed
//   unless the page was reached at #refused (read from `window.location.hash`
//   on mount — real browser navigation, independent of wouter's location
//   hook, which is why this reads the DOM global directly).

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { getBoardSlice, getFunnel } from '../lib/apiViews'
import type { EnginePrediction } from '../lib/api'
import { CallCard } from './parts/CallCard'
import { RefusalRow } from './parts/RefusalRow'

// one ranked, unsized row: sym, side, a short note (stage word for
// developing/watch, the distinct one-line reason for observations/near
// misses), and — only when it carries one — the conviction number.
function BoardThinRow({ p, note, conviction }: { p: EnginePrediction; note: string; conviction?: number }) {
  return (
    <Link href={`/stock/${p.sym}`} className="board-row board-row-thin pressable">
      <span className="board-row-main">
        <b>{p.sym}</b>
        <span className={`pill ${p.side}`}>{p.side === 'long' ? 'Long' : 'Short'}</span>
      </span>
      <span className="board-row-detail">{note}</span>
      {conviction != null && <span className="num board-row-core">{Math.round(conviction)}</span>}
    </Link>
  )
}

function RefusedSection({ date }: { date: string }) {
  const { data } = useSlice(`funnel:${date}`, () => getFunnel(date))
  // Real browser navigation lands the hash in window.location regardless of
  // which locationHook is routing the app (wouter's memory hook, used in
  // tests, never touches it) — checked once, at mount, per DS-17.
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.location.hash === '#refused')
  const refusals = data?.refusals ?? []
  return (
    <details id="refused" className="card board-refused" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
      <summary className="sec-label">The engine said no{data && !data.missing ? ` · ${refusals.length}` : ''}</summary>
      {data?.missing ? (
        <p className="cc-reason">No refusals recorded for {date}.</p>
      ) : refusals.length === 0 ? (
        data ? <p className="cc-reason">Nothing refused — every candidate cleared its gates today.</p> : null
      ) : (
        refusals.map(r => <RefusalRow key={r.key} row={r} />)
      )}
    </details>
  )
}

export default function Board() {
  const { data } = useSlice('board', getBoardSlice)
  const blob = data?.board ?? null
  const rows = blob?.board ?? []
  // same taxonomy as src/components/EngineBoard.tsx:251-255 and Today's
  // CountsRail — sized = live cards; the rest split into developing/watch
  // (thin, ranked) and observations/near-misses (thin, their own reason).
  const sized = rows.filter(p => !p.watchOnly)
  const developing = rows.filter(p => p.watchOnly && !p.nearMiss && !p.observation && p.horizon === 'developing')
  const watch = rows.filter(p => p.watchOnly && !p.nearMiss && !p.observation && p.horizon !== 'developing')
  const observations = rows.filter(p => p.observation && !p.nearMiss)
  const nearMisses = rows.filter(p => p.nearMiss)

  return (
    <div className="board2">
      <h1>Board</h1>
      {blob === null ? (
        <>
          <div className="skeleton" style={{ height: 118, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 118 }} />
        </>
      ) : (
        <>
          {rows.length === 0 && <p className="cc-reason">No edge today — every candidate failed the gates.</p>}

          {sized.length > 0 && (
            <div className="today-cards">
              {sized.map(row => (
                <CallCard key={row.id} row={row} />
              ))}
            </div>
          )}

          {developing.length > 0 && <p className="sec-label">Developing — building over 2–4 weeks</p>}
          {developing.map(p => (
            <BoardThinRow key={p.id} p={p} note="developing" conviction={Math.abs(p.composite)} />
          ))}

          {watch.length > 0 && <p className="sec-label">Watch — short-term observations</p>}
          {watch.map(p => (
            <BoardThinRow key={p.id} p={p} note="watch" conviction={Math.abs(p.composite)} />
          ))}

          {observations.length > 0 && <p className="sec-label">Observations — no ISA route</p>}
          {observations.map(p => (
            <BoardThinRow key={p.id} p={p} note="no ISA route — observation only" />
          ))}

          {nearMisses.length > 0 && <p className="sec-label">Nearest misses</p>}
          {nearMisses.map(p => (
            <BoardThinRow key={p.id} p={p} note="nearest miss — no size" />
          ))}
        </>
      )}
      {/* the funnel's day pairs with the BOARD's date — never funnel:latest */}
      {blob?.date && <RefusedSection date={blob.date} />}
    </div>
  )
}
