import { describe, expect, it } from 'vitest'
import {
  cohortRungOf,
  computeCohortRung,
  computeRung,
  initRisk,
  leverageAllowed,
  mapInstrument,
  migrateRisk,
  RUNG_RISK_PCT,
  type CohortRung,
  type OutcomeLite,
  type RiskState,
} from './riskLadder'

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
    let s: RiskState = { ...initRisk('2026-06-01'), rung: 2, gradedAtRung: 10 }
    const cold = [...wins(8), ...losses(12, false)] // 40%
    s = computeRung(s, cold, 5, true, null, '2026-07-01')
    expect(s.rung).toBe(1)
    expect(s.history.at(-1)?.evidence).toContain('hit rate')
  })

  it('three straight leveraged stop-outs demote even with a fine overall record', () => {
    let s: RiskState = { ...initRisk('2026-06-01'), rung: 3, gradedAtRung: 10 }
    const recent = [...wins(17), ...losses(3, true, true)]
    s = computeRung(s, recent, 3, true, null, '2026-07-01')
    expect(s.rung).toBe(2)
    expect(s.history.at(-1)?.evidence).toContain('leveraged')
  })

  it('override wins and is logged as manual; floor 0, ceiling 3', () => {
    let s: RiskState = { ...initRisk('2026-06-01'), rung: 1 }
    s = computeRung(s, [], 0, true, 3, '2026-07-01')
    expect(s.rung).toBe(3)
    expect(s.history.at(-1)?.evidence).toBe('manual override')
    let low: RiskState = { ...initRisk('2026-06-01'), rung: 0, gradedAtRung: 0 }
    low = computeRung(low, losses(20, false), 20, true, null, '2026-07-01')
    expect(low.rung).toBe(0) // can't go below 0
  })
})

describe('initRisk / migrateRisk', () => {
  it('initRisk seeds both cohorts at rung 0', () => {
    const s = initRisk('2026-06-01')
    expect(s.rung).toBe(0)
    expect(s.cohorts).toEqual({
      large: { rung: 0, sinceDate: '2026-06-01', gradedAtRung: 0, history: [] },
      small: { rung: 0, sinceDate: '2026-06-01', gradedAtRung: 0, history: [] },
    })
  })

  it('migrates a legacy (cohortless) blob by seeding BOTH cohorts from the top-level rung, without losing history/sinceDate', () => {
    // exactly the shape live in production, but at a non-zero rung to prove carry-over
    const legacy: RiskState = { rung: 2, sinceDate: '2026-06-01', gradedAtRung: 8, history: [{ date: '2026-06-01', from: 1, to: 2, evidence: 'earned' }] }
    const m = migrateRisk(legacy)
    expect(m.rung).toBe(2) // top-level preserved
    expect(m.sinceDate).toBe('2026-06-01')
    expect(m.history).toHaveLength(1)
    expect(m.cohorts!.large).toEqual(legacy) // seeded from the combined rung...
    expect(m.cohorts!.small.rung).toBe(2)
    // ...but as COPIES — mutating a cohort's history must not touch the top-level
    m.cohorts!.large.history.push({ date: 'x', from: 2, to: 3, evidence: 'y' })
    expect(m.history).toHaveLength(1)
  })

  it('migrateRisk is idempotent — a blob that already has cohorts is returned untouched', () => {
    const s = initRisk('2026-06-01')
    expect(migrateRisk(s)).toBe(s)
  })
})

describe('computeCohortRung — per-sleeve rung with pool-when-thin', () => {
  const r0: CohortRung = { rung: 0, sinceDate: '2026-06-01', gradedAtRung: 0, history: [] }
  const combinedAt = (rung: number): CohortRung => ({ rung: rung as CohortRung['rung'], sinceDate: '2026-07-01', gradedAtRung: 0, history: [] })

  it('THIN cohort mirrors the combined rung (never starved), evidence says so', () => {
    // only 5 own graded outcomes (< COHORT_STANDALONE_N) → mirror combined R2
    const next = computeCohortRung(r0, wins(5), 5, combinedAt(2), true, null, '2026-07-01')
    expect(next.rung).toBe(2)
    expect(next.history.at(-1)!.evidence).toContain('pooled: mirrors combined')
    expect(next.history.at(-1)!.evidence).toContain('5 own graded')
  })

  it('THIN cohort follows the combined rung DOWN too (inherits the book’s demotions)', () => {
    const atTwo: CohortRung = { ...r0, rung: 2 }
    const next = computeCohortRung(atTwo, wins(3), 3, combinedAt(1), true, null, '2026-07-01')
    expect(next.rung).toBe(1)
  })

  it('MATURE cohort (≥20 own graded) stands on its OWN stream, ignoring the combined rung', () => {
    // 25 own outcomes at 60%, brier improving, 25 graded at rung → promotes to 1
    const recent = [...wins(15), ...losses(10, false)]
    const next = computeCohortRung(r0, recent, 25, combinedAt(3), true, null, '2026-07-01')
    expect(next.rung).toBe(1) // its OWN 60% earned exactly one rung — NOT combined's R3
    expect(next.history.at(-1)!.evidence).toContain('earned')
  })

  it('a mature cohort with a COLD own stream demotes even while the book is warm', () => {
    const atTwo: CohortRung = { ...r0, rung: 2 }
    const cold = [...wins(8), ...losses(12, false)] // 40% over 20
    const next = computeCohortRung(atTwo, cold, 5, combinedAt(2), true, null, '2026-07-01')
    expect(next.rung).toBe(1)
    expect(next.history.at(-1)!.evidence).toContain('hit rate')
  })

  it('override pins the cohort regardless of its stream or the combined rung', () => {
    const next = computeCohortRung(r0, [], 0, combinedAt(0), true, 3, '2026-07-01')
    expect(next.rung).toBe(3)
    expect(next.history.at(-1)!.evidence).toBe('manual override')
  })
})

describe('cohortRungOf', () => {
  it('known cohorts read their own rung; unknown-cap pools to the top-level combined rung', () => {
    const s: RiskState = {
      rung: 1,
      sinceDate: '2026-06-01',
      gradedAtRung: 0,
      history: [],
      cohorts: { large: { rung: 3, sinceDate: 'x', gradedAtRung: 0, history: [] }, small: { rung: 0, sinceDate: 'x', gradedAtRung: 0, history: [] } },
    }
    expect(cohortRungOf(s, 'large')).toBe(3)
    expect(cohortRungOf(s, 'small')).toBe(0)
    expect(cohortRungOf(s, 'unknown')).toBe(1) // combined
  })

  it('falls back to the top-level rung when cohorts are absent (unmigrated blob)', () => {
    const s: RiskState = { rung: 2, sinceDate: 'x', gradedAtRung: 0, history: [] }
    expect(cohortRungOf(s, 'large')).toBe(2)
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
