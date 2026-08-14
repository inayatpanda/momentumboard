// Regrets (plan Task 20) — the regret surface: the top gates the miss ledger
// prices, cost order, each with its human label and its named examples
// ("PLTR · 04 Aug · ran +6.1pp"). Reads `learning.regrets`
// (missLedgerExamples's shape, shared/engine/missLedger.ts) — already in hand
// under DS-5's whole-slice fetch, no extra request.
//
// CX-15 (binding): `cost`/`saved` are EVENT COUNTS ("refused N priced times")
// and must never be printed with "pp" — only the averages
// (`avgCostExcessPct`/`avgSavedExcessPct`) carry the percentage-point
// magnitude, and only they get "pp".
//
// THE CAVEAT IS NOT OPTIONAL: `regrets.note` renders verbatim whenever
// `regrets.unchecked > 0` (the RETAINED-WINDOW total, not any one gate's own
// count) — an unmeasured gate is not a costless one, and the excesses
// measured are stopless upper bounds. This is orthogonal to whether any gate
// ranked: an unchecked backlog is true even on a day nothing measurable
// happened to rank.

import { Link } from 'wouter'
import type { LearningSlice, RegretGate } from '../../lib/apiViews'
import { GATE_LABELS } from '../../lib/gateLabels'
import type { MissExample } from '../../../shared/engine/missLedger'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// manual parse, never `new Date(iso)` — the reader's timezone can walk an ISO
// day string back to the wrong calendar date (the rule FunnelPath/StockPage
// follow by printing the raw ISO string instead; this surface wants a short
// human date, so it parses the digits itself rather than risking the shift).
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${String(d).padStart(2, '0')} ${MONTHS[(m ?? 1) - 1] ?? ''}`
}

const fmtPp = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}pp`

// `.num` wraps the WHOLE numeric-bearing clause, same convention as
// CallCard's cc-meta / PastCalls' OutcomePill — tabular-nums on a phrase that
// carries a figure reads correctly even where a word sits beside the digits.
function Example({ ex }: { ex: MissExample }) {
  return (
    <Link href={`/stock/${ex.sym}`} className="rec-regret-example pressable">
      <b>{ex.sym}</b>{' '}
      <span className="num">
        · {shortDate(ex.date)} · {ex.excessPct >= 0 ? 'ran' : 'fell'} {fmtPp(ex.excessPct)}
      </span>
    </Link>
  )
}

function GateRegret({ g }: { g: RegretGate }) {
  return (
    <div className="card rec-regret-gate">
      <p className="rec-regret-label">{GATE_LABELS[g.gate]}</p>
      {/* THE COUNT (CX-15): never "pp" on this clause */}
      <p className="rec-regret-stat num">
        Refused {g.cost} priced times
        {g.avgCostExcessPct != null && <> · averaged {fmtPp(g.avgCostExcessPct)} when it ran</>}
      </p>
      <p className="rec-regret-stat num">
        Saved {g.saved} priced times
        {g.avgSavedExcessPct != null && <> · averaged {fmtPp(g.avgSavedExcessPct)}</>}
      </p>
      {g.causal && (
        <p className="rec-regret-causal num">
          Wildcard tested it: {g.causal.n} tries, {g.causal.hits} hits
        </p>
      )}
      {g.examples.length > 0 && (
        <div className="rec-regret-examples">
          {g.examples.map(ex => (
            <Example key={`${ex.sym}-${ex.date}-${ex.side}`} ex={ex} />
          ))}
        </div>
      )}
    </div>
  )
}

export function Regrets({ regrets }: { regrets: LearningSlice['regrets'] }) {
  return (
    <section aria-label="Regrets">
      <p className="sec-label">Regrets — what the gates refused</p>
      {!regrets ? (
        <p className="cc-reason">Not enough measured misses yet — the regret surface fills in as refusals mature.</p>
      ) : (
        <>
          {regrets.topGates.length === 0 ? (
            <p className="cc-reason">Nothing measurable yet — no gate has cost or saved enough to rank.</p>
          ) : (
            regrets.topGates.map(g => <GateRegret key={g.gate} g={g} />)
          )}
          {/* THE CAVEAT IS NOT OPTIONAL (CX-15) */}
          {regrets.unchecked > 0 && <p className="cc-reason rec-regret-caveat">{regrets.note}</p>}
        </>
      )}
    </section>
  )
}
