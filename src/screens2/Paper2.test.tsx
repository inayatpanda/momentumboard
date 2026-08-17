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
  return { ...actual, getReportJson: vi.fn(notMocked), getReportList: vi.fn(notMocked) }
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
})
