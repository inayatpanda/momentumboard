// syncFromServer (DS-10/CX-22) — the launch pull, and the invalidation it owes
// the screens. A pull that changed the watchlist changed what the board is
// about; a v2 screen holding a fresh `board` slice would otherwise sit on the
// OTHER device's day until the slice's TTL ran out. App.tsx's legacy `syncTick`
// remounts the old shell and says nothing to a `useSlice`, which is why the
// invalidation is wired inside sync.ts rather than in any one caller.

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiGet: vi.fn(), getToken: vi.fn((): string | null => 'tok'), isSharedFreeToken: vi.fn(() => false) }))
vi.mock('./api', () => api)

import { db } from './db'
import { writeSlice } from './store'
import { syncFromServer } from './sync'
import { useSlice } from './useSlice'

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear(), db.watchlist.clear(), db.trades.clear(), db.notes.clear(), db.rules.clear()])
  api.apiGet.mockReset()
  api.getToken.mockReturnValue('tok')
})

/** A pull that really changes something: one watchlist name this device lacks. */
const changedPull = () =>
  api.apiGet.mockImplementation(async (path: string) => (path === '/api/config' ? { watchlist: [{ symbol: 'NVDA', riskClass: 'normal' }] } : null))

describe('syncFromServer', () => {
  it('refetches a mounted board slice when the pull changed something', async () => {
    changedPull()
    await writeSlice('board', { v: 'stale-device' }) // FRESH, so nothing refetches on mount
    let calls = 0
    const { result } = renderHook(() =>
      useSlice('board', async () => {
        calls++
        return { v: 'server' }
      }),
    )
    await waitFor(() => expect(result.current.data).toEqual({ v: 'stale-device' }))
    expect(calls).toBe(0)

    await expect(syncFromServer()).resolves.toBe(true)

    await waitFor(() => expect(result.current.data).toEqual({ v: 'server' }))
    expect(calls).toBe(1)
  })

  it('a pull that changed nothing leaves the fresh slice alone', async () => {
    api.apiGet.mockResolvedValue(null)
    await writeSlice('board', { v: 'mine' })
    let calls = 0
    const { result } = renderHook(() =>
      useSlice('board', async () => {
        calls++
        return { v: 'server' }
      }),
    )
    await waitFor(() => expect(result.current.data).toEqual({ v: 'mine' }))

    await expect(syncFromServer()).resolves.toBe(false)

    await new Promise(r => setTimeout(r, 20))
    expect(calls).toBe(0)
    expect(result.current.data).toEqual({ v: 'mine' })
  })

  it('does nothing at all without a token', async () => {
    api.getToken.mockReturnValue(null)
    await expect(syncFromServer()).resolves.toBe(false)
    expect(api.apiGet).not.toHaveBeenCalled()
  })
})
