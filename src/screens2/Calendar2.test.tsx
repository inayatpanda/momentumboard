// Calendar2 (visibility wave, 2026-08-17) — the failure state the day ledger
// never had. `getDayLedger(...).catch(() => {})` left the screen on "Loading
// the day…" forever, because null is BOTH the loading state and the failed
// one; a reader on a dropped connection watched a spinner that would never
// resolve. The retry is the other half: a state with no way out is a dead end
// with better copy.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import Calendar2 from './Calendar2'

const api = vi.hoisted(() => ({
  getMonthMap: vi.fn(() => Promise.resolve({})),
  getDayLedger: vi.fn(() => Promise.reject(new Error('offline'))),
}))

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, getMonthMap: api.getMonthMap, getDayLedger: api.getDayLedger }
})

const emptyLedger = (date: string) => ({ date, hasReport: false, regime: null, picks: [], alerts: [], events: [], videos: [] })

const withRouter = () => render(<Router base="/app" hook={memoryLocation({ path: '/app/more/calendar' }).hook}>{<Calendar2 />}</Router>)

beforeEach(() => {
  api.getMonthMap.mockReset().mockResolvedValue({})
  api.getDayLedger.mockReset().mockRejectedValue(new Error('offline'))
})

describe('Calendar2 — the day ledger fails honestly', () => {
  it('a rejected day says so instead of loading forever', async () => {
    withRouter()
    expect(await screen.findByText(/didn't load/i)).toBeInTheDocument()
    expect(screen.queryByText(/loading the day/i)).not.toBeInTheDocument()
  })

  it('offers a retry, and the retry re-fetches the same day', async () => {
    withRouter()
    const retry = await screen.findByRole('button', { name: /try again/i })
    expect(api.getDayLedger).toHaveBeenCalledTimes(1)
    api.getDayLedger.mockResolvedValue(emptyLedger(new Date().toISOString().slice(0, 10)) as never)
    fireEvent.click(retry)
    expect(await screen.findByText(/a quiet day/i)).toBeInTheDocument()
    expect(api.getDayLedger).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/didn't load/i)).not.toBeInTheDocument()
  })

  it('a day that loads normally never shows the failed state', async () => {
    api.getDayLedger.mockResolvedValue(emptyLedger(new Date().toISOString().slice(0, 10)) as never)
    withRouter()
    expect(await screen.findByText(/a quiet day/i)).toBeInTheDocument()
    expect(screen.queryByText(/didn't load/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })
})

describe('Calendar2 — the dots carry a key', () => {
  it('names all four dot colours', async () => {
    api.getDayLedger.mockResolvedValue(emptyLedger(new Date().toISOString().slice(0, 10)) as never)
    const { container } = withRouter()
    await screen.findByText(/a quiet day/i)
    const legend = container.querySelector('.cal-legend') as HTMLElement
    expect(legend).not.toBeNull()
    for (const word of ['paper', 'picks', 'alerts', 'events']) expect(legend.textContent).toContain(word)
    // every legend swatch uses the SAME classname the grid cells paint
    for (const cls of ['report', 'picks', 'alerts', 'events']) expect(legend.querySelector(`.dot.${cls}`)).not.toBeNull()
  })
})
