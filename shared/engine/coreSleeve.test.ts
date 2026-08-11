import { describe, expect, it } from 'vitest'
import { DEFAULT_CORE_SLEEVE, rankSleeve, sleeveWithDefaults } from './coreSleeve'

describe('DEFAULT_CORE_SLEEVE', () => {
  it('has 100-200 unique upper-case names including the famous ones', () => {
    expect(DEFAULT_CORE_SLEEVE.length).toBeGreaterThanOrEqual(100)
    expect(DEFAULT_CORE_SLEEVE.length).toBeLessThanOrEqual(200)
    expect(new Set(DEFAULT_CORE_SLEEVE).size).toBe(DEFAULT_CORE_SLEEVE.length)
    for (const sym of ['AAPL', 'NVDA', 'TSLA', 'GOOGL', 'GLW', 'AMD', 'PLTR', 'COIN', 'MSTR', 'RR.L', 'BP.L', 'SHEL.L'])
      expect(DEFAULT_CORE_SLEEVE).toContain(sym)
  })
})

describe('sleeveWithDefaults', () => {
  it('unions config names over defaults, deduped and upper-cased', () => {
    const s = sleeveWithDefaults(['aapl', 'ZZZZ'])
    expect(s.filter(x => x === 'AAPL')).toHaveLength(1)
    expect(s).toContain('ZZZZ')
    expect(s.length).toBe(new Set(s).size)
  })
  it('null/undefined leaves the defaults untouched', () => {
    expect(sleeveWithDefaults(null)).toEqual(DEFAULT_CORE_SLEEVE)
  })
})

describe('rankSleeve', () => {
  const flat = [...Array.from({ length: 62 }, () => 100), 112] // +12% on the last day
  const steady = Array.from({ length: 63 }, (_, i) => 100 * Math.pow(1.01, i % 2))
  it('ranks the unusual mover first and reports typical move', () => {
    const ranked = rankSleeve(new Map([['CALM', steady], ['MOVE', flat]]), 2)
    expect(ranked[0].sym).toBe('MOVE')
    expect(ranked[0].unusualness).toBeGreaterThan(ranked[1].unusualness)
    expect(ranked[0].typicalMovePct).not.toBeNull()
  })
  it('respects topN and skips series shorter than 30', () => {
    const ranked = rankSleeve(new Map([['SHORT', [1, 2, 3]], ['MOVE', flat]]), 5)
    expect(ranked.map(r => r.sym)).toEqual(['MOVE'])
  })
})
