import { useEffect, useState } from 'react'
import { getEngine, type EngineData, type EnginePrediction, type IntradayFlag } from '../lib/api'
import { capBand, emptySideLine, fmtRiskPct, sizeLabel } from '../lib/format'
import { GradeChip } from './GradeChip'

// the intraday-flag chip vocabulary, shared with the Desk rail card
export const FLAG_LABEL: Record<IntradayFlag['kind'], string> = { 'entry-zone': 'entry zone', 'second-chance': 'second chance', breakout: 'breakout' }
export const FLAG_BADGE: Record<IntradayFlag['kind'], string> = { 'entry-zone': 'info', 'second-chance': 'good', breakout: 'warn' }

// flatten a day's scans (newest scan first) into one row per symbol, freshest kept
export function flattenIntradayFlags(blob: EngineData['intradayFlags']): IntradayFlag[] {
  if (!blob) return []
  const seen = new Set<string>()
  const out: IntradayFlag[] = []
  for (const s of blob.scans) for (const f of s.flags) if (!seen.has(f.sym)) { seen.add(f.sym); out.push(f) }
  return out
}

const flagTime = (sec: number) => new Date(sec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })

// INTRADAY FLAGS strip: the morning's setups the moment price reaches the level,
// so an obvious entry gets surfaced at least once a day. Renders nothing before
// the first scan; an honest "scanned — nothing" line once a scan has run empty.
function IntradayFlagsStrip({ blob }: { blob: EngineData['intradayFlags'] }) {
  if (!blob || blob.scans.length === 0) return null // no scan yet — say nothing
  const flags = flattenIntradayFlags(blob)
  const lastAt = blob.scans[0]?.at
  if (flags.length === 0) {
    return <p className="empty-line" style={{ fontSize: 11 }}>Scanned {lastAt ? flagTime(lastAt) : ''} — no clean intraday entries.</p>
  }
  return (
    <div style={{ marginTop: 6, marginBottom: 4 }}>
      <h4 className="section-title" style={{ fontSize: 12 }}>Intraday flags — the morning setup at today's prices</h4>
      {flags.map(f => (
        <div key={`${f.sym}-${f.kind}`} className="perf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
            <span style={{ minWidth: 0 }}>
              <b>{f.sym}</b>
              {f.name && <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{f.name}</span>}
              <span className={`badge ${FLAG_BADGE[f.kind]}`} style={{ marginLeft: 6 }}>{FLAG_LABEL[f.kind]}</span>
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 11, flexShrink: 0 }}>flagged {flagTime(f.at)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            <span style={{ fontFamily: 'var(--font-num)' }}>{f.price} vs {f.level}</span> — {f.detail}
          </div>
        </div>
      ))}
      <p className="empty-line" style={{ fontSize: 11 }}>Not new calls — the same setups the board carries, flagged when price reaches the level intraday. No new sizing, no new levels.</p>
    </div>
  )
}

// THE BOARD: today's scored calls from the prediction engine. Numbers only —
// grade, calibrated probability, entry/stop/target — with the factor evidence
// one tap away. The paper narrates this; here it stands naked.

