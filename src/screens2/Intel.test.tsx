// Intel (plan Task 19; CX-19) — the paper + news desk + social pulse. Same
// local-first pattern as Movers/StockPage tests: every network fetcher is
// mocked to reject by default, every case paints from a seeded Dexie slice
// via writeSlice. The three sections are independently sliced — this file's
// first job is proving one section's failure (or simply not being seeded)
// never blanks the other two.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { CongressTrade, InsiderCluster, NewsDeskItem, getCongress } from '../lib/api'
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
    getInsiderClusters: vi.fn(notMocked),
    getCongress: vi.fn(notMocked),
  }
})

// `at` is UNIX SECONDS on the desk (src/lib/api.ts:186) — the fixture says so
// on purpose, because the stamp helper decides its unit by magnitude.
const mkNews = (i: number, overrides: Partial<NewsDeskItem> = {}): NewsDeskItem => ({
  title: `Headline ${i}`,
  url: `https://example.com/a${i}`,
  syms: [],
  score: 80 - i,
  why: 'because reasons',
  at: Math.floor(Date.now() / 1000),
  ...overrides,
})

const mkCluster = (overrides: Partial<InsiderCluster> = {}): InsiderCluster => ({
  symbol: 'NVDA',
  buyers: 4,
  totalValueUsd: 1_240_000,
  lastDate: '2026-08-11',
  names: ['A. Officer', 'B. Director'],
  ...overrides,
})

const mkTrade = (overrides: Partial<CongressTrade> = {}): CongressTrade => ({
  politician: 'Jane Doe',
  chamber: 'house',
  symbol: 'NVDA',
  side: 'buy',
  amountRange: '$15,001–$50,000',
  traded: '2026-08-01',
  filed: '2026-08-12',
  ...overrides,
})

