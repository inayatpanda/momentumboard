// Pull-to-refresh (dynamism wave, feature 3).
//
// jsdom ships no TouchEvent constructor and its `scrollTop` is a no-op, so the
// gestures here are plain Events carrying a `touches` array and the scroll
// position is injected. That is the honest way to drive this hook: what it
// actually consumes is `e.touches[0].clientY` and a number for how far the page
// has scrolled.

import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { readSlice, writeSlice } from './store'
import { PULL_THRESHOLD, usePullRefresh, useSlicesRefresh } from './usePullRefresh'

const touch = (type: string, y: number, fingers = 1) => {
  const e = new Event(type, { bubbles: true })
  Object.defineProperty(e, 'touches', { value: Array.from({ length: fingers }, () => ({ clientY: y })) })
  act(() => void window.dispatchEvent(e))
}
const endTouch = () => act(() => void window.dispatchEvent(new Event('touchend', { bubbles: true })))

function Harness({ onRefresh, scrollTop = () => 0 }: { onRefresh: () => void; scrollTop?: () => number }) {
  const { pull, armed } = usePullRefresh(onRefresh, { scrollTop })
  return (
    <div>
      <span data-testid="pull">{pull}</span>
      <span data-testid="armed">{String(armed)}</span>
    </div>
  )
}

describe('usePullRefresh', () => {
  it('a pull short of the threshold does nothing at all', () => {
    const onRefresh = vi.fn()
    render(<Harness onRefresh={onRefresh} />)
    touch('touchstart', 100)
    touch('touchmove', 100 + PULL_THRESHOLD - 10)
    expect(screen.getByTestId('pull').textContent).toBe(String(PULL_THRESHOLD - 10))
    expect(screen.getByTestId('armed').textContent).toBe('false')
    endTouch()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.getByTestId('pull').textContent).toBe('0')
  })

  it('a pull past the threshold refreshes exactly once, and the indicator resets', () => {
    const onRefresh = vi.fn()
    render(<Harness onRefresh={onRefresh} />)
    touch('touchstart', 100)
    touch('touchmove', 140)
    touch('touchmove', 100 + PULL_THRESHOLD + 5)
    expect(screen.getByTestId('armed').textContent).toBe('true')
    endTouch()
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('pull').textContent).toBe('0')
    // a second touchend with no gesture behind it fires nothing
    endTouch()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('never arms when the page is already scrolled — that gesture is reading', () => {
    const onRefresh = vi.fn()
    render(<Harness onRefresh={onRefresh} scrollTop={() => 320} />)
    touch('touchstart', 100)
    touch('touchmove', 300)
    endTouch()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('cancels mid-gesture if the page scrolls away from the top', () => {
    const onRefresh = vi.fn()
    let top = 0
    render(<Harness onRefresh={onRefresh} scrollTop={() => top} />)
    touch('touchstart', 100)
    touch('touchmove', 300)
    top = 40
    touch('touchmove', 400)
    expect(screen.getByTestId('pull').textContent).toBe('0')
    endTouch()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('an upward drag is not a pull, and a pinch cancels one', () => {
    const onRefresh = vi.fn()
    render(<Harness onRefresh={onRefresh} />)
    touch('touchstart', 300)
    touch('touchmove', 100)
    endTouch()
    expect(onRefresh).not.toHaveBeenCalled()

    touch('touchstart', 100)
    touch('touchmove', 300)
    touch('touchmove', 320, 2) // second finger
    endTouch()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('clamps the indicator so a long drag is still one refresh', () => {
    const onRefresh = vi.fn()
    render(<Harness onRefresh={onRefresh} />)
    touch('touchstart', 0)
    touch('touchmove', 5000)
    expect(Number(screen.getByTestId('pull').textContent)).toBeLessThanOrEqual(120)
    endTouch()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('lets go of the window on unmount', () => {
    const onRefresh = vi.fn()
    const { unmount } = render(<Harness onRefresh={onRefresh} />)
    unmount()
    touch('touchstart', 100)
    touch('touchmove', 300)
    endTouch()
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

function RefreshHarness({ entries }: { entries: { key: string; fetcher: () => Promise<unknown> }[] }) {
  const { refresh, refreshing } = useSlicesRefresh(entries)
  return (
    <button type="button" onClick={refresh}>
      {refreshing ? 'refreshing' : 'idle'}
    </button>
  )
}

describe('useSlicesRefresh', () => {
  beforeEach(async () => {
    await db.slices.clear()
  })
  afterEach(() => vi.restoreAllMocks())

  it('force-fetches every named slice, writes them, and reports busy until they settle', async () => {
    // a FRESH cache — the point of a forced refresh is that it fetches anyway
    await writeSlice('intel:news', [{ old: true }])
    let releaseA: (v: unknown) => void = () => {}
    const a = vi.fn(() => new Promise(r => (releaseA = r)))
    const b = vi.fn(async () => ({ b: 1 }))
    render(<RefreshHarness entries={[{ key: 'intel:news', fetcher: a }, { key: 'intel:social', fetcher: b }]} />)

    expect(screen.getByRole('button').textContent).toBe('idle')
    await act(async () => void screen.getByRole('button').click())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button').textContent).toBe('refreshing')

    releaseA({ fresh: true })
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('idle'))
    expect((await readSlice<{ fresh: boolean }>('intel:news'))?.data.fresh).toBe(true)
  })

  it('a second press mid-flight is not a second round of fetches', async () => {
    let release: (v: unknown) => void = () => {}
    const a = vi.fn(() => new Promise(r => (release = r)))
    render(<RefreshHarness entries={[{ key: 'intel:news', fetcher: a }]} />)
    await act(async () => void screen.getByRole('button').click())
    await act(async () => void screen.getByRole('button').click())
    expect(a).toHaveBeenCalledTimes(1)
    release({})
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('idle'))
  })

  it('stops claiming motion when a refresh fails', async () => {
    const a = vi.fn(async () => {
      throw new Error('offline')
    })
    render(<RefreshHarness entries={[{ key: 'intel:news', fetcher: a }]} />)
    await act(async () => void screen.getByRole('button').click())
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('idle'))
    expect(a).toHaveBeenCalledTimes(1)
  })
})
