// The desktop desk (plan Task 22 + DS-18): at ≥1200px the shell becomes a
// three-column master–detail grid — rail | board column | detail pane — and
// the ROUTED screen renders inside the pane. Below 1200px nothing changes.
//
// jsdom ships no matchMedia (verified: `typeof window.matchMedia === 'undefined'`),
// so every desk case installs a width-aware stub; the phone case leaves it
// undefined on purpose, which is exactly the state the existing AppShell tests
// run in — the desk must stay unmounted for them.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { BoardSlice } from '../lib/apiViews'
import type { EnginePrediction } from '../lib/api'
import AppShell from './AppShell'

// Every network getter the desk can reach is a never-resolving promise: the
// screens paint from Dexie (local-first) and nothing escapes to fetch. The
// four drawer fetchers are spies so "lazy" can be asserted as a fact.
const spies = vi.hoisted(() => ({
  getSeasonality: vi.fn(() => new Promise<never>(() => {})),
  getSmartMoney: vi.fn(() => new Promise<never>(() => {})),
  getEventDossiers: vi.fn(() => new Promise<never>(() => {})),
  getCandles: vi.fn(() => new Promise<never>(() => {})),
  getNews: vi.fn(() => new Promise<never>(() => {})),
}))

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, ...spies }
})

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  const never = () => new Promise<never>(() => {})
  return { ...actual, getBoardSlice: never, getFunnel: never, getJourney: never, getVerdict: never, getLearning: never }
})

const FACTOR_NAMES = ['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as const
const emptyFactors = () => Object.fromEntries(FACTOR_NAMES.map(n => [n, { score: null, detail: '', weight: 0 }])) as EnginePrediction['factors']

function mkRow(overrides: Partial<EnginePrediction> = {}): EnginePrediction {
  return {
    id: 'r1',
    sym: 'NVDA',
    name: 'NVIDIA',
    side: 'long',
    composite: 62,
    probability: 0.62,
    provisional: false,
    grade: 'A',
    expectedMovePct: 4.3,
    entry: 128.4,
    stop: 121.1,
    target: 141,
    capacityPct: 100,
    smallCap: false,
    earningsRisk: false,
    stage: 'trending',
    note: 'test note',
    riskRung: 3,
    riskPct: 1.25,
    instrument: null,
    paperOnly: false,
    factors: emptyFactors(),
    ...overrides,
  }
}

const mkBoardData = (board: EnginePrediction[], date = '2026-08-14'): BoardSlice => ({
  board: { date, generatedAt: Date.now(), regime: 'green', board },
  intradayFlags: null,
  eventRadar: null,
  runStatus: null,
  riskState: null,
  referenceBase: null,
  yesterday: null,
})

/** A width-aware matchMedia + innerWidth, the way a real browser reports them. */
function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query)
      return {
        media: query,
        matches: min ? width >= Number(min[1]) : false,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }
    },
  })
}

const boardColumn = () => screen.findByRole('complementary', { name: /board column/i })

