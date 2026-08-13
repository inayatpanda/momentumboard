import { describe, expect, it, vi } from 'vitest'
import {
  GATE_BOUNDS,
  GATE_CADENCE_SESSIONS,
  GATE_MIN_ATTRIBUTED,
  GATE_STATE_KEY,
  advanceGateState,
  effectiveGates,
  effectiveGateValues,
  emptyGateState,
  gateAnnouncement,
  gateEligibility,
  gateStateSummary,
  jointBoundOk,
  normaliseGateState,
  sessionsSince,
  TUNABLE_GATES,
  type GateEligibility,
  type GateState,
  type TunableGate,
} from './gateState'
import { AGGRESSIVE_GATES, MODERATE_GATES, gatesFor } from './catalyst'
import { CONTEXT_MAX_PTS } from './composite'
import { DOUBLE_BOOKED_GATES, type GateAttribution } from './missLedger'

// ---- fixtures ----

const attrib = (over: Partial<GateAttribution> & { gate: GateAttribution['gate'] }): GateAttribution => ({
  cost: 0,
  saved: 0,
  n: 0,
  unchecked: 0,
  doubleBooked: false,
  ...over,
})

/** An eligibility row straight from the ledger arithmetic — the only input that
 * may move a gate. */
const elig = (gate: TunableGate, cost: number, saved: number, doubleBooked = false): GateEligibility[] =>
  gateEligibility([attrib({ gate: GATE_BOUNDS[gate].source, cost, saved, n: cost + saved, doubleBooked })])

const OPTS = { date: '2026-08-13' }

// ---- the session clock, as the engine actually holds it ----

const DAY_MS = 86_400_000
/** `n` days after (or, negative, before) an ISO date. */
const shift = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
/** A `predictions-index`: `n` consecutive session dates ENDING the day before
 * `end`. The grading pass reads the index before the board appends today, so a
 * gate evaluated on `end` sees no entry of its own. */
const idx = (n: number, end = OPTS.date): string[] => Array.from({ length: n }, (_, i) => shift(end, i - n))
/** engine.ts writes `predictions-index` as `[...index, today].slice(-250)` — the
 * cap that froze the old length-based clock. */
const INDEX_MAX = 250
/** …and the same index rolled forward: `n` sessions AFTER `from`, appended, with
 * the engine's own cap applied. */
const plus = (index: readonly string[], from: string, n: number): string[] =>
  [...index, ...Array.from({ length: n }, (_, i) => shift(from, i + 1))].slice(-INDEX_MAX)

describe('the gate bounds themselves', () => {
  it('are the spec’s, exactly — and the joint invariant holds at EVERY reachable pair, on both appetites', () => {
    expect(GATE_BOUNDS.deadZone).toMatchObject({ min: 20, max: 25, notch: 2.5 })
    expect(GATE_BOUNDS.minExpectedMovePct).toMatchObject({ min: 1.0, max: 1.5, notch: 0.25 })
    expect(GATE_BOUNDS.contextCap).toMatchObject({ min: 12, max: 16, notch: 2 })

    // THE JOINT BOUND (composite.ts): the context cap must stay strictly below
    // the dead zone with margin, or context alone could cross the gate. Driven
    // over every delta a stored blob could ever hold — including the ones an
    // appetite switch composes into — rather than over the two the plan names.
    const deltas = [-7.5, -5, -2.5, 0, 2.5, 5, 7.5]
    const caps = [-4, -2, 0, 2, 4, 6]
    for (const appetite of ['moderate', 'aggressive'] as const)
      for (const d of deltas)
        for (const c of caps) {
          const state: GateState = { gates: { deadZone: { delta: d, history: [] }, contextCap: { delta: c, history: [] } } }
          const v = effectiveGateValues(appetite, state)
          expect(jointBoundOk(v.deadZone, v.contextCap)).toBe(true)
        }
  })

  it('names the boundary it is actually testing', () => {
    expect(jointBoundOk(20, 16)).toBe(true)
    expect(jointBoundOk(18, 16)).toBe(false) // cap must be < deadZone − 2, not ≤
    expect(jointBoundOk(18, 15)).toBe(true)
  })
})

