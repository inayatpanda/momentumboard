// PastCalls (plan Task 17) — every call the engine has published on this
// name, newest first, each with what price then did.
//
// TWO RULES:
//  • the grade pill obeys the same law as everywhere else — only a call that
//    was actually SIZED ever earned a letter. A shadow (never a live size)
//    and an observation (real, graded, but unplaceable) show none.
//  • green/red HERE is correct and stays: an outcome pill is P&L, the one
//    thing those colours are reserved for.
//
// "Load older calls" swaps the whole list onto the deep journey slice
// (`journey:SYM:deep`, 250 days) — a separate key with its own cache entry,
// mounted only once the reader asks, so the default page never pays for it.

import { useState } from 'react'
import { useSlice } from '../../lib/useSlice'
import { getJourney, type JourneyCall } from '../../lib/apiViews'
import type { PredOutcome } from '../../lib/api'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'

/** A ledger row that was never a live size carries no honest letter. */
const wasSized = (c: JourneyCall) => !c.shadow && !c.observation

const signed = (pct: number) => `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`

function OutcomePill({ horizon, o }: { horizon: string; o: PredOutcome }) {
  return (
    <span className={`pill num ${o.excessPct >= 0 ? 'long' : 'short'}`}>
      {horizon} {signed(o.excessPct)} vs SPY{o.stopped ? ' · stopped' : o.hit ? ' · hit' : ''}
    </span>
  )
}

function CallRow({ c }: { c: JourneyCall }) {
  const pm = c.postMortem?.sentence ?? c.postMortem?.detail ?? null
  return (
    <div className="card sp-call">
      <div className="sp-call-top">
        <span className="num sp-call-date">{c.date}</span>
        <span className={`pill ${c.side}`}>{c.side === 'long' ? 'Long' : 'Short'}</span>
        {wasSized(c) && (
          <span className="pill accent" aria-label={`Grade ${c.grade}`}>
            {c.grade}
          </span>
        )}
        {c.shadow && <span className="pill">shadow — never a live size</span>}
        {c.observation && <span className="pill">observation — no ISA route</span>}
      </div>
      <div className="sp-call-out">
        {c.outcome10 && <OutcomePill horizon="10d" o={c.outcome10} />}
        {c.outcome21 && <OutcomePill horizon="21d" o={c.outcome21} />}
        {!c.outcome10 && !c.outcome21 && <span className="cc-reason">Not yet matured — no graded outcome.</span>}
      </div>
      {c.wildcard && (
        <div className="cc-wildcard">
          <span className="pill">{WILDCARD_LABEL}</span>
          <span>{WILDCARD_WARNING}</span>
        </div>
      )}
      {pm && <p className="sp-pm">{pm}</p>}
    </div>
  )
}

function CallList({ calls }: { calls: JourneyCall[] }) {
  const rows = [...calls].sort((a, b) => b.date.localeCompare(a.date))
  if (rows.length === 0) return <p className="cc-reason">The engine has never published a call on this name.</p>
  return (
    <>
      {rows.map(c => (
        <CallRow key={c.id} c={c} />
      ))}
    </>
  )
}

/** The deep list: its own slice key, its own fetch, mounted only on demand.
 * Until the deep bytes land it keeps painting the shallow list it replaced —
 * asking for more history must never blank the history already on screen. */
function DeepCalls({ sym, fallback }: { sym: string; fallback: JourneyCall[] }) {
  const { data } = useSlice(`journey:${sym}:deep`, () => getJourney(sym, 250))
  return <CallList calls={data?.calls ?? fallback} />
}

export function PastCalls({ sym, calls }: { sym: string; calls: JourneyCall[] }) {
  const [deep, setDeep] = useState(false)
  return (
    <section aria-label="Past calls">
      <p className="sec-label">Past calls</p>
      {deep ? <DeepCalls sym={sym} fallback={calls} /> : <CallList calls={calls} />}
      {!deep && calls.length > 0 && (
        <button className="stx-showmore" onClick={() => setDeep(true)}>
          Load older calls
        </button>
      )}
    </section>
  )
}
