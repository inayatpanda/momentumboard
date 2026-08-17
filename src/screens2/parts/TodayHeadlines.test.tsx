// Three headlines on Today (dynamism wave, feature 6). Same local-first
// pattern as the rest of the v2 screens: the fetcher rejects, every case
// paints from a seeded Dexie slice.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../../lib/db'
import { resetSeenMarks, writeSeenMarks } from '../../lib/lastSeen'
import { writeSlice } from '../../lib/store'
import type { NewsDeskItem } from '../../lib/api'
import { TodayHeadlines } from './TodayHeadlines'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, getNewsDesk: vi.fn(() => Promise.reject(new Error('not mocked in this test'))) }
})

const NOW = Date.parse('2026-08-17T12:00:00Z')
const mkItem = (o: Partial<NewsDeskItem> = {}): NewsDeskItem => ({
  title: 'Chipmaker lifts guidance',
  url: 'https://www.reuters.com/a1',
  syms: ['NVDA'],
  score: 80,
  why: 'guidance',
  at: Math.floor(Date.parse('2026-08-17T10:00:00Z') / 1000), // seconds, as the desk stores them
  source: 'Reuters',
  ...o,
})

const withRouter = (ui: React.ReactElement) => render(<Router base="/app" hook={memoryLocation({ path: '/app/' }).hook}>{ui}</Router>)

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.settings.clear()])
  resetSeenMarks() // the in-memory snapshot is module-level and outlives a test
})

describe('TodayHeadlines', () => {
  it('renders nothing at all — and no skeleton — until the desk has bytes', async () => {
    const { container } = withRouter(<TodayHeadlines now={NOW} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(document.querySelector('.skeleton')).toBeNull()
  })

  it('renders nothing for an empty desk either', async () => {
    await writeSlice('intel:news', [])
    const { container } = withRouter(<TodayHeadlines now={NOW} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('shows the newest three, stamped and sourced, newest first', async () => {
    await writeSlice('intel:news', [
      mkItem({ title: 'Third', at: Math.floor(Date.parse('2026-08-17T06:00:00Z') / 1000), url: 'https://x.com/3' }),
      mkItem({ title: 'Newest', at: Math.floor(Date.parse('2026-08-17T11:30:00Z') / 1000), url: 'https://x.com/1' }),
      mkItem({ title: 'Fourth', at: Math.floor(Date.parse('2026-08-16T06:00:00Z') / 1000), url: 'https://x.com/4' }),
      mkItem({ title: 'Second', at: Math.floor(Date.parse('2026-08-17T10:00:00Z') / 1000), url: 'https://x.com/2' }),
    ])
    withRouter(<TodayHeadlines now={NOW} />)
    expect(await screen.findByText('Newest')).toBeInTheDocument()
    const titles = [...document.querySelectorAll('.th-title')].map(e => e.textContent)
    expect(titles).toEqual(['Newest', 'Second', 'Third'])
    expect(screen.getByText('30m ago')).toBeInTheDocument()
    expect(screen.getAllByText('Reuters').length).toBe(3)
  })

  it('every headline is a door into the desk, not out to the publisher', async () => {
    await writeSlice('intel:news', [mkItem()])
    withRouter(<TodayHeadlines now={NOW} />)
    const row = await screen.findByRole('link', { name: /chipmaker lifts guidance/i })
    expect(row).toHaveAttribute('href', '/app/intel#news')
  })

  // NEW SINCE THE LAST VISIT (dynamism wave, feature 7)
  it('counts what the desk took in since the last visit — across the whole desk, not the three shown', async () => {
    await writeSeenMarks({ boardGeneratedAt: null, newsTopAt: Math.floor(Date.parse('2026-08-17T09:00:00Z') / 1000) })
    await writeSlice('intel:news', [
      mkItem({ title: 'A', at: Math.floor(Date.parse('2026-08-17T11:30:00Z') / 1000), url: 'https://x.com/1' }),
      mkItem({ title: 'B', at: Math.floor(Date.parse('2026-08-17T10:30:00Z') / 1000), url: 'https://x.com/2' }),
      mkItem({ title: 'C', at: Math.floor(Date.parse('2026-08-17T09:30:00Z') / 1000), url: 'https://x.com/3' }),
      mkItem({ title: 'D', at: Math.floor(Date.parse('2026-08-17T09:20:00Z') / 1000), url: 'https://x.com/4' }),
      mkItem({ title: 'E', at: Math.floor(Date.parse('2026-08-17T08:00:00Z') / 1000), url: 'https://x.com/5' }),
    ])
    withRouter(<TodayHeadlines now={NOW} />)
    expect(await screen.findByText('4 new')).toBeInTheDocument()
  })

  it('says nothing about newness on a first visit', async () => {
    await writeSlice('intel:news', [mkItem()])
    withRouter(<TodayHeadlines now={NOW} />)
    expect(await screen.findByLabelText('Headlines')).toBeInTheDocument()
    expect(screen.queryByText(/\bnew\b/)).not.toBeInTheDocument()
  })

  it('falls back to the URL’s host when the desk stored no outlet, and undoes stored entities', async () => {
    await writeSlice('intel:news', [mkItem({ title: 'Nvidia&#x2019;s quarter', source: undefined })])
    withRouter(<TodayHeadlines now={NOW} />)
    expect(await screen.findByText('Nvidia’s quarter')).toBeInTheDocument()
    expect(screen.getByText('reuters.com')).toBeInTheDocument()
  })
})
