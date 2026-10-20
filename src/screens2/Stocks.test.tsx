// Stocks (plan Task 15). Same local-first pattern as Today.test.tsx/
// Board.test.tsx: the network fetchers are mocked (rejecting by default —
// see the note on the mock factory below for why "never resolves" is the
// wrong default here — so every render's real data comes from a seeded
// Dexie cache), and rail data-fetch gating is verified through a
// controllable fake IntersectionObserver that captures each rail's
// `observe()` call so a test can simulate "this rail scrolled into view" by
// hand.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { Quote } from '../../shared/types'
import type { EnginePrediction } from '../lib/api'
import type { BoardSlice } from '../lib/apiViews'
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
// The live ticker is its own tested machinery (useLiveQuotes.test.tsx) — here
// it is a controllable map so the WIRING can be asserted without fake timers.
const liveQuotesMock = vi.hoisted(() => vi.fn(() => ({}) as Record<string, unknown>))
vi.mock('../lib/useLiveQuotes', () => ({ useLiveQuotes: liveQuotesMock }))
// The crypto wire reads the SAME `board` slice Today and the board column do —
// rejecting by default for the same reason as above, so every case below paints
// from whatever the test seeded into Dexie and nothing else.
vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  return { ...actual, getBoardSlice: vi.fn(() => Promise.reject(new Error('not mocked in this test'))) }
})

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

const mkRow = (o: Partial<EnginePrediction> & { sym: string }): EnginePrediction => ({
  id: o.sym,
  side: 'long',
  composite: 58,
  probability: 0.61,
  provisional: false,
  grade: 'C',
  expectedMovePct: 5.4,
  entry: 61_000,
  stop: 57_500,
  target: 68_000,
  capacityPct: 100,
  smallCap: false,
  earningsRisk: false,
  stage: 'trending',
  note: 'crypto cohort — its own calibration, its own 14-bar clock, its own tape',
  riskRung: 3,
  riskPct: 1.25,
  instrument: null,
  paperOnly: true,
  factors: {},
  ...o,
})

/** The board slice, shaped as the view client serves it — only `board` matters
 * to the crypto wire, and every other field is honestly absent. */
