import { CONTEXT_MAX_PTS } from './composite'
import { gatesFor, type Gates } from './catalyst'
import { safe as promptSafe } from './voice'
import type { GateAttribution } from './missLedger'
import type { GateCode } from './types'

// THE GATES MOVE — bounded, evidenced, announced.
//
// Stage 3a gave the funnel a record of every refusal; Stage 3b priced those
// refusals ten sessions later and charged each one to the gate that made it.
// This module is the third step and the only one that changes a published
// number: a gate whose refusals have demonstrably cost the reader more than they
// saved may move ONE notch, and a gate whose refusals have demonstrably saved
// more than they cost moves one notch the other way.
//
// FIVE RULES, and every one of them is a bound rather than a hope (spec §4.3):
//
//  1. EVIDENCE. A gate is eligible only with ≥ GATE_MIN_ATTRIBUTED attributed
//     outcomes of its OWN, and only when one column beats the other by more than
//     GATE_COST_RATIO×. The population is the hygienic one (missLedger.ts's
//     `gateAttribution`): sided rows only, bare mirror-rows excluded, and the
//     double-booked `called-*` gates excluded in BOTH directions.
//  2. ONE NOTCH. Never two, never a computed step size — the notch per gate is a
//     constant here and the arithmetic cannot produce anything else.
//  3. CADENCE. One notch per gate per GATE_CADENCE_SESSIONS sessions, clocked on
//     the DATES in `predictions-index` — the entries recorded AFTER the gate last
//     moved, counted, never `index.length` minus a stored count. The index is
//     capped at 250 (engine.ts), so a length-based clock froze the moment it
//     saturated: the count stopped rising, the difference stopped growing, and
//     any gate that had ever moved was held forever while the panel printed "one
//     notch per 20 sessions" as though a clock were running. Counting entries
//     survives the cap AND a wipe — a wiped index shows <20 sessions since, which
//     blocks, which is the safe reading (Task-3 review, Important 1).
//  4. HARD BOUNDS. Every gate has a floor and a ceiling it cannot be argued
//     past, however much evidence arrives, and a stored blob from any source is
//     clamped into them on the way out (`effectiveGateValues`) as well as on the
//     way in (`advanceGateState`) — a corrupt or hand-edited delta can widen
//     nothing.
//  5. ANNOUNCEMENT. Every move writes a history entry AND a line, and the same
//     line is what the runlog, the engine panel and the paper print. One
//     sentence, three surfaces, no chance of them disagreeing.
//
// THE STORED VALUE IS A DELTA, NOT A THRESHOLD. `gatesFor(appetite)` stays the
// base (catalyst.ts) and this blob stores the offset feedback has earned from it,
// so switching risk appetite COMPOSES with what the engine has learned instead of
// silently discarding it — and the hard bounds still hold at both presets (an
// aggressive dead zone already sits on the floor, so a loosening delta clamps
// rather than digging under it).
//
// …WHICH MEANS AN APPETITE SWITCH RE-BASES EVERY EARNED DELTA. The delta is an
// offset from whichever preset is live, so flipping moderate → aggressive moves
// the published threshold by the preset gap PLUS the delta, in one step, without
// a notch being earned. That is deliberate — the owner's appetite is an owner
// decision and feedback composes with it rather than overriding it — but it means
// the "one notch per cadence window" guarantee is FRAME-LOCAL: it bounds what
// feedback may do inside one preset, not what the published number can do across
// a switch. The hard bounds still hold on both sides of the switch (they are
// clamped on the way out), so nothing can be argued past a floor or a ceiling;
// only the path between them is not rate-limited across a re-base.
//
// DIRECTION, AND ONE ADJUDICATION WORTH READING. "Loosen" means "let more
// through", which is DOWN for the dead zone and the expected-move floor. For the
// context cap it is also DOWN, and that is the opposite of the spec's original
// "context cap 12 → ceiling 16" — corrected in the spec itself at §9.1
// (2026-08-13), which this comment is the code-side half of. At HEAD the context
// layer is a VETO at its OWN gate: `composeCall` applies the dead zone to the
// core BEFORE context is added, so at `dead-zone-context` a bigger cap can only
// ever push more calls back under the gate, never lift one over it.
//
// It is not quite inert everywhere else, and §9.1 says so: the capped context
// points ride into `adj`, and `adj` is what `levelsFor` sizes the expected move
// from — so at the margin a bigger cap can lift a call OVER the expected-move
// floor it would otherwise have missed. Refuses more at its own gate, loosens
// expected-move at the margin; both are classified as a gate move in the
// controlled diff. The spec's range is kept verbatim ([12, 16], notch 2) and read
// for what it mechanically is at the gate whose evidence judges it: the cap
// stands on its own floor today, so the only move its evidence can buy is a
// TIGHTENING, and it earns that only by saving. If the context layer ever becomes
// able to rescue a call at `dead-zone-context`, this comment and `loosen` flip
// together.

