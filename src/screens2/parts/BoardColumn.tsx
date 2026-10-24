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
//
// THE HASH IS A DESTINATION, on both surfaces (final wave, D2). Today's counts
// rail links `/board#developing|#watch|#refused`, and at desk width the pane
// answers /board with a pointer paragraph while THIS column stays mounted — so
// the chip landed somewhere that showed nothing new and the reader was left to
// find the section themselves. The three sections now carry the ids the rail
// names, and this component honours whichever one it was sent to: #refused
// opens the details, #developing/#watch scroll their heading into view.

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useSlice } from '../../lib/useSlice'
import { getBoardSlice, getFunnel } from '../../lib/apiViews'
import type { JourneyFunnelRow } from '../../lib/apiViews'
import type { EnginePrediction } from '../../lib/api'
import type { GateCode } from '../../../shared/engine/types'
import { splitBoardRows } from '../../lib/boardTaxonomy'
import { GATE_LABELS } from '../../lib/gateLabels'
import { NO_BOARD_YET } from '../../lib/copy'
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
      {/* LABELLED, like every other place this number appears (visibility
          wave, 2026-08-17). A bare 51 at the end of a row is a number with no
          noun — RefusalRow has always printed "core 10.0" for the very same
          quantity, so the board was the one surface where the reader had to
          guess. */}
      {conviction != null && <span className="num board-row-core">core {Math.round(conviction)}</span>}
    </Link>
  )
}

/** The live `window.location.hash`.
 *
 * Two triggers, because one is not enough. A real browser hash navigation
 * fires `hashchange`; a wouter <Link href="/board#watch"> is a `pushState`,
 * which fires NOTHING — so the wouter location is watched too, and any change
 * to it re-reads the DOM global. window.location stays the source of truth
 * either way: wouter's own location hook carries no hash at all, and under the
 * memory hook the tests use it carries nothing real. */
const currentHash = () => (typeof window === 'undefined' ? '' : window.location.hash)

