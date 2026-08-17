// StockRow's price flash (dynamism wave, feature 4b) — ported from the legacy
// TickerRow, which was the only place in the app that ever showed a price
// moving and which no v2 screen renders.
//
// The row's sparkline slice is mocked away: this file is about the tick, and a
// real `candles:*` fetch would only add noise.

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import type { Quote } from '../../../shared/types'
import { StockRow, monogram } from './StockRow'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, getCandles: vi.fn(() => Promise.reject(new Error('not mocked in this test'))) }
})

const mkQuote = (price: number): Quote => ({
  symbol: 'NVDA',
  price,
  prevClose: 128,
  changePct: 1.2,
  currency: 'USD',
  todayVolume: 1,
  asOf: 1_755_000_000,
  source: 'finnhub',
})

const withRouter = (ui: React.ReactElement) => render(<Router base="/app" hook={memoryLocation({ path: '/app/stocks' }).hook}>{ui}</Router>)
const priceEl = () => screen.getByText(/^\$/)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => vi.useRealTimers())

describe('StockRow price flash', () => {
  it('does not flash the first price a row has ever seen', () => {
    withRouter(<StockRow symbol="NVDA" quote={mkQuote(128.4)} sparkCachedOnly />)
    expect(priceEl().className).toBe('num')
  })

  it('flashes up on a rise, down on a fall, and clears itself', () => {
    const { rerender } = withRouter(<StockRow symbol="NVDA" quote={mkQuote(128.4)} sparkCachedOnly />)
    const row = (price: number) => (
      <Router base="/app" hook={memoryLocation({ path: '/app/stocks' }).hook}>
        <StockRow symbol="NVDA" quote={mkQuote(price)} sparkCachedOnly />
      </Router>
    )

    rerender(row(129.1))
    expect(priceEl()).toHaveClass('flash-up')

    act(() => void vi.advanceTimersByTime(900))
    expect(priceEl().className).toBe('num')

    rerender(row(127.2))
    expect(priceEl()).toHaveClass('flash-down')
    act(() => void vi.advanceTimersByTime(900))
    expect(priceEl().className).toBe('num')
  })

  it('an unchanged price is not a tick', () => {
    const { rerender } = withRouter(<StockRow symbol="NVDA" quote={mkQuote(128.4)} sparkCachedOnly />)
    rerender(
      <Router base="/app" hook={memoryLocation({ path: '/app/stocks' }).hook}>
        <StockRow symbol="NVDA" quote={mkQuote(128.4)} sparkCachedOnly />
      </Router>,
    )
    expect(priceEl().className).toBe('num')
  })
})

// THE MONOGRAM COLLISION (sweep A #32): `slice(0, 2)` made AMD and AMZN both
// "AM", GOOG/GOOGL both "GO". First + last letter of the base symbol keeps
// two characters and separates every collision the sweep named.
describe('monogram', () => {
  it('separates the sweep’s collisions and leaves short symbols whole', () => {
    expect(monogram('AMD')).toBe('AD')
    expect(monogram('AMZN')).toBe('AN')
    expect(monogram('GOOG')).toBe('GG')
    expect(monogram('GOOGL')).toBe('GL')
    expect(monogram('MSFT')).toBe('MT')
    expect(monogram('MU')).toBe('MU')
    expect(monogram('F')).toBe('F')
    // suffixes and quote currencies never reach the tile
    expect(monogram('BTC-USD')).toBe('BC')
    expect(monogram('VOD.L')).toBe('VD')
  })
})

// A LAST-KNOWN-GOOD PRICE MUST SAY SO (S2 concern #3): the server now serves
// `stale: true` with the original asOf instead of a dash when the live fetch
// fails — rendering it indistinguishable from a live tick would be worse than
// the dash it replaced.
describe('stale quotes', () => {
  it('dims a stale price, names it, and never flashes it', () => {
    render(
      <Router hook={memoryLocation({ path: '/' }).hook}>
        <StockRow symbol="AAPL" quote={{ symbol: 'AAPL', price: 232.14, changePct: -0.4, currency: 'USD', asOf: 1786824000, stale: true } as never} sparkCachedOnly />
      </Router>,
    )
    const el = document.querySelector('.stx-row-prices .num') as HTMLElement
    expect(el.className).toContain('stale')
    expect(el.title).toMatch(/last known price/i)
  })
})
