// THE FETCHER IS PINNED TO ITS KEY (final wave, found while proving B1).
//
// `revalidate` awaits its OWN cache read before it invokes the fetcher, so a
// useSlice that reached for `fetcherRef.current` down there picked up whatever
// the newest render had installed — and after an in-place key change that is
// the NEW key's closure, whose payload then lands under the OLD key. StockPage's
// range pills hit this for real: clicking 3mo while the 6mo load sat between its
// two awaits fetched the 3mo series and cached it as `candles:SYM:6mo`, wrong
// bytes under a live key for the full 15-minute TTL. The generation guard cannot
// catch it — that guard gates setState, and this corruption is a WRITE.
//
// The window is held open here by wrapping `revalidate` at exactly the point the
// real one waits, which is the only way to make a race this narrow deterministic.

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => {
  let open!: () => void
  const opened = new Promise<void>(r => (open = r))
  return { opened, release: () => open(), entered: [] as string[] }
})

vi.mock('./store', async importOriginal => {
  const actual = await importOriginal<typeof import('./store')>()
  return {
    ...actual,
    revalidate: async (key: string, fetcher: () => Promise<unknown>, opts?: { force?: boolean }) => {
      gate.entered.push(key)
      await gate.opened
      return actual.revalidate(key, fetcher, opts)
    },
  }
})

import { db } from './db'
import { readSlice } from './store'
import { useSlice } from './useSlice'

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear()])
})

describe('useSlice — the fetcher belongs to the key it was made for', () => {
  it('a key change mid-load never writes the NEW key’s payload under the OLD key', async () => {
    const fetchers: Record<string, () => Promise<{ from: string }>> = {
      'pin:a': async () => ({ from: 'A' }),
      'pin:b': async () => ({ from: 'B' }),
    }
    const { rerender } = renderHook(({ k }: { k: string }) => useSlice(k, fetchers[k]), { initialProps: { k: 'pin:a' } })

    // A's load is now parked inside revalidate, exactly where the real one waits
    await waitFor(() => expect(gate.entered).toContain('pin:a'))
    rerender({ k: 'pin:b' }) // the render that used to swap A's fetcher out from under it
    gate.release()

    await waitFor(async () => expect((await readSlice<{ from: string }>('pin:a'))?.data).toEqual({ from: 'A' }))
    expect((await readSlice<{ from: string }>('pin:b'))?.data).toEqual({ from: 'B' })
  })
})
