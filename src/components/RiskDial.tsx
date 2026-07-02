import type { EngineData } from '../lib/api'

// RiskDial — the risk ladder, compact. One glance = how much the system currently
// permits. Four rung markers R0–R3 with their per-idea risk %, the current rung
// lit in blue, the graded-at-rung count, and the last rung-change evidence line.
// A tighter sibling of the fuller ledger view in EnginePanel; same data shapes.

// Per-idea risk budget earned at each rung (mirrors EnginePanel).
export const RUNG_PCT = [1.0, 1.25, 1.5, 2.0]

export function RiskDial({ riskState }: { riskState: EngineData['riskState'] }) {
  if (!riskState) return null
  const { rung, gradedAtRung, history } = riskState
  const pct = RUNG_PCT[rung] ?? RUNG_PCT[0]
  const last = history.at(-1)

  return (
    <div className="risk-dial">
      <div className="risk-dial-head">
        <span className="risk-dial-label">Risk ladder — what the system permits now</span>
        <span className="risk-dial-now num">
          R{rung} · {pct}% per idea
        </span>
      </div>
      <div className="risk-dial-track" role="img" aria-label={`Risk rung R${rung} of R3, ${pct}% risk per idea`}>
        {RUNG_PCT.map((p, i) => (
          <div key={i} className={`risk-rung${i === rung ? ' is-current' : ''}${i < rung ? ' is-passed' : ''}`}>
            <span className="risk-rung-r">R{i}</span>
            <span className="risk-rung-pct num">{p}%</span>
          </div>
        ))}
      </div>
      <div className="risk-dial-meta">
        <span className="num">{gradedAtRung} graded at R{rung}</span>
        {last && (
          <span className="risk-dial-ev">
            last change {last.date}: R{last.from}→R{last.to} — {last.evidence}
          </span>
        )}
      </div>
    </div>
  )
}
