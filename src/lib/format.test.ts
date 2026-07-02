import { describe, it, expect } from 'vitest'
import { fmtPrice, fmtPct } from './format'

describe('fmtPrice', () => {
  it('renders pence for GBp', () => expect(fmtPrice(123.4, 'GBp')).toBe('123.4p'))
  it('renders pounds for GBP', () => expect(fmtPrice(1.234, 'GBP')).toBe('£1.23'))
  it('renders dollars for USD', () => expect(fmtPrice(2.981, 'USD')).toBe('$2.98'))
})

describe('fmtPct', () => {
  it('signs both directions', () => {
    expect(fmtPct(1.7349)).toBe('+1.73%')
    expect(fmtPct(-0.5)).toBe('−0.50%')
  })
})