export const GATE_STATE_KEY = 'gate-state'
/** Attributed outcomes a gate needs before it may move at all (spec §4.3). */
export const GATE_MIN_ATTRIBUTED = 30
/** One column must beat the other by MORE than this to earn a notch. */
export const GATE_COST_RATIO = 2
/** Sessions between two notches of the SAME gate. Clocked on predictions-index. */
export const GATE_CADENCE_SESSIONS = 20
/** Per gate. Moves are rare by construction; this is a durability bound, not a
 * display one. */
export const GATE_HISTORY_MAX = 50
/** The `why` clause's budget at the compose seam. Generous — the engine's own
 * sentence is ~50 characters — because this bounds a hand-edited blob, not the
 * template. */
export const GATE_WHY_MAX = 140

/** THE THREE GATES FEEDBACK MAY TOUCH. `famAgree` (composite.ts's evidence
 * contract, 2) is the spec's fourth named gate and is deliberately absent: the
 * spec makes it reportable but IMMOVABLE, and a tunable with no legal move is a
 * lie in a type. The miss ledger still prices `evidence-fail` and the panel still
 * shows it — it simply has no lever here. */
export type TunableGate = 'deadZone' | 'minExpectedMovePct' | 'contextCap'

export interface GateBound {
  min: number
  max: number
  notch: number
  /** The sign that LOOSENS the funnel — see the header's adjudication. */
  loosen: -1 | 1
  /** The miss-ledger code whose attributed outcomes judge this gate. */
  source: GateCode
  label: string
}

export const GATE_BOUNDS: Record<TunableGate, GateBound> = {
  deadZone: { min: 20, max: 25, notch: 2.5, loosen: -1, source: 'dead-zone-core', label: 'dead zone' },
  minExpectedMovePct: { min: 1.0, max: 1.5, notch: 0.25, loosen: -1, source: 'expected-move', label: 'expected-move floor' },
  contextCap: { min: 12, max: 16, notch: 2, loosen: -1, source: 'dead-zone-context', label: 'context cap' },
}

export const TUNABLE_GATES = Object.keys(GATE_BOUNDS) as TunableGate[]

/** THE JOINT BOUND (composite.ts:141-143). The context cap is kept strictly
 * below the dead zone with margin so the capped context layer can never on its
 * own carry a name across the gate — and, since a gated core is already ≥ the
 * dead zone, can never flip its side either. The two gates move independently,
 * so the invariant has to be checked on the PAIR: the tightest legal pair under
 * the bounds above is cap 16 against dead zone 20, which holds with exactly the
 * margin the comment promises. Exported so the exhaustive lattice test and the
 * advance guard read the same predicate. */
export const jointBoundOk = (deadZone: number, contextCap: number): boolean => contextCap < deadZone - 2

