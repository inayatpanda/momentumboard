// useSlice (plan Task 8 + CX-4): paint from Dexie immediately, revalidate in
// the background, patch when fresh data lands, flip `offline` when a refresh
// fails while cache exists. The whole local-first feel in one hook.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { invalidateSlices, writeSlice } from './store'
import { useSlice } from './useSlice'

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear()])
})

const never = () => new Promise<never>(() => {})

describe('useSlice', () => {
  it('reports a cold server failure and recovers on retry', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Service temporarily unavailable')).mockResolvedValue({ v: 2 })
    const { result } = renderHook(() => useSlice('board:cold-error', fetcher))
    await waitFor(() => expect(result.current.error).toBe('Service temporarily unavailable'))
    expect(result.current.data).toBeNull()
    expect(result.current.refreshing).toBe(false)
    expect(result.current.offline).toBe(false)
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }))
    expect(result.current.error).toBeNull()
  })

  it('clears old ticker data immediately when a new uncached key fails', async () => {
    await writeSlice('journey:OLD', { sym: 'OLD' })
    const { result, rerender } = renderHook(({ k }: { k: string }) => useSlice(k, async () => {
      throw new Error('New ticker unavailable')
    }), { initialProps: { k: 'journey:OLD' } })
    await waitFor(() => expect(result.current.data).toEqual({ sym: 'OLD' }))
    rerender({ k: 'journey:NEW' })
    expect(result.current.data).toBeNull()
    await waitFor(() => expect(result.current.error).toBe('New ticker unavailable'))
    expect(result.current.data).toBeNull()
    expect(result.current.fetchedAt).toBeNull()
  })

  it('keeps a saved board visible while reporting a failed refresh', async () => {
    await db.slices.put({ key: 'board:stale-error', data: { v: 1 }, fetchedAt: Date.now() - 200_000 })
    const { result } = renderHook(() => useSlice('board:stale-error', async () => { throw new Error('Upstream unavailable') }))
    await waitFor(() => expect(result.current.error).toBe('Upstream unavailable'))
    expect(result.current.data).toEqual({ v: 1 })
    expect(result.current.refreshing).toBe(false)
  })

  it('does not let a superseded request replace the latest failure state', async () => {
    let rejectOld!: (error: Error) => void
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
      .mockRejectedValueOnce(new Error('Latest failure'))
    const { result } = renderHook(() => useSlice('board:request-generation', fetcher))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBe('Latest failure'))
    await act(async () => { rejectOld(new TypeError('Old connection failure')) })
    expect(result.current.error).toBe('Latest failure')
    expect(result.current.offline).toBe(false)
  })

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
    const { result } = renderHook(() => useSlice<{ v: number }>('board:off', async () => Promise.reject(new TypeError('Failed to fetch'))))
    await waitFor(() => expect(result.current.offline).toBe(true))
    expect(result.current.data).toEqual({ v: 1 }) // the whole point of local-first
  })

  it('an HTTP failure is not "offline" — the pill is a connectivity claim (walkthrough A2)', async () => {
    await db.slices.put({ key: 'board:http', data: { v: 1 }, fetchedAt: Date.now() - 200_000 })
    const { result } = renderHook(() => useSlice<{ v: number }>('board:http', async () => Promise.reject(new Error('http-404'))))
    // wait for the cached paint (refreshing starts false, so it can't be the marker)
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }))
    await new Promise(r => setTimeout(r, 30)) // let the rejection land
    expect(result.current.offline).toBe(false) // a 404 while online is a server answer, not lost connectivity
    expect(result.current.data).toEqual({ v: 1 }) // the stale paint still stays

    // …but a genuine network rejection (fetch throws TypeError) DOES flip it
    const { result: r2 } = renderHook(() => useSlice<{ v: number }>('board:net', async () => Promise.reject(new TypeError('Failed to fetch'))))
    await waitFor(() => expect(r2.current.offline).toBe(true))
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

  it('an in-place key change never lets the old key’s slow fetch clobber the new key’s data', async () => {
    // The race Task 15 found: `alive` is a single re-armable ref, so a load()
    // continuation from the OLD key could setRec after the key changed.
    let resolveA!: (v: unknown) => void
    const fetchers: Record<string, () => Promise<unknown>> = {
      'board:gen-a': () => new Promise(r => (resolveA = r)),
      'board:gen-b': async () => ({ v: 'B-fresh' }),
    }
    await db.slices.put({ key: 'board:gen-a', data: { v: 'A-stale' }, fetchedAt: Date.now() - 200_000 })
    const { result, rerender } = renderHook(({ k }: { k: string }) => useSlice(k, fetchers[k]), {
      initialProps: { k: 'board:gen-a' },
    })
    await waitFor(() => expect(result.current.data).toEqual({ v: 'A-stale' })) // painted + A's fetch hanging
    rerender({ k: 'board:gen-b' })
    await waitFor(() => expect(result.current.data).toEqual({ v: 'B-fresh' }))
    act(() => resolveA({ v: 'A-late' })) // the old fetch lands late…
    await new Promise(r => setTimeout(r, 40))
    expect(result.current.data).toEqual({ v: 'B-fresh' }) // …and must not win
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
