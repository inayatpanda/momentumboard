// The stale-board banner (dynamism wave, feature 2). Clocks are injected
// throughout: the whole point of this line is which DAY the reader is on.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StaleBoardNote, staleBoardLine } from './StaleBoardNote'

const at = (iso: string) => Date.parse(iso)

describe('staleBoardLine', () => {
  it('names the day a weekend reader is actually looking at', () => {
    expect(staleBoardLine('2026-08-14', at('2026-08-15T09:00:00Z'))).toBe("Friday's board (14 Aug) — the engine publishes on weekday mornings.")
    expect(staleBoardLine('2026-08-14', at('2026-08-16T18:00:00Z'))).toBe("Friday's board (14 Aug) — the engine publishes on weekday mornings.")
  })

  it('still says so on a Monday before the run has published', () => {
    expect(staleBoardLine('2026-08-14', at('2026-08-17T06:00:00Z'))).toBe("Friday's board (14 Aug) — the engine publishes on weekday mornings.")
  })

  it('says nothing at all about a board struck today', () => {
    expect(staleBoardLine('2026-08-17', at('2026-08-17T06:00:00Z'))).toBeNull()
    expect(staleBoardLine('2026-08-17', at('2026-08-17T22:30:00Z'))).toBeNull()
  })

  it('uses the LONDON day, so a board goes stale at London midnight, not UTC’s', () => {
    // 23:30 UTC in August is 00:30 the next day in London — the board is now yesterday's
    expect(staleBoardLine('2026-08-17', at('2026-08-17T23:30:00Z'))).toBe("Monday's board (17 Aug) — the engine publishes on weekday mornings.")
  })

  it('carries the year when the board is from a different one', () => {
    expect(staleBoardLine('2025-12-31', at('2026-01-02T09:00:00Z'))).toBe("Wednesday's board (31 Dec 2025) — the engine publishes on weekday mornings.")
  })

  it('says nothing for a missing, malformed or future-dated board', () => {
    expect(staleBoardLine(null, at('2026-08-17T09:00:00Z'))).toBeNull()
    expect(staleBoardLine(undefined, at('2026-08-17T09:00:00Z'))).toBeNull()
    expect(staleBoardLine('not-a-date', at('2026-08-17T09:00:00Z'))).toBeNull()
    expect(staleBoardLine('2026-08-18', at('2026-08-17T09:00:00Z'))).toBeNull()
  })
})

describe('StaleBoardNote', () => {
  it('renders the line, dim, when the board is not today’s', () => {
    render(<StaleBoardNote date="2026-08-14" now={at('2026-08-15T09:00:00Z')} />)
    const el = screen.getByText(/Friday's board \(14 Aug\)/)
    expect(el).toHaveClass('stale-board')
  })

  it('renders nothing at all for a fresh board', () => {
    const { container } = render(<StaleBoardNote date="2026-08-17" now={at('2026-08-17T09:00:00Z')} />)
    expect(container).toBeEmptyDOMElement()
  })
})
