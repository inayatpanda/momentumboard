// Intel (plan Task 19; CX-19) — the paper + news desk + social pulse. Same
// local-first pattern as Movers/StockPage tests: every network fetcher is
// mocked to reject by default, every case paints from a seeded Dexie slice
// via writeSlice. The three sections are independently sliced — this file's
// first job is proving one section's failure (or simply not being seeded)
// never blanks the other two.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { NewsDeskItem } from '../lib/api'
import Intel from './Intel'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return {
    ...actual,
    getReportJson: vi.fn(notMocked),
    getReportList: vi.fn(notMocked),
    getNewsDesk: vi.fn(notMocked),
    getSocialPulse: vi.fn(notMocked),
    getTrending: vi.fn(notMocked),
  }
})

const mkNews = (i: number, overrides: Partial<NewsDeskItem> = {}): NewsDeskItem => ({
  title: `Headline ${i}`,
  url: `https://example.com/a${i}`,
  syms: [],
  score: 80 - i,
  why: 'because reasons',
  at: Date.now(),
  ...overrides,
})

const withRouter = (path = '/app/intel') =>
  render(
    <Router base="/app" hook={memoryLocation({ path }).hook}>
      <Switch>
        <Route path="/stock/:sym">{(params: { sym: string }) => <div>Landed on {params.sym}</div>}</Route>
        <Route path="/intel">
          <Intel />
        </Route>
      </Switch>
    </Router>,
  )

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear()])
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Intel', () => {
  it('has a heading containing "Intel"', () => {
    withRouter()
    expect(screen.getByRole('heading', { name: /intel/i })).toBeInTheDocument()
  })

  it('one section erroring never blanks the others — seeded news paints while the paper and social pulse stay pending', async () => {
    await writeSlice('intel:news', [mkNews(0), mkNews(1)])
    withRouter()
    expect(await screen.findByText('Headline 0')).toBeInTheDocument()
    expect(screen.getByText('Headline 1')).toBeInTheDocument()
    // the page is not blank — the other two sections show skeleton placeholders, not an error
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: /intel/i })).toBeInTheDocument()
  })

  describe('the paper', () => {
    it('renders the latest edition inline via a sandboxed srcDoc iframe', async () => {
      await writeSlice('reports', { date: '2026-08-13', at: 1, html: '<h1>The Edition</h1>' })
      withRouter()
      const iframe = await screen.findByTitle(/today.?s paper/i)
      expect(iframe.getAttribute('srcdoc')).toContain('The Edition')
      expect(iframe.getAttribute('sandbox')).toBe('')
      expect(screen.getByText('2026-08-13')).toBeInTheDocument()
    })

    it('tapping an archive date swaps the iframe to that edition', async () => {
      await writeSlice('reports', { date: '2026-08-13', at: 1, html: '<h1>Today edition</h1>' })
      await writeSlice('reports:list', ['2026-08-13', '2026-08-12'])
      await writeSlice('reports:2026-08-12', { date: '2026-08-12', at: 2, html: '<h1>Yesterday edition</h1>' })
      withRouter()

      const first = (await screen.findByTitle(/today.?s paper/i)) as HTMLIFrameElement
      expect(first.getAttribute('srcdoc')).toContain('Today edition')

      fireEvent.click(screen.getByText(/archive/i)) // opens the <details>
      const dateBtn = await screen.findByRole('button', { name: '2026-08-12' })
      fireEvent.click(dateBtn)

      const swapped = await screen.findByTitle(/today.?s paper/i)
      expect(swapped.getAttribute('srcdoc')).toContain('Yesterday edition')
    })
  })

  describe('news desk', () => {
    it('shows headline rows, first 30 then Show more on a 40-item feed', async () => {
      const items = Array.from({ length: 40 }, (_, i) => mkNews(i))
      await writeSlice('intel:news', items)
      withRouter()

      await screen.findByText('Headline 0')
      expect(screen.getAllByText(/^Headline \d+$/)).toHaveLength(30)
      expect(screen.queryByText('Headline 30')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /show more/i }))
      expect(screen.getAllByText(/^Headline \d+$/)).toHaveLength(40)
      expect(screen.getByText('Headline 39')).toBeInTheDocument()
    })

    it('a headline symbol links to /stock/SYM', async () => {
      await writeSlice('intel:news', [mkNews(0, { syms: ['NVDA'] })])
      withRouter()
      const link = await screen.findByRole('link', { name: 'NVDA' })
      expect(link).toHaveAttribute('href', '/app/stock/NVDA')
    })
  })

  describe('social pulse', () => {
    it('renders trending symbols as /stock/SYM links, first 30 then Show more', async () => {
      const pulse = Array.from({ length: 40 }, (_, i) => ({
        sym: `SYM${i}`,
        redditRank: i + 1,
        redditMentions: 10 - i,
        surging: i === 0,
        surgeMultiple: i === 0 ? 3.2 : null,
        stocktwits: false,
        channelNet: null,
        sources: 1,
        onWatchlist: false,
      }))
      await writeSlice('intel:social', { discoveries: [], alsoLoud: ['TSLA'], pulse, at: Date.now() })
      withRouter()

      await screen.findByText('SYM0')
      expect(screen.getAllByText(/^SYM\d+$/)).toHaveLength(30)

      fireEvent.click(screen.getByRole('button', { name: /show more/i }))
      expect(screen.getByText('SYM39')).toBeInTheDocument()

      const link = screen.getByRole('link', { name: /SYM0/ })
      expect(link).toHaveAttribute('href', '/app/stock/SYM0')
    })

    it('shows an empty state, not a blank section, when nothing is loud', async () => {
      await writeSlice('intel:social', { discoveries: [], alsoLoud: [], pulse: [], at: Date.now() })
      withRouter()
      expect(await screen.findByText(/nothing loud/i)).toBeInTheDocument()
    })
  })
})