describe('effectiveGates — nothing moves while the blob is absent', () => {
  it('is byte-identical to gatesFor on an empty state, on both appetites', () => {
    for (const appetite of [undefined, 'moderate', 'aggressive'] as const) {
      const cfg = appetite ? { riskAppetite: appetite } : {}
      expect(effectiveGates(cfg, null)).toEqual(gatesFor(appetite))
      expect(JSON.stringify(effectiveGates(cfg, null))).toBe(JSON.stringify(gatesFor(appetite)))
      expect(JSON.stringify(effectiveGates(cfg, emptyGateState()))).toBe(JSON.stringify(gatesFor(appetite)))
    }
    expect(JSON.stringify(effectiveGates(null, null))).toBe(JSON.stringify(MODERATE_GATES))
  })

  it('carries the context cap ONLY once it has moved — absent means the module default', () => {
    expect(effectiveGates({}, null).contextMaxPts).toBeUndefined()
    const moved: GateState = { gates: { contextCap: { delta: 2, history: [] } } }
    expect(effectiveGates({}, moved).contextMaxPts).toBe(CONTEXT_MAX_PTS + 2)
  })

  it('composes an appetite switch: the delta rides the preset and clamps to the hard bound, never below', () => {
    const loosened: GateState = { gates: { deadZone: { delta: -2.5, history: [] } } }
    expect(effectiveGates({ riskAppetite: 'moderate' }, loosened).deadZone).toBe(22.5)
    // aggressive already sits ON the floor: the same delta cannot dig under it
    expect(effectiveGates({ riskAppetite: 'aggressive' }, loosened).deadZone).toBe(AGGRESSIVE_GATES.deadZone)
    const tightened: GateState = { gates: { minExpectedMovePct: { delta: 0.5, history: [] } } }
    expect(effectiveGates({ riskAppetite: 'moderate' }, tightened).minExpectedMovePct).toBe(MODERATE_GATES.minExpectedMovePct)
    expect(effectiveGates({ riskAppetite: 'aggressive' }, tightened).minExpectedMovePct).toBe(1.5)
  })

  it('an owner override pins the gate absolutely — and is itself clamped to the hard bounds', () => {
    const loosened: GateState = { gates: { deadZone: { delta: -5, history: [] } } }
    expect(effectiveGates({ gateOverride: { deadZone: 24 } }, loosened).deadZone).toBe(24)
    expect(effectiveGates({ gateOverride: { deadZone: 5 } }, loosened).deadZone).toBe(20)
    expect(effectiveGates({ gateOverride: { deadZone: 99 } }, loosened).deadZone).toBe(25)
  })

  it('GATES=off is the rollback lever: the presets, whatever the blob says', () => {
    const moved: GateState = { gates: { deadZone: { delta: -5, history: [] }, contextCap: { delta: 4, history: [] } } }
    vi.stubEnv('GATES', 'off')
    try {
      expect(JSON.stringify(effectiveGates({}, moved))).toBe(JSON.stringify(MODERATE_GATES))
    } finally {
      vi.unstubAllEnvs()
    }
    expect(effectiveGates({}, moved).deadZone).toBe(20) // …and back again
  })
})

