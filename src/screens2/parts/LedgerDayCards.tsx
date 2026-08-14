// LedgerDayCards (plan Task 20) — the ledger's receipts, grouped by day, each
// prediction as a card. Replaces the legacy 11-column sideways table with the
// SAME row-kind law CallCard/PastCalls already use: a letter grade is a read
// on evidence only a sized, live row ever cleared (rowKind/unsizedReason,
// src/lib/boardTaxonomy.ts). A ledger row adds ONE more way to be unsized that
// the board never carries — `shadow` (never a live size, Stage 3's suppressed
// hypothesis) — so the grade pill is gated on both the shared law AND !shadow,
// and shadow gets its own honest pill exactly like PastCalls.tsx.

import { Link } from 'wouter'
import type { LedgerDay, JourneyCall } from '../../lib/apiViews'
import type { PredOutcome } from '../../lib/api'
import { rowKind, unsizedReason } from '../../lib/boardTaxonomy'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'

const signed = (pct: number) => `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`

function OutcomePill({ horizon, o }: { horizon: string; o: PredOutcome }) {
  return (
    <span className={`pill num ${o.excessPct >= 0 ? 'long' : 'short'}`}>
      {horizon} {signed(o.excessPct)} vs SPY{o.stopped ? ' · stopped' : o.hit ? ' · hit' : ''}
    </span>
  )
}

function LedgerCard({ c }: { c: JourneyCall }) {
  // the ledger never carries near misses (they never enter it — apiViews.ts's
  // LedgerPrediction doc comment), so `nearMiss` is always false here; the
  // shared law still reads watchOnly/observation off the wire directly.
  const kind = rowKind({ watchOnly: c.watchOnly, nearMiss: false, observation: c.observation })
  const sized = kind === 'sized-live' && !c.shadow && !c.belowBase
  const pm = c.postMortem?.sentence ?? c.postMortem?.detail ?? null
  return (
    <div className="card rec-ledger-card">
      <div className="rec-ledger-top">
        <Link href={`/stock/${c.sym}`} className="rec-ledger-sym pressable">
          {c.sym}
        </Link>
        <span className={`pill ${c.side}`}>{c.side === 'long' ? 'Long' : 'Short'}</span>
        {sized && (
          <span className="pill accent" aria-label={`Grade ${c.grade}`}>
            {c.grade}
          </span>
        )}
        {c.shadow && <span className="pill">shadow — never a live size</span>}
        {c.observation && <span className="pill">observation — no ISA route</span>}
      </div>
      {c.thesis && <p className="rec-ledger-thesis">{c.thesis}</p>}
      <div className="rec-ledger-out">
        {c.outcome10 && <OutcomePill horizon="10d" o={c.outcome10} />}
        {c.outcome21 && <OutcomePill horizon="21d" o={c.outcome21} />}
        {!c.outcome10 && !c.outcome21 && <span className="cc-reason">Not yet matured — no graded outcome.</span>}
      </div>
      {/* the reason line: only the shapes the shared law names one for — a
          sized (and non-shadow) row carries its grade instead and gets none */}
      {!sized && kind !== 'sized-live' && <p className="cc-reason">{unsizedReason(kind, c.belowBase)}</p>}
      {c.wildcard && (
        <div className="cc-wildcard">
          <span className="pill">{WILDCARD_LABEL}</span>
          <span>{WILDCARD_WARNING}</span>
        </div>
      )}
      {pm && <p className="rec-ledger-pm">{pm}</p>}
    </div>
  )
}

/** Grouped by day, newest first (the server already returns newest-first —
 * `viewLedger`'s `dates.reverse()` — so this trusts that order rather than
 * re-sorting, exactly as PastCalls trusts its own server order elsewhere). */
export function LedgerDayCards({ days }: { days: LedgerDay[] }) {
  if (days.length === 0) {
    return <p className="cc-reason">No predictions on the ledger yet. The receipts arrive once the engine has run and graded.</p>
  }
  return (
    <>
      {days.map(d => (
        <div className="rec-ledger-day" key={d.date}>
          <p className="sec-label num">{d.date}</p>
          {d.predictions.map(c => (
            <LedgerCard key={c.id} c={c} />
          ))}
        </div>
      ))}
    </>
  )
}
