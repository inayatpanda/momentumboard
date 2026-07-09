import { describe, expect, it } from 'vitest'
import { validateConfig } from './config'

const minimal = { watchlist: [], rules: [], ytChannels: [] }

describe('validateConfig engine fields', () => {
  it('round-trips levMap, override and favourites; sanitises junk', () => {
    const cfg = validateConfig({
      ...minimal,
      levMap: { nvda: { short3x: '3snv', bogus: 'X', long2x: 42 }, junk: null },
      riskRungOverride: 2,
      favouriteChannels: ['Stocks with Josh', 7],
    })!
    expect(cfg.levMap).toEqual({ NVDA: { short3x: '3SNV' } })
    expect(cfg.riskRungOverride).toBe(2)
    expect(cfg.favouriteChannels).toEqual(['Stocks with Josh'])
  })
  it('rejects out-of-range override; absent fields stay absent', () => {
    const cfg = validateConfig({ ...minimal, riskRungOverride: 5 })!
    expect(cfg.riskRungOverride).toBeNull()
    expect(cfg.levMap).toBeUndefined()
    expect(validateConfig(minimal)!.favouriteChannels).toBeUndefined()
  })
  it('distinguishes an ABSENT override (undefined → caller may preserve) from an explicit null (→ clear)', () => {
    // absent: the phone mirror never sends this field — must stay undefined so the
    // server merge can preserve a stored pin
    expect(validateConfig(minimal)!.riskRungOverride).toBeUndefined()
    // explicit null: the user cleared the pin — a real "engine decides" instruction
    expect(validateConfig({ ...minimal, riskRungOverride: null })!.riskRungOverride).toBeNull()
  })
  it('riskAppetite: accepts aggressive/moderate, ignores junk, absent stays undefined', () => {
    expect(validateConfig({ ...minimal, riskAppetite: 'aggressive' })!.riskAppetite).toBe('aggressive')
    expect(validateConfig({ ...minimal, riskAppetite: 'moderate' })!.riskAppetite).toBe('moderate')
    expect(validateConfig({ ...minimal, riskAppetite: 'reckless' })!.riskAppetite).toBeUndefined()
    expect(validateConfig(minimal)!.riskAppetite).toBeUndefined()
  })
})
