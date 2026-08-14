// Board (plan Task 14). Same local-first pattern as Today.test.tsx: both
// fetchers are mocked to NEVER resolve, every case seeds Dexie directly
// (`db.slices.put`) and asserts on the cached paint. Router wraps every
// render in wouter's memoryLocation (src/shell/AppShell.test.tsx's pattern).

import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { BoardSlice, FunnelSlice, JourneyFunnelRow } from '../lib/apiViews'
import type { EnginePrediction } from '../lib/api'
import Board from './Board'

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  return {
    ...actual,
    getBoardSlice: () => new Promise<never>(() => {}),
    getFunnel: () => new Promise<never>(() => {}),
  }
})

const withRouter = (ui: React.ReactElement, path = '/app/board') => render(<Router base="/app" hook={memoryLocation({ path }).hook}>{ui}</Router>)

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

function mkFunnelRow(overrides: Partial<JourneyFunnelRow> = {}): JourneyFunnelRow {
  return { key: 'AMD', gate: 'dead-zone-core', ...overrides }
}

const mkFunnelData = (refusals: JourneyFunnelRow[], opts: Partial<FunnelSlice> = {}): FunnelSlice => ({
  date: '2026-08-14',
  refusals,
  published: [],
  nearMisses: [],
  ...opts,
})

async function seedBoard(board: EnginePrediction[], date = '2026-08-14') {
  await db.slices.put({ key: 'board', data: mkBoardData(board, date), fetchedAt: Date.now() })
}

async function seedFunnel(date: string, funnel: FunnelSlice) {
  await db.slices.put({ key: `funnel:${date}`, data: funnel, fetchedAt: Date.now() })
}

beforeEach(async () => {
  await db.slices.clear()
  window.history.pushState(null, '', '/app/board')
})

