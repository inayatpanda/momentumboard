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
  gateEligibility,
  gateStateSummary,
  jointBoundOk,
  normaliseGateState,
  type GateEligibility,
  type GateState,
  type TunableGate,
} from './gateState'
import { AGGRESSIVE_GATES, MODERATE_GATES, gatesFor } from './catalyst'
import { CONTEXT_MAX_PTS } from './composite'
import type { GateAttribution } from './missLedger'

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

  it('tightens symmetrically when the saves overtake the cost', () => {
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 10, saved: 20, n: 30 })])[0].direction).toBeNull()
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 10, saved: 21, n: 31 })])[0].direction).toBe('tighten')
  })

  it('a DOUBLE-BOOKED gate is evidence for nothing — cost 100 / saved 0 still moves nothing, and neither does the mirror case', () => {
    const loosen = gateEligibility([attrib({ gate: 'dead-zone-core', cost: 100, saved: 0, n: 100, doubleBooked: true })])[0]
    expect(loosen.direction).toBeNull()
    expect(loosen.doubleBooked).toBe(true)
    expect(gateEligibility([attrib({ gate: 'dead-zone-core', cost: 0, saved: 100, n: 100, doubleBooked: true })])[0].direction).toBeNull()
  })

  it('reports every tunable gate every time, so an unmeasured gate is visible as unmeasured', () => {
    const rows = gateEligibility([])
    expect(rows.map(r => r.gate).sort()).toEqual(['contextCap', 'deadZone', 'minExpectedMovePct'])
    expect(rows.every(r => r.n === 0 && r.direction === null)).toBe(true)
  })
})

