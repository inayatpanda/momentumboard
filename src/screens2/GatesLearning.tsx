// Gates & learning (plan Task 21) — the engine's self-tuning made visible:
// the three tunable gates (shared/engine/gateState.ts), the paper's own
// sentences about them, the factor weights the IC loop has nudged, the
// roster it hunts on, and which channels have earned credibility. ONE slice
// (`learning`, DS-5's whole-blob read) — the same cache Track record already
// warms, so a reader who has visited Record pays no second fetch here.
//
// Every numeric is `.num`; every bar is tokens-only, same primitives as
// FactorVotes/Record (.convbar, .sp-path/.sp-step for the dated timeline).

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { getLearning } from '../lib/apiViews'
import type { LearningSlice } from '../lib/apiViews'
import { GATE_CADENCE_SESSIONS } from '../../shared/engine/gateState'
import type { GateStructuredEntry } from '../../shared/engine/gateState'
import { labelOf } from './parts/FactorVotes'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Manual parse, never `new Date(iso)` — same rule Regrets.tsx follows: the
// reader's timezone can walk an ISO day string back to the wrong calendar
// date. This surface's history can span years, so the label carries one.
function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${String(d).padStart(2, '0')} ${MONTHS[(m ?? 1) - 1] ?? ''} ${y}`
}

/** The three "why" sentences a held gate can carry — human prose, not the
 * server's prompt-safe template (gateAnnouncement owns that one). */
function blockedSentence(blocked: NonNullable<GateStructuredEntry['blocked']>): string {
  if (blocked.why === 'override') return `Eligible to move since ${longDate(blocked.date)}, but pinned by your override — the threshold stays put.`
  if (blocked.why === 'bound') return `Eligible to move since ${longDate(blocked.date)}, but already at its hard bound — the evidence points beyond the range you've ratified.`
  return `Eligible to move since ${longDate(blocked.date)}, held by the cadence — one notch per ${GATE_CADENCE_SESSIONS} sessions.`
}

