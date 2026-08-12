import type { TechnicalRead } from '../../shared/technicals'
import type { EnginePrediction } from '../lib/api'
import { GradeChip } from './GradeChip'

// EngineRead — the Explore surface's read of the tape.
//
// EngineReadStrip: the client-side chart maths (pure, works with NO board call) —
// stage, entry quality, volume flag and the plain-English note. Sits above the
// annotated chart and mirrors the marker drawn on the last bar.
//
// EngineFactors: only when the symbol has a LIVE board call — the full factor
// evidence (grade, probability, composite, expected move, capacity, weight-sorted
// signed factor rows). No call → a muted one-liner; nothing is invented.

const STAGE_LABEL: Record<string, string> = {
  'early-reversal': 'Early reversal',
  basing: 'Basing',
  pullback: 'Pullback',
  trending: 'Trending',
  extended: 'Extended',
  exhausted: 'Exhausted',
  'falling-knife': 'Falling knife',
  weak: 'Weak',
}

const QUALITY_LABEL: Record<string, string> = {
  early: 'early entry',
  neutral: 'neutral',
  chase: 'chase',
  wait: 'wait',
}

// Sanctioned market-semantic colouring of the read: early = green, chase = red,
// everything else ink. (Per the Explore spec — the one place green/red carry the
// stage's meaning rather than a price move.)
function qualityColor(q: string): string {
  return q === 'early' ? 'var(--green)' : q === 'chase' ? 'var(--red)' : 'var(--text)'
}

export function EngineReadStrip({ read }: { read: TechnicalRead | null }) {
  if (!read) return null
  const tone = qualityColor(read.entryQuality)
  return (
    // .engine-read-strip (not .engine-read — that class is the Journal/Desk
    // position row and carries a conflicting flex layout): its own card surface.
    <div className="engine-read-strip">
      <div className="engine-read-head">
        <span className="eyebrow">Engine read</span>
        <span className="engine-stage" style={{ color: tone }}>{STAGE_LABEL[read.stage] ?? read.stage}</span>
        <span className="engine-quality" style={{ color: tone }}>{QUALITY_LABEL[read.entryQuality] ?? read.entryQuality}</span>
        <span className={`engine-vol${read.volumeConfirmed ? ' is-confirmed' : ''}`}>
          {read.volumeConfirmed ? '✓ volume-confirmed' : 'light volume'}
          {read.rvol != null ? ` · RVOL ${read.rvol}×` : ''}
        </span>
      </div>
      <p className="engine-read-note">{read.note}</p>
    </div>
  )
}

export function EngineFactors({ call, hasRead }: { call: EnginePrediction | null; hasRead: boolean }) {
  if (!call) {
    return hasRead ? (
      <p className="engine-nocall">No live engine call — the read above is the chart maths only.</p>
    ) : null
  }
  const dirColor = call.side === 'long' ? 'var(--green)' : 'var(--red)'
  const rows = Object.entries(call.factors)
    .filter(([, f]) => f.score != null)
    .sort((a, b) => Math.abs(b[1].weight * (b[1].score ?? 0)) - Math.abs(a[1].weight * (a[1].score ?? 0)))
  return (
    <section className="calc engine-factors">
      {/* a near miss is the engine's NO, on the board only so a side with nothing
          on it is not blank — calling this panel a live call would invert it.
          An observation is the engine's YES on a row an ISA cannot place: the
          read below is real, the trade is not on offer, and "live engine call"
          would read as an invitation to take it. */}
      <h3>
        Factor breakdown{' '}
        <span className="calc-sub">{call.nearMiss ? 'nearest miss — not a call' : call.observation ? 'observation — no route' : 'live engine call'}</span>
      </h3>
      <div className="engine-factor-top">
        <span className="engine-factor-id">
          {/* a near miss was never scored — a letter grade would be a fiction */}
          {call.nearMiss ? <span className="badge">near miss</span> : <GradeChip grade={call.grade} provisional={call.provisional} />}{' '}
          <b>{call.sym}</b>
          {call.name && <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12, marginLeft: 4 }}>{call.name}</span>}
          <span className="engine-factor-dir" style={{ color: dirColor }}>{call.side === 'long' ? '▲ long' : '▼ short'}</span>
          {call.watchOnly && !call.nearMiss && <span className="badge warn">watch</span>}
          {call.setup && <span className="badge">{call.setup}</span>}
        </span>
        {/* a near miss earned no calibrated bucket — its stored probability is the
            engine's base rate, so printing it as a percentage would be a fiction
            dressed as a measurement (same rule as the printed board) */}
        <span className="engine-factor-prob num">{call.nearMiss ? `~${call.expectedMovePct}%` : `${Math.round(call.probability * 100)}% · ~${call.expectedMovePct}%`}</span>
      </div>
      <div className="engine-factor-meta num">
        <span>composite {call.composite}</span>
        <span>capacity {call.capacityPct}%</span>
        {call.evidence && <span>{call.evidence.detail}</span>}
      </div>
      {rows.map(([name, f]) => (
        <div key={name} className="engine-factor-row">
          <span>{name} <span className="engine-factor-w">w{f.weight}</span></span>
          <span className="engine-factor-score">{f.score! > 0 ? '+' : ''}{f.score} <span className="engine-factor-detail">— {f.detail}</span></span>
        </div>
      ))}
    </section>
  )
}
