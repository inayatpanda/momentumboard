// useSlice (plan Task 8 + CX-4): paint from Dexie immediately, revalidate in
// the background, patch when fresh data lands, flip `offline` when a refresh
// fails while cache exists. The whole local-first feel in one hook.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { invalidateSlices, writeSlice } from './store'
import { useSlice } from './useSlice'

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear()])
})

const never = () => new Promise<never>(() => {})

describe('useSlice', () => {
  it('paints cached data without waiting for the network', async () => {
    await db.slices.put({ key: 'board', data: { cached: true }, fetchedAt: Date.now() - 10 * 60_000 })
    const { result } = renderHook(() => useSlice<{ cached: boolean }>('board', never))
    await waitFor(() => expect(result.current.data).toEqual({ cached: true }))
    expect(result.current.refreshing).toBe(true) // stale → a background refresh is in flight
    expect(result.current.fetchedAt).toBeGreaterThan(0)
  })

  it('patches the screen when the background refresh lands', async () => {
    await db.slices.put({ key: 'board:patch', data: { v: 1 }, fetchedAt: Date.now() - 10 * 60_000 })
    const { result } = renderHook(() => useSlice<{ v: number }>('board:patch', async () => ({ v: 2 })))
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }))
    expect(result.current.refreshing).toBe(false)
    expect(result.current.offline).toBe(false)
  })

  it('keeps stale data and flips offline when the refresh fails', async () => {
    await db.slices.put({ key: 'board:off', data: { v: 1 }, fetchedAt: Date.now() - 10 * 60_000 })
    const { result } = renderHook(() => useSlice<{ v: number }>('board:off', async () => Promise.reject(new Error('net down'))))
    await waitFor(() => expect(result.current.offline).toBe(true))
    expect(result.current.data).toEqual({ v: 1 }) // the whole point of local-first
  })

  it('a fresh cache never triggers the fetcher', async () => {
    await writeSlice('board:fresh', { fresh: true })
    let calls = 0
    const { result } = renderHook(() =>
      useSlice('board:fresh', async () => {
        calls++
        return { fresh: false }
      }),
    )
    await waitFor(() => expect(result.current.data).toEqual({ fresh: true }))
    expect(calls).toBe(0)
  })

  it('invalidateSlices forces a refetch on a mounted slice, and only the matching one', async () => {
    await writeSlice('board:inv', { v: 1 })
    let boardCalls = 0
    let otherCalls = 0
    const { result } = renderHook(() =>
      useSlice('board:inv', async () => {
        boardCalls++
        return { v: 9 }
      }),
    )
    renderHook(() =>
      useSlice('learning-not-invalidated', async () => {
        otherCalls++
        return {}
      }),
    )
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }))
    act(() => invalidateSlices(['board:inv']))
    await waitFor(() => expect(result.current.data).toEqual({ v: 9 }))
    expect(boardCalls).toBe(1)
    expect(otherCalls).toBeLessThanOrEqual(1) // its own mount fetch at most, not the invalidation
  })
})