/** One gate's earned offset from its preset. */
export interface GateDelta {
  delta: number
  /** THE CADENCE CLOCK: the ISO date this gate last moved. Sessions since are
   * COUNTED out of `predictions-index` (`sessionsSince`), never subtracted from
   * its length — see rule 3 in the header for what the length-based clock did at
   * saturation. Absent means "never moved".
   *
   * REPLACES `lastMoveSession` outright rather than shipping beside it: two
   * clocks in one blob is two things to keep in step, and the count was only ever
   * read by the rule this fix deletes. A blob written before this change carries
   * its move dates in `history`, so `normaliseGateState` migrates from there —
   * and a blob with neither reads as "never moved", which admits one notch early
   * at worst, on a mechanism that has never moved a gate in production. */
  lastMoveDate?: string
  history: { date: string; from: number; to: number; why: string }[]
  /** Recorded the FIRST time this gate was eligible and could not move, and why.
   * The panel says so once; a note repeated every morning is noise, and the
   * plan's own self-review asked for exactly one statement (the evidence for the
   * dead zone justifies the machinery, not an immediate move — the notch arrives
   * on the evidence's clock, not the deploy's). */
  blocked?: { why: 'cadence' | 'override'; date: string }
}

export interface GateState {
  gates: Partial<Record<TunableGate, GateDelta>>
}

export const emptyGateState = (): GateState => ({ gates: {} })

const isObj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null)
const isFin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
/** A date this module will print. ISO calendar dates only, because every date in
 * this blob is compared with `>` against `predictions-index` entries and read
 * back into a sentence — and both of those want the same lexicographic shape. */
const isDate = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)

/** Fail-soft read of the stored blob: anything that is not the shape becomes an
 * empty state rather than an exception inside the daily run — and an empty state
 * is byte-identically today's behaviour.
 *
 * EVERY FIELD IS TYPE-GUARDED, not just the delta (Task-3 review, Minor). This
 * blob is small, hand-editable and — unlike the ledger — its strings are READ
 * BACK INTO SENTENCES: the panel prints them and `gateAnnouncement` hands them to
 * the paper's LLM. A history entry whose `from` is the string "25" would print
 * "dead zone 25 → 22.5" indistinguishably from a real one, and a `blocked.why`
 * outside the two known reasons would fall through the summary's ternary and be
 * announced as a cadence hold. Malformed entries are DROPPED rather than
 * repaired: a record nobody can audit is not evidence, and the alternative is
 * printing a number the engine never chose. */
export function normaliseGateState(raw: unknown): GateState {
  const gates: GateState['gates'] = {}
  const src = isObj(isObj(raw)?.gates)
  for (const g of TUNABLE_GATES) {
    const d = isObj(src?.[g])
    if (!d || !isFin(d.delta)) continue
    const history = (Array.isArray(d.history) ? d.history : [])
      .map(isObj)
      .filter((h): h is Record<string, unknown> => !!h && isDate(h.date) && isFin(h.from) && isFin(h.to) && typeof h.why === 'string')
      .map(h => ({ date: h.date as string, from: h.from as number, to: h.to as number, why: h.why as string }))
    const blocked = isObj(d.blocked)
    // The clock, and its migration: a blob written before `lastMoveDate` existed
    // carries the same fact in the history it wrote at every move.
    const lastMoveDate = isDate(d.lastMoveDate) ? d.lastMoveDate : history.reduce<string | null>((m, h) => (m == null || h.date > m ? h.date : m), null)
    gates[g] = {
      delta: d.delta,
      ...(lastMoveDate != null ? { lastMoveDate } : {}),
      history,
      ...(blocked && (blocked.why === 'cadence' || blocked.why === 'override') && isDate(blocked.date)
        ? { blocked: { why: blocked.why, date: blocked.date } }
        : {}),
    }
  }
  return { gates }
}

