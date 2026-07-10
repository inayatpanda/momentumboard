import { describe, expect, it } from 'vitest'
import { CAP_COHORT_LABEL, capCohortOf, SMALL_CAP_MAX_USD_M } from './capClass'

describe('capCohortOf', () => {
  it('splits large/small at $2B (exclusive small ceiling); null/undefined → unknown', () => {
    expect(capCohortOf(1999)).toBe('small')
    expect(capCohortOf(SMALL_CAP_MAX_USD_M - 0.01)).toBe('small')
    expect(capCohortOf(SMALL_CAP_MAX_USD_M)).toBe('large') // exactly $2B is LARGE
    expect(capCohortOf(50_000)).toBe('large')
    expect(capCohortOf(null)).toBe('unknown')
    expect(capCohortOf(undefined)).toBe('unknown')
  })

  it('labels match the Phase 1 display sleeves exactly', () => {
    expect(CAP_COHORT_LABEL[capCohortOf(50_000)]).toBe('Large-cap')
    expect(CAP_COHORT_LABEL[capCohortOf(500)]).toBe('Small-cap')
    expect(CAP_COHORT_LABEL[capCohortOf(null)]).toBe('Unknown')
  })
})