beforeEach(async () => {
  await db.slices.clear()
  await db.candles.clear()
  await writeSlice('board', mkBoardData([mkRow()]))
  // the board column reads window.location.hash (D2) — leave no hash behind
  window.history.pushState(null, '', '/app/')
  for (const s of Object.values(spies)) s.mockClear()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('DeskLayout — the desktop master–detail desk', () => {
  // Owner review of the first DMG: the column beside Today duplicated the same
  // cards twice. The column now earns its place ONLY beside a journey pane.
  it('at 1440px on Today: rail + FULL-WIDTH pane, no board column', async () => {
    setViewport(1440)
    render(<AppShell locationHook={memoryLocation({ path: '/app/' }).hook} />)

    const pane = screen.getByRole('main')
    expect(await within(pane).findByRole('heading', { name: /today/i })).toBeInTheDocument()
    const grid = document.querySelector('.desk2')
    expect(grid).not.toBeNull()
    expect(grid!.classList.contains('desk2-wide')).toBe(true)
    expect(screen.queryByRole('complementary', { name: /board column/i })).toBeNull()
    // the rail is the EXISTING Nav, placed by the grid — not a second copy
    expect(grid!.querySelectorAll('.v2-nav')).toHaveLength(1)
    expect(grid!.querySelector('.desk2-rail .v2-nav')).not.toBeNull()
  })

  it('at 1440px on a stock page: three regions — rail, board column, journey pane', async () => {
    setViewport(1440)
    render(<AppShell locationHook={memoryLocation({ path: '/app/stock/NVDA' }).hook} />)

    const col = await boardColumn()
    const grid = document.querySelector('.desk2')!
    expect(grid.classList.contains('desk2-wide')).toBe(false)
    expect(grid.contains(col)).toBe(true)
    const pane = screen.getByRole('main')
    expect(await within(pane).findByRole('heading', { name: /NVDA/ }, { timeout: 5000 })).toBeInTheDocument()
  })

  it('at 390px there is no desk grid and the nav stays the bottom tab bar', async () => {
    setViewport(390)
    render(<AppShell locationHook={memoryLocation({ path: '/app/' }).hook} />)

    expect(await screen.findByRole('heading', { name: /today/i })).toBeInTheDocument()
    expect(document.querySelector('.desk2')).toBeNull()
    expect(screen.queryByRole('complementary', { name: /board column/i })).toBeNull()
    const nav = screen.getByRole('navigation')
    expect([...nav.querySelectorAll('.v2-tab-label')].map(el => el.textContent?.trim())).toEqual([
      'Today',
      'Stocks',
      'Intel',
      'Track record',
      'More',
    ])
  })

  it('DS-18: a row click NAVIGATES and the board column survives — same DOM node, same scroll', async () => {
    setViewport(1440)
    // start on a stock page: that's where the column lives now
    render(<AppShell locationHook={memoryLocation({ path: '/app/stock/AAPL', record: true }).hook} />)

    const col = await boardColumn()
    col.scrollTop = 137
    const row = await within(col).findByText('NVDA')

    fireEvent.click(row)

    // the URL really changed: the stock page is in the pane. StockPage is a
    // lazy chunk — on a loaded machine the import can outrun the 1s default,
    // so both stock-page waits here allow 5s (the assertion is what the DOM
    // ends up being, never how fast a dynamic import resolved).
    const pane = screen.getByRole('main')
    expect(await within(pane).findByRole('heading', { name: /NVDA/ }, { timeout: 5000 })).toBeInTheDocument()
    // …and the layout did NOT remount around it: same column node, same row
    // node inside it (a remount would have built fresh elements), same scroll
    expect(screen.getByRole('complementary', { name: /board column/i })).toBe(col)
    expect(within(col).getByText('NVDA')).toBe(row)
    expect(col.scrollTop).toBe(137)
  })

  it('mounts exactly ONE live chart: a stock page in the pane has a single .sp-chart', async () => {
    setViewport(1440)
    render(<AppShell locationHook={memoryLocation({ path: '/app/stock/NVDA' }).hook} />)

    await screen.findByRole('heading', { name: /NVDA/ }, { timeout: 5000 })
    expect(document.querySelectorAll('.sp-chart')).toHaveLength(1)
  })

  it('lazy-mounts the analytics drawer: no panel fetch until it is opened', async () => {
    setViewport(1440)
    render(<AppShell locationHook={memoryLocation({ path: '/app/' }).hook} />)

    await screen.findByRole('heading', { name: /today/i })
    expect(spies.getSmartMoney).not.toHaveBeenCalled()
    expect(spies.getSeasonality).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /analytics/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /analytics/i }))

    expect(await screen.findByRole('dialog', { name: /analytics/i })).toBeInTheDocument()
    await waitFor(() => expect(spies.getSmartMoney).toHaveBeenCalledTimes(1))
    expect(spies.getSeasonality).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: /next-day lean/i })).toBeInTheDocument()
  })

  it('is reactive: widening the window past 1200px builds the desk without a reload', async () => {
    setViewport(1024)
    render(<AppShell locationHook={memoryLocation({ path: '/app/' }).hook} />)
    await screen.findByRole('heading', { name: /today/i })
    expect(document.querySelector('.desk2')).toBeNull()

    setViewport(1440)
    fireEvent(window, new Event('resize'))

    await waitFor(() => expect(document.querySelector('.desk2')).not.toBeNull())
    expect(within(screen.getByRole('main')).getByRole('heading', { name: /today/i })).toBeInTheDocument()
  })

  it('at desk width /board is the full-width Board page — no column, no duplicate list', async () => {
    setViewport(1440)
    render(<AppShell locationHook={memoryLocation({ path: '/app/board' }).hook} />)
    const pane = screen.getByRole('main')
    expect(await within(pane).findByRole('heading', { name: /board/i })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: /board column/i })).toBeNull()
    // the seeded row renders ONCE (the page's), never twice
    expect(await screen.findAllByText('NVDA')).toHaveLength(1)
  })

  it('at desk width /board#refused opens the PAGE’s "engine said no" details', async () => {
    setViewport(1440)
    window.history.pushState(null, '', '/app/board#refused')
    render(<AppShell locationHook={memoryLocation({ path: '/app/board' }).hook} />)
    const pane = screen.getByRole('main')
    const details = (await within(pane).findByText(/the engine said no/i)).closest('details') as HTMLDetailsElement
    expect(details.open).toBe(true)
  })

  it('below 1200px the analytics drawer does not exist at all', async () => {
    setViewport(1024)
    render(<AppShell locationHook={memoryLocation({ path: '/app/' }).hook} />)

    await screen.findByRole('heading', { name: /today/i })
    expect(screen.queryByRole('button', { name: /analytics/i })).toBeNull()
  })
})
