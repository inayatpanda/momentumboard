// VerdictHero (plan Task 17) — the one card that answers "would the engine
// trade this name?", in six mutually exclusive shapes: sized+live, on the board
// unsized, refused today, published on the newest funnel day but off today's
// board, the day's nearest miss, and the on-demand read — with a plain
// "no read today" behind all of them.
//
// THE HARD RULE (CX-13), enforced here rather than trusted from the caller: a
// letter grade and a calibrated probability are reads on evidence that only a
// SIZED, live row ever cleared. A watch/observation/near-miss row, a refused
// candidate and an on-demand read each get their own honest line instead —
// never a grade, never a probability, not even a softened one. Same semantics
// as src/components/EngineBoard.tsx:70-121, worded for this page.

import type { GateCode } from '../../../shared/engine/types'
import type { EnginePrediction } from '../../lib/api'
import type { JourneyFunnelRow, VerdictRead } from '../../lib/apiViews'
import { rowKind, unsizedReason } from '../../lib/boardTaxonomy'
import { GATE_LABELS } from '../../lib/gateLabels'
import { fmtRiskPct, sizeLabel } from '../../lib/format'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'
import { CohortPill, WhySized } from './CohortMarks'
import { RouteNote } from './RouteNote'

const sideWord = (s: 'long' | 'short') => (s === 'long' ? 'Expecting a rise' : 'Expecting a fall')

// Which shape a row is, and the one line an unsized shape carries instead of a
// grade, are ONE law shared with CallCard: src/lib/boardTaxonomy.ts. Two copies
// is how the two cards drifted apart in the first place (Task 17 review, I7).

/** A gate label opens a sentence here, so it is spoken with a capital — the
 * labels themselves stay lower-case for the mid-sentence uses everywhere else. */
const openWith = (label: string) => label.charAt(0).toUpperCase() + label.slice(1)

