import { useEffect, useState } from 'react'
import { getEngine, type EngineData, type EnginePrediction } from '../lib/api'
import { GradeChip } from './GradeChip'

// THE BOARD: today's scored calls from the prediction engine. Numbers only —
// grade, calibrated probability, entry/stop/target — with the factor evidence
// one tap away. The paper narrates this; here it stands naked.

function Call({ p }: { p: EnginePrediction }) {
  const [open, setOpen] = useState(false)
  const dir = p.side === 'long' ? '▲ LONG' : '▼ SHORT'
  return (
    <div className="perf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 700 }}>
          <GradeChip grade={p.grade} provisional={p.provisional} />{' '}
          {p.sym}
          <span style={{ color: p.side === 'long' ? 'var(--green, #37b26c)' : 'var(--red, #ff5d73)', fontSize: 11, marginLeft: 6 }}>{dir}</span>
          {p.smallCap && <span className="badge warn" style={{ marginLeft: 6 }}>small cap</span>}
          {p.earningsRisk && <span className="badge bad" style={{ marginLeft: 4 }}>earnings ≤10d</span>}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{Math.round(p.probability * 100)}% · ~{p.expectedMovePct}%</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
        <span>in {p.entry} · stop {p.stop} · tgt {p.target}</span>
        <span>risk {p.riskPct}%{p.instrument ? ` · ${p.instrument.ticker} ${p.instrument.leverage}x` : p.paperOnly ? ' · paper-only' : ''}</span>
      </div>
      <button className="mini-btn ghost" style={{ alignSelf: 'flex-start', fontSize: 11, padding: '1px 6px' }} onClick={() => setOpen(o => !o)}>
        {open ? 'hide evidence' : 'evidence'}
      </button>
      {open && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          <div style={{ marginBottom: 3 }}>{p.note}</div>
          {Object.entries(p.factors)
            .filter(([, f]) => f.score != null)
            .sort((a, b) => Math.abs(b[1].weight * (b[1].score ?? 0)) - Math.abs(a[1].weight * (a[1].score ?? 0)))
            .map(([name, f]) => (
              <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <span>{name} <span style={{ color: 'var(--faint)' }}>w{f.weight}</span></span>
                <span style={{ textAlign: 'right' }}>{f.score! > 0 ? '+' : ''}{f.score} — {f.detail}</span>
              </div>
            ))}
          {p.instrument && <div style={{ marginTop: 3, color: 'var(--faint)' }}>Leveraged ETPs decay daily — max hold 10 sessions; exit on the UNDERLYING levels above, not the ETP price.</div>}
        </div>
      )}
    </div>
  )
}

export function EngineBoard() {
  const [data, setData] = useState<EngineData | null>(null)
  useEffect(() => {
    getEngine().then(setData).catch(() => {})
  }, [])
  const b = data?.board
  if (!b) return null
  return (
    <section className="digest-section">
      <h3 className="section-title">
        The Board — engine calls, {b.date} <span className={`badge ${b.regime === 'green' ? '' : b.regime === 'red' ? 'bad' : 'warn'}`}>{b.regime}</span>
      </h3>
      <p className="board-strip">
        <span>regime {b.regime}</span>
        {b.worldTape && (
          <>
            <span className="sep">·</span>
            <span>world tape {b.worldTape.tone}{b.worldTape.detail ? ` — ${b.worldTape.detail}` : ''}</span>
          </>
        )}
        {b.newsTone && (
          <>
            <span className="sep">·</span>
            <span>news {b.newsTone.label}</span>
          </>
        )}
      </p>
      {b.board.length === 0 && <p className="empty-line">No edge today — every candidate failed the gates. An honest empty board beats a forced call.</p>}
      {b.board.map(p => (
        <Call key={p.id} p={p} />
      ))}
      <p className="empty-line" style={{ fontSize: 11 }}>
        Grades are calibrated on the engine's own graded history (excess return vs SPY, stops honoured). Provisional = thin evidence bucket. This is analysis, not advice.
      </p>
    </section>
  )
}
