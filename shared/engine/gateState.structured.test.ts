// gateStateStructured (PWA rebuild, plan Task 5 / amendment DS-Task5): the
// PANEL'S structured read — every tunable gate with its current value, ratified
// bounds, full move history and any block note. gateStateSummary stays the
// paper's three-sentence read; this is the timeline the new Gates & learning
// screen draws.

import { describe, expect, it } from 'vitest'
import { GATE_BOUNDS, baseGateValue, gateStateStructured } from './gateState'

describe('gateStateStructured', () => {
  it('lists every tunable gate, moved or not, with current = base + delta and its bounds', () => {
    const raw = {
      gates: {
        deadZone: {
          delta: -2.5,
          lastMoveDate: '2026-08-01',
          history: [{ date: '2026-08-01', from: 25, to: 22.5, why: 'cost cleared the ratio' }],
          blocked: { why: 'cadence', date: '2026-08-12' },
        },
      },
    }
    const s = gateStateStructured(raw)
    expect(s.gates.map(g => g.gate).sort()).toEqual(['contextCap', 'deadZone', 'minExpectedMovePct'])

    const dz = s.gates.find(g => g.gate === 'deadZone')!
    expect(dz.label).toBe(GATE_BOUNDS.deadZone.label)
    expect(dz.base).toBe(baseGateValue('deadZone'))
    expect(dz.current).toBe(baseGateValue('deadZone') - 2.5)
    expect(dz.bounds).toEqual({ min: GATE_BOUNDS.deadZone.min, max: GATE_BOUNDS.deadZone.max })
    expect(dz.history).toHaveLength(1)
    expect(dz.history[0].why).toBe('cost cleared the ratio')
    expect(dz.blocked).toEqual({ why: 'cadence', date: '2026-08-12' })

    const unmoved = s.gates.find(g => g.gate === 'minExpectedMovePct')!
    expect(unmoved.current).toBe(baseGateValue('minExpectedMovePct'))
    expect(unmoved.history).toEqual([])
    expect(unmoved.blocked).toBeUndefined()
  })

  it('is defensive about garbage input — a corrupt blob reads as pristine gates', () => {
    const s = gateStateStructured({ gates: { deadZone: 'nonsense' } })
    const dz = s.gates.find(g => g.gate === 'deadZone')!
    expect(dz.current).toBe(baseGateValue('deadZone'))
    expect(dz.history).toEqual([])
  })

  it("honours the owner's pin: an override IS the current value, and is surfaced", () => {
    const s = gateStateStructured({ gates: { deadZone: { delta: -2.5, history: [] } } }, { riskAppetite: null, gateOverride: { deadZone: 21 } })
    const dz = s.gates.find(g => g.gate === 'deadZone')!
    expect(dz.current).toBe(21)
    expect(dz.override).toBe(21)
    const unpinned = s.gates.find(g => g.gate === 'minExpectedMovePct')!
    expect(unpinned.override).toBeUndefined()
  })

  it('clamps the effective value into the ratified bounds, exactly as the engine does', () => {
    const s = gateStateStructured({ gates: { deadZone: { delta: -100, history: [] } } })
    const dz = s.gates.find(g => g.gate === 'deadZone')!
    expect(dz.current).toBe(GATE_BOUNDS.deadZone.min)
  })
})
