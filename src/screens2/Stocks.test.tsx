// Stocks (plan Task 15). Same local-first pattern as Today.test.tsx/
// Board.test.tsx: the network fetchers are mocked (rejecting by default —
// see the note on the mock factory below for why "never resolves" is the
// wrong default here — so every render's real data comes from a seeded
// Dexie cache), and rail data-fetch gating is verified through a
// controllable fake IntersectionObserver that captures each rail's
// `observe()` call so a test can simulate "this rail scrolled into view" by
// hand.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { Quote } from '../../shared/types'
import Stocks from './Stocks'

// Defaults REJECT quickly rather than hanging forever: `store.ts`'s inflight
// map is module-level and outlives any one test, so a fetcher that never
// settles leaves a permanent stale entry for its key — the NEXT test to ask
// for that same key (e.g. `candles:NVDA:3mo`, reused across watchlist-row
// cases) gets handed the old, forever-pending promise instead of ever
// calling the fetcher again. A quick rejection lets `revalidate`'s `finally`
// clean the entry up before the next test starts. Individual tests still
// paint from a seeded Dexie cache (the local-first contract), never from
// these resolving.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return {
    ...actual,
    getMovers: vi.fn(notMocked),
    getSectors: vi.fn(notMocked),
    getQuotes: vi.fn(notMocked),
    getCandles: vi.fn(notMocked),
  }
})
vi.mock('../lib/configMirror', () => ({ mirrorConfig: vi.fn() }))

import { getCandles, getMovers, getQuotes, getSectors } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'

const mkQuote = (symbol: string, overrides: Partial<Quote> = {}): Quote => ({
  symbol,
  price: 128.4,
  prevClose: 130,
  changePct: -1.23,
  currency: 'USD',
  todayVolume: 1_000_000,
  asOf: 0,
  source: 'finnhub',
  ...overrides,
})

const mkCandles = (n = 30) =>
  Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000 + i * 86_400, o: 100, h: 102, l: 99, c: 100 + i, v: 1_000_000 }))

// A minimal router: `/stocks` mounts the screen under test, `/stock/:sym`
// stands in for the real (stubbed elsewhere) journey page so a search
// submit's navigation is directly observable.
const withRouter = (path = '/app/stocks') =>
  render(
    <Router base="/app" hook={memoryLocation({ path }).hook}>
      <Switch>
        <Route path="/stock/:sym">{(params: { sym: string }) => <div>Landed on {params.sym}</div>}</Route>
        <Route path="/stocks">
          <Stocks />
        </Route>
      </Switch>
    </Router>,
  )

// A controllable fake IntersectionObserver: records every `observe(el)` call
// alongside the callback the component registered, so a test can fire the
// exact rail's intersection by hand.
let observed: { el: Element; cb: IntersectionObserverCallback }[]
class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    observed.push({ el, cb: this.cb })
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function intersect(el: Element) {
  const entry = observed.find(o => o.el === el)
  if (!entry) throw new Error('element was never observed')
  act(() => {
    entry.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], entry as unknown as IntersectionObserver)
  })
}

