// VerdictHero (plan Task 17) — the one card that answers "would the engine
// trade this name?", in four mutually exclusive shapes.
//
// THE HARD RULE (CX-13), enforced here rather than trusted from the caller: a
// letter grade and a calibrated probability are reads on evidence that only a
// SIZED, live row ever cleared. A watch/observation/near-miss row, a refused
// candidate and an on-demand read each get their own honest line instead —
// never a grade, never a probability, not even a softened one. Same semantics
// as src/components/EngineBoard.tsx:70-121, worded for this page.

import type { EnginePrediction } from '../../lib/api'
import type { JourneyFunnelRow, VerdictRead } from '../../lib/apiViews'
import { GATE_LABELS } from '../../lib/gateLabels'
import { fmtRiskPct, sizeLabel } from '../../lib/format'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'

const sideWord = (s: 'long' | 'short') => (s === 'long' ? 'Long' : 'Short')

/** Sized/live, and therefore gradeable — checked against every unsized flag
 * directly, never inferred from `watchOnly` alone. */
const isSizedLive = (row: EnginePrediction) => !row.watchOnly && !row.nearMiss && !row.observation

/** The one-line reason an ungraded row carries instead of a grade. */
function reasonLine(row: EnginePrediction): string {
  if (row.nearMiss) return 'Nearest miss — cleared no gate, so no grade, no probability and no size.'
  if (row.observation) return 'Cleared every gate, but no ISA route — observation only, no size.'
  return row.belowBase ? 'Tracking — below its own historical hit rate today, no size yet.' : 'Watch — no size yet.'
}

const Q = <p className="sec-label">Would the engine trade it?</p>

function Levels({ row }: { row: EnginePrediction }) {
  return (
    <div className="cc-levels">
      <span>
        Entry <b className="num">{row.entry}</b>
      </span>
      <span>
        Stop <b className="num">{row.stop}</b>
      </span>
      <span>
        Target <b className="num">{row.target}</b>
      </span>
    </div>
  )
}

export function VerdictHero({
  row,
  refusal,
  verdict,
  onWatch,
  watched,
  resolved,
}: {
  row?: EnginePrediction | null
  refusal?: { date: string; row: JourneyFunnelRow } | null
  verdict?: VerdictRead | null
  onWatch?: () => void
  watched?: boolean
  /** the journey slice has LANDED and simply carries no read for today — the
   * difference between "still loading" and "nothing to say", which a
   * skeleton left up forever would quietly turn into a lie */
  resolved?: boolean
}) {
  const shell = (children: React.ReactNode) => (
    <section className="card sp-hero" aria-label="The engine's verdict">
      {children}
    </section>
  )

  // 1 — SIZED AND LIVE: the only surface in the app that may print both.
  if (row && isSizedLive(row)) {
    const conviction = Math.max(0, Math.min(100, Math.abs(row.composite)))
    return shell(
      <>
        {Q}
        <div className="sp-hero-top">
          <span className={`sp-side ${row.side}`}>Yes — {sideWord(row.side)}</span>
          <span className="pill accent" aria-label={`Grade ${row.grade}`}>
            {row.grade}
          </span>
        </div>
        <span className="num sp-prob">
          {Math.round(row.probability * 100)}% · ~{row.expectedMovePct}%
        </span>
        <div className="convbar">
          <i style={{ width: `${conviction}%` }} />
        </div>
        <div className="cc-meta">
          <span>conviction</span>
          <span className="num">{Math.round(Math.abs(row.composite))}</span>
        </div>
        {row.wildcard && (
          <div className="cc-wildcard">
            <span className="pill">{WILDCARD_LABEL}</span>
            <span>{WILDCARD_WARNING}</span>
          </div>
        )}
        <Levels row={row} />
        <p className="cc-reason num">
          risk {fmtRiskPct(row.riskPct)}%
          {sizeLabel(row.riskPct, row.riskRung)}
          {row.instrument ? ` · ${row.instrument.ticker} ${row.instrument.leverage}x` : row.paperOnly ? ' · paper-only' : ''}
        </p>
        {row.thesis && <p className="sp-thesis">{row.thesis}</p>}
      </>,
    )
  }

  // 2 — ON THE BOARD, BUT UNSIZED: its own reason, no grade, no probability.
  if (row) {
    return shell(
      <>
        {Q}
        <div className="sp-hero-top">
          <span className={`sp-side ${row.side}`}>{sideWord(row.side)}</span>
        </div>
        <p className="cc-reason">{reasonLine(row)}</p>
        <div className="convbar">
          <i style={{ width: `${Math.max(0, Math.min(100, Math.abs(row.composite)))}%` }} />
        </div>
        <div className="cc-meta">
          <span>conviction</span>
          <span className="num">{Math.round(Math.abs(row.composite))}</span>
        </div>
        {/* a near miss's levels are synthetic orientation, not a designed
            trade — printing them would read as engine conviction */}
        {!row.nearMiss && (
          <>
            <Levels row={row} />
            <p className="cc-reason">Levels for orientation only — the engine did not size this row.</p>
          </>
        )}
      </>,
    )
  }

  // 3 — REFUSED: the gate that stopped it, and the bare conviction it would
  // have carried. `core` is printed plainly, labelled "core", never dressed
  // up as a grade or a probability.
  if (refusal) {
    return shell(
      <>
        {Q}
        <p className="sp-verdict-line">
          Not today — <b>{GATE_LABELS[refusal.row.gate]}</b>
        </p>
        {refusal.row.detail && <p className="sp-refuse-detail">{refusal.row.detail}</p>}
        {refusal.row.core != null && (
          <div className="cc-meta sp-core">
            <span className="sp-core-label">core</span>
            <b className="num">{refusal.row.core.toFixed(1)}</b>
          </div>
        )}
        <p className="cc-reason">
          Refused on <span className="num">{refusal.date}</span> — a candidate a gate turned away never earned a letter or a calibrated read, so it has neither.
        </p>
      </>,
    )
  }

  // 4 — ON DEMAND: a name today's scan never looked at. Its honesty note is
  // printed verbatim; the "no calibrated grade" line is not negotiable.
  if (verdict) {
    const computed = verdict.computed.filter(c => c.score != null).length
    return shell(
      <>
        {Q}
        {verdict.unavailable ? (
          <p className="sp-verdict-line">No read available — the engine could not price this name right now.</p>
        ) : (
          <>
            <div className="sp-hero-top">
              <span className={`sp-side ${verdict.lean === 'none' ? 'flat' : verdict.lean}`}>{verdict.lean === 'none' ? 'No lean' : `Leans ${sideWord(verdict.lean)}`}</span>
            </div>
            {verdict.core != null && (
              <div className="cc-meta sp-core">
                <span className="sp-core-label">core</span>
                <b className="num">{verdict.core.toFixed(1)}</b>
              </div>
            )}
            <p className="cc-reason num">{computed} factors computed</p>
            <p className="cc-reason">no calibrated grade — on-demand read</p>
          </>
        )}
        <p className="sp-note">{verdict.note}</p>
        {onWatch && (
          <button className="sp-watch-btn" onClick={onWatch} disabled={watched}>
            {watched ? 'On your watchlist' : 'Add to watchlist'}
          </button>
        )}
      </>,
    )
  }

  // 5 — the slice landed and holds no read for today: say that, plainly.
  if (resolved) {
    return shell(
      <>
        {Q}
        <p className="sp-verdict-line">No read today — the engine neither called this name nor recorded a gate turning it away.</p>
      </>,
    )
  }

  return shell(<div className="skeleton" style={{ height: 96 }} />)
}