describe('eligibility — the hygienic population, and nothing else', () => {
  it('needs 30 attributed outcomes AND cost > 2× saved', () => {
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 20, saved: 9, n: 29 })])[0].direction).toBeNull()
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 20, saved: 10, n: 30 })])[0].direction).toBeNull() // 20 > 20 is false
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 21, saved: 10, n: 31 })])[0].direction).toBe('loosen')
  })

  it('EXACTLY 30 admits — the bar is ≥, and one outcome short of it is not', () => {
    // The bar was only ever pinned from above (31) and from a ratio failure at
    // 30. This is the boundary itself: the same ratio, one outcome either side.
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 25, saved: 5, n: 30 })])[0].direction).toBe('loosen')
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 24, saved: 5, n: 29 })])[0].direction).toBeNull()
    expect(GATE_MIN_ATTRIBUTED).toBe(30)
  })

  it('tightens symmetrically when the saves overtake the cost', () => {
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 10, saved: 20, n: 30 })])[0].direction).toBeNull()
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 10, saved: 21, n: 31 })])[0].direction).toBe('tighten')
  })

  it('a DOUBLE-BOOKED gate is evidence for nothing — cost 100 / saved 0 still moves nothing, and neither does the mirror case', () => {
    // DEFENCE IN DEPTH, and the Task-3 report overstated it: no tunable gate's
    // source is double-booked today (`GATE_BOUNDS` reads dead-zone-core /
    // expected-move / dead-zone-context; `DOUBLE_BOOKED_GATES` holds the three
    // `called-*` codes), so the marker can only reach this arithmetic if a
    // future gate is pointed at a published code — which is exactly when the
    // symmetric refusal below has to already be in place. The fixture therefore
    // hand-sets a flag the live ledger never sets on this gate, deliberately.
    const loosen = gateEligibility([attrib({ gate: 'dead-zone-core', cost: 100, saved: 0, n: 100, doubleBooked: true })])[0]
    expect(loosen.direction).toBeNull()
    expect(loosen.doubleBooked).toBe(true)
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 0, saved: 100, n: 100, doubleBooked: true })])[0].direction).toBeNull()
    // …and the disjointness that makes it defence in depth, pinned so the day it
    // stops being true is the day this test starts carrying live weight
    expect(TUNABLE_GATES.map(g => GATE_BOUNDS[g].source).filter(s => DOUBLE_BOOKED_GATES.has(s))).toEqual([])
  })

  it('reports every tunable gate every time, so an unmeasured gate is visible as unmeasured', () => {
    const rows = gateEligibility([])
    expect(rows.map(r => r.gate).sort()).toEqual(['contextCap', 'deadZone', 'minExpectedMovePct'])
    expect(rows.every(r => r.n === 0 && r.direction === null)).toBe(true)
  })
})