beforeEach(async () => {
  await Promise.all([db.watchlist.clear(), db.slices.clear(), db.quotes.clear(), db.candles.clear()])
  vi.clearAllMocks()
  observed = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Stocks', () => {
  it('has a heading containing "Stocks"', () => {
    withRouter()
    expect(screen.getByRole('heading', { name: /stocks/i })).toBeInTheDocument()
  })

  // THE TIME-AWARENESS LINE (dynamism wave). Stocks holds no board slice, so
  // it gets the session half alone — never a fabricated stamp.
  it('renders the session line under the heading, with no board stamp', () => {
    withRouter()
    const line = document.querySelector('.session-line')
    expect(line?.textContent).toMatch(/^US /)
    expect(line?.textContent).not.toContain('board struck')
  })

  // WIRED REFRESH (dynamism wave). This screen's slices all live in children,
  // so the screen names their keys and forces them together. The gesture itself
  // is covered in src/lib/usePullRefresh.test.tsx; this is the seam.
  describe('the refresh affordance', () => {
    it('force-fetches the rails’ slices — even ones no rail has scrolled to', async () => {
      withRouter()
      fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
      expect(getSectors).toHaveBeenCalledTimes(1)
    })

    it('includes the watchlist’s quote batch when there is a watchlist', async () => {
      await db.watchlist.bulkPut([{ symbol: 'NVDA', addedAt: 1, riskClass: 'normal' }])
      withRouter()
      expect(await screen.findByText('NVDA')).toBeInTheDocument()
      vi.clearAllMocks()
      fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
      await waitFor(() => expect(getQuotes).toHaveBeenCalledWith(['NVDA']))
    })

    it('asks the API for nothing when the watchlist is empty', async () => {
      withRouter()
      expect(await screen.findByText(/your watchlist is empty/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
      expect(getQuotes).not.toHaveBeenCalled()
    })
  })

  describe('search', () => {
    it('submitting a valid ticker navigates to /stock/SYM, uppercased', async () => {
      withRouter()
      fireEvent.change(screen.getByLabelText(/search ticker/i), { target: { value: 'nvda' } })
      fireEvent.click(screen.getByRole('button', { name: /search/i }))
      expect(await screen.findByText('Landed on NVDA')).toBeInTheDocument()
    })

    it('rejects a string outside [A-Za-z0-9.-]{1,12} and does not navigate', () => {
      withRouter()
      fireEvent.change(screen.getByLabelText(/search ticker/i), { target: { value: 'BAD SYM!' } })
      fireEvent.click(screen.getByRole('button', { name: /search/i }))
      expect(screen.getByText(/enter a valid ticker/i)).toBeInTheDocument()
      expect(screen.queryByText(/^landed on/i)).not.toBeInTheDocument()
    })
  })

  describe('watchlist rows', () => {
    it('renders from seeded Dexie watchlist plus a seeded quotes slice', async () => {
      await db.watchlist.bulkPut([
        { symbol: 'NVDA', addedAt: 1, riskClass: 'normal' },
        { symbol: 'AMD', addedAt: 2, riskClass: 'normal' },
      ])
      await writeSlice('quotes:AMD,NVDA', [mkQuote('AMD', { price: 172.5, changePct: 1.47 }), mkQuote('NVDA', { price: 128.4, changePct: -1.23 })])
      withRouter()
      expect(await screen.findByText('AMD')).toBeInTheDocument()
      expect(screen.getByText('NVDA')).toBeInTheDocument()
      expect(await screen.findByText('$172.50')).toHaveClass('num')
      expect(await screen.findByText('$128.40')).toHaveClass('num')
    })

    it('renders rows from the quotes batch without waiting on any candle slice', async () => {
      await db.watchlist.put({ symbol: 'NVDA', addedAt: 1, riskClass: 'normal' })
      await writeSlice('quotes:NVDA', [mkQuote('NVDA')])
      withRouter()
      expect(await screen.findByText('NVDA')).toBeInTheDocument()
      expect(await screen.findByText('$128.40')).toBeInTheDocument()
      // no candle slice was ever seeded, and getCandles's default mock
      // rejects rather than resolving — the row must not be sitting behind it
      expect(document.querySelector('svg.spark')).not.toBeInTheDocument()
      expect(getCandles).toHaveBeenCalledWith('NVDA', '3mo')
    })

    it('shows an empty-watchlist line once Dexie has resolved with nothing', async () => {
      withRouter()
      expect(await screen.findByText(/your watchlist is empty/i)).toBeInTheDocument()
    })

    // B1: the one shape every `candles:*` record now holds — the whole
    // `{candles, quote}` payload getCandles returns, exactly what StockPage's
    // chart slice writes under this very key. A row must paint its sparkline
    // straight off it, and must not re-fetch a record that is already fresh.
    it('paints the sparkline from a cached {candles, quote} record without a second fetch', async () => {
      await db.watchlist.put({ symbol: 'NVDA', addedAt: 1, riskClass: 'normal' })
      await writeSlice('quotes:NVDA', [mkQuote('NVDA')])
      await writeSlice('candles:NVDA:3mo', { candles: mkCandles(), quote: mkQuote('NVDA') })
      withRouter()
      expect(await screen.findByText('NVDA')).toBeInTheDocument()
      await waitFor(() => expect(document.querySelector('svg.spark')).toBeInTheDocument())
      expect(getCandles).not.toHaveBeenCalled()
    })
  })

  describe('rail lazy loading', () => {
    it('does not call the movers fetcher until a movers/losers rail is observed as visible', async () => {
      withRouter()
      expect(getMovers).not.toHaveBeenCalled()
      const region = screen.getByRole('region', { name: 'Top movers' })
      intersect(region)
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
    })

    it('the sectors rail does not fetch until IT is observed as visible, independent of movers', async () => {
      const { getSectors } = await import('../lib/api')
      withRouter()
      expect(getSectors).not.toHaveBeenCalled()
      intersect(screen.getByRole('region', { name: 'Top movers' }))
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
      expect(getSectors).not.toHaveBeenCalled() // still untouched — its own rail was never observed
      intersect(screen.getByRole('region', { name: 'Sectors' }))
      await waitFor(() => expect(getSectors).toHaveBeenCalledTimes(1))
    })

    it('Top movers and Top losers share ONE movers fetch — whichever is observed first is the only call', async () => {
      withRouter()
      intersect(screen.getByRole('region', { name: 'Top losers' }))
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
      intersect(screen.getByRole('region', { name: 'Top movers' }))
      // give any stray effect a tick, then confirm no second call landed
      await new Promise(r => setTimeout(r, 0))
      expect(getMovers).toHaveBeenCalledTimes(1)
    })
  })

  describe('watchlist edits', () => {
    it('remove deletes the Dexie row and calls mirrorConfig', async () => {
      await db.watchlist.put({ symbol: 'NVDA', addedAt: 1, riskClass: 'normal' })
      await writeSlice('quotes:NVDA', [mkQuote('NVDA')])
      withRouter()
      const removeBtn = await screen.findByRole('button', { name: /remove nvda/i })
      fireEvent.click(removeBtn)
      await waitFor(() => expect(screen.queryByText('NVDA')).not.toBeInTheDocument())
      expect(mirrorConfig).toHaveBeenCalled()
      expect(await db.watchlist.get('NVDA')).toBeUndefined()
    })

    it('adding a mover from the rail writes it to Dexie and calls mirrorConfig', async () => {
      vi.mocked(getMovers).mockResolvedValueOnce({
        gainers: [{ sym: 'PLTR', price: 42.1, capUsdM: 1000, changePct: 5.2, name: 'Palantir', stage: null }],
        losers: [],
        actives: [],
        at: Date.now(),
      })
      withRouter()
      intersect(screen.getByRole('region', { name: 'Top movers' }))
      const addBtn = await screen.findByRole('button', { name: /add pltr to watchlist/i })
      fireEvent.click(addBtn)
      await waitFor(async () => expect(await db.watchlist.get('PLTR')).toBeTruthy())
      expect(mirrorConfig).toHaveBeenCalled()
    })
  })
})