describe('Board', () => {
  it('has a heading containing "Board"', async () => {
    await seedBoard([])
    withRouter(<Board />)
    expect(await screen.findByRole('heading', { name: /board/i })).toBeInTheDocument()
  })

  it('renders sized rows as CallCards (grade pill + probability) and developing/watch as thin rows (no grade pill)', async () => {
    const sizedRow = mkRow({ id: 's1', sym: 'NVDA', watchOnly: false, grade: 'A' })
    const developingRow = mkRow({ id: 'd1', sym: 'TSLA', side: 'short', watchOnly: true, horizon: 'developing', composite: -54 })
    const watchRow = mkRow({ id: 'w1', sym: 'AMD', watchOnly: true, horizon: 'week', composite: 58 })
    await seedBoard([sizedRow, developingRow, watchRow])
    withRouter(<Board />)

    // sized: a CallCard — grade pill + probability text
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.getByLabelText('Grade A')).toBeInTheDocument()
    expect(screen.getByLabelText(/^probability/i)).toBeInTheDocument()

    // developing/watch: thin rows — sym, side, stage word, conviction .num, NO grade pill
    expect(screen.getByText('TSLA')).toBeInTheDocument()
    expect(screen.getByText('developing')).toBeInTheDocument()
    expect(screen.getByText('54')).toHaveClass('num')
    expect(screen.getByText('AMD')).toBeInTheDocument()
    expect(screen.getByText('watch')).toBeInTheDocument()
    expect(screen.getByText('58')).toHaveClass('num')
    expect(screen.queryByLabelText(/^grade/i)).toHaveTextContent('A') // only the one sized row's grade pill exists
    expect(screen.getAllByLabelText(/^grade/i)).toHaveLength(1)
  })

  it('renders refusals in server order with gate labels, and no grade/probability text anywhere in the section', async () => {
    const refusals = [
      mkFunnelRow({ key: 'ZZZ:long', gate: 'slot-cut', core: 10 }),
      mkFunnelRow({ key: 'AAA:short', gate: 'dead-zone-core', core: 90 }),
      mkFunnelRow({ key: 'MMM:long', gate: 'entry-chase', core: 50 }),
    ]
    await seedBoard([])
    await seedFunnel('2026-08-14', mkFunnelData(refusals))
    window.history.pushState(null, '', '/app/board#refused')
    withRouter(<Board />, '/app/board#refused')
    await screen.findByText('ZZZ')

    const details = document.getElementById('refused') as HTMLDetailsElement
    const rowEls = within(details).getAllByText(/ZZZ|AAA|MMM/)
    // server order preserved: slot-cut(ZZZ) → dead-zone-core(AAA) → entry-chase(MMM), NOT sorted by core desc
    expect(rowEls.map(el => el.textContent)).toEqual(['ZZZ', 'AAA', 'MMM'])

    expect(within(details).getByText(/lost the last slot/)).toBeInTheDocument()
    expect(within(details).getByText(/below the conviction bar/)).toBeInTheDocument()
    expect(within(details).getByText(/already ran — refused to chase/)).toBeInTheDocument()

    // no letter grade, no probability, anywhere in the refused section
    expect(within(details).queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    expect(within(details).queryByLabelText(/^probability/i)).not.toBeInTheDocument()
    expect(within(details).queryByText(/%/)).not.toBeInTheDocument()

    // core is printed bare, labelled "core"
    expect(within(details).getByText(/core 10\.0/)).toBeInTheDocument()
  })

  it('renders "No refusals recorded for {date}" when the funnel comes back missing', async () => {
    await seedBoard([], '2026-08-13')
    await seedFunnel('2026-08-13', { date: null, missing: true, refusals: [], published: [], nearMisses: [] })
    window.history.pushState(null, '', '/app/board#refused')
    withRouter(<Board />, '/app/board#refused')
    expect(await screen.findByText('No refusals recorded for 2026-08-13.')).toBeInTheDocument()
  })

  it('opens the "engine said no" details when arriving at #refused', async () => {
    await seedBoard([])
    await seedFunnel('2026-08-14', mkFunnelData([mkFunnelRow({ key: 'AMD', gate: 'dead-zone-core' })]))
    window.history.pushState(null, '', '/app/board#refused')
    withRouter(<Board />, '/app/board#refused')
    const details = await screen.findByText('AMD').then(() => document.getElementById('refused') as HTMLDetailsElement)
    expect(details.open).toBe(true)
  })

  it('the "engine said no" details starts collapsed with no hash', async () => {
    await seedBoard([])
    await seedFunnel('2026-08-14', mkFunnelData([mkFunnelRow({ key: 'AMD', gate: 'dead-zone-core' })]))
    withRouter(<Board />)
    await screen.findByText(/the engine said no/i)
    const details = document.getElementById('refused') as HTMLDetailsElement
    expect(details.open).toBe(false)
  })

  it('does NOT render published rows in the refusals section', async () => {
    await seedBoard([])
    await seedFunnel(
      '2026-08-14',
      mkFunnelData([mkFunnelRow({ key: 'REFUSED_SYM', gate: 'dead-zone-core' })], {
        published: [mkFunnelRow({ key: 'PUBLISHED_SYM', gate: 'called-full' })],
      }),
    )
    window.history.pushState(null, '', '/app/board#refused')
    withRouter(<Board />, '/app/board#refused')
    expect(await screen.findByText('REFUSED_SYM')).toBeInTheDocument()
    expect(screen.queryByText('PUBLISHED_SYM')).not.toBeInTheDocument()
  })

  it('the funnel slice pairs with the BOARD date, not funnel:latest', async () => {
    await seedBoard([], '2026-08-10')
    await seedFunnel('2026-08-10', mkFunnelData([mkFunnelRow({ key: 'OLDCALL', gate: 'trimmed' })]))
    window.history.pushState(null, '', '/app/board#refused')
    withRouter(<Board />, '/app/board#refused')
    expect(await screen.findByText('OLDCALL')).toBeInTheDocument()
  })

  it('renders near-miss and observation rows with their own distinct one-line reasons, no grade pill or probability', async () => {
    const nearMissRow = mkRow({ id: 'nm1', sym: 'ZOOM', watchOnly: true, nearMiss: true })
    const observationRow = mkRow({ id: 'ob1', sym: 'ROKU', watchOnly: true, observation: true })
    await seedBoard([nearMissRow, observationRow])
    withRouter(<Board />)

    const nearMissLink = (await screen.findByText('ZOOM')).closest('a') as HTMLAnchorElement
    const observationLink = screen.getByText('ROKU').closest('a') as HTMLAnchorElement

    // (a) each renders its own distinct sentence
    expect(within(nearMissLink).getByText('nearest miss — no size')).toBeInTheDocument()
    expect(within(observationLink).getByText('no ISA route — observation only')).toBeInTheDocument()
    // neither borrows the other's reason
    expect(within(nearMissLink).queryByText('no ISA route — observation only')).not.toBeInTheDocument()
    expect(within(observationLink).queryByText('nearest miss — no size')).not.toBeInTheDocument()

    // (b) neither row shows a letter grade pill or any probability text
    expect(within(nearMissLink).queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    expect(within(observationLink).queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    expect(within(nearMissLink).queryByLabelText(/^probability/i)).not.toBeInTheDocument()
    expect(within(observationLink).queryByLabelText(/^probability/i)).not.toBeInTheDocument()
    expect(within(nearMissLink).queryByText(/%/)).not.toBeInTheDocument()
    expect(within(observationLink).queryByText(/%/)).not.toBeInTheDocument()
  })

  it('remounts the refused section on a board-date change — never shows a stale day\'s refusals beside the new date', async () => {
    // dateA has real refusals in cache; dateB is pre-seeded (as a real fetch
    // would land it) so the remount's own useSlice call resolves instantly
    // from Dexie rather than hanging on the never-resolving mocked fetcher.
    await seedBoard([], '2026-08-10')
    await seedFunnel('2026-08-10', mkFunnelData([mkFunnelRow({ key: 'STALE_SYM', gate: 'dead-zone-core' })]))
    await seedFunnel('2026-08-11', { date: '2026-08-11', missing: true, refusals: [], published: [], nearMisses: [] })
    window.history.pushState(null, '', '/app/board#refused')
    withRouter(<Board />, '/app/board#refused')
    expect(await screen.findByText('STALE_SYM')).toBeInTheDocument()

    // the board moves on to a new day under the SAME mounted <Board/> — write
    // the slice through the store (writeSlice both persists to Dexie AND
    // fires the 'slice' write event useSlice listens for), exactly how a
    // background revalidation lands a fresh board in production.
    await writeSlice('board', mkBoardData([], '2026-08-11'))

    await waitFor(() => expect(screen.getByText('No refusals recorded for 2026-08-11.')).toBeInTheDocument())
    // dateA's refusal row must never sit beside dateB's board — key={date}
    // forces the section to remount rather than carry stale state forward.
    expect(screen.queryByText('STALE_SYM')).not.toBeInTheDocument()
  })
})