describe('advanceGateState', () => {
  it('moves ONE notch, writes the history entry, and announces it', () => {
    const { state, moves } = advanceGateState(null, elig('deadZone', 190, 12), idx(100), OPTS)
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ gate: 'deadZone', from: 25, to: 22.5, direction: 'loosen' })
    expect(moves[0].line).toContain('dead zone 25 → 22.5')
    expect(moves[0].line).toContain('cost 190')
    expect(moves[0].line).toContain('saved 12')

    const g = state.gates.deadZone!
    expect(g.delta).toBe(-2.5)
    expect(g.lastMoveDate).toBe(OPTS.date) // the clock is a DATE, not a count
    expect(g.history).toEqual([{ date: OPTS.date, from: 25, to: 22.5, why: moves[0].why }])
    expect(effectiveGates({}, state).deadZone).toBe(22.5)
  })

  it('refuses a second notch inside the cadence window, and takes it on the session the window closes', () => {
    const base = idx(100)
    const first = advanceGateState(null, elig('deadZone', 190, 12), base, OPTS)
    const later = { ...OPTS, date: shift(OPTS.date, 30) }

    const tooSoon = advanceGateState(first.state, elig('deadZone', 190, 12), plus(base, OPTS.date, GATE_CADENCE_SESSIONS - 1), later)
    expect(tooSoon.moves).toEqual([])
    expect(tooSoon.state.gates.deadZone!.delta).toBe(-2.5)
    expect(tooSoon.notes.map(n => n.why)).toEqual(['cadence'])

    const due = advanceGateState(first.state, elig('deadZone', 190, 12), plus(base, OPTS.date, GATE_CADENCE_SESSIONS), later)
    expect(due.moves).toHaveLength(1)
    expect(due.state.gates.deadZone!.delta).toBe(-5)
    expect(due.state.gates.deadZone!.lastMoveDate).toBe(later.date)
  })

  // THE FIX WAVE'S FIRST PIN (Task-3 review, Important 1). `predictions-index` is
  // capped at 250, so the old `sessionCount - lastMoveSession` clock froze the
  // moment the index saturated: the count stopped rising, the difference stopped
  // growing, and any gate that had ever moved was held forever — while the panel
  // printed "one notch per 20 sessions" as though a clock were running.
  describe('the cadence clock survives the index cap', () => {
    const saturated = idx(INDEX_MAX)

    it('counts the index ENTRIES since the move, so a full index still admits the next notch', () => {
      const moved: GateState = { gates: { deadZone: { delta: -2.5, lastMoveDate: '2020-01-01', history: [] } } }
      // 250 sessions, every one of them after the move: the clock reads 250
      expect(sessionsSince(saturated, '2020-01-01')).toBe(INDEX_MAX)
      const { moves, notes } = advanceGateState(moved, elig('deadZone', 190, 12), saturated, OPTS)
      expect(moves.map(m => m.gate)).toEqual(['deadZone'])
      expect(notes).toEqual([]) // …and no "held" sentence about a clock that is not holding it
    })

    it('a move AT saturation still needs 20 more index entries — 19 holds, 20 admits', () => {
      const first = advanceGateState(null, elig('deadZone', 190, 12), saturated, OPTS)
      const later = { ...OPTS, date: shift(OPTS.date, 40) }
      const rolled = (n: number) => plus(saturated, OPTS.date, n)
      expect(rolled(20)).toHaveLength(INDEX_MAX) // the window really did roll, not grow

      const held = advanceGateState(first.state, elig('deadZone', 190, 12), rolled(GATE_CADENCE_SESSIONS - 1), later)
      expect(held.moves).toEqual([])
      expect(held.notes[0].line).toContain(`${GATE_CADENCE_SESSIONS - 1}`)
      const due = advanceGateState(first.state, elig('deadZone', 190, 12), rolled(GATE_CADENCE_SESSIONS), later)
      expect(due.moves).toHaveLength(1)
    })

    it('a WIPED index blocks — no sessions since means no cadence served, which is the safe reading', () => {
      const moved = advanceGateState(null, elig('deadZone', 190, 12), saturated, OPTS).state
      const wiped = advanceGateState(moved, elig('deadZone', 190, 12), [], { ...OPTS, date: shift(OPTS.date, 400) })
      expect(wiped.moves).toEqual([])
      expect(wiped.notes.map(n => n.why)).toEqual(['cadence'])
      expect(wiped.state.gates.deadZone!.delta).toBe(-2.5) // and the notch it earned survives the wipe
    })

    it('the held note states the clock it is actually reading', () => {
      const moved = advanceGateState(null, elig('deadZone', 190, 12), idx(100), OPTS).state
      const held = advanceGateState(moved, elig('deadZone', 190, 12), plus(idx(100), OPTS.date, 3), { ...OPTS, date: shift(OPTS.date, 4) })
      expect(held.notes[0].line).toContain(`one notch per ${GATE_CADENCE_SESSIONS} sessions`)
      expect(held.notes[0].line).toContain('3 since it moved on 2026-08-13')
    })
  })

  it('says the cadence refusal ONCE — the panel note is a statement, not a drumbeat', () => {
    const base = idx(100)
    const first = advanceGateState(null, elig('deadZone', 190, 12), base, OPTS)
    const a = advanceGateState(first.state, elig('deadZone', 190, 12), plus(base, OPTS.date, 1), OPTS)
    expect(a.notes).toHaveLength(1)
    const b = advanceGateState(a.state, elig('deadZone', 190, 12), plus(base, OPTS.date, 2), OPTS)
    expect(b.notes).toEqual([])
    expect(b.state.gates.deadZone!.blocked).toEqual(a.state.gates.deadZone!.blocked)
  })

  it('drops the held note once the gate stops being eligible — a stale “eligible and held” is a lie', () => {
    const base = idx(100)
    const first = advanceGateState(null, elig('deadZone', 190, 12), base, OPTS)
    const held = advanceGateState(first.state, elig('deadZone', 190, 12), plus(base, OPTS.date, 1), OPTS)
    expect(gateStateSummary(held.state)!.notes).toHaveLength(1)
    // the evidence turns: cost no longer beats saved, so there is nothing to hold
    const cooled = advanceGateState(held.state, elig('deadZone', 100, 90), plus(base, OPTS.date, 2), OPTS)
    expect(cooled.state.gates.deadZone!.blocked).toBeUndefined()
    expect(gateStateSummary(cooled.state)!.notes).toEqual([])
    expect(cooled.state.gates.deadZone!.delta).toBe(-2.5) // …and the notch it earned is untouched
  })

  it('an override WINS over an eligible move', () => {
    const { state, moves, notes } = advanceGateState(null, elig('deadZone', 190, 12), idx(100), { ...OPTS, overrides: { deadZone: 24 } })
    expect(moves).toEqual([])
    expect(state.gates.deadZone?.delta ?? 0).toBe(0)
    expect(notes.map(n => n.why)).toEqual(['override'])
    expect(notes[0].line).toContain('pinned')
  })

  it('never crosses a hard bound, however long the evidence keeps arriving (50 advances, both directions)', () => {
    let state: GateState | null = null
    let day = 0
    // +1 because `idx` ends the day BEFORE its argument, exactly as the grading
    // pass reads the index: a gate that moved on D sees its 20th later session
    // on D+21, not D+20.
    const step = () => {
      day += GATE_CADENCE_SESSIONS + 1
      return { index: idx(INDEX_MAX, shift(OPTS.date, day)), opts: { date: shift(OPTS.date, day) } }
    }
    for (let i = 0; i < 50; i++) {
      const { index, opts } = step()
      state = advanceGateState(state, elig('deadZone', 500, 1), index, opts).state
      expect(effectiveGates({}, state).deadZone).toBeGreaterThanOrEqual(GATE_BOUNDS.deadZone.min)
    }
    expect(effectiveGates({}, state).deadZone).toBe(20)
    expect(state!.gates.deadZone!.history).toHaveLength(2) // 25 → 22.5 → 20, and then nothing forever

    for (let i = 0; i < 50; i++) {
      const { index, opts } = step()
      state = advanceGateState(state, elig('deadZone', 1, 500), index, opts).state
      expect(effectiveGates({}, state).deadZone).toBeLessThanOrEqual(GATE_BOUNDS.deadZone.max)
    }
    expect(effectiveGates({}, state).deadZone).toBe(25)
  })

  it('the expected-move floor walks its own notch to its own floor', () => {
    let state: GateState | null = null
    for (let i = 1; i <= 10; i++) {
      const date = shift(OPTS.date, i * (GATE_CADENCE_SESSIONS + 1))
      state = advanceGateState(state, elig('minExpectedMovePct', 90, 10), idx(INDEX_MAX, date), { date }).state
    }
    expect(effectiveGates({}, state).minExpectedMovePct).toBe(1.0)
    expect(state!.gates.minExpectedMovePct!.history.map(h => h.to)).toEqual([1.25, 1.0])
  })

  it('the context cap is frozen until ITS OWN gate has 30 attributed outcomes of its own', () => {
    // the dead zone is drowning in evidence; the context gate has none. Only one
    // of them may move — the cap's replay zero was an artefact and its live
    // population is still unmeasured.
    const eligibility = gateEligibility([
      attrib({ gate: 'dead-zone-core', cost: 190, saved: 12, n: 202 }),
      attrib({ gate: 'dead-zone-context', cost: 0, saved: 0, n: 0 }),
    ])
    const { moves } = advanceGateState(null, eligibility, idx(100), OPTS)
    expect(moves.map(m => m.gate)).toEqual(['deadZone'])
  })

  it('the context cap tightens on ITS OWN saves, and its floor is where it stands today', () => {
    const saves = gateEligibility([attrib({ gate: 'dead-zone-context', cost: 5, saved: 40, n: 45 })])
    const up = advanceGateState(null, saves, idx(100), OPTS)
    expect(up.moves[0]).toMatchObject({ gate: 'contextCap', from: 12, to: 14, direction: 'tighten' })
    // …and the other direction is already at the bound: a veto that costs is
    // asking for a SMALLER cap, and 12 is the smallest the spec allows.
    const costs = gateEligibility([attrib({ gate: 'dead-zone-context', cost: 40, saved: 5, n: 45 })])
    expect(advanceGateState(null, costs, idx(100), OPTS).moves).toEqual([])
  })

  it('leaves a state it did not move byte-identical (and returns the empty state untouched)', () => {
    const before: GateState = { gates: { deadZone: { delta: -2.5, lastMoveDate: '2026-01-01', history: [{ date: '2026-01-01', from: 25, to: 22.5, why: 'x' }] } } }
    const after = advanceGateState(before, gateEligibility([]), idx(INDEX_MAX), OPTS)
    expect(after.moves).toEqual([])
    expect(after.notes).toEqual([])
    expect(JSON.stringify(after.state)).toBe(JSON.stringify(before))
  })
})