function useLocationHash(): string {
  const [loc] = useLocation()
  const [hash, setHash] = useState(currentHash)
  useEffect(() => setHash(currentHash()), [loc])
  useEffect(() => {
    const onHash = () => setHash(currentHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return hash
}

/** THREE HUNDRED AND FIFTY-EIGHT ROWS IS NOT A LIST, IT IS A LANDFILL
 * (visibility wave, 2026-08-17). Ungrouped, "the engine said no · 358" told
 * the reader a number and then buried the only thing that number is FOR: which
 * gate is doing the refusing. Grouped by gate with per-gate counts, the same
 * scroll answers "what stopped the day" in one screen.
 *
 * Ordered by count desc, and STABLE inside that — a gate's own rows keep the
 * server's order, and gates with equal counts keep the order they first appear
 * in, so the section never re-sorts a day's trace into a ranking the server
 * never made. */
export interface RefusalGroup {
  gate: GateCode
  rows: JourneyFunnelRow[]
}

export function groupRefusalsByGate(refusals: JourneyFunnelRow[]): RefusalGroup[] {
  const byGate = new Map<GateCode, JourneyFunnelRow[]>()
  for (const r of refusals) byGate.set(r.gate, [...(byGate.get(r.gate) ?? []), r])
  return [...byGate.entries()].map(([gate, rows]) => ({ gate, rows })).sort((a, b) => b.rows.length - a.rows.length)
}

/** How many refusal ROWS the section paints before offering the rest. The
 * groups above it are always all present — it is the rows inside them that are
 * budgeted, so the shape of the day (which gates, how many each) is complete
 * from the first paint even when the names are not. */
export const REFUSED_PAGE = 50

function RefusedSection({ date, hash }: { date: string; hash: string }) {
  const { data } = useSlice(`funnel:${date}`, () => getFunnel(date))
  const [visible, setVisible] = useState(REFUSED_PAGE)
  // Real browser navigation lands the hash in window.location regardless of
  // which locationHook is routing the app (wouter's memory hook, used in
  // tests, never touches it) — checked at mount per DS-17, and again whenever
  // the hash changes UNDER a mounted column, which is the desk's whole case:
  // the column never unmounts, so mount-only would have answered the chip once
  // per session and never again. Only ever opens — a reader who collapsed it
  // does not get it reopened under them by an unrelated re-render.
  const [open, setOpen] = useState(() => hash === '#refused')
  useEffect(() => {
    if (hash === '#refused') setOpen(true)
  }, [hash])
  const refusals = data?.refusals ?? []
  const groups = groupRefusalsByGate(refusals)
  // the row budget, spent group by group in order
  let budget = visible
  const painted = groups.map(g => {
    const rows = g.rows.slice(0, Math.max(0, budget))
    budget -= rows.length
    return { ...g, rows, total: g.rows.length }
  })
  const hidden = refusals.length - visible
  return (
    <details id="refused" className="card board-refused" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
      {/* A CHEVRON, so the bar reads as something that opens (visibility wave).
          The default marker is suppressed for the token look, which left a flat
          strip nothing invited the reader to press. */}
      <summary className="sec-label">
        <span className="board-refused-chev" aria-hidden="true">
          ›
        </span>
        The engine said no{data && !data.missing ? ` · ${refusals.length}` : ''}
      </summary>
      {data?.missing ? (
        <p className="cc-reason">No refusals recorded for {date}.</p>
      ) : refusals.length === 0 ? (
        data ? <p className="cc-reason">Nothing refused — every candidate cleared its gates today.</p> : null
      ) : (
        <>
          {painted.map(g => (
            <div className="board-refused-group" key={g.gate}>
              <p className="sec-label board-refused-gate">
                {GATE_LABELS[g.gate]} · <span className="num">{g.total}</span>
              </p>
              {g.rows.map(r => (
                <RefusalRow key={r.key} row={r} showGate={false} />
              ))}
            </div>
          ))}
          {hidden > 0 && (
            <button type="button" className="stx-showmore board-refused-more" onClick={() => setVisible(refusals.length)}>
              Show {hidden} more
            </button>
          )}
        </>
      )}
    </details>
  )
}

export default function BoardColumn() {
  const { data } = useSlice('board', getBoardSlice)
  const hash = useLocationHash()
  const blob = data?.board ?? null
  const rows = blob?.board ?? []
  // same taxonomy as src/components/EngineBoard.tsx:251-255 and Today's
  // CountsRail — sized = live cards; the rest split into developing/watch
  // (thin, ranked) and observations/near-misses (thin, their own reason).
  // One shared helper (src/lib/boardTaxonomy.ts) so this file, Today, and
  // CountsRail can never drift on what counts as what.
  const { sized, developing, watch, observations, nearMisses } = splitBoardRows(rows)

  // …and the two scroll targets. Re-run on `rows.length` as well as the hash:
  // the chip usually lands here before the board slice has painted, and there
  // is nothing to scroll to until it has. `scrollIntoView` is optional-called —
  // jsdom ships none, and this is chrome, not a behaviour worth crashing over.
  useEffect(() => {
    if (hash !== '#developing' && hash !== '#watch') return
    document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [hash, rows.length])

  return (
    <>
      {data && blob === null ? (
        // resolved-and-empty is an ANSWER (cold store, pre-run morning) — an
        // empty state, never a skeleton that looks hung (walkthrough A1)
        <p className="cc-reason">{NO_BOARD_YET}</p>
      ) : blob === null ? (
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

          {/* THE ANCHOR IS UNCONDITIONAL (visibility wave, 2026-08-17). These
              ids are Today's counts-rail destinations (D2), and they were
              rendered only when the section had rows — so on a day with
              nothing developing, "Developing · 0" landed the reader at a
              heading that did not exist and the page simply did not move. A
              heading that says the section is empty is an answer; a missing
              anchor is a dead link. */}
          <p className="sec-label" id="developing">
            Developing · <span className="num">{developing.length}</span>
            {developing.length === 0 ? ' — nothing building today' : ' — building over 2–4 weeks'}
          </p>
          {developing.map(p => (
            <BoardThinRow key={p.id} p={p} note="developing" conviction={Math.abs(p.composite)} />
          ))}

          <p className="sec-label" id="watch">
            Watch · <span className="num">{watch.length}</span>
            {watch.length === 0 ? ' — nothing on watch today' : ' — short-term observations'}
          </p>
          {watch.map(p => (
            <BoardThinRow key={p.id} p={p} note="watch" conviction={Math.abs(p.composite)} />
          ))}

          {observations.length > 0 && <p className="sec-label">Observations — no ISA route</p>}
          {observations.map(p => (
            <BoardThinRow key={p.id} p={p} note="no suitable ISA investment — observation only" />
          ))}

          {nearMisses.length > 0 && <p className="sec-label">Nearest misses</p>}
          {nearMisses.map(p => (
            <BoardThinRow key={p.id} p={p} note="Close to qualifying — no trade plan" />
          ))}
        </>
      )}
      {/* the funnel's day pairs with the BOARD's date — never funnel:latest.
          `key={blob.date}` forces a full remount on a date change so a stale
          render can never show yesterday's refusals beside today's date —
          without it, useSlice's own state would carry the OLD date's cached
          rows into the very same commit that already shows the NEW date. */}
      {blob?.date && <RefusedSection key={blob.date} date={blob.date} hash={hash} />}
    </>
  )
}
