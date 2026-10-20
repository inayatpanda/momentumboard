import '../styles/gates.css'
import { DataStatus } from './parts/DataStatus'
// Gates & learning (plan Task 21) — the engine's self-tuning made visible:
// the three tunable gates (shared/engine/gateState.ts), the paper's own
// sentences about them, the factor weights the IC loop has nudged, the
// roster it hunts on, and which channels have earned credibility. ONE slice
// (`learning`, DS-5's whole-blob read) — the same cache Track record already
// warms, so a reader who has visited Record pays no second fetch here.
//
// Every numeric is `.num`; every bar is tokens-only, same primitives as
// FactorVotes/Record (.convbar, .sp-path/.sp-step for the dated timeline).
//
// OWNER ITERATION 2 — "Gates and Learning is illegible - cant make anything
// out of it." Nothing about the DATA changed here; every word around it did.
// The page was a wall of jargon nouns and bare numbers — "dead zone 22.5",
// "base 25", a bar between two unlabelled bounds — none of which says what the
// thing IS, which way is loose, or what a move meant. So: a page intro, one
// plain-English sentence per gate, looser/tighter labels on the bar's ends
// (derived from GATE_BOUNDS' own `loosen` sign, never hardcoded), each history
// entry as a sentence, and the weights renamed to what they actually are —
// how much the engine trusts a factor now versus at launch.

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { getLearning } from '../lib/apiViews'
import type { LearningSlice } from '../lib/apiViews'
import { GATE_BOUNDS, GATE_CADENCE_SESSIONS } from '../../shared/engine/gateState'
import type { GateStructuredEntry, TunableGate } from '../../shared/engine/gateState'
import { labelOf } from './parts/FactorVotes'
import { compactUsd, longDate } from '../lib/format'

/** WHAT EACH GATE ACTUALLY IS, in one sentence a reader who has never seen the
 * engine's source can act on. The engine's own labels ("dead zone", "context
 * cap") are names, not explanations. */
const GATE_WHAT: Record<TunableGate, string> = {
  deadZone: 'The conviction bar — below this composite score, no call.',
  minExpectedMovePct: 'The payoff floor — a setup must promise at least this much move to be worth a slot.',
  contextCap: 'How much soft evidence (news, social) can add on top of the chart.',
}

/** WHICH END OF THE BAR IS LOOSE, read off the engine's own rule rather than
 * assumed. `GATE_BOUNDS[gate].loosen` is the SIGN that loosens the funnel: −1
 * means loosening DECREASES the value, so the minimum end is the loose one and
 * the maximum end the strict one. All three gates are −1 today; a future gate
 * that loosens upward relabels itself here with no edit. */
function endLabels(gate: TunableGate): { min: string; max: string } {
  return GATE_BOUNDS[gate].loosen === -1 ? { min: 'looser', max: 'tighter' } : { min: 'tighter', max: 'looser' }
}

/** Did this move loosen the funnel or tighten it? Same rule, applied to the
 * direction the value actually travelled. */
function moveWord(gate: TunableGate, from: number, to: number): string {
  if (to === from) return 'held'
  return Math.sign(to - from) === GATE_BOUNDS[gate].loosen ? 'loosened' : 'tightened'
}

/** The three "why" sentences a held gate can carry — human prose, not the
 * server's prompt-safe template (gateAnnouncement owns that one). */
function blockedSentence(blocked: NonNullable<GateStructuredEntry['blocked']>): string {
  if (blocked.why === 'override') return `Eligible to move since ${longDate(blocked.date)}, but pinned by your override — the threshold stays put.`
  if (blocked.why === 'bound') return `Eligible to move since ${longDate(blocked.date)}, but already at its hard bound — the evidence points beyond the range you've ratified.`
  return `Eligible to move since ${longDate(blocked.date)}, held by the cadence — one notch per ${GATE_CADENCE_SESSIONS} sessions.`
}