describe('normaliseGateState / the summary', () => {
  it('fails soft on anything that is not the shape', () => {
    for (const junk of [null, undefined, 3, 'x', [], { gates: 7 }, { gates: { deadZone: 'no' } }]) {
      const s = normaliseGateState(junk)
      expect(s.gates).toBeTypeOf('object')
      expect(JSON.stringify(effectiveGates({}, s))).toBe(JSON.stringify(MODERATE_GATES))
    }
    expect(normaliseGateState({ gates: { deadZone: { delta: -2.5, history: [] } } }).gates.deadZone!.delta).toBe(-2.5)
    expect(GATE_STATE_KEY).toBe('gate-state')
    expect(GATE_MIN_ATTRIBUTED).toBe(30)
  })

  it('TYPE-GUARDS every field it keeps — a malformed entry is dropped, never carried into a printed sentence', () => {
    const s = normaliseGateState({
      gates: {
        deadZone: {
          delta: -2.5,
          lastMoveDate: 42, // not a string
          history: [
            { date: '2026-08-01', from: 25, to: 22.5, why: 'ok' },
            { date: 'the first of August', from: 25, to: 22.5, why: 'not an ISO date' },
            { date: '2026-08-02', from: '25', to: 22.5, why: 'a string threshold' },
            { date: '2026-08-03', from: 25, to: Number.NaN, why: 'a threshold that is not a number' },
            { date: '2026-08-04', from: 25, to: 22.5, why: { toString: () => 'not a string' } },
            'not an object at all',
          ],
          blocked: { why: 'invented-reason', date: '2026-08-05' },
        },
        contextCap: { delta: 2, history: 'not an array', blocked: { why: 'cadence', date: 'soon' } },
      },
    })
    expect(s.gates.deadZone!.history).toEqual([{ date: '2026-08-01', from: 25, to: 22.5, why: 'ok' }])
    expect(s.gates.deadZone!.blocked).toBeUndefined() // an unknown reason is not a reason
    expect(s.gates.contextCap!.history).toEqual([])
    expect(s.gates.contextCap!.blocked).toBeUndefined() // a blocked note with no real date says nothing
    // …and the clock migrates from the history it does trust: a blob written
    // before the date clock existed carries its move dates there
    expect(s.gates.deadZone!.lastMoveDate).toBe('2026-08-01')
    expect(normaliseGateState({ gates: { deadZone: { delta: -2.5, lastMoveSession: 3, history: [] } } }).gates.deadZone!.lastMoveDate).toBeUndefined()
  })

  it('says nothing at all until a gate has moved or been held', () => {
    expect(gateStateSummary(null)).toBeNull()
    expect(gateStateSummary(emptyGateState())).toBeNull()
  })

  it('prints the move and the held gate, newest first', () => {
    const base = idx(100)
    const moved = advanceGateState(null, elig('deadZone', 190, 12), base, OPTS).state
    const held = advanceGateState(moved, elig('deadZone', 190, 12), plus(base, OPTS.date, 1), OPTS).state
    const summary = gateStateSummary(held)!
    expect(summary.moves).toHaveLength(1)
    expect(summary.moves[0]).toContain('dead zone 25 → 22.5')
    expect(summary.notes[0]).toContain('one notch per')
  })
})

