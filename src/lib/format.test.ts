import { describe, it, expect } from 'vitest'
import { fmtPrice, fmtPct, capCohort } from './format'

describe('fmtPrice', () => {
  it('renders pence for GBp', () => expect(fmtPrice(123.4, 'GBp')).toBe('123.4p'))
  it('renders pounds for GBP', () => expect(fmtPrice(1.234, 'GBP')).toBe('£1.23'))
  it('renders dollars for USD', () => expect(fmtPrice(2.981, 'USD')).toBe('$2.98'))
  it('drops decimals and adds separators for large prices (BTC)', () => expect(fmtPrice(109432.55, 'USD')).toBe('$109,433'))
})

describe('fmtPct', () => {
  it('signs both directions', () => {
    expect(fmtPct(1.7349)).toBe('+1.73%')
    expect(fmtPct(-0.5)).toBe('−0.50%')
  })
})

describe('capCohort', () => {
  it('splits at $2000M and falls back to Unknown', () => {
    expect(capCohort(1999)).toBe('Small-cap')
    expect(capCohort(2000)).toBe('Large-cap')
    expect(capCohort(null)).toBe('Unknown')
    expect(capCohort(undefined)).toBe('Unknown')
  })
})
