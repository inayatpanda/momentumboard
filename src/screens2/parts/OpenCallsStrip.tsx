// Open calls, still walking (owner iteration 2) — the money already on the
// table, on the home screen.
//
// Today painted only what was published THIS MORNING, so a reader with three
// live calls from last week opened the app and saw nothing about them; the
// re-walk existed (`open-trace`, one entry per still-open call) and was
// reachable only one tap deep on a per-symbol journey. This is the compact
// index of it: one row a call, the verdict word carrying its own colour
// because "still on", "intact" and "weakening" are three different states
// (the same three OpenTraceCard spells out in full on the stock page).
//
// SECONDARY BY CONSTRUCTION: no skeleton, ever. Nothing here is worth a
// placeholder on a screen whose subject is today's calls — the section simply
// is not there until the bytes are.

import { Link } from 'wouter'
import type { OpenTraceEntry } from '../../lib/api'

/** still-on = the engine would publish it again today (accent); intact = it
 * would not, but nothing has broken (dim); weakening = the evidence behind it
 * is thinner than when it was called (warn).
 *
 * EXPORTED, because ChannelPicksStrip says the same three words about the same
 * three states — and a verdict vocabulary that lived in two files would drift
 * the way the row-kind law did before boardTaxonomy.ts took it. */
export const VERDICT_WORD: Record<NonNullable<OpenTraceEntry['verdict']>, string> = {
  'still-on': 'still on',
  intact: 'intact',
  weakening: 'weakening',
}
export const VERDICT_CLASS: Record<NonNullable<OpenTraceEntry['verdict']>, string> = {
  'still-on': 'on',
  intact: 'flat',
  weakening: 'weak',
}

/** A row whose level has been crossed has no verdict — the engine stops
 * opining once the trade is mechanically over. Say what happened instead of
 * printing an empty slot. */
export const crossedWord = (status: OpenTraceEntry['status']) => (status === 'stopped' ? 'stopped out' : status === 'target' ? 'hit target' : '')

export function OpenCallsStrip({ entries }: { entries: OpenTraceEntry[] | undefined }) {
  if (!entries || entries.length === 0) return null
  return (
    <section className="oc-strip" aria-label="Open calls">
      <p className="sec-label">Open calls, still walking</p>
      <div className="card oc-list">
        {entries.map(e => {
          const progress = Math.max(0, Math.min(100, e.progressPct ?? 0))
          const word = e.verdict ? VERDICT_WORD[e.verdict] : crossedWord(e.status)
          const cls = e.verdict ? VERDICT_CLASS[e.verdict] : 'flat'
          return (
            <div className="oc-row" key={e.id}>
              <Link href={`/stock/${e.sym}`} className="oc-sym">
                {e.sym}
              </Link>
              <span className={`pill ${e.side}`}>{e.side}</span>
              {word && <span className={`oc-verdict ${cls}`}>{word}</span>}
              <span className="convbar oc-bar">
                <i style={{ width: `${progress}%` }} />
              </span>
              <span className="num oc-day">day {e.day}</span>
              <span className="num oc-move">
                {e.movePct >= 0 ? '+' : '−'}
                {Math.abs(e.movePct).toFixed(1)}%
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
