// The paper — its own page (owner 2026-08-17: "a new fresh tab, move… just
// the Today paper"). The collapsed-summary behaviour died with Intel's paper
// section: here the edition IS the page, so it mounts OPEN. Same local-first
// harness as Intel's tests: fetchers rejected, cases paint from seeded Dexie.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import Paper2 from './Paper2'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return {
    ...actual,
    getReportJson: vi.fn(notMocked),
    getReportList: vi.fn(notMocked),
    getBulletins: vi.fn(notMocked),
    getBulletinJson: vi.fn(notMocked),
  }
})

function withRouter() {
  const { hook } = memoryLocation({ path: '/app/more/paper' })
  render(
    <Router base="/app" hook={hook}>
      <Paper2 />
    </Router>,
  )
}

beforeEach(async () => {
  await db.slices.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Paper2', () => {
  it('mounts the edition OPEN — a sandboxed srcDoc iframe with no tap needed', async () => {
    await writeSlice('reports', { date: '2026-08-13', at: 1, html: '<h1>The Edition</h1>' })
    withRouter()
    expect(screen.getByRole('heading', { name: /the paper/i })).toBeInTheDocument()
    const iframe = await screen.findByTitle(/today.?s paper/i)
    expect(iframe.getAttribute('srcdoc')).toContain('The Edition')
    expect(iframe.getAttribute('sandbox')).toBe('')
    expect(screen.getByText('2026-08-13')).toBeInTheDocument()
  })

  it('tapping an archive date swaps the iframe to that edition', async () => {
    await writeSlice('reports', { date: '2026-08-13', at: 1, html: '<h1>Today edition</h1>' })
    await writeSlice('reports:list', ['2026-08-13', '2026-08-12'])
    await writeSlice('reports:2026-08-12', { date: '2026-08-12', at: 2, html: '<h1>Yesterday edition</h1>' })
    withRouter()

    const first = (await screen.findByTitle(/today.?s paper/i)) as HTMLIFrameElement
    expect(first.getAttribute('srcdoc')).toContain('Today edition')

    fireEvent.click(screen.getByText(/archive/i)) // opens the <details>
    const dateBtn = await screen.findByRole('button', { name: '2026-08-12' })
    fireEvent.click(dateBtn)

    const swapped = await screen.findByTitle(/today.?s paper/i)
    expect(swapped.getAttribute('srcdoc')).toContain('Yesterday edition')
  })

  it('the archive list fetch stays deferred until the details is opened', async () => {
    const api = await import('../lib/api')
    await writeSlice('reports', { date: '2026-08-13', at: 1, html: '<h1>The Edition</h1>' })
    withRouter()
    await screen.findByTitle(/today.?s paper/i)
    expect(api.getReportList).not.toHaveBeenCalled()
  })

  it('switches to the latest evening report and keeps its archive separate from pre-market', async () => {
    await writeSlice('reports', { date: '2026-08-13', at: 1, html: '<h1>Morning edition</h1>' })
    await writeSlice('bulletins:list', [
      { date: '2026-08-13', kind: 'evening' },
      { date: '2026-08-13', kind: 'premarket' },
      { date: '2026-08-12', kind: 'evening' },
    ])
    await writeSlice('reports:evening:2026-08-13', {
      kind: 'evening',
      date: '2026-08-13',
      at: 1_765_641_900,
      subject: 'Evening report',
      text: 'The session',
      html: '<h1>Evening edition</h1>',
    })
    await writeSlice('reports:evening:2026-08-12', {
      kind: 'evening',
      date: '2026-08-12',
      at: 1_765_555_500,
      subject: 'Earlier evening report',
      text: 'Earlier session',
      html: '<h1>Earlier evening edition</h1>',
    })
    withRouter()

    fireEvent.click(screen.getByRole('tab', { name: /evening/i }))
    const latest = await screen.findByTitle('Evening report')
    expect(latest.getAttribute('srcdoc')).toContain('Evening edition')
    expect(screen.getByText(/Published .* UK/)).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Archive · 2 editions/i))
    expect(screen.getByRole('button', { name: '2026-08-12' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '2026-08-13' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '2026-08-12' }))
    expect((await screen.findByTitle('Evening report')).getAttribute('srcdoc')).toContain('Earlier evening edition')
  })

  it('shows a clear empty state when an edition has never published', async () => {
    await writeSlice('reports', { date: '2026-08-13', at: 1, html: '<h1>Morning edition</h1>' })
    await writeSlice('bulletins:list', [])
    withRouter()
    fireEvent.click(screen.getByRole('tab', { name: /pre-market/i }))
    expect(await screen.findByText(/No pre-market brief has been published yet/i)).toBeInTheDocument()
  })
})
