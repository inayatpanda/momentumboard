import { useEffect, useState } from 'react'
import { getEngine, type EngineData, type EnginePrediction } from '../lib/api'
import { capBand, emptySideLine, fmtRiskPct, sizeLabel } from '../lib/format'
import { GradeChip } from './GradeChip'

// TODAY'S CALLS: the engine board, front and centre on the watchlist. Each
// call carries its reason line (the top weighted factors) in the open — the
// full evidence and levels live one tap away on the ticker page and in
// Intel → Markets.

const MAX_SHOWN = 6

/** Trades lead, watch rows fill what's left — but a side is never silenced by
 * the cut. If the board has a short and the first six rows are all longs, the
 * reader would be told the engine saw nothing short today, which is false. So
 * each side with any row is guaranteed its best row a slot, taken from the
 * weakest slot of the crowded side. PURE + exported so it can be tested. */
export function visibleCalls(board: readonly EnginePrediction[], max = MAX_SHOWN): EnginePrediction[] {
  const ordered = [...board.filter(p => !p.watchOnly), ...board.filter(p => p.watchOnly)]
  const shown = ordered.slice(0, max)
  for (const side of ['long', 'short'] as const) {
    const best = ordered.find(p => p.side === side)
    if (!best || shown.some(p => p.side === side)) continue
    // the crowded side gives up its weakest slot — but only while it keeps one,
    // so squeezing a short in can never silence the longs in its turn
    const evictAt = shown.length - 1
    if (evictAt < 1) continue
    shown[evictAt] = best
  }
  return shown
}

export function TodaysCalls({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [data, setData] = useState<EngineData | null>(null)
  useEffect(() => {
    getEngine().then(setData).catch(() => {})
  }, [])
  const b = data?.board
  if (!b) return null
  const todayLondon = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const weekend = [0, 6].includes(new Date().getDay())
  const stale = b.date !== todayLondon
  // trades lead; watch-only fills what's left of the shown slots, and neither
  // side is ever cut away entirely while it has a row (visibleCalls)
  const trades = b.board.filter(p => !p.watchOnly)
  const calls = visibleCalls(b.board)
  const shownIds = new Set(calls.map(p => p.id))
  const moreCalls = b.board.filter(p => !p.nearMiss && !shownIds.has(p.id)).length
  return (
    <section className="digest-section" style={{ marginBottom: 14 }}>
      <h3 className="section-title">
        Today's calls
        <span className={`badge ${b.regime === 'green' ? '' : b.regime === 'red' ? 'bad' : 'warn'}`}>{b.regime}</span>
        {stale && <span className="badge warn">{weekend ? 'markets closed — last session' : `as of ${b.date}`}</span>}
      </h3>
      {calls.length === 0 && <p className="empty-line">No edge today — every candidate failed the gates. An honest empty board beats a forced call.</p>}
      {calls.length > 0 && trades.length === 0 && !calls.every(p => p.nearMiss) && (
        <p className="empty-line">Nothing reached even half size today — these are watch-only observations, not calls.</p>
      )}
      {calls.length > 0 && calls.every(p => p.nearMiss) && (
        <p className="empty-line">These are the nearest misses, named so the board is never blank. No grade, no size.</p>
      )}
      {/* the engine's own reason a side has nothing tradeable — "nothing cleared the
          gates" is false when a graded, evidenced call simply cannot be routed */}
      {(['long', 'short'] as const).map(side =>
        b.emptySides?.[side] ? (
          <p key={side} className="empty-line">{emptySideLine(side, b.emptySides[side]!)}</p>
        ) : null,
      )}
      {calls.map(p => {
        const band = capBand(p.capUsdM) ?? (p.smallCap ? 'small cap' : null)
        return (
          <div
            key={p.id}
            className="perf-row calls-row"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(p.sym)}
            onKeyDown={e => e.key === 'Enter' && onOpen(p.sym)}
          >
            <span className="calls-top">
              {/* a near miss was never scored — a letter grade would be a fiction */}
              {p.nearMiss ? <span className="badge">—</span> : <GradeChip grade={p.grade} provisional={p.provisional} />}
              <span className="calls-sym">{p.sym}</span>
              {p.name && <span className="calls-name">{p.name}</span>}
              <span className={`chg-pill calls-side ${p.side === 'long' ? 'up' : 'down'}`}>{p.side === 'long' ? '▲ Long' : '▼ Short'}</span>
              {p.watchOnly && <span className="badge warn">{p.nearMiss ? 'near miss' : 'watch'}</span>}
              <span className="calls-odds">{p.nearMiss ? `~${p.expectedMovePct}%` : `${Math.round(p.probability * 100)}% · ~${p.expectedMovePct}%`}</span>
            </span>
            {/* what the row is WORTH, said on the card: full, half, a lane's quarter-size probe, or nothing */}
            <span className="calls-risk" style={{ fontSize: 11, color: 'var(--muted)' }}>
              {p.riskPct > 0 ? `${fmtRiskPct(p.riskPct)}% risk${sizeLabel(p.riskPct, p.riskRung)}` : p.nearMiss ? 'nearest miss — no size' : 'watch only'}
            </span>
            {(band || (p.themes ?? []).length > 0 || p.earningsRisk || p.wildcard) && (
              <span className="calls-tags">
                {/* THE EXPERIMENT (Stage 3d), first and warned — parity with
                    EngineBoard, which has carried this chip since the slot
                    shipped. This is the card the reader opens first, so a
                    wildcard printed here without it is quarter-size money on a
                    row the engine's own gates REFUSED, dressed as an ordinary
                    call. The thesis line beneath already carries the label, the
                    hypothesis and the standing warning; this finds it at a
                    glance. */}
                {p.wildcard && <span className="badge warn" title={`Experiment · testing the ${p.wildcard.gate} gate`}>🃏 wildcard</span>}
                {band && <span className="badge">{band}</span>}
                {(p.themes ?? []).slice(0, 2).map(t => (
                  <span key={t} className="badge">{t}</span>
                ))}
                {p.earningsRisk && <span className="badge bad">earnings ≤10d</span>}
              </span>
            )}
            {/* THE LEAD LINE is what the engine believes and what would end it
                (voice.ts). The machine-voiced factor line survives beneath it as
                the evidence, unchanged — and is the whole line on a near miss,
                which has no thesis because it cleared no gate. */}
            {p.thesis && <span className="calls-thesis">{p.thesis}</span>}
            <span className="calls-note">{p.note}</span>
          </div>
        )
      })}
      {/* "+N more" counts CALLS, not near misses — a row that cleared no gate is not
          a call waiting on the full board, and the watchdog counts the same way */}
      {moreCalls > 0 && <p className="empty-line calls-foot">+{moreCalls} more on the full board — Intel → Markets.</p>}
      {calls.length > 0 && (
        <p className="empty-line calls-foot">Tap a call for the chart and full factor evidence. Calibrated analysis, not advice.</p>
      )}
    </section>
  )
}
