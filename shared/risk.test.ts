import { describe, it, expect } from 'vitest'
import { positionSize } from './risk'

const base = { capital: 5000, riskPct: 2, entry: 100, stop: 95, riskClass: 'normal' as const }

describe('positionSize', () => {
  it('sizes a normal long, capping at 20% of capital with a warning', () => {
    // risk £100 / £5 per share = 20 shares = £2000 — but 20% cap is £1000 → 10 shares
    const r = positionSize(base)!
    expect(r.riskAmount).toBe(100)
    expect(r.perUnitRisk).toBe(5)
    expect(r.units).toBe(10)
    expect(r.positionValue).toBe(1000)
    expect(r.positionPctOfCapital).toBe(20)
    expect(r.warnings.some(w => w.includes('20%'))).toBe(true)
  })

  it('uncapped when the natural size fits inside the cap', () => {
    // wider stop: £20/share risk → 5 units = £500 (10% of capital)
    const r = positionSize({ ...base, stop: 80 })!
    expect(r.units).toBe(5)
    expect(r.positionValue).toBe(500)
    expect(r.warnings).toHaveLength(0)
  })

  it('halves risk for speculative names', () => {
    const r = positionSize({ ...base, stop: 80, riskClass: 'speculative' })!
    expect(r.riskAmount).toBe(50)
    expect(r.units).toBe(2)
  })

  it('warns when the stop is above entry (short-side setup)', () => {
    const r = positionSize({ ...base, stop: 105 })!
    expect(r.warnings.some(w => w.toLowerCase().includes('above entry'))).toBe(true)
  })

  it('warns on a noise-tight stop', () => {
    const r = positionSize({ ...base, stop: 99.95 })! // 0.05% away
    expect(r.warnings.some(w => w.toLowerCase().includes('tight'))).toBe(true)
  })

  it('returns null on invalid input', () => {
    expect(positionSize({ ...base, entry: 0 })).toBeNull()
    expect(positionSize({ ...base, stop: 100 })).toBeNull()
  })
})
