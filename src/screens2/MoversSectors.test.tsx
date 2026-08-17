// Movers + Sectors see-all pages (plan Task 16; CX-24). Same local-first
// pattern as Stocks.test.tsx: network fetchers are mocked (rejecting by
// default), every render's real data comes from a seeded Dexie slice via
// `writeSlice`, so `useSlice`'s Dexie-first paint shows it without a network
// round trip.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { MoverRow } from '../lib/api'
import Movers from './Movers'
import Sectors, { rsLegend } from './Sectors'

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
    await screen.findByRole('button', { name: /technology/i })
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

  it('tapping a sector tile promotes its members from links to full rows', async () => {
    await seedSectors()
    withRouter('/app/stocks/sectors', 'sectors')
    await screen.findByRole('button', { name: /technology/i })

    // VISIBILITY WAVE (2026-08-17): the members are on the page from the first
    // paint now — as plain links in the "what's inside" list, which is what the
    // dead two thirds of a desk screen is spent on. Tapping the tile is what
    // turns THIS sector's into full rows.
    expect(screen.getByText('AAPL').closest('.stx-sector-inside-row')).not.toBeNull()
    expect(screen.queryByText('AAPL')!.closest('.stx-row')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /technology/i }))
    expect((await screen.findByText('AAPL')).closest('.stx-row')).not.toBeNull()
    expect(screen.getByText('MSFT')).toBeInTheDocument()
    // …and the whole "what's inside" list steps aside so the open sector is the
    // only thing being read — the other sector's members go with it
    expect(document.querySelector('.stx-sector-inside')).toBeNull()
    expect(screen.queryByText('XOM')).not.toBeInTheDocument()
  })

  // VISIBILITY WAVE (2026-08-17) — the grid printed `5.2` and `-6.0` with no
  // unit and no benchmark anywhere on the page. The wording was verified
  // against computeSectorRows (netlify/functions/lib/sectors.ts) before it was
  // written: sector-ETF return minus SPY's, over N BARS, in percentage points.
  describe('the tiles say what their numbers are', () => {
    it('names the benchmark, the unit and the window', async () => {
      await seedSectors()
      withRouter('/app/stocks/sectors', 'sectors')
      await screen.findByRole('button', { name: /technology/i })
      const legend = document.querySelector('.stx-sector-legend') as HTMLElement
      expect(legend.textContent).toBe("Relative strength over the last 21 sessions — the sector ETF's return minus SPY's, in percentage points.")
    })

    it('rsLegend counts SESSIONS, per period, never calendar time', () => {
      expect(rsLegend('1w')).toContain('last 5 sessions')
      expect(rsLegend('1m')).toContain('last 21 sessions')
      expect(rsLegend('3m')).toContain('last 63 sessions')
    })

    it('the window in the legend follows the toggle', async () => {
      await seedSectors()
      withRouter('/app/stocks/sectors', 'sectors')
      await screen.findByRole('button', { name: /technology/i })
      fireEvent.click(screen.getByRole('button', { name: '3m' }))
      expect(document.querySelector('.stx-sector-legend')!.textContent).toContain('last 63 sessions')
    })
  })

  describe("what's inside each one", () => {
    it('lists every sector with its constituents as links, from the payload', async () => {
      await seedSectors()
      withRouter('/app/stocks/sectors', 'sectors')
      await screen.findByRole('button', { name: /technology/i })
      const inside = document.querySelector('.stx-sector-inside') as HTMLElement
      const names = [...inside.querySelectorAll('.stx-sector-inside-name')].map(n => n.textContent)
      expect(names).toEqual(['Technology', 'Energy'])
      expect(within(inside).getByText('XOM').closest('a')).toHaveAttribute('href', '/app/stock/XOM')
    })

    it('renders no StockRow at all — fifty-five live tapes is the burst sparkCachedOnly exists to prevent', async () => {
      await seedSectors()
      withRouter('/app/stocks/sectors', 'sectors')
      await screen.findByRole('button', { name: /technology/i })
      expect(document.querySelector('.stx-sector-inside .stx-row')).toBeNull()
    })
  })

  it('never renders grade or probability text', async () => {
    await seedSectors()
    withRouter('/app/stocks/sectors', 'sectors')
    await screen.findByRole('button', { name: /technology/i })
    fireEvent.click(screen.getByRole('button', { name: /technology/i }))
    await screen.findByText('AAPL')
    expect(document.body.textContent).not.toMatch(/\bgrade\b/i)
    expect(document.body.textContent).not.toMatch(/\bprobability\b/i)
  })
})
