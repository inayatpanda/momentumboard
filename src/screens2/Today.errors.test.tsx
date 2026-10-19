import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { getBoardSlice, type BoardSlice } from '../lib/apiViews'
import Today from './Today'

vi.mock('../lib/apiViews', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/apiViews')>(),
  getBoardSlice: vi.fn(),
}))
vi.mock('./parts/TodayHeadlines', () => ({ TodayHeadlines: () => null }))
vi.mock('../lib/useLiveQuotes', () => ({ useLiveQuotes: () => ({}) }))

const emptyBoard: BoardSlice = {
  board: { date: '2026-10-19', generatedAt: 1_792_382_400, regime: 'green', board: [] },
  intradayFlags: null, eventRadar: null, runStatus: null, riskState: null,
  referenceBase: null, yesterday: null,
}

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.settings.clear()])
  vi.mocked(getBoardSlice).mockReset()
})

describe('Today request failures', () => {
  it('replaces a failed cold load with an explanation and a working retry', async () => {
    vi.mocked(getBoardSlice).mockRejectedValue(new Error('Service temporarily unavailable'))
    const { container } = render(<Router hook={memoryLocation().hook}><Today /></Router>)
    expect(await screen.findByRole('alert')).toHaveTextContent("Today's board could not load.")
    expect(container.querySelector('.skeleton')).toBeNull()
    vi.mocked(getBoardSlice).mockResolvedValue(emptyBoard)
    fireEvent.click(screen.getByRole('button', { name: 'Retry board' }))
    await screen.findByLabelText('Decision cockpit')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(getBoardSlice).toHaveBeenCalled()
  })

  it('labels the saved board when a background refresh fails', async () => {
    await db.slices.put({ key: 'board', data: emptyBoard, fetchedAt: Date.now() - 200_000 })
    vi.mocked(getBoardSlice).mockRejectedValue(new Error('Service temporarily unavailable'))
    render(<Router hook={memoryLocation().hook}><Today /></Router>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Showing the saved board.')
    expect(screen.getByLabelText('Decision cockpit')).toBeInTheDocument()
  })
})
