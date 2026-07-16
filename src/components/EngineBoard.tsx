import { useEffect, useState } from 'react'
import { getEngine, type EngineData, type EnginePrediction } from '../lib/api'
import { capBand } from '../lib/format'
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
        <span style={{ fontWeight: 700, minWidth: 0 }}>
          {/* below-base rows have no honest letter grade (they're beneath C's bar) — a plain "tracking" chip instead of a misleading C */}
          {p.belowBase ? <span className="badge">tracking</span> : <GradeChip grade={p.grade} provisional={p.provisional} />}{' '}
          {p.sym}
          <span className={p.side === 'long' ? 'up-text' : 'down-text'} style={{ fontSize: 11, marginLeft: 6, fontWeight: 700 }}>{dir}</span>
          {p.name && <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{p.name}</span>}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{Math.round(p.probability * 100)}% · ~{p.expectedMovePct}%</span>
      </div>
      {(p.setup || p.smallCap || p.capUsdM != null || (p.themes ?? []).length > 0 || p.earningsRisk) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {p.setup && <span className="badge">{p.setup}</span>}
          {(capBand(p.capUsdM) ?? (p.smallCap ? 'small cap' : null)) && (
            <span className="badge warn">{capBand(p.capUsdM) ?? 'small cap'}</span>
          )}
          {(p.themes ?? []).slice(0, 2).map(t => (
            <span key={t} className="badge">{t}</span>
          ))}
          {p.earningsRisk && <span className="badge bad">earnings ≤10d</span>}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
        <span>in {p.entry} · stop {p.stop} · tgt {p.target}</span>
        <span>{p.watchOnly ? 'watch — no size' : `risk ${p.riskPct}%${p.instrument ? ` · ${p.instrument.ticker} ${p.instrument.leverage}x` : p.paperOnly ? ' · paper-only' : ''}`}</span>
      </div>
      {p.belowBase && (
        <div style={{ fontSize: 11, color: 'var(--faint)' }}>
          Valid {p.side} setup — but calibration rates this side below its base rate in a {p.side === 'long' ? 'mixed/soft' : 'firm'} tape, so it's tracked, not sized.
        </div>
      )}
      <button className="mini-btn ghost" style={{ alignSelf: 'flex-start', fontSize: 11, padding: '1px 6px' }} onClick={() => setOpen(o => !o)}>
        {open ? 'hide evidence' : 'evidence'}
      </button>
      {open && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          <div style={{ marginBottom: 3 }}>{p.note}</div>
          {p.evidence && <div style={{ marginBottom: 3, color: 'var(--faint)' }}>{p.evidence.detail}{p.evidence.contract ? '' : ' — below the evidence bar'}</div>}
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

// a name's technical stage tinted by how it reads going into a print: weak/knife/
// stretched charts are the danger set (bad), a base or plain trend is neutral (warn),
// early-reversal / pullback near support reads constructive (no tint).
function stageTone(stage: string | null): string {
  if (!stage) return ''
  if (['weak', 'falling-knife', 'extended', 'exhausted'].includes(stage)) return 'bad'
  if (['basing', 'trending'].includes(stage)) return 'warn'
  return ''
}

// EVENT RADAR: dated earnings binaries the engine already tracks. Explicitly NOT
// a call — the engine refuses to bet a print (earningsRisk shadows those trades).
// This is the shape going INTO the print, so a big overnight surprise is never a
// name the reader had never heard of.
function EventRadar({ radar }: { radar: EngineData['eventRadar'] }) {
  if (!radar || radar.entries.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <h4 className="section-title" style={{ fontSize: 12 }}>Event radar — earnings ahead</h4>
      {radar.entries.map(e => (
        <div key={`${e.sym}-${e.date}`} className="perf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
            <span style={{ minWidth: 0 }}>
              <b>{e.sym}</b>
              {e.name && <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{e.name}</span>}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>prints {e.date} ({e.daysToPrint}d)</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'baseline', fontSize: 11.5 }}>
            {e.stage && <span className={`badge ${stageTone(e.stage)}`}>{e.stage}</span>}
            {e.rs21 != null && (
              <span className={e.rs21 >= 0 ? 'up-text' : 'down-text'}>RS {e.rs21 >= 0 ? '+' : ''}{e.rs21}pp</span>
            )}
            {e.note && <span style={{ color: 'var(--faint)' }}>{e.note}</span>}
          </div>
        </div>
      ))}
      <p className="empty-line" style={{ fontSize: 11 }}>
        The engine never bets an earnings print — this is the shape going in, so a 26%-overnight surprise is never a name you'd never heard of.
      </p>
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
  const todayLondon = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const weekend = [0, 6].includes(new Date().getDay())
  const stale = b.date !== todayLondon
  return (
    <section className="digest-section">
      <h3 className="section-title">
        The Board — engine calls, {b.date} <span className={`badge ${b.regime === 'green' ? '' : b.regime === 'red' ? 'bad' : 'warn'}`}>{b.regime}</span>
        {stale && <span className="badge warn" style={{ marginLeft: 6 }}>{weekend ? 'markets closed — last session' : `as of ${b.date}`}</span>}
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
        {!!b.themes?.length && (
          <>
            <span className="sep">·</span>
            <span>in the news: {b.themes.map(t => t.name.toLowerCase()).join(', ')}</span>
          </>
        )}
      </p>
      {b.board.length === 0 && <p className="empty-line">No edge today — every candidate failed the gates. An honest empty board beats a forced call.</p>}
      {(() => {
        // the new taxonomy: this-week trades, developing 2-4 week builds, then the
        // remaining short-horizon watch observations (horizon stamped by the engine)
        const trades = b.board.filter(p => !p.watchOnly)
        const developing = b.board.filter(p => p.watchOnly && p.horizon === 'developing')
        const watch = b.board.filter(p => p.watchOnly && p.horizon !== 'developing')
        return (
          <>
            {trades.length > 0 && <h4 className="section-title" style={{ fontSize: 12, marginTop: 6 }}>This week — trades</h4>}
            {trades.map(p => (
              <Call key={p.id} p={p} />
            ))}
            {trades.length === 0 && b.board.length > 0 && (
              <p className="empty-line">No qualified trades this week — nothing earned an A/B grade on full evidence. What follows is what the engine is tracking.</p>
            )}
            {developing.length > 0 && (
              <h4 className="section-title" style={{ fontSize: 12, marginTop: 8 }}>Developing — building over 2–4 weeks</h4>
            )}
            {developing.map(p => (
              <Call key={p.id} p={p} />
            ))}
            {watch.length > 0 && (
              <h4 className="section-title" style={{ fontSize: 12, marginTop: 8 }}>Watch — short-term observations</h4>
            )}
            {watch.map(p => (
              <Call key={p.id} p={p} />
            ))}
          </>
        )
      })()}
      <EventRadar radar={data?.eventRadar ?? null} />
      <p className="empty-line" style={{ fontSize: 11 }}>
        Grades are calibrated on the engine's own graded history: a hit must beat SPY by ≥1pp over the horizon, and stops are judged on daily closes — an
        intraday wick through is survivable. A/B/C means the call's bucket beats the engine's own base rate, not a coin flip. Provisional = thin evidence
        bucket. Only A/B calls on full evidence carry size — watch rows are observations. This is analysis, not advice.
      </p>
    </section>
  )
}
