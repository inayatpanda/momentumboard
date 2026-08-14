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

import type { JourneySlice } from '../../lib/apiViews'
import { GATE_LABELS } from '../../lib/gateLabels'

type Day = JourneySlice['funnel'][number]

const isPublished = (gate: string) => gate.startsWith('called-')

const kindOf = (day: Day): 'published' | 'refused' | 'seen' => {
  if (day.rows.some(r => isPublished(r.gate))) return 'published'
  return day.rows.length > 0 ? 'refused' : 'seen'
}

export function FunnelPath({ days }: { days: Day[] }) {
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
            <li className="sp-step" key={day.date} data-kind={kindOf(day)}>
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