function Call({ p }: { p: EnginePrediction }) {
  const [open, setOpen] = useState(false)
  const dir = p.side === 'long' ? '▲ LONG' : '▼ SHORT'
  // A reduced row says WHY in one word: half = one of conviction/evidence was short
  // (grade C with the full contract, or A/B without it); quarter = a lane's door cap
  // (a fresh breakout, sized as momentum rather than as a deficiency). Derived from
  // the FRACTION of the rung, so the label can never disagree with the number.
  const size = sizeLabel(p.riskPct, p.riskRung)
  return (
    <div className="perf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 700, minWidth: 0 }}>
          {/* below-base and near-miss rows have no honest letter grade (they're beneath C's bar,
              or never scored at all) — a plain chip instead of a misleading C */}
          {p.nearMiss ? <span className="badge">near miss</span> : p.belowBase ? <span className="badge">tracking</span> : <GradeChip grade={p.grade} provisional={p.provisional} />}{' '}
          {p.sym}
          <span className={p.side === 'long' ? 'up-text' : 'down-text'} style={{ fontSize: 11, marginLeft: 6, fontWeight: 700 }}>{dir}</span>
          {p.name && (
            <span
              title={p.name}
              style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12, marginLeft: 6, display: 'inline-block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
            >
              {p.name}
            </span>
          )}
        </span>
        {/* a near miss was never scored — its base-rate probability is a placeholder, not a read */}
        <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{p.nearMiss ? `~${p.expectedMovePct}%` : `${Math.round(p.probability * 100)}% · ~${p.expectedMovePct}%`}</span>
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
      {/* What the row believes and what would end it (voice.ts) — in the open,
          above the levels it is about. The machine-voiced factor line is still
          `note`, and it stays where it was: inside the evidence toggle below. */}
      {p.thesis && <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>{p.thesis}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
        <span>in {p.entry} · stop {p.stop} · tgt {p.target}</span>
        <span>
          {p.watchOnly
            ? p.nearMiss
              ? 'nearest miss — no size'
              : // an observation is unsized because an ISA cannot route it, not
                // because it fell short of anything — the card says which
                p.observation
                ? 'no ISA route — observation only'
                : 'watch — no size'
            : `risk ${fmtRiskPct(p.riskPct)}%${size}${p.instrument ? ` · ${p.instrument.ticker} ${p.instrument.leverage}x` : p.paperOnly ? ' · paper-only' : ''}`}
        </span>
      </div>
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
  if (!b)
    // skeleton shaped like the board, not a blank void — the Signals/Markets
    // tab used to render nothing here while loading, which read as broken
    return (
      <section className="digest-section" aria-busy="true">
        <div className="skeleton" style={{ height: 18, width: '55%', marginBottom: 12 }} />
        {[0, 1, 2].map(i => (
          <div key={i} className="skeleton" style={{ height: 84, marginBottom: 8 }} />
        ))}
      </section>
    )
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
      <IntradayFlagsStrip blob={data?.intradayFlags ?? null} />
      {b.board.length === 0 && <p className="empty-line">No edge today — every candidate failed the gates. An honest empty board beats a forced call.</p>}
      {(() => {
        // the new taxonomy: this-week trades, developing 2-4 week builds, then the
        // remaining short-horizon watch observations (horizon stamped by the engine),
        // then the route-blocked observations, and last of all the nearest misses —
        // rows that cleared no gate at all and exist only so a side with nothing on
        // it still says what came closest.
        //
        // A promoted observation gets its OWN section rather than falling into the
        // watch list: that section's line explains its rows as reads "below the
        // sizing bar", and this row cleared the bar and every gate above it. It is
        // unsized for one reason only, and it is not a reason about the evidence.
        const trades = b.board.filter(p => !p.watchOnly)
        const developing = b.board.filter(p => p.watchOnly && !p.nearMiss && !p.observation && p.horizon === 'developing')
        const watch = b.board.filter(p => p.watchOnly && !p.nearMiss && !p.observation && p.horizon !== 'developing')
        const observations = b.board.filter(p => p.observation && !p.nearMiss)
        const nearMisses = b.board.filter(p => p.nearMiss)
        return (
          <>
            {trades.length > 0 && <h4 className="section-title" style={{ fontSize: 12, marginTop: 6 }}>This week — trades</h4>}
            {trades.map(p => (
              <Call key={p.id} p={p} />
            ))}
            {trades.length === 0 && b.board.length > 0 && (
              <p className="empty-line">No sized trades this week — nothing reached even half size. What follows is what the engine is tracking.</p>
            )}
            {/* WHY a side is empty, in the engine's own words. A side emptied by
                routing has candidates that cleared every gate — saying "nothing
                cleared the gates" there is false, and the reader can check it. */}
            {(['long', 'short'] as const).map(side =>
              b.emptySides?.[side] ? (
                <p key={side} className="empty-line" style={{ fontSize: 11, marginTop: -2, marginBottom: 4 }}>
                  {emptySideLine(side, b.emptySides[side]!)}
                </p>
              ) : null,
            )}
            {developing.length > 0 && (
              <>
                <h4 className="section-title" style={{ fontSize: 12, marginTop: 8 }}>Developing — building over 2–4 weeks</h4>
                {/* the tracked-not-sized reason, said ONCE for the group instead of on every card */}
                <p className="empty-line" style={{ fontSize: 11, marginTop: -2, marginBottom: 4 }}>Valid setups the engine rates below their base rate in this tape — tracked while they build, not sized.</p>
              </>
            )}
            {developing.map(p => (
              <Call key={p.id} p={p} />
            ))}
            {watch.length > 0 && (
              <>
                <h4 className="section-title" style={{ fontSize: 12, marginTop: 8 }}>Watch — short-term observations</h4>
                <p className="empty-line" style={{ fontSize: 11, marginTop: -2, marginBottom: 4 }}>Short-horizon reads below the sizing bar — observed, not sized.</p>
              </>
            )}
            {watch.map(p => (
              <Call key={p.id} p={p} />
            ))}
            {observations.length > 0 && (
              <>
                <h4 className="section-title" style={{ fontSize: 12, marginTop: 8 }}>Observations — no ISA route</h4>
                <p className="empty-line" style={{ fontSize: 11, marginTop: -2, marginBottom: 4 }}>
                  Cleared every gate and fully graded — but nothing in an ISA can place them, so they are shown as reads, not offers.
                </p>
              </>
            )}
            {observations.map(p => (
              <Call key={p.id} p={p} />
            ))}
            {nearMisses.length > 0 && (
              <>
                <h4 className="section-title" style={{ fontSize: 12, marginTop: 8 }}>
                  Nearest misses{nearMisses.some(p => p.side === 'long') && nearMisses.some(p => p.side === 'short') ? '' : ` — ${nearMisses[0].side} side`}
                </h4>
                {/* the CAUSE is stated once, above, from what the engine recorded —
                    this line says only what these rows are */}
                <p className="empty-line" style={{ fontSize: 11, marginTop: -2, marginBottom: 4 }}>
                  What came closest on {nearMisses.some(p => p.side === 'long') && nearMisses.some(p => p.side === 'short') ? 'either side' : `the ${nearMisses[0].side} side`} today.
                  Named, not called: no evidence read, no calibrated grade, no size, and they never enter the ledger.
                </p>
              </>
            )}
            {nearMisses.map(p => (
              <Call key={p.id} p={p} />
            ))}
          </>
        )
      })()}
      <EventRadar radar={data?.eventRadar ?? null} />
      <p className="empty-line" style={{ fontSize: 11 }}>
        Grades are calibrated on the engine's own graded history: a hit must beat SPY by ≥1pp over the horizon, and stops are judged on daily closes — an
        intraday wick through is survivable. A/B/C means the call's bucket beats the engine's own base rate, not a coin flip. Provisional = thin evidence
        bucket. A/B on full evidence carry full size; grade C on full evidence, and A/B whose evidence is thin, carry HALF size; below-base, unpicked and
        near-miss rows are watch-only. This is analysis, not advice.
      </p>
    </section>
  )
}
