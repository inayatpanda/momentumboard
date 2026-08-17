// The reader's day, London (dynamism wave). The board's `date` is a London
// calendar day struck by the engine; anything comparing against it must ask
// the same calendar, not the reader's timezone and not UTC.

import { describe, expect, it } from 'vitest'
import { daysBetweenIso, londonToday } from './londonDay'

const at = (iso: string) => Date.parse(iso)

describe('londonToday', () => {
  it('is the London calendar day, not the UTC one, across the BST offset', () => {
    // 23:30 UTC in August is already 00:30 the NEXT day in London
    expect(londonToday(at('2026-08-17T23:30:00Z'))).toBe('2026-08-18')
    expect(londonToday(at('2026-08-17T22:30:00Z'))).toBe('2026-08-17')
    // …and in January London IS UTC, so midnight is the boundary
    expect(londonToday(at('2026-01-17T23:30:00Z'))).toBe('2026-01-17')
  })

  it('formats as the ISO calendar date the engine stamps boards with', () => {
    expect(londonToday(at('2026-08-04T12:00:00Z'))).toBe('2026-08-04')
  })
})

describe('daysBetweenIso', () => {
  it('counts whole calendar days, signed, across a month and a DST switch', () => {
    expect(daysBetweenIso('2026-08-14', '2026-08-17')).toBe(3)
    expect(daysBetweenIso('2026-08-17', '2026-08-14')).toBe(-3)
    expect(daysBetweenIso('2026-08-17', '2026-08-17')).toBe(0)
    expect(daysBetweenIso('2026-10-24', '2026-10-26')).toBe(2) // British Summer Time ends on the 25th
    expect(daysBetweenIso('2026-02-27', '2026-03-02')).toBe(3)
  })

  it('refuses a malformed date rather than answering NaN', () => {
    expect(daysBetweenIso('', '2026-08-17')).toBeNull()
    expect(daysBetweenIso('2026-08-17', 'soon')).toBeNull()
  })
})