/** THE CADENCE CLOCK ITSELF: sessions the index has recorded SINCE a gate moved.
 *
 * `index` is `predictions-index` — the engine's only honest session list, capped
 * at 250 entries. Counting the entries that fall after the move is what makes the
 * rule survive that cap (a saturated index of 250 sessions, every one of them
 * later than an old move, reads 250 and admits the notch — correct, and simple)
 * and survive a wipe (an emptied index reads 0 and blocks — also correct: the
 * engine cannot prove 20 sessions passed, so it does not act as though they did).
 *
 * Entries are compared with `>`, so the session a gate moved ON never counts
 * toward its own next window. */
export const sessionsSince = (index: readonly string[], lastMoveDate: string): number =>
  index.reduce((n, d) => (typeof d === 'string' && d > lastMoveDate ? n + 1 : n), 0)

/** THE ROLLBACK LEVER, mirroring `REGRET=off` (missLedger.ts) and
 * `FUNNEL_TRACE=off` (funnelTrace.ts) down to the guard on `process`.
 *
 * This is the first Stage-3 mechanism that changes a published number, so it
 * ships with one switch that puts the engine back on the frozen presets — the
 * stored blob is ignored for the run and no advance is evaluated. Nothing in
 * production sets it. Read per call rather than cached at import, and guarded for
 * the browser bundle, which has no `process` at all. */
export function gateFeedbackDisabled(): boolean {
  try {
    return typeof process !== 'undefined' && process.env?.GATES === 'off'
  } catch {
    return false
  }
}

/** The owner's absolute pin, mirroring `riskRungOverride` (shared/config.ts). A
 * pinned gate ignores its delta AND refuses to move — evidence still accrues and
 * is still reported, it simply cannot act. */
export type GateOverride = Partial<Record<TunableGate, number>>

