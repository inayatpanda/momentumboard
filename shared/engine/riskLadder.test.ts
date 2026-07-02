import { describe, expect, it } from 'vitest'
import { computeRung, initRisk, leverageAllowed, mapInstrument, RUNG_RISK_PCT, type OutcomeLite } from './riskLadder'

const wins = (n: number, leveraged = false): OutcomeLite[] => Array.from({ length: n }, () => ({ hit: true, stopped: false, leveraged }))
const losses = (n: number, stopped = true, leveraged = false): OutcomeLite[] => Array.from({ length: n }, () => ({ hit: false, stopped, leveraged }))

describe('computeRung', () => {
  it('promotes only when all three conditions hold', () => {
    let s = initRisk('2026-06-01')
    // 25 graded at 60% hit rate, brier improving → promote
    const recent = [...wins(15), ...losses(10, false)]
    s = computeRung(s, recent, 25, true, null, '2026-07-01')
    expect(s.rung).toBe(1)
    expect(s.gradedAtRung).toBe(0)
    // same record but brier worsening → stays
    let s2 = initRisk('2026-06-01')
    s2 = computeRung(s2, recent, 25, false, null, '2026-07-01')
    expect(s2.rung).toBe(0)
    // not enough graded at rung → stays even with great hit rate
    let s3 = initRisk('2026-06-01')
    s3 = computeRung(s3, wins(20), 20, true, null, '2026-07-01')
    expect(s3.rung).toBe(0)
  })

  it('demotes on a cold streak (<45% over last 20)', () => {
    let s = { ...initRisk('2026-06-01'), rung: 2 as const, gradedAtRung: 10 }
    const cold = [...wins(8), ...losses(12, false)] // 40%
    s = computeRung(s, cold, 5, true, null, '2026-07-01')
    expect(s.rung).toBe(1)
    expect(s.history.at(-1)?.evidence).toContain('hit rate')
  })

  it('three straight leveraged stop-outs demote even with a fine overall record', () => {
    let s = { ...initRisk('2026-06-01'), rung: 3 as const, gradedAtRung: 10 }
    const recent = [...wins(17), ...losses(3, true, true)]
    s = computeRung(s, recent, 3, true, null, '2026-07-01')
    expect(s.rung).toBe(2)
    expect(s.history.at(-1)?.evidence).toContain('leveraged')
  })

  it('override wins and is logged as manual; floor 0, ceiling 3', () => {
    let s = { ...initRisk('2026-06-01'), rung: 1 as const }
    s = computeRung(s, [], 0, true, 3, '2026-07-01')
    expect(s.rung).toBe(3)
    expect(s.history.at(-1)?.evidence).toBe('manual override')
    let low = { ...initRisk('2026-06-01'), rung: 0 as const, gradedAtRung: 0 }
    low = computeRung(low, losses(20, false), 20, true, null, '2026-07-01')
    expect(low.rung).toBe(0) // can't go below 0
  })
})

describe('leverage gating', () => {
  it('allowed leverage by rung and grade', () => {
    expect(leverageAllowed(0, 'A')).toBe(0)
    expect(leverageAllowed(1, 'A')).toBe(2)
    expect(leverageAllowed(1, 'B')).toBe(0)
    expect(leverageAllowed(2, 'B')).toBe(2)
    expect(leverageAllowed(3, 'A')).toBe(3)
    expect(leverageAllowed(3, 'C')).toBe(0)
  })

  it('mapInstrument picks the highest allowed with a mapping, falls back 3x→2x, else null', () => {
    const levMap = { NVDA: { short3x: '3SNV', short2x: 'SNVD', long2x: 'LNVD' } }
    expect(mapInstrument('short', 'NVDA', 'A', 3, levMap)).toEqual({ ticker: '3SNV', leverage: 3 })
    expect(mapInstrument('short', 'NVDA', 'A', 1, levMap)).toEqual({ ticker: 'SNVD', leverage: 2 })
    expect(mapInstrument('long', 'NVDA', 'A', 3, { NVDA: { long2x: 'LNVD' } })).toEqual({ ticker: 'LNVD', leverage: 2 })
    expect(mapInstrument('short', 'TSLA', 'A', 3, levMap)).toBeNull()
    expect(mapInstrument('short', 'NVDA', 'B', 1, levMap)).toBeNull()
  })

  it('risk per idea follows the rung', () => {
    expect(RUNG_RISK_PCT).toEqual([1.0, 1.25, 1.5, 2.0])
  })
})
