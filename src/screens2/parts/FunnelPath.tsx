// FunnelPath (plan Task 17) — this name's walk through the engine's gates,
// one dated step per day, newest first. The step's dot says what KIND of day
// it was, and the colours are semantic (never decorative):
//   published (`called-*`)  → var(--accent): the day it made the board
//   refused                  → var(--warn):  a gate turned it away
//   near-miss only           → dim:          it was looked at, nothing more
//
// A `priorGate` is the row's own history inside one day — the gate it was
// sitting behind before the one it ended on — so it renders as "was: {label}"
// rather than as a second, contradictory step.

import type { GateCode } from '../../../shared/engine/types'
import { PUBLISHED_GATES } from '../../../shared/engine/funnelTrace'
import type { JourneySlice } from '../../lib/apiViews'
import { GATE_LABELS } from '../../lib/gateLabels'

export type FunnelDay = JourneySlice['funnel'][number]
export type FunnelDayKind = 'published' | 'refused' | 'seen'

/** Did this gate PUBLISH the row? Asked of the engine's own set, not of the
 * `called-` prefix, so a future publishing gate cannot silently read as a
 * refusal here. */
export const isPublishedGate = (gate: GateCode) => PUBLISHED_GATES.has(gate)

/** THE PER-DAY LAW, exported because the hero obeys it too (Task 17 review,
 * C1): a day carrying ANY published row is a PUBLICATION day, whatever else
 * happened to the name's other side that morning. Only a day with rows and no
 * publication is a refusal; a day with no rows at all was merely looked at. */
export const funnelDayKind = (day: FunnelDay): FunnelDayKind => {
  if (day.rows.some(r => isPublishedGate(r.gate))) return 'published'
  return day.rows.length > 0 ? 'refused' : 'seen'
}

export function FunnelPath({ days }: { days: FunnelDay[] }) {
  // The server hands these newest-first already; sorting defensively costs
  // nothing and means a re-ordered projection can never silently invert the
  // reader's sense of "what happened most recently".
  const ordered = [...days].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <section aria-label="The funnel path">
      <p className="sec-label">The funnel path</p>
      {ordered.length === 0 ? (
        <p className="cc-reason">No recorded gate decisions for this name yet.</p>
      ) : (
        <ol className="sp-path">
          {ordered.map(day => (
            <li className="sp-step" key={day.date} data-kind={funnelDayKind(day)}>
              <span className="sp-dot" aria-hidden="true" />
              <div className="sp-step-body">
                <span className="sp-step-date num">{day.date}</span>
                {day.rows.map(r => (
                  <span className="sp-step-gate" key={`${r.key}:${r.gate}`}>
                    {GATE_LABELS[r.gate]}
                    {r.side ? ` · ${r.side}` : ''}
                    {r.detail ? ` — ${r.detail}` : ''}
                    {r.priorGate ? ` · was: ${GATE_LABELS[r.priorGate]}` : ''}
                  </span>
                ))}
                {day.rows.length === 0 && day.nearMiss && <span className="sp-step-gate">nearest miss — looked at, no gate cleared</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