/** WHERE THE GATE SITS in its own ratified range, 0–100.
 *
 * The arithmetic never changed; what it was DRAWN as did. A fill bar answers
 * "how much", and a threshold is not a quantity — it is a position. The live
 * desk caught the consequence: the context cap sits at 12 of 12–16, its own
 * minimum, so the fill was mathematically a perfect zero and read on screen as
 * a broken widget beside two bars that happened to be pinned at their maxima
 * and so read as full. A marker on the track says the same number and cannot
 * be mistaken for a failure to render. (Visibility wave, 2026-08-17.) */
export function gatePosition(current: number, min: number, max: number): number {
  if (!(max > min)) return 0
  return Math.min(100, Math.max(0, ((current - min) / (max - min)) * 100))
}

function GateCard({ gate }: { gate: GateStructuredEntry }) {
  const { min, max } = gate.bounds
  const pos = gatePosition(gate.current, min, max)
  const ends = endLabels(gate.gate)
  return (
    <div className="card gl-gate">
      <div className="gl-gate-head">
        <span className="gl-gate-label">{gate.label}</span>
        <span className="num gl-gate-current">{gate.current}</span>
      </div>
      <p className="cc-reason gl-gate-what">{GATE_WHAT[gate.gate]}</p>
      <div className="gl-gate-bar-row">
        <span className="gl-gate-bound">
          <span className="num">{min}</span>
          <span className="gl-gate-end">{ends.min}</span>
        </span>
        <span
          className="gl-gate-track"
          role="img"
          aria-label={`${gate.label} sits at ${gate.current} on a scale from ${min} to ${max}`}
          data-position={Math.round(pos)}
        >
          <i className="gl-gate-marker" style={{ left: `${pos}%` }} />
        </span>
        <span className="gl-gate-bound gl-gate-bound-max">
          <span className="num">{max}</span>
          <span className="gl-gate-end">{ends.max}</span>
        </span>
      </div>
      {/* the big number above IS the current value — this note is only where it
          started, so it never reprints it */}
      <p className="cc-reason gl-gate-base">
        Set at launch to <span className="num">{gate.base}</span>
        {gate.current !== gate.base && ' — the engine has moved it since'}
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
              {/* ONE SENTENCE per move (owner iteration 2): the date, the word
                  for what the move DID to the funnel, the numbers, and the
                  engine's own reason. It used to be three stacked fragments. */}
              <span className="sp-step-body gl-history-line">
                <span className="sp-step-date">{longDate(h.date)}</span>
                <span className="gl-history-prose">
                  — {moveWord(gate.gate, h.from, h.to)}{' '}
                  <span className="sp-step-gate num">
                    {h.from} → {h.to}
                  </span>
                  : {h.why}
                </span>
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
      <p className="sec-label">The gates</p>
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

/** "Factor weights — base vs current" told the reader nothing: a weight is an
 * internal coefficient, and two bars beside "1.00 → 0.80" is a diff, not a
 * meaning. What the number IS is how much the engine trusts that factor now
 * compared with the day it launched — so say that, per factor, in a percentage
 * a reader can hold. (Owner iteration 2.) */
function trustPhrase(base: number, current: number): string {
  if (!Number.isFinite(base) || base === 0) return current === base ? 'unchanged since launch' : 'no launch weight to compare against'
  const delta = ((current - base) / base) * 100
  if (Math.abs(delta) < 0.05) return 'unchanged since launch'
  return `trusts it ${Math.abs(delta).toFixed(1)}% ${delta > 0 ? 'more' : 'less'} than launch`
}

function WeightsSection({ weights }: { weights: LearningSlice['weights'] }) {
  if (!weights) return null
  const keys = Object.keys(weights.base)
  if (keys.length === 0) return null
  const max = Math.max(1, ...keys.map(k => Math.max(weights.base[k] ?? 0, weights.current[k] ?? 0)))
  return (
    <section aria-label="Factor trust">
      <p className="sec-label">Factor trust</p>
      <p className="cc-reason gl-intro">
        Each factor started at a weight the engine was launched with; the learning loop nudges that weight as priced outcomes arrive. The bars are launch
        (upper) against today (lower).
      </p>
      <div className="card gl-weights">
        {keys.map(k => {
          const base = weights.base[k] ?? 0
          const current = weights.current[k] ?? 0
          return (
            <div className="gl-weight-row" key={k}>
              <span className="gl-weight-name">{labelOf(k)}</span>
              <span className="gl-weight-phrase">{trustPhrase(base, current)}</span>
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

/** A NAME CANNOT BOTH JOIN AND BE DROPPED (visibility wave, 2026-08-17). The
 * live roster printed "joined AVGO, LLY · dropped AVGO (roster full), LLY
 * (roster full)" on seven separate days — which reads as churn, as though the
 * engine kept changing its mind. It never did: the trim runs in the same pass
 * as the screen, so a name that qualified and then lost the cut appears in
 * both arrays. It was knocked at the door; it was never on the roster.
 *
 * Returns the day's clauses in reading order — the knocked first (grouped by
 * the reason they were shed, so one line can carry several names), then the
 * names that actually joined, then the names that were actually dropped. */
export function churnLines(c: { joined: string[]; dropped: { sym: string; why: string }[] }): string[] {
  const joined = c.joined ?? []
  const dropped = c.dropped ?? []
  const joinedSet = new Set(joined)
  const knockedSyms = new Set<string>()
  const byWhy = new Map<string, string[]>()
  for (const d of dropped) {
    if (!joinedSet.has(d.sym) || knockedSyms.has(d.sym)) continue
    knockedSyms.add(d.sym)
    byWhy.set(d.why, [...(byWhy.get(d.why) ?? []), d.sym])
  }
  const out: string[] = []
  for (const [why, syms] of byWhy) out.push(`${syms.join(', ')} knocked — ${why}, not admitted`)
  const admitted = joined.filter(s => !knockedSyms.has(s))
  if (admitted.length > 0) out.push(`joined ${admitted.join(', ')}`)
  const shed = dropped.filter(d => !joinedSet.has(d.sym))
  if (shed.length > 0) out.push(`dropped ${shed.map(d => `${d.sym} (${d.why})`).join(', ')}`)
  return out
}

function RosterSection({ roster }: { roster: LearningSlice['roster'] }) {
  const [visible, setVisible] = useState(ROSTER_PAGE)
  if (!roster || roster.entries.length === 0) return null
  const entries = roster.entries as { sym: string; joined: string; source: string; capUsdM: number | null; lastCapacity: number | null; lastQualified: string }[]
  const changes = roster.changes as { date: string; joined: string[]; dropped: { sym: string; why: string }[] }[]
  return (
    <section aria-label="Roster">
      <p className="sec-label">
        Roster — <span className="num">{entries.length}</span> names
      </p>
      <p className="cc-reason gl-intro">The names the engine actively hunts on (beyond the day's movers).</p>
      <div className="card gl-roster">
        {entries.slice(0, visible).map(e => (
          <Link href={`/stock/${e.sym}`} key={e.sym} className="gl-roster-row">
            <span className="gl-roster-sym">{e.sym}</span>
            <span className="cc-reason">joined {e.joined} · {e.source}</span>
            {/* `$16487M` is not a number a reader holds — compactUsd is the
                same rule the insider column uses, and capUsdM is millions */}
            <span className="num gl-roster-cap">{e.capUsdM != null ? compactUsd(e.capUsdM * 1e6) : '—'}</span>
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
              {churnLines(c).map((line, i) => (
                <span key={i}> · {line}</span>
              ))}
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
      <p className="cc-reason gl-intro">Which YouTube/Reddit callers have earned trust — graded calls vs hits.</p>
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
  const { data, error, refresh, refreshing } = useSlice('learning', getLearning)

  return (
    <div className="gl2">
      <h1>Gates &amp; learning</h1>
      {/* THE PAGE, IN TWO SENTENCES (owner iteration 2: "cant make anything out
          of it"). Everything below is a bar, a number or a date; without this
          the reader has no idea what any of it is FOR. */}
      <p className="cc-reason gl-page-intro">
        The engine tunes its own strictness. Each gate below is a bar every candidate must clear; the engine may loosen or tighten them one notch at a
        time when the priced record says so.
      </p>
      {data == null ? (
        <DataStatus label="Engine learning" error={error} refresh={refresh} refreshing={refreshing} />
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
