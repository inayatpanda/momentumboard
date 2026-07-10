import { describe, it, expect } from 'vitest'
import { isUsMarketHoliday } from './usMarketHolidays'

describe('isUsMarketHoliday', () => {
  it('shifts a Saturday Independence Day to the preceding Friday', () => {
    expect(isUsMarketHoliday('2026-07-03')).toBe(true) // observed: Jul 4 2026 falls on a Saturday
    expect(isUsMarketHoliday('2026-07-04')).toBe(false) // the nominal Saturday itself — already a weekend, not this module's concern
  })

  it('pins the 2026 NYSE holiday calendar', () => {
    expect(isUsMarketHoliday('2026-01-01')).toBe(true) // New Year's Day
    expect(isUsMarketHoliday('2026-01-19')).toBe(true) // MLK Day
    expect(isUsMarketHoliday('2026-02-16')).toBe(true) // Washington's Birthday
    expect(isUsMarketHoliday('2026-04-03')).toBe(true) // Good Friday (Easter Sunday is 2026-04-05)
    expect(isUsMarketHoliday('2026-05-25')).toBe(true) // Memorial Day
    expect(isUsMarketHoliday('2026-06-19')).toBe(true) // Juneteenth
    expect(isUsMarketHoliday('2026-09-07')).toBe(true) // Labor Day
    expect(isUsMarketHoliday('2026-11-26')).toBe(true) // Thanksgiving
    expect(isUsMarketHoliday('2026-12-25')).toBe(true) // Christmas
  })

  it('pins 2027 spot-checks, including a moved Good Friday', () => {
    // Easter Sunday 2027 is 2027-03-28, so Good Friday is 2027-03-26 — NOT
    // the naive "last Friday of April" guess this is easy to get wrong with.
    expect(isUsMarketHoliday('2027-03-26')).toBe(true)
    expect(isUsMarketHoliday('2027-01-01')).toBe(true) // New Year's Day
    expect(isUsMarketHoliday('2027-11-25')).toBe(true) // Thanksgiving
  })

  it('shifts a fixed-date holiday landing on Sunday to the following Monday', () => {
    // Juneteenth 2033-06-19 falls on a Sunday — observed the following Monday.
    expect(isUsMarketHoliday('2033-06-19')).toBe(false) // nominal Sunday — already a weekend
    expect(isUsMarketHoliday('2033-06-20')).toBe(true) // observed Monday
  })

  it('is false for ordinary weekdays', () => {
    expect(isUsMarketHoliday('2026-07-06')).toBe(false) // Monday right after the July 4th long weekend
    expect(isUsMarketHoliday('2026-03-17')).toBe(false) // an unremarkable Tuesday
    expect(isUsMarketHoliday('2026-11-27')).toBe(false) // day after Thanksgiving — NYSE has a half day, not a closure
  })

  it('does not treat weekends as its own concern (that is the caller\'s job)', () => {
    expect(isUsMarketHoliday('2026-07-11')).toBe(false) // an ordinary Saturday, not a shifted holiday
  })
})
