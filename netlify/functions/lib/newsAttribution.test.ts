import { describe, expect, it } from 'vitest'
import { attributedHeadline } from './newsAttribution'

describe('company attribution', () => {
  it('rejects wrong-company headlines even when the provider labels them with the requested stock', () => {
    expect(attributedHeadline('Should you invest in PayPal (PYPL)?', 'NVDA', undefined, 'NVDA')).toBe(false)
    expect(attributedHeadline('GPC misses earnings estimates', 'LCID', 'Lucid Group Inc', 'LCID')).toBe(false)
    expect(attributedHeadline('Nvidia announces new chips', 'NVDA')).toBe(true)
    expect(attributedHeadline('Apple ships new thing', 'AAPL')).toBe(true)
    expect(attributedHeadline('LCID cuts outlook', 'LCID', undefined, 'GPC')).toBe(false)
  })
  it('does not mistake ordinary short words for ticker symbols', () => {
    expect(attributedHeadline('A new way to invest', 'A', 'Agilent Technologies')).toBe(false)
    expect(attributedHeadline('IT is a difficult market', 'IT', 'Gartner')).toBe(false)
    expect(attributedHeadline('Analysts downgrade $IT', 'IT')).toBe(true)
  })
})
