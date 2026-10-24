// SessionLine (dynamism wave, feature 1) — the time-awareness line.
//
// Every clock here is INJECTED and every label is asked for in an explicit
// timezone: a test that reads the machine's own clock or its own TZ passes in
// London and fails in CI, and this component's whole job is to be right about
// when the reader is.

import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionLine, usSessionRead } from './SessionLine'

const LDN = 'Europe/London'
const at = (iso: string) => Date.parse(iso)

describe('usSessionRead', () => {
  it('inside the cash session: says open and when it closes, in the reader’s own clock', () => {
    // BST: the 20:00 UTC close is 21:00 in London
    expect(usSessionRead(at('2026-08-17T15:00:00Z'), LDN)).toEqual({ kind: 'open', text: 'US market open · closes 21:00' })
    // New York is on winter time too: its close is 21:00 UTC in January.
    expect(usSessionRead(at('2026-01-05T15:00:00Z'), LDN).text).toBe('US market open · closes 21:00')
    // The transition gap lasts until London changes its own clocks.
    expect(usSessionRead(at('2026-03-09T15:00:00Z'), LDN).text).toBe('US market open · closes 20:00')
  })

  it('opens exactly at 13:30 UTC and is shut the instant it closes', () => {
    expect(usSessionRead(at('2026-08-17T13:30:00Z'), LDN).kind).toBe('open')
    expect(usSessionRead(at('2026-08-17T13:29:00Z'), LDN).kind).toBe('pre-open')
    expect(usSessionRead(at('2026-08-17T20:00:00Z'), LDN).kind).not.toBe('open')
  })

  it('before the bell on a trading day: counts down to the open', () => {
    expect(usSessionRead(at('2026-08-17T10:49:00Z'), LDN)).toEqual({ kind: 'pre-open', text: 'US opens in 2h 41m' })
    expect(usSessionRead(at('2026-08-17T13:00:00Z'), LDN).text).toBe('US opens in 30m')
    expect(usSessionRead(at('2026-08-17T12:30:00Z'), LDN).text).toBe('US opens in 1h')
  })

  it('computes the next opening using that day’s DST offset', () => {
    expect(usSessionRead(at('2026-03-06T22:00:00Z'), LDN).text).toBe('US closed — opens Mon 13:30')
    expect(usSessionRead(at('2026-10-30T22:00:00Z'), LDN).text).toBe('US closed — opens Mon 14:30')
    expect(usSessionRead(at('2026-01-05T14:00:00Z'), LDN).text).toBe('US opens in 30m')
  })

  it('a weekend says weekend — both days, at any hour', () => {
    expect(usSessionRead(at('2026-08-15T12:00:00Z'), LDN)).toEqual({ kind: 'weekend', text: 'US closed — weekend' })
    expect(usSessionRead(at('2026-08-16T20:00:00Z'), LDN)).toEqual({ kind: 'weekend', text: 'US closed — weekend' })
  })

  it('a holiday says holiday, even at an hour the session clock calls open', () => {
    // Thanksgiving 2026 — 15:00 UTC is mid-session by the clock alone
    expect(usSessionRead(at('2026-11-26T15:00:00Z'), LDN)).toEqual({ kind: 'holiday', text: 'US closed — holiday' })
    // Independence Day 2026 falls on a Saturday, so the NYSE observes the Friday
    expect(usSessionRead(at('2026-07-03T15:00:00Z'), LDN).kind).toBe('holiday')
    // Good Friday
    expect(usSessionRead(at('2026-04-03T15:00:00Z'), LDN).kind).toBe('holiday')
  })

  it('after the close on a weekday: names the next open rather than a 17-hour countdown', () => {
    expect(usSessionRead(at('2026-08-17T20:30:00Z'), LDN)).toEqual({ kind: 'closed', text: 'US closed — opens Tue 14:30' })
    // Friday evening skips the weekend entirely
    expect(usSessionRead(at('2026-08-14T21:00:00Z'), LDN).text).toBe('US closed — opens Mon 14:30')
    // …and Thursday evening before Good Friday skips the holiday too
    expect(usSessionRead(at('2026-04-02T21:00:00Z'), LDN).text).toBe('US closed — opens Mon 14:30')
  })
})

describe('SessionLine', () => {
  afterEach(() => vi.useRealTimers())

  it('renders the state line alone when no board stamp is offered', () => {
    render(<SessionLine now={at('2026-08-15T12:00:00Z')} timeZone={LDN} />)
    expect(screen.getByText('US closed — weekend')).toBeInTheDocument()
  })

  it('appends the board’s own stamp when the board slice carries one', () => {
    render(<SessionLine now={at('2026-08-17T15:00:00Z')} generatedAt={at('2026-08-17T05:42:00Z')} timeZone={LDN} />)
    expect(screen.getByText('US market open · closes 21:00 · updated 06:42')).toBeInTheDocument()
  })

  it('ignores a missing or zero stamp rather than printing an epoch', () => {
    render(<SessionLine now={at('2026-08-17T15:00:00Z')} generatedAt={0} timeZone={LDN} />)
    expect(screen.getByText('US market open · closes 21:00')).toBeInTheDocument()
  })

  // SEEN LIVE (first DMG with this line): the board blob stamps generatedAt in
  // SECONDS; read as ms that is January 1970, rendered as "struck 17:22". The
  // magnitude rule relativeStamp already uses applies here too.
  it('reads a seconds-unit stamp by magnitude, like every other stamp reader', () => {
    render(<SessionLine now={at('2026-08-17T15:00:00Z')} generatedAt={Math.floor(at('2026-08-17T05:42:00Z') / 1000)} timeZone={LDN} />)
    expect(screen.getByText('US market open · closes 21:00 · updated 06:42')).toBeInTheDocument()
  })

  it('ticks on its own clock when none is injected, and clears the interval on unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at('2026-08-17T13:29:00Z')))
    const { unmount } = render(<SessionLine timeZone={LDN} />)
    expect(screen.getByText('US opens in 1m')).toBeInTheDocument()
    vi.setSystemTime(new Date(at('2026-08-17T13:31:00Z')))
    act(() => void vi.advanceTimersByTime(30_000))
    expect(screen.getByText('US market open · closes 21:00')).toBeInTheDocument()
    const before = vi.getTimerCount()
    expect(before).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an injected clock never arms an interval — a frozen line stays frozen', () => {
    vi.useFakeTimers()
    render(<SessionLine now={at('2026-08-17T15:00:00Z')} timeZone={LDN} />)
    expect(vi.getTimerCount()).toBe(0)
  })
})
