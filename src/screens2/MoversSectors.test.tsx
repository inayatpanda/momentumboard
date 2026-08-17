// Movers + Sectors see-all pages (plan Task 16; CX-24). Same local-first
// pattern as Stocks.test.tsx: network fetchers are mocked (rejecting by
// default), every render's real data comes from a seeded Dexie slice via
// `writeSlice`, so `useSlice`'s Dexie-first paint shows it without a network
// round trip.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { MoverRow } from '../lib/api'
import Movers from './Movers'
import Sectors from './Sectors'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return {
    ...actual,
    getMovers: vi.fn(notMocked),
    getSectors: vi.fn(notMocked),
    getCandles: vi.fn(notMocked),
  }
})

const mkMover = (sym: string, changePct: number, overrides: Partial<MoverRow> = {}): MoverRow => ({
  sym,
  price: 100,
  capUsdM: 5000,
  changePct,
  name: `${sym} Inc`,
  stage: null,
  ...overrides,
})

const withRouter = (path: string, screen2: 'movers' | 'sectors') =>
  render(
    <Router base="/app" hook={memoryLocation({ path }).hook}>
      <Switch>
        <Route path="/stock/:sym">{(params: { sym: string }) => <div>Landed on {params.sym}</div>}</Route>
        <Route path="/stocks/movers">
          <Movers />
        </Route>
        <Route path="/stocks/sectors">
          <Sectors />
        </Route>
      </Switch>
    </Router>,
  )

beforeEach(async () => {
  await Promise.all([db.watchlist.clear(), db.slices.clear(), db.quotes.clear(), db.candles.clear()])
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // the reorder case spies on Element.prototype.getBoundingClientRect — a
  // prototype spy that outlived its test would measure every later one
  vi.restoreAllMocks()
})

describe('Movers', () => {
  it('has a heading containing "Movers"', () => {
    withRouter('/app/stocks/movers', 'movers')
    expect(screen.getByRole('heading', { name: /movers/i })).toBeInTheDocument()
  })

  it('toggle switches between gainers and losers lists', async () => {
    await writeSlice('movers', {
      gainers: [mkMover('GAINR', 5.1)],
      losers: [mkMover('LOSER', -4.2)],
      actives: [],
      at: Date.now(),
    })
    withRouter('/app/stocks/movers', 'movers')

    expect(await screen.findByText('GAINR')).toBeInTheDocument()
    expect(screen.queryByText('LOSER')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /losers/i }))
    expect(await screen.findByText('LOSER')).toBeInTheDocument()
    expect(screen.queryByText('GAINR')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /gainers/i }))
    expect(await screen.findByText('GAINR')).toBeInTheDocument()
    expect(screen.queryByText('LOSER')).not.toBeInTheDocument()
  })

  it('windowing: shows the first 40 rows, "Show more" reveals the rest', async () => {
    const gainers = Array.from({ length: 45 }, (_, i) => mkMover(`SYM${i}`, 1))
    await writeSlice('movers', { gainers, losers: [], actives: [], at: Date.now() })
    withRouter('/app/stocks/movers', 'movers')

    await screen.findByText('SYM0')
    expect(screen.getAllByText(/^SYM\d+$/)).toHaveLength(40)
    expect(screen.queryByText('SYM40')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(screen.getAllByText(/^SYM\d+$/)).toHaveLength(45)
    expect(screen.getByText('SYM44')).toBeInTheDocument()
  })

  // D3: forty rows, each of which USED to own a `candles:SYM:3mo` slice and
  // fetch it — forty parallel requests for decoration, on a screen the reader
  // opened to scan names. Cached-only now: a name already charted elsewhere
  // still draws for free, and nothing else goes near the network.
  it('renders forty rows without a single candle fetch, and still draws a cached sparkline', async () => {
    const { getCandles } = await import('../lib/api')
    const gainers = Array.from({ length: 45 }, (_, i) => mkMover(`SYM${i}`, 1))
    await writeSlice('movers', { gainers, losers: [], actives: [], at: Date.now() })
    // one name the app happens to have charted already
    await writeSlice('candles:SYM3:3mo', {
      candles: Array.from({ length: 30 }, (_, i) => ({ t: 1_700_000_000 + i * 86_400, o: 100, h: 102, l: 99, c: 100 + i, v: 1_000_000 })),
    })
    withRouter('/app/stocks/movers', 'movers')

    await screen.findByText('SYM0')
    expect(screen.getAllByText(/^SYM\d+$/)).toHaveLength(40)
    await waitFor(() => expect(document.querySelectorAll('svg.spark')).toHaveLength(1)) // only the cached one
    expect(getCandles).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(screen.getAllByText(/^SYM\d+$/)).toHaveLength(45)
    expect(getCandles).not.toHaveBeenCalled()
  })

  it('never renders grade or probability text', async () => {
    await writeSlice('movers', { gainers: [mkMover('GAINR', 5.1)], losers: [mkMover('LOSER', -4.2)], actives: [], at: Date.now() })
    withRouter('/app/stocks/movers', 'movers')
    await screen.findByText('GAINR')
    expect(document.body.textContent).not.toMatch(/\bgrade\b/i)
    expect(document.body.textContent).not.toMatch(/\bprobability\b/i)
  })

  // REORDER MOTION (dynamism wave, feature 8). jsdom lays nothing out, so the
  // ruler here is DOM order: a row's top is its index among its siblings. The
  // hook's own rules — the invert arithmetic, reduced motion, arriving rows —
  // are pinned in src/lib/useFlip.test.tsx.
  it('slides the rows when a refresh re-ranks them', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const i = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0
      return { top: i * 50, left: 0, right: 0, bottom: i * 50 + 50, width: 0, height: 50, x: 0, y: i * 50, toJSON: () => ({}) } as DOMRect
    })
    const at = Date.now()
    await writeSlice('movers', { gainers: [mkMover('AAA', 5.1), mkMover('BBB', 4.2), mkMover('CCC', 3.3)], losers: [], actives: [], at })
    withRouter('/app/stocks/movers', 'movers')
    expect(await screen.findByText('AAA')).toBeInTheDocument()

    // the same three names, re-ranked — the mounted slice repaints off the
    // store's own write announcement
    await writeSlice('movers', { gainers: [mkMover('CCC', 9.1), mkMover('AAA', 5.1), mkMover('BBB', 4.2)], losers: [], actives: [], at: at + 1 })
    await waitFor(() => {
      const first = document.querySelector('.stx-watchlist > *')
      expect(first?.getAttribute('data-flip-key')).toBe('CCC')
    })
    const climbed = document.querySelector<HTMLElement>('[data-flip-key="CCC"]')!
    expect(climbed).toHaveClass('flip-move')
    expect(climbed.style.transform).toBe('translate(0px, 100px)') // it came from two rows down
  })

  it('null price renders dash, not fabricated $0.00 or pill', async () => {
    await writeSlice('movers', {
      gainers: [mkMover('NULLPX', 0, { price: null, changePct: null })],
      losers: [],
      actives: [],
      at: Date.now(),
    })
    withRouter('/app/stocks/movers', 'movers')

    await screen.findByText('NULLPX')
    // Should show dash, not $0.00
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('$0.00')
    // Should not render a pill with false +0.00%
    expect(document.body.textContent).not.toContain('+0.00%')
    expect(document.querySelector('.pill')).not.toBeInTheDocument()
  })
})

