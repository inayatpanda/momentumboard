// Live quotes (dynamism wave, feature 4). Fake timers throughout, and the
// clock is pinned to a real session hour: every rule this hook enforces is a
// rule about WHEN, and a test that reads the machine's clock would pass on a
// Tuesday afternoon and fail on a Sunday.
//
// 2026-08-17 is a Monday. 15:00 UTC is mid-session for the US; 02:00 UTC is not.

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { writeSlice } from './store'
import type { Quote } from '../../shared/types'

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, getQuotes: vi.fn(async (syms: string[]) => syms.map(s => mkQuote(s, 100))) }
})

import { getQuotes } from './api'
import { IDLE_AFTER_MS, IDLE_INTERVAL_MS, LIVE_INTERVAL_MS, useLiveQuotes } from './useLiveQuotes'

function mkQuote(symbol: string, price: number): Quote {
  return { symbol, price, prevClose: price - 1, changePct: 1, currency: 'USD', todayVolume: 1, asOf: 1_755_000_000, source: 'finnhub' }
}

const OPEN = Date.parse('2026-08-17T15:00:00Z') // Monday, mid-session
const SHUT = Date.parse('2026-08-16T15:00:00Z') // Sunday

function Harness({ symbols }: { symbols: string[] }) {
  const quotes = useLiveQuotes(symbols)
  return <span data-testid="px">{Object.entries(quotes).map(([s, q]) => `${s}:${q.price}`).join('|')}</span>
}

const px = () => screen.getByTestId('px').textContent

/** Let the real macrotask queue drain — Dexie's reads and writes ride
 * `setImmediate`, which stays real here, so a fake-timer advance alone never
 * settles them. */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r))
}
const settle = () => act(async () => void (await flush()))

/** Advance the fake clock in steps SHORTER than the poll beat, settling the
 * awaited chain after each — otherwise one beat fires, its fetch never
 * resolves, and the beat after it is never scheduled. */
const advance = async (ms: number) => {
  const CHUNK = 15_000
  await act(async () => {
    for (let left = ms; left > 0; left -= CHUNK) {
      await vi.advanceTimersByTimeAsync(Math.min(CHUNK, left))
      await flush()
    }
  })
}

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
}

beforeEach(async () => {
  await db.quotes.clear()
  vi.clearAllMocks()
  // `setImmediate` and the microtask queue stay REAL: fake-indexeddb schedules
  // every request on setImmediate, and faking it wedges Dexie (and with it the
  // slice store this hook reads and writes) for the whole file.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(OPEN)
  setVisibility('visible')
})

afterEach(() => {
  vi.useRealTimers()
  setVisibility('visible')
})

describe('useLiveQuotes', () => {
  it('paints whatever the store already holds before any fetch', async () => {
    await writeSlice('quotes:NVDA,AMD', [mkQuote('NVDA', 128.4), mkQuote('AMD', 171.2)])
    render(<Harness symbols={['NVDA', 'AMD']} />)
    await settle()
    expect(px()).toBe('NVDA:128.4|AMD:171.2')
    expect(getQuotes).not.toHaveBeenCalled()
  })

  it('revalidates on the 45s beat while the market is open and the tab is visible', async () => {
    render(<Harness symbols={['NVDA']} />)
    await settle()
    expect(getQuotes).not.toHaveBeenCalled()
    await advance(LIVE_INTERVAL_MS - 1000)
    expect(getQuotes).not.toHaveBeenCalled()
    await advance(1000)
    expect(getQuotes).toHaveBeenCalledTimes(1)
    expect(px()).toBe('NVDA:100')
    await advance(LIVE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(2)
  })

  it('never fetches out of hours — the last close is the answer', async () => {
    vi.setSystemTime(SHUT)
    render(<Harness symbols={['NVDA']} />)
    await advance(LIVE_INTERVAL_MS * 4)
    expect(getQuotes).not.toHaveBeenCalled()
  })

  it('…but a crypto pair trades on a Sunday, and is polled', async () => {
    vi.setSystemTime(SHUT)
    render(<Harness symbols={['BTC-USD']} />)
    await advance(LIVE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(1)
  })

  it('tears the timer down on hide and re-arms on return', async () => {
    render(<Harness symbols={['NVDA']} />)
    await advance(LIVE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    await advance(LIVE_INTERVAL_MS * 5)
    expect(getQuotes).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    setVisibility('visible')
    await advance(LIVE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(2)
  })

  it('respects saveData — a reader who asked to save data asked for this too', async () => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true })
    render(<Harness symbols={['NVDA']} />)
    await advance(LIVE_INTERVAL_MS * 3)
    expect(getQuotes).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true })
  })

  it('backs off to five minutes after ten idle minutes, and speeds up again on a touch', async () => {
    render(<Harness symbols={['NVDA']} />)
    // past the idle threshold AND past the last beat scheduled before it
    await advance(IDLE_AFTER_MS + LIVE_INTERVAL_MS)
    const beforeIdle = vi.mocked(getQuotes).mock.calls.length
    expect(beforeIdle).toBeGreaterThan(10)
    // the next beat is five minutes away, not 45 seconds
    await advance(LIVE_INTERVAL_MS * 2)
    expect(getQuotes).toHaveBeenCalledTimes(beforeIdle)
    await advance(IDLE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(beforeIdle + 1)
    // the reader comes back: full speed on the very next beat
    act(() => void window.dispatchEvent(new Event('pointerdown')))
    await advance(LIVE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(beforeIdle + 2)
  })

  it('keeps the last good paint when a refresh fails', async () => {
    await writeSlice('quotes:NVDA', [mkQuote('NVDA', 128.4)])
    render(<Harness symbols={['NVDA']} />)
    await settle()
    vi.mocked(getQuotes).mockRejectedValueOnce(new Error('offline'))
    await advance(LIVE_INTERVAL_MS)
    expect(px()).toBe('NVDA:128.4')
    // …and the beat survives the failure
    await advance(LIVE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(2)
  })

  it('asks for nothing at all with no symbols, and lets go of the clock on unmount', async () => {
    const { unmount, rerender } = render(<Harness symbols={[]} />)
    await advance(LIVE_INTERVAL_MS * 3)
    expect(getQuotes).not.toHaveBeenCalled()
    rerender(<Harness symbols={['NVDA']} />)
    await advance(LIVE_INTERVAL_MS)
    expect(getQuotes).toHaveBeenCalledTimes(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(LIVE_INTERVAL_MS * 3)
    expect(getQuotes).toHaveBeenCalledTimes(1)
  })
})
