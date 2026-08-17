// RefusalRow (plan Task 14) — one row inside "the engine said no". Renders a
// single funnel refusal (JourneyFunnelRow): sym, side word, the human gate
// label, `detail` when the trace carried one, and the bare `core` composite
// number.
//
// THE HARD RULE: a refusal never earned a grade or a probability — those are
// reads on evidence a refused candidate never cleared. `core` is printed
// plainly, labelled "core", never dressed up as either.

import { Link } from 'wouter'
import type { JourneyFunnelRow } from '../../lib/apiViews'
import { GATE_LABELS } from '../../lib/gateLabels'

/** `showGate` false when the row sits UNDER a heading that already names the
 * gate (BoardColumn groups the refusals by it — visibility wave, 2026-08-17).
 * Repeating the label on every row under its own heading is the noise the
 * grouping was meant to remove; the row's own `detail`, which differs row to
 * row, still prints. Defaults true so any future caller keeps the whole line. */
export function RefusalRow({ row, showGate = true }: { row: JourneyFunnelRow; showGate?: boolean }) {
  // key is `SYM:side` or bare `SYM` — the symbol always comes from the key,
  // never inferred from `side` (which the row may omit, e.g. no-data).
  const sym = row.key.split(':')[0]
  const label = showGate ? GATE_LABELS[row.gate] : ''
  return (
    <Link href={`/stock/${sym}`} className="board-row pressable">
      <span className="board-row-main">
        <b>{sym}</b>
        {row.side && <span className={`pill ${row.side}`}>{row.side === 'long' ? 'Long' : 'Short'}</span>}
      </span>
      <span className="board-row-detail">
        {label}
        {row.detail ? `${label ? ' — ' : ''}${row.detail}` : ''}
      </span>
      {row.core != null && (
        <span className="num board-row-core">
          core {row.core.toFixed(1)}
        </span>
      )}
    </Link>
  )
}
