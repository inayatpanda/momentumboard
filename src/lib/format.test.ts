import { describe, it, expect, afterEach, vi } from 'vitest'
import { fmtPrice, fmtPct, capCohort, compactUsd, emptySideLine, relativeStamp, sizeLabel, longDate, shortDateWithWeekday } from './format'

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

// Owner iteration 2: "News desk doesnt show date of news." The desk stores `at`
// in SECONDS and other feeds here store milliseconds, so the unit is decided by
// magnitude — read the wrong way round, every headline dates to 1970.
describe('relativeStamp', () => {
  // LOCAL noon, not UTC noon: the >24h fallback prints a local calendar date,
  // and a UTC-noon anchor would land on the previous/next day for readers far
  // enough east or west to make this test machine-dependent.
  const now = new Date(2026, 7, 14, 12, 0, 0).getTime() // Fri 14 Aug 2026

  it('reads a SECONDS stamp as seconds', () => {
    expect(relativeStamp(Math.floor((now - 2 * 3_600_000) / 1000), now)).toBe('2h ago')
  })

  it('reads a MILLISECONDS stamp as milliseconds', () => {
    expect(relativeStamp(now - 2 * 3_600_000, now)).toBe('2h ago')
  })

  it('counts minutes under the hour and hours under the day', () => {
    expect(relativeStamp(now - 90_000, now)).toBe('1m ago')
    expect(relativeStamp(now - 45 * 60_000, now)).toBe('45m ago')
    expect(relativeStamp(now - 23 * 3_600_000, now)).toBe('23h ago')
  })

  it('falls back to a weekday date beyond 24 hours', () => {
    // 3 days back from Fri 14 Aug 2026 is Tue 11 Aug
    expect(relativeStamp(now - 3 * 86_400_000, now)).toMatch(/^Tue 11 Aug$/)
  })

  it('never prints a negative age, and never prints an empty stamp as a number', () => {
    expect(relativeStamp(now + 5 * 60_000, now)).toBe('just now')
    expect(relativeStamp(0, now)).toBe('')
    expect(relativeStamp(Number.NaN, now)).toBe('')
  })
})

describe('compactUsd', () => {
  it('scales to K/M/B and keeps small values whole', () => {
    expect(compactUsd(1_240_000)).toBe('$1.2M')
    expect(compactUsd(2_400_000_000)).toBe('$2.4B')
    expect(compactUsd(950_000)).toBe('$950K')
    expect(compactUsd(420)).toBe('$420')
    expect(compactUsd(-1_500_000)).toBe('−$1.5M')
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

describe('emptySideLine', () => {
  // The whole point: a side emptied by ROUTING had candidates that cleared every
  // gate, so the gates wording is simply untrue there — and the reader can check.
  it('names the ISA route when routing is what emptied the side', () => {
    expect(emptySideLine('short', 'no-route')).toBe('Nothing tradeable on the short side today — the candidates have no ISA route.')
  })

  it('keeps the gates wording for a side where nothing actually cleared them', () => {
    expect(emptySideLine('long', 'gates')).toBe('Nothing cleared the gates on the long side today.')
  })

  // A short the dip lane demoted cleared every gate AND had a route: it was a
  // live, sized row until the engine's other lane outranked it. Both of the
  // other two sentences would be false about it.
  it('names the dip lane when it is what emptied the side', () => {
    expect(emptySideLine('short', 'dip-lane')).toBe('Nothing tradeable on the short side today — the dip read outranked the shorts we had.')
  })

  // …and the velocity lane gets its OWN sentence. "The dip read outranked it" is
  // simply false about a breakout, and one lane's copy must not be told about the
  // other's trade.
  it('names the velocity lane separately — a breakout is not a dip', () => {
    expect(emptySideLine('short', 'velocity-lane')).toBe('Nothing tradeable on the short side today — a breakout read outranked the shorts we had.')
  })
})

describe('longDate / shortDateWithWeekday — timezone-proof date labels', () => {
  // `new Date('2026-08-13')` is parsed as UTC midnight; a reader west of
  // Greenwich (America/Los_Angeles, UTC-7/8) would see `toLocaleDateString`
  // walk it back to 12 Aug. Pin TZ to that offset and assert the manual-parse
  // helpers still land on 13 Aug — proving the bug this replaces is gone.
  afterEach(() => vi.unstubAllEnvs())

  it('renders 2026-08-13 as 13 Aug 2026 regardless of TZ', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    expect(longDate('2026-08-13')).toBe('13 Aug 2026')
    vi.stubEnv('TZ', 'Pacific/Kiritimati') // UTC+14, the other direction
    expect(longDate('2026-08-13')).toBe('13 Aug 2026')
  })

  it('renders 2026-08-13 (a Thursday) with its weekday regardless of TZ', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    expect(shortDateWithWeekday('2026-08-13')).toBe('Thu, 13 Aug')
    vi.stubEnv('TZ', 'Pacific/Kiritimati')
    expect(shortDateWithWeekday('2026-08-13')).toBe('Thu, 13 Aug')
  })

  it('sanity check: the bug this replaces is real — new Date + toLocaleDateString walks the day back in LA', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    const bugged = new Date('2026-08-13').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    expect(bugged).toBe('12 Aug') // proves the trap, not the fix
  })
})

describe('sizeLabel', () => {
  // Read off the FRACTION of the rung, never off "less than the rung": a quarter-size
  // velocity probe and a half-size grade-C trade are different sentences.
  it('says quarter, half or nothing', () => {
    expect(sizeLabel(1.25, 1)).toBe('') // the whole rung
    expect(sizeLabel(0.625, 1)).toBe(' (half size)') // the half tier
    expect(sizeLabel(0.3125, 1)).toBe(' (quarter size)') // the early door's cap
    expect(sizeLabel(0.25, 0)).toBe(' (quarter size)')
    expect(sizeLabel(0.5, 0)).toBe(' (half size)')
  })

  it('says nothing at all for an unsized row', () => {
    expect(sizeLabel(0, 0)).toBe('')
  })
})