// THE FIX WAVE'S SECOND PIN (Task-3 review, Important 2). The paper used to be
// handed `gateStateSummary` — up to fifty history entries, months old — under a
// brief that says "state the move VERBATIM", so every edition re-announced the
// same notch as today's news, and a HELD gate rode the same key as a move.
describe('gateAnnouncement — what the paper is allowed to call news', () => {
  const movedOn = (date: string) => advanceGateState(null, elig('deadZone', 190, 12), idx(100, date), { date }).state

  it('announces a move on the day it happened, and never again', () => {
    const state = movedOn(OPTS.date)
    const today = gateAnnouncement(state, OPTS.date)!
    expect(today.moves).toHaveLength(1)
    expect(today.moves[0]).toContain('dead zone 25 → 22.5')
    expect(today.moves[0]).toContain(OPTS.date)
    // the next morning the same blob says nothing at all
    expect(gateAnnouncement(state, shift(OPTS.date, 1))).toBeNull()
  })

  it('a HELD gate is status, never a move — it can never appear under gateMoves', () => {
    const base = idx(100)
    const moved = advanceGateState(null, elig('deadZone', 190, 12), base, OPTS).state
    const tomorrow = shift(OPTS.date, 1)
    const held = advanceGateState(moved, elig('deadZone', 190, 12), plus(base, OPTS.date, 1), { date: tomorrow }).state

    const a = gateAnnouncement(held, tomorrow)!
    expect(a.moves).toEqual([]) // yesterday's notch is not today's news…
    expect(a.notes).toHaveLength(1) // …and the hold is a standing statement
    expect(a.notes[0]).toContain('unchanged')
    expect(a.notes.join(' ')).not.toContain('→')
  })

  it('strips the hand-editable half: `why` is the only free text in the blob, and it reaches the LLM', () => {
    const state: GateState = {
      gates: {
        deadZone: {
          delta: -2.5,
          lastMoveDate: OPTS.date,
          history: [{ date: OPTS.date, from: 25, to: 22.5, why: 'cost 190 vs saved 12 <b>over</b> 202 attributed outcomes' }],
        },
        contextCap: { delta: 0, history: [{ date: OPTS.date, from: 12, to: 14, why: 'the expectedMovePct floor said so' }] },
      },
    }
    const a = gateAnnouncement(state, OPTS.date)!
    expect(a.moves.join('|')).not.toMatch(/[<>]/)
    expect(a.moves.find(l => l.includes('dead zone'))).toContain('cost 190 vs saved 12 b over /b 202')
    // an identifier is a leak whatever it is doing there: the CLAUSE goes, the
    // move itself — which is the engine's own arithmetic — still gets announced
    const cap = a.moves.find(l => l.includes('context cap'))!
    expect(cap).toContain('context cap 12 → 14')
    expect(cap).not.toContain('expectedMovePct')
  })

  it('says nothing when nothing happened', () => {
    expect(gateAnnouncement(null, OPTS.date)).toBeNull()
    expect(gateAnnouncement(emptyGateState(), OPTS.date)).toBeNull()
  })
})