function GateCard({ gate }: { gate: GateStructuredEntry }) {
  const { min, max } = gate.bounds
  const pct = max > min ? Math.min(100, Math.max(0, ((gate.current - min) / (max - min)) * 100)) : 0
  return (
    <div className="card gl-gate">
      <div className="gl-gate-head">
        <span className="gl-gate-label">{gate.label}</span>
        <span className="num gl-gate-current">{gate.current}</span>
      </div>
      <div className="gl-gate-bar-row">
        <span className="num gl-gate-bound">{min}</span>
        <span className="convbar gl-gate-track">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="num gl-gate-bound">{max}</span>
      </div>
      <p className="cc-reason gl-gate-base">
        base <span className="num">{gate.base}</span>
      </p>
      {gate.override != null && (
        <span className="pill accent gl-pin">
          pinned by you at <span className="num">{gate.override}</span>
        </span>
      )}
      {gate.blocked && <p className="cc-reason gl-blocked">{blockedSentence(gate.blocked)}</p>}
      {gate.history.length > 0 && (
        <ul className="sp-path gl-history">
          {[...gate.history].reverse().map((h, i) => (
            <li className="sp-step" data-kind="published" key={`${h.date}-${i}`}>
              <i className="sp-dot" aria-hidden="true" />
              <span className="sp-step-body">
                <span className="sp-step-date">{longDate(h.date)}</span>
                <span className="sp-step-gate num">
                  {h.from} → {h.to}
                </span>
                <span className="cc-reason">{h.why}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function GatesSection({ gates }: { gates: GateStructuredEntry[] }) {
  return (
    <section aria-label="Gates">
      <p className="sec-label">Gates</p>
      <div className="gl-gates">
        {gates.map(g => (
          <GateCard gate={g} key={g.gate} />
        ))}
      </div>
    </section>
  )
}

function GateLinesSection({ lines }: { lines: LearningSlice['gateLines'] }) {
  if (!lines || (lines.moves.length === 0 && lines.notes.length === 0)) return null
  return (
    <section aria-label="The paper's own lines">
      <p className="sec-label">What the paper has said about this</p>
      <div className="gl-lines">
        {lines.moves.map((m, i) => (
          <blockquote key={`m${i}`} className="gl-line">
            {m}
          </blockquote>
        ))}
        {lines.notes.map((n, i) => (
          <blockquote key={`n${i}`} className="gl-line gl-line-note">
            {n}
          </blockquote>
        ))}
      </div>
    </section>
  )
}

function WeightsSection({ weights }: { weights: LearningSlice['weights'] }) {
  if (!weights) return null
  const keys = Object.keys(weights.base)
  if (keys.length === 0) return null
  const max = Math.max(1, ...keys.map(k => Math.max(weights.base[k] ?? 0, weights.current[k] ?? 0)))
  return (
    <section aria-label="Weights">
      <p className="sec-label">Factor weights — base vs current</p>
      <div className="card gl-weights">
        {keys.map(k => {
          const base = weights.base[k] ?? 0
          const current = weights.current[k] ?? 0
          return (
            <div className="gl-weight-row" key={k}>
              <span className="gl-weight-name">{labelOf(k)}</span>
              <span className="gl-weight-bars">
                <span className="gl-weight-bar" title="base">
                  <i className="base" style={{ width: `${(base / max) * 100}%` }} />
                </span>
                <span className="gl-weight-bar" title="current">
                  <i className="current" style={{ width: `${(current / max) * 100}%` }} />
                </span>
              </span>
              <span className="num gl-weight-vals">
                {base.toFixed(2)} → {current.toFixed(2)}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

const ROSTER_PAGE = 10

function RosterSection({ roster }: { roster: LearningSlice['roster'] }) {
  const [visible, setVisible] = useState(ROSTER_PAGE)
  if (!roster || roster.entries.length === 0) return null
  const entries = roster.entries as { sym: string; joined: string; source: string; capUsdM: number | null; lastCapacity: number | null; lastQualified: string }[]
  const changes = roster.changes as { date: string; joined: string[]; dropped: { sym: string; why: string }[] }[]
  return (
    <section aria-label="Roster">
      <p className="sec-label">
        Roster — <span className="num">{entries.length}</span> names the engine hunts on
      </p>
      <div className="card gl-roster">
        {entries.slice(0, visible).map(e => (
          <Link href={`/stock/${e.sym}`} key={e.sym} className="gl-roster-row">
            <span className="gl-roster-sym">{e.sym}</span>
            <span className="cc-reason">joined {e.joined} · {e.source}</span>
            <span className="num gl-roster-cap">{e.capUsdM != null ? `$${Math.round(e.capUsdM)}M` : '—'}</span>
          </Link>
        ))}
      </div>
      {visible < entries.length && (
        <button type="button" className="stx-showmore" onClick={() => setVisible(entries.length)}>
          Show more ({entries.length - visible})
        </button>
      )}
      {changes.length > 0 && (
        <div className="gl-roster-changes">
          <p className="sec-label">Last changes</p>
          {[...changes].reverse().map(c => (
            <p className="cc-reason" key={c.date}>
              <strong>{c.date}</strong>
              {c.joined.length > 0 && <> · joined {c.joined.join(', ')}</>}
              {c.dropped.length > 0 && <> · dropped {c.dropped.map(d => `${d.sym} (${d.why})`).join(', ')}</>}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}

function ChannelCredSection({ channelCred }: { channelCred: LearningSlice['channelCred'] }) {
  const rows = Object.entries(channelCred).sort((a, b) => b[1].graded - a[1].graded)
  if (rows.length === 0) return null
  return (
    <section aria-label="Channel credibility">
      <p className="sec-label">Channel credibility</p>
      <div className="gl-cred-wrap">
        <table className="gl-cred-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Graded</th>
              <th>Hits</th>
              <th>Avg excess</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([channel, s]) => (
              <tr key={channel}>
                <td>{channel}</td>
                <td className="num">{s.graded}</td>
                <td className="num">{s.hits}</td>
                <td className="num">{s.avgExcess != null ? `${s.avgExcess >= 0 ? '+' : ''}${s.avgExcess.toFixed(1)}pp` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function GatesLearning() {
  const { data } = useSlice('learning', getLearning)

  return (
    <div className="gl2">
      <h1>Gates &amp; learning</h1>
      {data == null ? (
        <>
          <div className="skeleton" style={{ height: 220, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 120 }} />
        </>
      ) : (
        <>
          <GatesSection gates={data.gateState.gates} />
          <GateLinesSection lines={data.gateLines} />
          <WeightsSection weights={data.weights} />
          <RosterSection roster={data.roster} />
          <ChannelCredSection channelCred={data.channelCred} />
        </>
      )}
    </div>
  )
}