const Q = <p className="sec-label">What does StreetSignal think?</p>

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
  published,
  nearMissDate,
  verdict,
  onWatch,
  watched,
  resolved,
}: {
  row?: EnginePrediction | null
  refusal?: { date: string; row: JourneyFunnelRow } | null
  /** the NEWEST funnel day published this name, but it is not on today's board:
   * an honest "it was called, on that day" — never a grade, because the grade
   * belongs to that day's row and this page is not showing that day's row */
  published?: { date: string; gate: GateCode } | null
  /** …and the newest funnel day looked at it and called nothing at all */
  nearMissDate?: string | null
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

  // The experiment slot's standing warning belongs to the ROW, not to the row's
  // size: a wildcard watch row is every bit as experimental as a sized one, and
  // the sized-only rendering hid the warning from exactly the rows least able to
  // afford losing it (Task 17 review, I6 — CallCard has always done it this way).
  const wildcard = row?.wildcard ? (
    <div className="cc-wildcard">
      <span className="pill">{WILDCARD_LABEL}</span>
      <span>{WILDCARD_WARNING}</span>
    </div>
  ) : null

  // 1 — SIZED AND LIVE: the only surface in the app that may print both.
  const kind = row ? rowKind(row) : null
  if (row && kind === 'sized-live') {
    const conviction = Math.max(0, Math.min(100, Math.abs(row.composite)))
    return shell(
      <>
        {Q}
        <div className="sp-hero-top">
          <span className={`sp-side ${row.side}`}>{sideWord(row.side)}</span>
          <CohortPill cohort={row.cohort} />
          <span className="pill accent" aria-label={`Grade ${row.grade}`}>
            {row.grade}
          </span>
        </div>
        {row.thesis && <p className="sp-thesis">{row.thesis}</p>}
        {wildcard}
        <details className="company-detail"><summary>See the evidence</summary>
        <span className="num sp-prob">
          Estimated success: {Math.round(row.probability * 100)}% · expected move: ~{row.expectedMovePct}%
        </span>
        <div className="convbar">
          <i style={{ width: `${conviction}%` }} />
        </div>
        <div className="cc-meta">
          <span>Research score</span>
          <span className="num">{Math.round(Math.abs(row.composite))}</span>
        </div>
        <Levels row={row} />
        <p className="cc-reason num">
          risk {fmtRiskPct(row.riskPct)}%
          {sizeLabel(row.riskPct, row.riskRung)}
          {row.instrument ? ` · ${row.instrument.ticker} ${row.instrument.leverage}x` : row.paperOnly ? ' · paper-only' : ''}
        </p>
        {/* the shared route disclaimer: the levels above are the UNDERLYING's,
            and only a geared route decays (parts/RouteNote.tsx) */}
        <RouteNote instrument={row.instrument} />
        {/* …and, on a cohort row, the engine's own account of why it is sized
            like this — its 14-bar calibration, the cold start, the designed
            C-at-half-size floor, the missing tracker (parts/CohortMarks.tsx) */}
        <WhySized cohort={row.cohort} note={row.note} />
        </details>
      </>,
    )
  }

  // 2 — ON THE BOARD, BUT UNSIZED: its own reason, no grade, no probability.
  if (row && kind) {
    return shell(
      <>
        {Q}
        <div className="sp-hero-top">
          <span className={`sp-side ${row.side}`}>{sideWord(row.side)}</span>
          <CohortPill cohort={row.cohort} />
        </div>
        <p className="cc-reason">{unsizedReason(kind, row.belowBase)}</p>
        <WhySized cohort={row.cohort} note={row.note} />
        {wildcard}
        <div className="convbar">
          <i style={{ width: `${Math.max(0, Math.min(100, Math.abs(row.composite)))}%` }} />
        </div>
        <div className="cc-meta">
          <span>Research score</span>
          <span className="num">{Math.round(Math.abs(row.composite))}</span>
        </div>
        {/* a near miss's levels are synthetic orientation, not a designed
            trade — printing them would read as engine conviction */}
        {!row.nearMiss && (
          <>
            <Levels row={row} />
            <p className="cc-reason">Illustrative prices only. No trade allocation has been made.</p>
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
            <span className="sp-core-label">Research score</span>
            <b className="num">{refusal.row.core.toFixed(1)}</b>
          </div>
        )}
        <p className="cc-reason">
          Checked on <span className="num">{refusal.date}</span>. It did not qualify, so no grade or probability is shown.
        </p>
      </>,
    )
  }

  // 3b — PUBLISHED, BUT NOT TODAY (Task 17 review, C1): the newest funnel day
  // called this name and today's board does not carry it. Saying "no read
  // today" here would bury a publication the reader can see two sections down;
  // saying it WITH a grade would lend that day's letter to a row this page is
  // not showing. So: what it was called at, when, and that it is gone.
  if (published) {
    return shell(
      <>
        {Q}
        <p className="sp-verdict-line">
          {openWith(GATE_LABELS[published.gate])} on <span className="num">{published.date}</span> — not on today's board.
        </p>
        <p className="cc-reason">There is no new prediction for this stock today. Its earlier prediction is saved below.</p>
      </>,
    )
  }

  // 3c — LOOKED AT, CALLED NOTHING: the day's nearest miss. It is a real thing
  // the engine did, and it is not "no read".
  if (nearMissDate) {
    return shell(
      <>
        {Q}
        <p className="sp-verdict-line">Close to qualifying, but no prediction was published.</p>
        <p className="cc-reason">
          Recorded on <span className="num">{nearMissDate}</span> — the required checks were not met. No trade plan or probability estimate.
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
        {verdict.contained ? (
          // THE CONTAINED PAIR (crypto-v2 wave, finding 1). The on-demand desk
          // runs the EQUITY factors — momentum against SPY, equity windows,
          // equity weights, the board's equity regime — so it refuses a coin
          // rather than publishing a lean nothing ever measured. NOT the
          // "could not price this name" sentence: the lane prices this pair
          // every morning, and the note below says which door to use.
          <p className="sp-verdict-line">This asset is assessed separately in the crypto section.</p>
        ) : verdict.unavailable ? (
          <p className="sp-verdict-line">No view available. A current price could not be found.</p>
        ) : (
          <>
            <div className="sp-hero-top">
              <span className={`sp-side ${verdict.lean === 'none' ? 'flat' : verdict.lean}`}>{verdict.lean === 'none' ? 'No clear direction' : sideWord(verdict.lean)}</span>
            </div>
            {verdict.core != null && (
              <div className="cc-meta sp-core">
                <span className="sp-core-label">Research score</span>
                <b className="num">{verdict.core.toFixed(1)}</b>
              </div>
            )}
            <p className="cc-reason num">
              {computed} factor{computed === 1 ? '' : 's'} computed
            </p>
            <p className="cc-reason">Quick assessment only; no tested success estimate</p>
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
        <p className="sp-verdict-line">No assessment recorded for this stock today.</p>
      </>,
    )
  }

  return shell(<div className="skeleton" style={{ height: 96 }} />)
}
