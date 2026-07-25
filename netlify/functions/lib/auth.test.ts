import { describe, it, expect } from 'vitest'
import { scopedToken } from './auth'

describe('scopedToken (audit H-1 cutover)', () => {
  it('prefers the dedicated token once it is set', () => {
    expect(scopedToken('scoped', 'shared')).toBe('scoped')
  })

  it('falls back to the shared token while the dedicated one is absent', () => {
    expect(scopedToken(undefined, 'shared')).toBe('shared')
  })

  // The 2026-07-24/25 outage: the daily-paper workflow passes
  // `REPORT_PUBLISH_TOKEN: ${{ secrets.REPORT_PUBLISH_TOKEN }}`, and GitHub
  // materialises a MISSING secret as an empty string. `??` only falls back on
  // null/undefined, so the composer published with an empty header and the
  // site 401'd every morning. Blank means "not cut over yet", same as absent.
  it('treats a blank dedicated token as NOT set', () => {
    expect(scopedToken('', 'shared')).toBe('shared')
    expect(scopedToken('   ', 'shared')).toBe('shared')
  })

  it('is undefined when nothing is set, so callers still reject', () => {
    expect(scopedToken('', undefined)).toBeUndefined()
    expect(scopedToken('', '')).toBeUndefined()
  })
})