type CongressSlice = Awaited<ReturnType<typeof getCongress>>
const seedCongress = (overrides: Partial<CongressSlice> = {}) =>
  writeSlice<CongressSlice>('intel:congress', {
    trades: [],
    watchlistHits: [],
    source: 'quiverquant',
    asOf: 1,
    aggregates: null,
    scorecard: null,
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

  it('one section erroring never blanks the others — seeded news paints while insiders and social stay pending', async () => {
    await writeSlice('intel:news', [mkNews(0), mkNews(1)])
    withRouter()
    expect(await screen.findByText('Headline 0')).toBeInTheDocument()
    expect(screen.getByText('Headline 1')).toBeInTheDocument()
    // the page is not blank — the other two sections show skeleton placeholders, not an error
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: /intel/i })).toBeInTheDocument()
  })

  // THE JUMP RAIL (owner iteration 2): "scrolling is difficult to reach
  // directly to the News desk without scrolling through the entire bulletin."
  describe('the jump chips', () => {
    it('renders one anchor per section, pointing at that section’s id', async () => {
      withRouter()
      const rail = screen.getByRole('navigation', { name: /jump to a section/i })
      const chips = [...rail.querySelectorAll('a')].map(a => [a.textContent?.trim(), a.getAttribute('href')])
      // the paper left for its own tab (owner 2026-08-17) — news leads
      expect(chips).toEqual([
        ['News', '#news'],
        ['Insiders', '#insiders'],
        ['Congress', '#congress'],
        ['Social', '#social'],
      ])
    })

    it('every anchor target actually exists on the page — and the paper is gone', () => {
      withRouter()
      for (const id of ['news', 'insiders', 'congress', 'social']) {
        expect(document.getElementById(id)).not.toBeNull()
      }
      expect(document.getElementById('paper')).toBeNull()
      expect(screen.queryByText(/today.?s paper/i)).not.toBeInTheDocument()
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

    // "News desk doesnt show date of news. It just is a big collection of cards."
    it('stamps every card with when it happened, reading `at` as SECONDS', async () => {
      const twoHoursAgo = Math.floor((Date.now() - 2 * 3_600_000) / 1000)
      await writeSlice('intel:news', [mkNews(0, { at: twoHoursAgo })])
      withRouter()
      await screen.findByText('Headline 0')
      expect(screen.getByText('2h ago')).toBeInTheDocument()
      // read as milliseconds, a seconds stamp dates every headline to 1970
      expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
    })

    // owner 2026-08-17, screenshot of a desk that was 100% "finnhub.io": the
    // url's host is the AGGREGATOR; `source` is the outlet, and it wins
    it('names the publisher from `source`, falling back to the url host only without one', async () => {
      await writeSlice('intel:news', [
        mkNews(0, { title: 'Sourced', url: 'https://finnhub.io/api/news?id=9', source: 'Bloomberg' }),
        mkNews(1, { title: 'Unsourced', url: 'https://example.com/a1' }),
      ])
      withRouter()
      await screen.findByText('Sourced')
      expect(screen.getByText('Bloomberg')).toBeInTheDocument()
      expect(screen.queryByText('finnhub.io')).not.toBeInTheDocument()
      expect(screen.getByText('example.com')).toBeInTheDocument()
    })

    it('sorts newest first regardless of the order the feed arrived in', async () => {
      const now = Math.floor(Date.now() / 1000)
      await writeSlice('intel:news', [
        mkNews(0, { title: 'Older', at: now - 20 * 3_600_000 / 1000 }),
        mkNews(1, { title: 'Newest', at: now - 60 }),
        mkNews(2, { title: 'Middle', at: now - 5 * 3_600_000 / 1000 }),
      ])
      withRouter()
      await screen.findByText('Newest')
      const titles = [...document.querySelectorAll('.itl-news-title')].map(el => el.textContent)
      expect(titles).toEqual(['Newest', 'Middle', 'Older'])
    })
  })

  // INSIDERS (owner iteration 2): "Intel doesnt show insider news/buying".
  describe('insiders', () => {
    it('renders a cluster row: symbol link, buyer count, compact dollars, last date, names', async () => {
      await writeSlice('intel:insiders', { clusters: [mkCluster()], asOf: 1 })
      withRouter()
      const section = document.getElementById('insiders') as HTMLElement
      expect(await within(section).findByText('4 buyers')).toBeInTheDocument()
      expect(within(section).getByText('$1.2M')).toBeInTheDocument()
      expect(within(section).getByText(/11 Aug 2026/)).toBeInTheDocument()
      expect(within(section).getByText('A. Officer, B. Director')).toBeInTheDocument()
      expect(within(section).getByRole('link', { name: 'NVDA' })).toHaveAttribute('href', '/app/stock/NVDA')
    })

    it('says so honestly when the engine has no coverage yet', async () => {
      await writeSlice('intel:insiders', { clusters: [], asOf: 1 })
      withRouter()
      expect(await screen.findByText(/no insider-buying clusters in the engine's coverage yet/i)).toBeInTheDocument()
    })
  })

  // CONGRESS (owner iteration 2): "…congressional things."
  describe('congress', () => {
    it('renders a disclosure row: who, chamber, direction, symbol, amount, dates and the disclosure lag', async () => {
      await seedCongress({ trades: [mkTrade()] })
      withRouter()
      const section = document.getElementById('congress') as HTMLElement
      expect(await within(section).findByText('Jane Doe')).toBeInTheDocument()
      expect(within(section).getByText('house')).toBeInTheDocument()
      expect(within(section).getByText('$15,001–$50,000')).toBeInTheDocument()
      expect(within(section).getByRole('link', { name: 'NVDA' })).toHaveAttribute('href', '/app/stock/NVDA')
      // traded 1 Aug, filed 12 Aug
      expect(within(section).getByText(/01 Aug 2026 · disclosed 11d later/)).toBeInTheDocument()
    })

    // the transaction IS a direction, so it wears the direction colours the
    // rest of the app uses — a bought line and a sold line must never read the
    // same at a glance
    it('colours the buy/sell pill by direction', async () => {
      await seedCongress({ trades: [mkTrade({ side: 'buy' }), mkTrade({ politician: 'John Roe', symbol: 'AMD', side: 'sell' })] })
      withRouter()
      const section = document.getElementById('congress') as HTMLElement
      expect(await within(section).findByText('bought')).toHaveClass('pill', 'long')
      expect(within(section).getByText('sold')).toHaveClass('pill', 'short')
    })

    it('lifts watchlist hits into their own highlighted block on top', async () => {
      await seedCongress({ trades: [mkTrade()], watchlistHits: [mkTrade({ politician: 'Watched Rep', symbol: 'PLTR' })] })
      withRouter()
      await screen.findByText('Watched Rep')
      const hits = document.querySelector('.itl-congress-hits') as HTMLElement
      expect(hits).not.toBeNull()
      expect(within(hits).getByText('Watched Rep')).toBeInTheDocument()
      expect(within(hits).getByText(/on your watchlist/i)).toBeInTheDocument()
    })

    it('renders the aggregates and scorecard lines when the payload carries them', async () => {
      await seedCongress({
        trades: [mkTrade()],
        aggregates: {
          topTickers: [{ symbol: 'NVDA', buys: 12, sells: 2 }, { symbol: 'AAPL', buys: 5, sells: 0 }],
          topPoliticians: [],
          sectorBreakdown: [],
          historyCount: 90,
          since: '2026-05-16',
        },
        scorecard: {
          rows: [{ politician: 'Jane Doe', chamber: 'house', gradedBuys: 6, avgExcessPct: 3.4, hitRate: 0.5, bestCall: { symbol: 'NVDA', excessPct: 9 } }],
          gradedBuys: 24,
          skipped: 3,
          asOf: 1,
        },
      })
      withRouter()
      const section = document.getElementById('congress') as HTMLElement
      expect(await within(section).findByText(/most bought over the last 90 days: NVDA \(12\) · AAPL \(5\)/i)).toBeInTheDocument()
      const graded = within(section).getByText(/graded against SPY so far/i)
      expect(graded).toHaveTextContent(/24 disclosed buys/)
      expect(graded).toHaveTextContent(/Jane Doe/)
      expect(graded).toHaveTextContent(/\+3\.4pp/)
    })

    it('gives the honest fallback when every upstream source is dead', async () => {
      await seedCongress({ source: 'none' })
      withRouter()
      expect(await screen.findByText(/every upstream source is dead or unkeyed/i)).toBeInTheDocument()
    })
  })

  // FAILURE ISOLATION, across all five sections now.
  it('a seeded insiders slice paints while the other four sections stay pending', async () => {
    await writeSlice('intel:insiders', { clusters: [mkCluster({ symbol: 'AMD' })], asOf: 1 })
    withRouter()
    expect(await screen.findByText('4 buyers')).toBeInTheDocument()
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: /intel/i })).toBeInTheDocument()
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
