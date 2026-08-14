// CallCard (plan Task 13) — one board row, the way Today shows it. Reused
// later by the Board screen (Task 14), so it stays honest about EVERY row
// shape the engine publishes, not just the sized ones Today leads with.
//
// THE HARD RULE: a letter grade and a probability are a read on evidence that
// only exists once a row is sized/live. `nearMiss`, `observation` and a plain
// `watchOnly` row each explain themselves in one line instead — the DATA
// semantics are the old src/components/EngineBoard.tsx:70-121 ternary, worded
// fresh for the new card (see `reasonLine`).

import { Link } from 'wouter'
import type { EnginePrediction } from '../../lib/api'
import { rowKind, unsizedReason } from '../../lib/boardTaxonomy'
import { fmtRiskPct, sizeLabel } from '../../lib/format'
import { Sparkline } from '../../components/Sparkline'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'

// The row-kind law (which shape is this, and what does it say instead of a
// grade) lives in src/lib/boardTaxonomy.ts — ONE copy, shared with VerdictHero.
// It used to be duplicated here, and the duplicate had drifted (Task 17 review).

// `spark` is an OPTIONAL second prop, not part of the row: the board slice
// (Task 13's only sanctioned data source — the amendment killed the extra
// ledger/funnel fetches) carries no price history, so Today never passes one
// today. The prop exists so a future caller with candles in hand (the Board
// screen, Task 14) can hand them in without this component changing shape.
export function CallCard({ row, spark }: { row: EnginePrediction; spark?: number[] }) {
  const kind = rowKind(row)
  const sized = kind === 'sized-live'
  const pct = Math.round(row.probability * 100)
  // composite is signed and effectively unbounded past the grade bar; the bar
  // is decoration, not a measurement, so it clamps rather than overflows.
  const convictionPct = Math.max(0, Math.min(100, Math.abs(row.composite)))
  const sizingNote = `risk ${fmtRiskPct(row.riskPct)}%${sizeLabel(row.riskPct, row.riskRung)}${
    row.instrument ? ` · ${row.instrument.ticker} ${row.instrument.leverage}x` : row.paperOnly ? ' · paper-only' : ''
  }`
  return (
    <Link href={`/stock/${row.sym}`} className="card pressable cc">
      <div className="cc-top">
        <span className="cc-sym">
          {row.sym}
          <span className={`pill ${row.side}`}>{row.side === 'long' ? 'Long' : 'Short'}</span>
          {row.name && <span className="cc-name">{row.name}</span>}
        </span>
        {sized && (
          <span className="pill accent" aria-label={`Grade ${row.grade}`}>
            {row.grade}
          </span>
        )}
      </div>
      <div className="convbar">
        <i style={{ width: `${convictionPct}%` }} />
      </div>
      {spark && spark.length > 1 && <Sparkline closes={spark} />}
      {row.wildcard && (
        <div className="cc-wildcard">
          <span className="pill">{WILDCARD_LABEL}</span>
          <span>{WILDCARD_WARNING}</span>
        </div>
      )}
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
      {sized ? (
        <div className="cc-meta">
          <span className="num" aria-label={`Probability ${pct} percent`}>
            {pct}% · ~{row.expectedMovePct}%
          </span>
          <span className="num">{sizingNote}</span>
        </div>
      ) : (
        <p className="cc-reason">{unsizedReason(kind, row.belowBase)}</p>
      )}
    </Link>
  )
}