describe('advanceGateState', () => {
  it('moves ONE notch, writes the history entry, and announces it', () => {
    const { state, moves } = advanceGateState(null, elig('deadZone', 190, 12), 100, OPTS)
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ gate: 'deadZone', from: 25, to: 22.5, direction: 'loosen' })
    expect(moves[0].line).toContain('dead zone 25 → 22.5')
    expect(moves[0].line).toContain('cost 190')
    expect(moves[0].line).toContain('saved 12')

    const g = state.gates.deadZone!
    expect(g.delta).toBe(-2.5)
    expect(g.lastMoveSession).toBe(100)
    expect(g.history).toEqual([{ date: OPTS.date, from: 25, to: 22.5, why: moves[0].why }])
    expect(effectiveGates({}, state).deadZone).toBe(22.5)
  })

  it('refuses a second notch inside the cadence window, and takes it on the session the window closes', () => {
    const first = advanceGateState(null, elig('deadZone', 190, 12), 100, OPTS)
    const tooSoon = advanceGateState(first.state, elig('deadZone', 190, 12), 100 + GATE_CADENCE_SESSIONS - 1, OPTS)
    expect(tooSoon.moves).toEqual([])
    expect(tooSoon.state.gates.deadZone!.delta).toBe(-2.5)
    expect(tooSoon.notes.map(n => n.why)).toEqual(['cadence'])

    const due = advanceGateState(first.state, elig('deadZone', 190, 12), 100 + GATE_CADENCE_SESSIONS, OPTS)
    expect(due.moves).toHaveLength(1)
    expect(due.state.gates.deadZone!.delta).toBe(-5)
  })

  it('says the cadence refusal ONCE — the panel note is a statement, not a drumbeat', () => {
    const first = advanceGateState(null, elig('deadZone', 190, 12), 100, OPTS)
    const a = advanceGateState(first.state, elig('deadZone', 190, 12), 101, OPTS)
    expect(a.notes).toHaveLength(1)
    const b = advanceGateState(a.state, elig('deadZone', 190, 12), 102, OPTS)
    expect(b.notes).toEqual([])
    expect(b.state.gates.deadZone!.blocked).toEqual(a.state.gates.deadZone!.blocked)
  })

  it('drops the held note once the gate stops being eligible — a stale “eligible and held” is a lie', () => {
    const first = advanceGateState(null, elig('deadZone', 190, 12), 100, OPTS)
    const held = advanceGateState(first.state, elig('deadZone', 190, 12), 101, OPTS)
    expect(gateStateSummary(held.state)!.notes).toHaveLength(1)
    // the evidence turns: cost no longer beats saved, so there is nothing to hold
    const cooled = advanceGateState(held.state, elig('deadZone', 100, 90), 102, OPTS)
    expect(cooled.state.gates.deadZone!.blocked).toBeUndefined()
    expect(gateStateSummary(cooled.state)!.notes).toEqual([])
    expect(cooled.state.gates.deadZone!.delta).toBe(-2.5) // …and the notch it earned is untouched
  })

  it('an override WINS over an eligible move', () => {
    const { state, moves, notes } = advanceGateState(null, elig('deadZone', 190, 12), 100, { ...OPTS, overrides: { deadZone: 24 } })
    expect(moves).toEqual([])
    expect(state.gates.deadZone?.delta ?? 0).toBe(0)
    expect(notes.map(n => n.why)).toEqual(['override'])
    expect(notes[0].line).toContain('pinned')
  })

  it('never crosses a hard bound, however long the evidence keeps arriving (50 advances, both directions)', () => {
    let state: GateState | null = null
    let session = 0
    for (let i = 0; i < 50; i++) {
      session += GATE_CADENCE_SESSIONS
      state = advanceGateState(state, elig('deadZone', 500, 1), session, OPTS).state
      expect(effectiveGates({}, state).deadZone).toBeGreaterThanOrEqual(GATE_BOUNDS.deadZone.min)
    }
    expect(effectiveGates({}, state).deadZone).toBe(20)
    expect(state!.gates.deadZone!.history).toHaveLength(2) // 25 → 22.5 → 20, and then nothing forever

    for (let i = 0; i < 50; i++) {
      session += GATE_CADENCE_SESSIONS
      state = advanceGateState(state, elig('deadZone', 1, 500), session, OPTS).state
      expect(effectiveGates({}, state).deadZone).toBeLessThanOrEqual(GATE_BOUNDS.deadZone.max)
    }
    expect(effectiveGates({}, state).deadZone).toBe(25)
  })

  it('the expected-move floor walks its own notch to its own floor', () => {
    let state: GateState | null = null
    let session = 0
    for (let i = 0; i < 10; i++) {
      session += GATE_CADENCE_SESSIONS
      state = advanceGateState(state, elig('minExpectedMovePct', 90, 10), session, OPTS).state
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
    const { moves } = advanceGateState(null, eligibility, 100, OPTS)
    expect(moves.map(m => m.gate)).toEqual(['deadZone'])
  })

  it('the context cap tightens on ITS OWN saves, and its floor is where it stands today', () => {
    const saves = gateEligibility([attrib({ gate: 'dead-zone-context', cost: 5, saved: 40, n: 45 })])
    const up = advanceGateState(null, saves, 100, OPTS)
    expect(up.moves[0]).toMatchObject({ gate: 'contextCap', from: 12, to: 14, direction: 'tighten' })
    // …and the other direction is already at the bound: a veto that costs is
    // asking for a SMALLER cap, and 12 is the smallest the spec allows.
    const costs = gateEligibility([attrib({ gate: 'dead-zone-context', cost: 40, saved: 5, n: 45 })])
    expect(advanceGateState(null, costs, 100, OPTS).moves).toEqual([])
  })

  it('leaves a state it did not move byte-identical (and returns the empty state untouched)', () => {
    const before: GateState = { gates: { deadZone: { delta: -2.5, lastMoveSession: 10, history: [{ date: '2026-01-01', from: 25, to: 22.5, why: 'x' }] } } }
    const after = advanceGateState(before, gateEligibility([]), 500, OPTS)
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

  it('says nothing at all until a gate has moved or been held', () => {
    expect(gateStateSummary(null)).toBeNull()
    expect(gateStateSummary(emptyGateState())).toBeNull()
  })

  it('prints the move and the held gate, newest first', () => {
    const moved = advanceGateState(null, elig('deadZone', 190, 12), 100, OPTS).state
    const held = advanceGateState(moved, elig('deadZone', 190, 12), 101, OPTS).state
    const summary = gateStateSummary(held)!
    expect(summary.moves).toHaveLength(1)
    expect(summary.moves[0]).toContain('dead zone 25 → 22.5')
    expect(summary.notes[0]).toContain('one notch per')
  })
})