describe('Sectors', () => {
  const seedSectors = () =>
    writeSlice('sectors', {
      rows: [
        { sym: 'XLK', name: 'Technology', rs5: 1.1, rs21: 2.2, rs63: 3.3, trend: 'in' as const, members: ['AAPL', 'MSFT'] },
        { sym: 'XLE', name: 'Energy', rs5: -0.5, rs21: -1.5, rs63: -2.5, trend: 'out' as const, members: ['XOM', 'CVX'] },
      ],
      rotatingIn: ['Technology'],
      rotatingOut: ['Energy'],
      at: Date.now(),
    })

  it('has a heading containing "Sectors"', () => {
    withRouter('/app/stocks/sectors', 'sectors')
    expect(screen.getByRole('heading', { name: /sectors/i })).toBeInTheDocument()
  })

  it('shows the CX-24 1w/1m/3m period toggle, never day/week', async () => {
    await seedSectors()
    withRouter('/app/stocks/sectors', 'sectors')
    await screen.findByText('Technology')
    expect(screen.getByRole('button', { name: '1w' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1m' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '3m' })).toBeInTheDocument()
    expect(screen.queryByText(/\bday\b/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/\bweek\b/i)).not.toBeInTheDocument()
  })

  it('period toggle changes which rs value renders (rs5/rs21/rs63)', async () => {
    await seedSectors()
    withRouter('/app/stocks/sectors', 'sectors')

    // default period is 1m -> rs21
    expect(await screen.findByText('2.2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '1w' }))
    expect(await screen.findByText('1.1')).toBeInTheDocument()
    expect(screen.queryByText('2.2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '3m' }))
    expect(await screen.findByText('3.3')).toBeInTheDocument()
    expect(screen.queryByText('1.1')).not.toBeInTheDocument()
  })

  it('tapping a sector tile reveals its real member symbols', async () => {
    await seedSectors()
    withRouter('/app/stocks/sectors', 'sectors')
    await screen.findByText('Technology')

    expect(screen.queryByText('AAPL')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /technology/i }))
    expect(await screen.findByText('AAPL')).toBeInTheDocument()
    expect(screen.getByText('MSFT')).toBeInTheDocument()
    // the other sector's members stay hidden
    expect(screen.queryByText('XOM')).not.toBeInTheDocument()
  })

  it('never renders grade or probability text', async () => {
    await seedSectors()
    withRouter('/app/stocks/sectors', 'sectors')
    await screen.findByText('Technology')
    fireEvent.click(screen.getByRole('button', { name: /technology/i }))
    await screen.findByText('AAPL')
    expect(document.body.textContent).not.toMatch(/\bgrade\b/i)
    expect(document.body.textContent).not.toMatch(/\bprobability\b/i)
  })
})