export interface GateConfigLike {
  riskAppetite?: 'moderate' | 'aggressive' | null
  gateOverride?: GateOverride | null
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
/** Notches are 2.5 / 0.25 / 2 — all exact in binary — but a delta accumulated
 * over dozens of advances is worth snapping anyway: a published dead zone of
 * 22.499999999999996 would be a real bug in a printed number. */
const snap = (n: number) => Math.round(n * 10_000) / 10_000

/** The preset this gate's delta is an offset FROM. */
export function baseGateValue(gate: TunableGate, appetite?: 'moderate' | 'aggressive' | null): number {
  if (gate === 'contextCap') return CONTEXT_MAX_PTS // no appetite variant: one module constant
  return gatesFor(appetite)[gate]
}

/** Preset + earned delta (or the owner's pin), clamped into the hard bounds. */
export function effectiveGateValues(
  appetite: 'moderate' | 'aggressive' | null | undefined,
  state: GateState | null | undefined,
  overrides?: GateOverride | null,
): Record<TunableGate, number> {
  const out = {} as Record<TunableGate, number>
  const off = gateFeedbackDisabled()
  for (const g of TUNABLE_GATES) {
    const b = GATE_BOUNDS[g]
    const base = baseGateValue(g, appetite)
    if (off) {
      out[g] = base
      continue
    }
    const pin = overrides?.[g]
    const raw = typeof pin === 'number' && Number.isFinite(pin) ? pin : base + (state?.gates?.[g]?.delta ?? 0)
    out[g] = clamp(snap(raw), b.min, b.max)
  }
  return out
}

/** THE SEAM buildBoard reads instead of `gatesFor(cfg.riskAppetite)`.
 *
 * `contextMaxPts` is present ONLY when the cap has actually moved — the same
 * absent-means-the-default pattern the calibration blob uses for its optional
 * sub-counts, and the reason this function is byte-identical to `gatesFor` while
 * the blob is empty. The funnel trace stores the object whole (funnelTrace.ts),
 * so a trace read back next quarter says exactly which thresholds judged that
 * run — including a moved cap. */
export function effectiveGates(cfg: GateConfigLike | null | undefined, state: GateState | null | undefined): Gates {
  const v = effectiveGateValues(cfg?.riskAppetite, state, cfg?.gateOverride)
  const gates: Gates = { deadZone: v.deadZone, minExpectedMovePct: v.minExpectedMovePct }
  if (v.contextCap !== CONTEXT_MAX_PTS) gates.contextMaxPts = v.contextCap
  return gates
}

export interface GateEligibility {
  gate: TunableGate
  source: GateCode
  cost: number
  saved: number
  /** Attributed outcomes: sided costs + sided saves. Rows whose ten-session
   * excess landed inside the ±5pp bar are measured but not attributed to either
   * column, and `unchecked` rows are not evidence in either direction. */
  n: number
  doubleBooked: boolean
  direction: 'loosen' | 'tighten' | null
  why: string
}

/** THE ARITHMETIC, on the hygienic population only (missLedger.ts owns the
 * hygiene; this owns the policy). Every tunable gate is reported every time,
 * including the ones with nothing to say — a gate that has never been measured
 * must be visible AS unmeasured rather than absent.
 *
 * THE COUNTERS ARE LIFETIME, deliberately (the ledger's per-gate columns are
 * never pruned — only its day window is). So a gate whose evidence keeps saying
 * the same thing keeps earning notches, one per cadence window, until it reaches
 * its hard bound: the dead zone can walk 25 → 22.5 → 20 over forty sessions and
 * then stop forever. The bound is the brake, not the counter — and a resetting
 * counter would be worse, since it would make the SECOND notch cheaper than the
 * first (30 fresh outcomes rather than a standing verdict).
 *
 * COUNT-BASED, never pp-based (spec §4.3, direction-not-magnitude): the excesses
 * are stopless upper bounds, so a gate that refused one +40pp runner has not
 * proved anything a reader could have banked. Measured on a real 48-session
 * window, this is the difference between "the dead zone cost +526pp net" and the
 * truth that its refusals ran 592 times and fell 561 — nowhere near eligible. */
export function gateEligibility(attribution: readonly GateAttribution[]): GateEligibility[] {
  const by = new Map(attribution.map(a => [a.gate, a]))
  return TUNABLE_GATES.map(gate => {
    const b = GATE_BOUNDS[gate]
    const a = by.get(b.source)
    const cost = a?.cost ?? 0
    const saved = a?.saved ?? 0
    const n = a?.n ?? 0
    const doubleBooked = a?.doubleBooked ?? false
    const direction =
      doubleBooked || n < GATE_MIN_ATTRIBUTED
        ? null
        : cost > GATE_COST_RATIO * saved
          ? ('loosen' as const)
          : saved > GATE_COST_RATIO * cost
            ? ('tighten' as const)
            : null
    return { gate, source: b.source, cost, saved, n, doubleBooked, direction, why: `cost ${cost} vs saved ${saved} over ${n} attributed outcomes` }
  })
}

export interface GateMove {
  gate: TunableGate
  from: number
  to: number
  direction: 'loosen' | 'tighten'
  why: string
  /** The announcement — the ONE sentence the runlog, the panel and the paper all
   * print, so three surfaces can never describe one move three ways. */
  line: string
}

export interface GateNote {
  gate: TunableGate
  why: 'cadence' | 'override'
  line: string
}

export interface GateAdvance {
  state: GateState
  moves: GateMove[]
  notes: GateNote[]
}

const moveLine = (gate: TunableGate, from: number, to: number, why: string, date?: string): string =>
  `${GATE_BOUNDS[gate].label} ${from} → ${to}${date ? ` on ${date}` : ''}${why ? ` — ${why}` : ''}`

/** ONE EVALUATION. Pure: the caller reads the blob, the ledger and the session
 * index, and writes back what comes out — nothing here touches a store, a clock
 * or the environment.
 *
 * `sessionIndex` is `predictions-index` itself (engine.ts) rather than its
 * length: the engine's only honest session clock — calendar days include the
 * mornings it never ran — and the list, not the count, because the list is capped
 * at 250 and a count that cannot rise is not a clock (rule 3, `sessionsSince`). */
export function advanceGateState(
  state: GateState | null | undefined,
  eligibility: readonly GateEligibility[],
  sessionIndex: readonly string[],
  opts: { date: string; appetite?: 'moderate' | 'aggressive' | null; overrides?: GateOverride | null },
): GateAdvance {
  const next: GateState = { gates: { ...(state?.gates ?? {}) } }
  const moves: GateMove[] = []
  const notes: GateNote[] = []
  if (gateFeedbackDisabled()) return { state: next, moves, notes }

  const values = effectiveGateValues(opts.appetite, state, opts.overrides)

  /** The blocked note is written ONCE per gate per reason (see GateDelta). */
  const block = (gate: TunableGate, why: 'cadence' | 'override', line: string) => {
    const prev = next.gates[gate]
    if (prev?.blocked?.why === why) return
    next.gates[gate] = { delta: prev?.delta ?? 0, ...(prev?.lastMoveDate != null ? { lastMoveDate: prev.lastMoveDate } : {}), history: prev?.history ?? [], blocked: { why, date: opts.date } }
    notes.push({ gate, why, line })
  }

  for (const e of eligibility) {
    if (!e.direction) {
      // A HELD note says "this gate is eligible and cannot move". The moment that
      // stops being true — the evidence cools, the columns even out — the note is
      // a stale claim about the present, so it is dropped. The delta and the
      // history it earned are untouched.
      const prev = next.gates[e.gate]
      if (prev?.blocked) {
        const { blocked: _dropped, ...rest } = prev
        next.gates[e.gate] = rest
      }
      continue
    }
    const b = GATE_BOUNDS[e.gate]
    const cur = next.gates[e.gate]
    const from = values[e.gate]

    if (opts.overrides?.[e.gate] != null) {
      block(e.gate, 'override', `${b.label} is eligible to ${e.direction} (${e.why}) but is pinned at ${from} by the owner's override`)
      continue
    }
    // THE CLOCK. Counted, not subtracted — and the note quotes the count it
    // actually read, so a held gate can never claim a window that is not running.
    const since = cur?.lastMoveDate != null ? sessionsSince(sessionIndex, cur.lastMoveDate) : null
    if (since != null && since < GATE_CADENCE_SESSIONS) {
      block(
        e.gate,
        'cadence',
        `${b.label} is eligible to ${e.direction} (${e.why}) but held: one notch per ${GATE_CADENCE_SESSIONS} sessions, and the index holds ${since} since it moved on ${cur!.lastMoveDate}`,
      )
      continue
    }

    const sign = e.direction === 'loosen' ? b.loosen : -b.loosen
    const to = clamp(snap(from + sign * b.notch), b.min, b.max)
    // AT THE BOUND: no move, and no note either — a gate resting on a hard bound
    // is the mechanism working, not a decision being withheld.
    if (to === from) continue
    // …and the pair invariant, checked against the TIGHTEST dead zone any
    // appetite could hand this state, so an appetite switch can never be the
    // thing that breaks it. Unreachable under the bounds above (cap 16 vs dead
    // zone 20 holds) and kept because the bounds are constants someone will
    // one day edit.
    const probe: GateState = { gates: { ...next.gates, [e.gate]: { ...(cur ?? { delta: 0, history: [] }), delta: snap(to - baseGateValue(e.gate, opts.appetite)) } } }
    const worst = (['moderate', 'aggressive'] as const).map(a => effectiveGateValues(a, probe, opts.overrides))
    if (!worst.every(v => jointBoundOk(v.deadZone, v.contextCap))) continue

    const why = e.why
    const history = [...(cur?.history ?? []), { date: opts.date, from, to, why }].slice(-GATE_HISTORY_MAX)
    next.gates[e.gate] = { delta: snap(to - baseGateValue(e.gate, opts.appetite)), lastMoveDate: opts.date, history }
    moves.push({ gate: e.gate, from, to, direction: e.direction, why, line: moveLine(e.gate, from, to, why) })
  }
  return { state: next, moves, notes }
}

export interface GateStateSummary {
  /** Newest first, bounded — one line per recent move. */
  moves: string[]
  /** The gates that earned a notch and did not get one, and why. */
  notes: string[]
}

/** THE BOUNDED READ FOR THE PANEL — the engine's STATE, which is what a panel is
 * for: the last few notches this blob holds and any gate standing eligible and
 * unable to move. Null when no gate has ever moved or been held, so a surface
 * says NOTHING rather than announcing that the gates are where they started.
 *
 * NOT the paper's read. The paper is a daily edition and this is a standing
 * record: handing months of history to a writer told to state the move verbatim
 * re-announced the same notch as news every morning (Task-3 review, Important 2).
 * `gateAnnouncement` below is the compose seam, and it is date-bounded. */
export function gateStateSummary(raw: unknown, max = 3): GateStateSummary | null {
  const state = normaliseGateState(raw)
  const moves = (Object.entries(state.gates) as [TunableGate, GateDelta][])
    .flatMap(([gate, d]) => (d.history ?? []).map(h => ({ gate, ...h })))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, max)
    .map(h => moveLine(h.gate, h.from, h.to, h.why, h.date))
  const notes = (Object.entries(state.gates) as [TunableGate, GateDelta][])
    .filter(([, d]) => d.blocked)
    .map(([gate, d]) =>
      d.blocked!.why === 'override'
        ? `${GATE_BOUNDS[gate].label}: eligible to move on ${d.blocked!.date}, pinned by the owner's override`
        : `${GATE_BOUNDS[gate].label}: eligible to move on ${d.blocked!.date}, held by the cadence — one notch per ${GATE_CADENCE_SESSIONS} sessions, so the evidence moves it on its own clock`,
    )
  return moves.length || notes.length ? { moves, notes } : null
}

