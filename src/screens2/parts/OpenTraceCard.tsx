// OpenTraceCard (plan Task 17) — shown ONLY while a published call on this
// name is still open. The engine re-reads its own live calls each morning and
// records one of three verdicts; each gets its OWN sentence, because "still
// on", "intact" and "weakening" are three different things and collapsing
// them into one hedge would be the page lying by compression:
//
//   still-on   the engine would publish this trade again today
//   intact     it would not re-publish it, but nothing has broken
//   weakening  the evidence behind it is thinner than when it was called
//
// Grading NEVER moves off the published stop — `trailStop` is what the open
// book actually enforced on a velocity row, so it is labelled as the trail,
// beside (not instead of) the published stop.

import type { OpenTraceEntry } from '../../lib/api'

const TRACE_COPY: Record<NonNullable<OpenTraceEntry['verdict']>, string> = {
  'still-on': 'Still on — the engine would still take this trade today.',
  intact: 'Not re-called today, but the thesis is intact — nothing has broken.',
  weakening: 'Weakening — the evidence behind this call is thinner than when it was made.',
}

export function OpenTraceCard({ trace }: { trace: OpenTraceEntry }) {
  const progress = Math.max(0, Math.min(100, trace.progressPct ?? 0))
  return (
    <section className="card sp-trace" aria-label="Open call">
      <p className="sec-label">{trace.status === 'in-play' ? 'This call is still open' : 'This call has crossed a level — not yet graded'}</p>
      <div className="sp-call-top">
        <span className={`pill ${trace.side}`}>{trace.side === 'long' ? 'Long' : 'Short'}</span>
        <span className="num sp-call-date">
          called {trace.callDate} · day {trace.day}
        </span>
        {trace.status !== 'in-play' && (
          <span className="pill">
            {trace.status === 'stopped' ? 'stopped out' : 'hit target'}
            {trace.crossedDate ? ` ${trace.crossedDate}` : ''}
          </span>
        )}
        {trace.requalified && <span className="pill accent">requalified today</span>}
      </div>
      {trace.verdict && (
        <p className="sp-trace-line" data-testid="trace-line">
          {TRACE_COPY[trace.verdict]}
        </p>
      )}
      <div className="convbar">
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="cc-meta">
        <span>{trace.progressPct == null ? 'no progress reading' : 'of the way to target'}</span>
        <span className="num">{trace.progressPct == null ? '—' : `${Math.round(trace.progressPct)}%`}</span>
      </div>
      <div className="cc-levels">
        <span>
          Stop <b className="num">{trace.stop}</b>
        </span>
        {trace.trailStop != null && (
          <span>
            Trail <b className="num">{trace.trailStop}</b>
          </span>
        )}
        <span>
          Target <b className="num">{trace.target}</b>
        </span>
      </div>
      <div className="cc-meta">
        <span>last</span>
        <span className="num">
          {trace.last} · {trace.movePct >= 0 ? '+' : '−'}
          {Math.abs(trace.movePct).toFixed(1)}% from entry
        </span>
      </div>
      <p className="cc-reason">{trace.note}</p>
    </section>
  )
}
