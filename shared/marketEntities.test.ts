import { describe, expect, it } from 'vitest'
import { normaliseTradableMention, resolveMarketEntity } from './marketEntities'

describe('market mention resolver', () => {
  it('canonicalises crypto aliases instead of routing them as US stocks', () => {
    expect(normaliseTradableMention('BTC')).toBe('BTC-USD')
    expect(resolveMarketEntity('$ETH').kind).toBe('crypto')
  })

  it('keeps listed equities and exchange suffixes', () => {
    expect(normaliseTradableMention('GOOGL')).toBe('GOOGL')
    expect(normaliseTradableMention('RR.L')).toBe('RR.L')
    expect(normaliseTradableMention('BRK-B')).toBe('BRK-B')
  })

  it('refuses FX, commodity labels and private companies as stock routes', () => {
    expect(resolveMarketEntity('USD/GBP').kind).toBe('fx')
    expect(resolveMarketEntity('SILVER').kind).toBe('commodity')
    expect(resolveMarketEntity('SpaceX').kind).toBe('private')
    expect(normaliseTradableMention('USD/CAD')).toBeNull()
  })
})
