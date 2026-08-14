import { describe, expect, it } from 'vitest'
import {
  cohortRungOf,
  computeCohortRung,
  computeRung,
  initRisk,
  isRouteEtp,
  leverageAllowed,
  mapInstrument,
  migrateRisk,
  spotInstrument,
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

  it('mapInstrument falls through to the 1× ticket only when no leveraged one fires', () => {
    // the leveraged ticket still wins wherever the ladder allows one — a 1x
    // field cannot demote a route the rung and the grade already earned
    expect(mapInstrument('long', 'X', 'A', 2, { X: { long1x: 'SPOT', long2x: 'L2' } })).toEqual({ ticker: 'L2', leverage: 2 })
    expect(mapInstrument('long', 'X', 'A', 3, { X: { long1x: 'SPOT', long2x: 'L2', long3x: 'L3' } })).toEqual({ ticker: 'L3', leverage: 3 })
    // …and a full-size row with ONLY a 1× configured routes it
    expect(mapInstrument('long', 'X', 'A', 2, { X: { long1x: 'SPOT' } })).toEqual({ ticker: 'SPOT', leverage: 1 })
    // LEVERAGE-FREE, SO THE LEVERAGE LADDER HAS NOTHING TO SAY ABOUT IT: a 1×
    // tracker is the asset, so `leverageAllowed` — which exists to decide who
    // may hold a DECAYING geared ETP — is not asked. A grade-C row at rung 0
    // would take a plain share; this is the ISA-shaped way to hold one.
    expect(mapInstrument('long', 'X', 'C', 0, { X: { long1x: 'SPOT' } })).toEqual({ ticker: 'SPOT', leverage: 1 })
    expect(mapInstrument('short', 'X', 'B', 1, { X: { short1x: 'INV' } })).toEqual({ ticker: 'INV', leverage: 1 })
    // …per side, and never across it
    expect(mapInstrument('short', 'X', 'A', 2, { X: { long1x: 'SPOT' } })).toBeNull()
  })

  it('spotInstrument reads ONLY the 1x fields — a geared ticket is not a tracker', () => {
    const levMap = { 'BTC-USD': { long1x: 'BTCE.DE' }, NVDA: { long2x: 'LNVD', short3x: '3SNV' } }
    expect(spotInstrument('long', 'BTC-USD', levMap)).toEqual({ ticker: 'BTCE.DE', leverage: 1 })
    expect(spotInstrument('short', 'BTC-USD', levMap)).toBeNull() // no short1x configured
    expect(spotInstrument('long', 'NVDA', levMap)).toBeNull() // a 2× ETP is not a spot tracker
    expect(spotInstrument('short', 'NVDA', levMap)).toBeNull()
    expect(spotInstrument('long', 'TSLA', levMap)).toBeNull() // no entry at all
  })

  it('every leveraged answer is the answer it was — no equity entry carries a 1x field', () => {
    const levMap = { NVDA: { short3x: '3SNV', short2x: 'SNVD', long2x: 'LNVD' } }
    expect(mapInstrument('short', 'NVDA', 'A', 3, levMap)).toEqual({ ticker: '3SNV', leverage: 3 })
    expect(mapInstrument('short', 'NVDA', 'A', 1, levMap)).toEqual({ ticker: 'SNVD', leverage: 2 })
    expect(mapInstrument('long', 'NVDA', 'A', 3, levMap)).toEqual({ ticker: 'LNVD', leverage: 2 })
    expect(mapInstrument('short', 'NVDA', 'B', 1, levMap)).toBeNull() // the grade withholds it
    expect(mapInstrument('long', 'NVDA', 'C', 3, levMap)).toBeNull() // …and C never unlocks one
    expect(mapInstrument('short', 'TSLA', 'A', 3, levMap)).toBeNull() // no mapping
  })

  it('risk per idea follows the rung', () => {
    expect(RUNG_RISK_PCT).toEqual([1.0, 1.25, 1.5, 2.0])
  })

  it('isRouteEtp flags levMap route tickers and digit-prefixed LSE ETPs, never ordinary equities', () => {
    const levMap = { NVDA: { short3x: '3SNV.L', long2x: 'LNVD.L' }, 'BTC-USD': { long1x: 'BTCE.DE', short1x: 'XBTS.L' } }
    // the 1× trackers are route tickers like any other: a held spot tracker must
    // never circle back into the candidate pool as an underlying
    expect(isRouteEtp('BTCE.DE', levMap)).toBe(true)
    expect(isRouteEtp('xbts.l', levMap)).toBe(true)
    expect(isRouteEtp('3SNV.L', levMap)).toBe(true) // a configured route
    expect(isRouteEtp('lnvd.l', levMap)).toBe(true) // case-insensitive
    expect(isRouteEtp('3CON.L', {})).toBe(true) // digit prefix — LSE ETP naming, even unconfigured
    expect(isRouteEtp('NVDA', levMap)).toBe(false) // the underlying itself is fine
    expect(isRouteEtp('SOC', {})).toBe(false)
    expect(isRouteEtp('RR.L', {})).toBe(false) // ordinary LSE equity
  })
})