/** THE PAPER'S READ — two keys, and the difference between them is the point.
 *
 * `moves` is NEWS: only the notches taken on `date`, so a move is announced on
 * the morning it happened and never again. The writer's brief tells it to state
 * that line verbatim, which is only honest about a change that just occurred —
 * fed the standing history instead, every edition re-reported the same notch as
 * today's development, and a gate that had merely been HELD rode the same key
 * and read as one that moved (Task-3 review, Important 2).
 *
 * `notes` is STATUS: a gate eligible and unable to move has, by definition, not
 * moved, so it travels under its own key with the threshold's unchanged-ness said
 * out loud, and the brief tells the writer to treat it as a state of affairs.
 *
 * THE STRINGS ARE SCRUBBED HERE because this is the seam where they leave the
 * engine for an LLM prompt. `why` is the only free text in the blob — everything
 * else is a label this module owns or a number `normaliseGateState` has proved
 * finite — and it is template-built today, but the blob is small, durable and
 * hand-editable, and the house rule (voice.ts) is that text the engine did not
 * author reaches a prompt only when it is clean. A `why` that fails the sweep
 * costs its clause, not the announcement: the arithmetic in `25 → 22.5` is the
 * engine's own and is still the reader's to see. */
export function gateAnnouncement(raw: unknown, date: string): GateStateSummary | null {
  const state = normaliseGateState(raw)
  const entries = Object.entries(state.gates) as [TunableGate, GateDelta][]
  const moves = entries.flatMap(([gate, d]) =>
    (d.history ?? []).filter(h => h.date === date).map(h => moveLine(gate, h.from, h.to, promptSafe(h.why, GATE_WHY_MAX) ?? '', h.date)),
  )
  const notes = entries
    .filter(([, d]) => d.blocked)
    .map(([gate, d]) =>
      d.blocked!.why === 'override'
        ? `${GATE_BOUNDS[gate].label}: eligible to move, pinned by the owner since ${d.blocked!.date} — the threshold is unchanged`
        : `${GATE_BOUNDS[gate].label}: eligible to move, waiting on the cadence since ${d.blocked!.date} — the threshold is unchanged`,
    )
  return moves.length || notes.length ? { moves, notes } : null
}