const mkBoardSlice = (rows: EnginePrediction[]): BoardSlice => ({
  board: { date: '2026-08-17', generatedAt: Date.now(), regime: 'green', board: rows },
  intradayFlags: null,
  eventRadar: null,
  runStatus: null,
  riskState: null,
  referenceBase: null,
  yesterday: null,
})

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
  liveQuotesMock.mockReturnValue({}) // clearAllMocks keeps implementations — reset the ticker to quiet
  observed = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Stocks', () => {
  it('keeps the opening view focused and reveals sectors on Discover', async () => {
    withRouter()
    expect(screen.getByRole('tab', { name: 'Watchlist' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('region', { name: 'Crypto wire' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Discover' }))
    expect(await screen.findByRole('button', { name: /Technology.*listings/ })).toBeInTheDocument()
    expect(screen.getByText(/Counts are listings/)).toBeInTheDocument()
  })
  it('searches by company name and offers a real stock link', async () => {
    withRouter()
    fireEvent.change(screen.getByLabelText(/search ticker or company/i), { target: { value: 'Apple' } })
    expect(await screen.findByRole('link', { name: /AAPL.*Apple/ })).toHaveAttribute('href', '/app/stock/AAPL')
    expect(screen.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true')
  })
  it('shows six watchlist rows first, with an explicit way to expand', async () => {
    await db.watchlist.bulkPut(Array.from({ length: 8 }, (_, i) => ({ symbol: `TEST${i}`, addedAt: i, riskClass: 'normal' as const })))
    withRouter()
    expect(await screen.findByRole('button', { name: 'View all 8 stocks' })).toBeInTheDocument()
    expect(screen.queryByText('TEST6')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View all 8 stocks' }))
    expect(await screen.findByText('TEST6')).toBeInTheDocument()
  })
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

    it('asks for no WATCHLIST quotes when the watchlist is empty — the crypto wire still gets its pair', async () => {
      // merge of two same-day waves: the dynamism wave wrote "no quotes at
      // all", the crypto wire made BTC/ETH unconditional BY DESIGN ("i dont
      // see any crypto information anywhere"). The composed truth: the only
      // quotes fetch on an empty watchlist is the crypto pair's.
      withRouter()
      expect(await screen.findByText(/your watchlist is empty/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
      for (const call of vi.mocked(getQuotes).mock.calls) {
        expect(call[0]).toEqual(['BTC-USD', 'ETH-USD'])
      }
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
    // owner 2026-08-17: "are the prices of stocks being gathered live now?" —
    // the market-hours ticker (useLiveQuotes) now runs on the WATCHLIST too,
    // not just Today's call cards, and its fresher row beats the slice's.
    it('prefers the live ticker’s quote over the slice’s when both exist', async () => {
      liveQuotesMock.mockReturnValue({ NVDA: mkQuote('NVDA', { price: 129.99, changePct: 0.5 }) })
      await db.watchlist.put({ symbol: 'NVDA', addedAt: 1, riskClass: 'normal' })
      await writeSlice('quotes:NVDA', [mkQuote('NVDA', { price: 128.4, changePct: -1.23 })])
      withRouter()
      expect(await screen.findByText('$129.99')).toBeInTheDocument()
      expect(screen.queryByText('$128.40')).not.toBeInTheDocument()
    })

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
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      expect(getMovers).not.toHaveBeenCalled()
      const region = screen.getByRole('region', { name: 'Top movers' })
      intersect(region)
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
    })

    it('the sectors rail does not fetch until IT is observed as visible, independent of movers', async () => {
      const { getSectors } = await import('../lib/api')
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      expect(getSectors).not.toHaveBeenCalled()
      intersect(screen.getByRole('region', { name: 'Top movers' }))
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
      expect(getSectors).not.toHaveBeenCalled() // still untouched — its own rail was never observed
      intersect(screen.getByRole('region', { name: 'Sectors' }))
      await waitFor(() => expect(getSectors).toHaveBeenCalledTimes(1))
    })

    it('Top movers and Top losers share ONE movers fetch — whichever is observed first is the only call', async () => {
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      intersect(screen.getByRole('region', { name: 'Top losers' }))
      await waitFor(() => expect(getMovers).toHaveBeenCalledTimes(1))
      intersect(screen.getByRole('region', { name: 'Top movers' }))
      // give any stray effect a tick, then confirm no second call landed
      await new Promise(r => setTimeout(r, 0))
      expect(getMovers).toHaveBeenCalledTimes(1)
    })
  })

  // THE CRYPTO WIRE (owner: "i dont see any crpto information anywhere"). The
  // one section on this screen that may never go absent-when-empty: the whole
  // point of it is that the lane is visible on a day it says nothing.
  describe('crypto wire', () => {
    const wire = () => screen.getByRole('region', { name: 'Crypto wire' })

    it('renders with no data at all — heading, both pairs named, and the standing basis line', async () => {
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      const w = wire()
      expect(within(w).getByText('BTC-USD')).toBeInTheDocument()
      expect(within(w).getByText('ETH-USD')).toBeInTheDocument()
      expect(within(w).getByText(/fourteen crypto bars/i)).toBeInTheDocument()
      expect(within(w).getByText(/observation first/i)).toBeInTheDocument()
    })

    it('paints both pairs off ONE crypto quotes slice, and links each to its journey page', async () => {
      await writeSlice('quotes:BTC-USD,ETH-USD', [
        mkQuote('BTC-USD', { name: 'Bitcoin USD', price: 61_240, changePct: 2.4 }),
        mkQuote('ETH-USD', { name: 'Ethereum USD', price: 2_980, changePct: -1.1 }),
      ])
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      const w = wire()
      expect(await within(w).findByText('$61,240')).toHaveClass('num')
      expect(await within(w).findByText('$2,980')).toHaveClass('num')
      expect(within(w).getByText('+2.40%')).toBeInTheDocument()
      expect(within(w).getByText('−1.10%')).toBeInTheDocument()
      expect(within(w).getByRole('link', { name: /BTC-USD/ })).toHaveAttribute('href', '/app/stock/BTC-USD')
    })

    it('never fetches candles for the two pairs — the sparkline is cache-only here', async () => {
      await writeSlice('quotes:BTC-USD,ETH-USD', [mkQuote('BTC-USD'), mkQuote('ETH-USD', { price: 2_980 })])
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      expect(await within(wire()).findByText('$128.40')).toBeInTheDocument()
      expect(getCandles).not.toHaveBeenCalledWith('BTC-USD', '3mo')
      expect(getCandles).not.toHaveBeenCalledWith('ETH-USD', '3mo')
    })

    it('says the lane is quiet when the day HAS a board and no crypto row on it', async () => {
      await writeSlice('board', mkBoardSlice([mkRow({ sym: 'NVDA', cohort: undefined, note: 'trend intact' })]))
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      expect(await within(wire()).findByText(/only speaks when a coin sets up/i)).toBeInTheDocument()
    })

    it('says there is no board yet when the slice resolved without one — not "the lane is quiet"', async () => {
      await writeSlice('board', { ...mkBoardSlice([]), board: null })
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      expect(await within(wire()).findByText(/no board yet/i)).toBeInTheDocument()
      expect(within(wire()).queryByText(/only speaks when a coin sets up/i)).not.toBeInTheDocument()
    })

    // THE ROW-KIND LAW, unchanged by which screen renders it: a near miss
    // cleared no gate, so it carries no letter, no probability and no size.
    it('a crypto nearest miss shows its own reason and NO grade, probability or size', async () => {
      await writeSlice('board', mkBoardSlice([mkRow({ sym: 'BTC-USD', cohort: 'crypto', watchOnly: true, nearMiss: true })]))
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      const w = wire()
      expect(await within(w).findByText(/nearest miss/i)).toBeInTheDocument()
      expect(within(w).getByText(/no grade, no probability and no size/i)).toBeInTheDocument()
      expect(within(w).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
      expect(within(w).queryByText(/61%/)).not.toBeInTheDocument()
      expect(within(w).queryByText(/risk 1\.25%/)).not.toBeInTheDocument()
      expect(within(w).getByText('crypto')).toBeInTheDocument() // which partition it belongs to
    })

    it('a watch-only crypto row says watch — still no grade, no probability, no size', async () => {
      await writeSlice('board', mkBoardSlice([mkRow({ sym: 'ETH-USD', cohort: 'crypto', watchOnly: true })]))
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      const w = wire()
      expect(await within(w).findByText(/watch — no size yet/i)).toBeInTheDocument()
      expect(within(w).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    })

    it('a SIZED crypto row carries its grade and its probability, and its own note behind the disclosure', async () => {
      await writeSlice('board', mkBoardSlice([mkRow({ sym: 'BTC-USD', cohort: 'crypto', grade: 'C', probability: 0.61 })]))
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      const w = wire()
      expect(await within(w).findByLabelText('Grade C')).toBeInTheDocument()
      expect(within(w).getByText(/61% · ~5\.4%/)).toBeInTheDocument()
      expect(within(w).getByText(/why sized like this/i)).toBeInTheDocument()
    })

    // A cohort row is not the only crypto row the board can carry: a legacy row
    // published before the lane stamped its partition is still a coin.
    it('recognises a crypto pair by its SYMBOL even when the row carries no cohort stamp', async () => {
      await writeSlice('board', mkBoardSlice([mkRow({ sym: 'BTC-USD', watchOnly: true, nearMiss: true })]))
      withRouter()
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      expect(await within(wire()).findByText(/nearest miss/i)).toBeInTheDocument()
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
      fireEvent.click(screen.getByRole('tab', { name: 'Markets' }))
      intersect(screen.getByRole('region', { name: 'Top movers' }))
      const addBtn = await screen.findByRole('button', { name: /add pltr to watchlist/i })
      fireEvent.click(addBtn)
      await waitFor(async () => expect(await db.watchlist.get('PLTR')).toBeTruthy())
      expect(mirrorConfig).toHaveBeenCalled()
    })
  })
})
