// BoardColumn (plan Task 14, extracted at Task 22) — the engine's whole mind
// as one conviction-ranked list: sized calls as full CallCards, then
// developing/watch as thinner ranked rows, then observations/nearest-misses
// each with their own one-line reason (same taxonomy Today's CountsRail and
// the old src/components/EngineBoard.tsx:70-121 use), ending with "The engine
// said no": every candidate a gate refused today.
//
// This is the BODY of the /board screen and, at ≥1200px, the desk's board
// column (src/shell/DeskLayout.tsx) — ONE component, rendered in one place at
// a time by the router, so the ranked list can never drift between the two
// surfaces and the `board` slice is read through the same cache either way.
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
import { useSlice } from '../../lib/useSlice'
import { getBoardSlice, getFunnel } from '../../lib/apiViews'
import type { EnginePrediction } from '../../lib/api'
import { splitBoardRows } from '../../lib/boardTaxonomy'
import { CallCard } from './CallCard'
import { CohortPill } from './CohortMarks'
import { RefusalRow } from './RefusalRow'

// one ranked, unsized row: sym, side, a short note (stage word for
// developing/watch, the distinct one-line reason for observations/near
// misses), and — only when it carries one — the conviction number.
function BoardThinRow({ p, note, conviction }: { p: EnginePrediction; note: string; conviction?: number }) {
  return (
    <Link href={`/stock/${p.sym}`} className="board-row board-row-thin pressable">
      <span className="board-row-main">
        <b>{p.sym}</b>
        <span className={`pill ${p.side}`}>{p.side === 'long' ? 'Long' : 'Short'}</span>
        {/* which partition measured this row (crypto-v2 wave, finding 7) — a
            label, never a grade: the row-kind law is untouched by it */}
        <CohortPill cohort={p.cohort} />
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

export default function BoardColumn() {
  const { data } = useSlice('board', getBoardSlice)
  const blob = data?.board ?? null
  const rows = blob?.board ?? []
  // same taxonomy as src/components/EngineBoard.tsx:251-255 and Today's
  // CountsRail — sized = live cards; the rest split into developing/watch
  // (thin, ranked) and observations/near-misses (thin, their own reason).
  // One shared helper (src/lib/boardTaxonomy.ts) so this file, Today, and
  // CountsRail can never drift on what counts as what.
  const { sized, developing, watch, observations, nearMisses } = splitBoardRows(rows)

  return (
    <>
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
      {/* the funnel's day pairs with the BOARD's date — never funnel:latest.
          `key={blob.date}` forces a full remount on a date change so a stale
          render can never show yesterday's refusals beside today's date —
          without it, useSlice's own state would carry the OLD date's cached
          rows into the very same commit that already shows the NEW date. */}
      {blob?.date && <RefusedSection key={blob.date} date={blob.date} />}
    </>
  )
}
