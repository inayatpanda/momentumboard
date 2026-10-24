// Board (plan Task 14). Same local-first pattern as Today.test.tsx: both
// fetchers are mocked to NEVER resolve, every case seeds Dexie directly
// (`db.slices.put`) and asserts on the cached paint. Router wraps every
// render in wouter's memoryLocation (src/shell/AppShell.test.tsx's pattern).

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { BoardSlice, FunnelSlice, JourneyFunnelRow } from '../lib/apiViews'
import type { EnginePrediction } from '../lib/api'
import Board from './Board'
import { groupRefusalsByGate, REFUSED_PAGE } from './parts/BoardColumn'

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
    // the composite is LABELLED (visibility wave) — a bare number at the end
    // of a row was the one place the reader had to guess what it was
    expect(screen.getByText('core 54')).toHaveClass('num')
    expect(screen.getByText('AMD')).toBeInTheDocument()
    expect(screen.getByText('watch')).toBeInTheDocument()
    expect(screen.getByText('core 58')).toHaveClass('num')
    expect(screen.queryByLabelText(/^grade/i)).toHaveTextContent('A') // only the one sized row's grade pill exists
    expect(screen.getAllByLabelText(/^grade/i)).toHaveLength(1)
  })

  // THE COHORT ON THE BOARD (crypto-v2 wave, finding 7). `EnginePrediction` had
  // no `cohort` field at all, though the server has been stamping it since the
  // lane merged — so every board consumer was typed blind to it and no fixture
  // had ever rendered one. Both shapes here, sized and thin.
  it('renders cohort rows on both board shapes, each marked crypto, with the row-kind law untouched', async () => {
    const sizedCoin = mkRow({ id: 'c1', sym: 'BTC-USD', name: 'Bitcoin', cohort: 'crypto', grade: 'C', watchOnly: false, note: 'crypto cohort — its own 14-bar clock' })
    const watchCoin = mkRow({ id: 'c2', sym: 'ETH-USD', name: 'Ethereum', cohort: 'crypto', watchOnly: true, horizon: 'week', composite: 33 })
    const equity = mkRow({ id: 'e1', sym: 'NVDA', watchOnly: false, grade: 'A' })
    await seedBoard([sizedCoin, watchCoin, equity])
    withRouter(<Board />)

    expect(await screen.findByText('BTC-USD')).toBeInTheDocument()
    expect(screen.getByText('ETH-USD')).toBeInTheDocument()
    // the mark is on BOTH cohort rows and on neither equity row
    expect(screen.getAllByText('crypto')).toHaveLength(2)
    // …and a cohort stamp changes nothing about which rows may carry a letter:
    // the sized coin keeps its C, the watch coin has none.
    expect(screen.getByLabelText('Grade C')).toBeInTheDocument()
    expect(screen.getAllByLabelText(/^grade/i)).toHaveLength(2) // the coin's C and NVDA's A
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

    expect(within(details).getByText(/other ideas ranked higher/)).toBeInTheDocument()
    expect(within(details).getByText(/score below the required level/)).toBeInTheDocument()
    expect(within(details).getByText(/price has already moved too far/)).toBeInTheDocument()

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

  // D2: Today's counts rail links `/board#developing` and `/board#watch`, and
  // until now neither id existed anywhere — the chips scrolled to nothing.
  it('the developing and watch headings carry the ids the counts rail links to', async () => {
    await seedBoard([
      mkRow({ id: 'd1', sym: 'TSLA', watchOnly: true, horizon: 'developing', composite: -54 }),
      mkRow({ id: 'w1', sym: 'AMD', watchOnly: true, horizon: 'week', composite: 58 }),
    ])
    withRouter(<Board />)
    await screen.findByText('TSLA')
    expect(document.getElementById('developing')!.textContent).toMatch(/developing · 1 — building/i)
    expect(document.getElementById('watch')!.textContent).toMatch(/watch · 1 — short-term/i)
  })

  // …and the anchor cannot depend on the section having rows, or the chip
  // lands on nothing exactly on the days the reader most wants to know why
  // (visibility wave, 2026-08-17).
  it('renders both headings on a day with nothing developing and nothing watched', async () => {
    await seedBoard([mkRow({ id: 's1', sym: 'NVDA', watchOnly: false, grade: 'A' })])
    withRouter(<Board />)
    await screen.findByText('NVDA')
    expect(document.getElementById('developing')!.textContent).toMatch(/developing · 0 — nothing building today/i)
    expect(document.getElementById('watch')!.textContent).toMatch(/watch · 0 — nothing on watch today/i)
  })

  // …and the desk never unmounts this column, so a hash arriving UNDER it has
  // to be honoured too — mount-only would answer the chip once a session.
  it('opens the refused details when the hash changes under a mounted column', async () => {
    await seedBoard([])
    await seedFunnel('2026-08-14', mkFunnelData([mkFunnelRow({ key: 'AMD', gate: 'dead-zone-core' })]))
    withRouter(<Board />)
    await screen.findByText(/the engine said no/i)
    const details = document.getElementById('refused') as HTMLDetailsElement
    expect(details.open).toBe(false)

    window.history.pushState(null, '', '/app/board#refused')
    fireEvent(window, new Event('hashchange'))
    await waitFor(() => expect((document.getElementById('refused') as HTMLDetailsElement).open).toBe(true))
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
    expect(within(nearMissLink).getByText('Close to qualifying — no trade plan')).toBeInTheDocument()
    expect(within(observationLink).getByText('no suitable ISA investment — observation only')).toBeInTheDocument()
    // neither borrows the other's reason
    expect(within(nearMissLink).queryByText('no suitable ISA investment — observation only')).not.toBeInTheDocument()
    expect(within(observationLink).queryByText('Close to qualifying — no trade plan')).not.toBeInTheDocument()

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

// VISIBILITY WAVE (2026-08-17) — the live desk read "THE ENGINE SAID NO · 358"
// as a flat bar with no affordance, and behind it 358 undifferentiated rows.
// The number is the most interesting thing on the board and it answered
// nothing: 358 refused by WHAT?
describe('the engine said no — grouped, counted, openable', () => {
  const rows = (gate: JourneyFunnelRow['gate'], n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => mkFunnelRow({ key: `${prefix}${i}`, gate, core: 40 + i }))

  const openRefused = async (refusals: JourneyFunnelRow[]) => {
    await seedBoard([])
    await seedFunnel('2026-08-14', mkFunnelData(refusals))
    window.history.pushState(null, '', '/app/board#refused')
    withRouter(<Board />, '/app/board#refused')
    await screen.findByText(`${prefixOf(refusals[0])}`)
    return document.getElementById('refused') as HTMLDetailsElement
  }
  const prefixOf = (r: JourneyFunnelRow) => r.key.split(':')[0]

  describe('groupRefusalsByGate', () => {
    it('groups by gate and orders the groups by size, biggest first', () => {
      const groups = groupRefusalsByGate([
        mkFunnelRow({ key: 'A', gate: 'entry-chase' }),
        mkFunnelRow({ key: 'B', gate: 'dead-zone-core' }),
        mkFunnelRow({ key: 'C', gate: 'dead-zone-core' }),
        mkFunnelRow({ key: 'D', gate: 'dead-zone-core' }),
        mkFunnelRow({ key: 'E', gate: 'slot-cut' }),
        mkFunnelRow({ key: 'F', gate: 'slot-cut' }),
      ])
      expect(groups.map(g => [g.gate, g.rows.length])).toEqual([
        ['dead-zone-core', 3],
        ['slot-cut', 2],
        ['entry-chase', 1],
      ])
    })

    it('keeps the server order inside a gate, and among gates of equal size', () => {
      const groups = groupRefusalsByGate([
        mkFunnelRow({ key: 'ZZZ', gate: 'slot-cut' }),
        mkFunnelRow({ key: 'AAA', gate: 'dead-zone-core' }),
        mkFunnelRow({ key: 'MMM', gate: 'entry-chase' }),
      ])
      expect(groups.map(g => g.gate)).toEqual(['slot-cut', 'dead-zone-core', 'entry-chase'])
      expect(groups.flatMap(g => g.rows.map(r => r.key))).toEqual(['ZZZ', 'AAA', 'MMM'])
    })

    it('an empty trace is no groups at all', () => {
      expect(groupRefusalsByGate([])).toEqual([])
    })
  })

  it('heads each group with the gate that refused them and its own count', async () => {
    const details = await openRefused([...rows('dead-zone-core', 3, 'DZ'), ...rows('slot-cut', 1, 'SC')])
    const heads = [...details.querySelectorAll('.board-refused-gate')].map(p => p.textContent)
    expect(heads).toEqual(['score below the required level · 3', 'other ideas ranked higher · 1'])
  })

  it('names the gate once per group, never again on every row under it', async () => {
    const details = await openRefused(rows('dead-zone-core', 3, 'DZ'))
    expect(within(details).getAllByText(/score below the required level/)).toHaveLength(1)
  })

  it('paints 50 rows, then offers the rest — and the group shape is complete from the first paint', async () => {
    const details = await openRefused([...rows('dead-zone-core', 60, 'DZ'), ...rows('slot-cut', 20, 'SC')])
    expect(details.querySelectorAll('.board-row')).toHaveLength(REFUSED_PAGE)
    // both gates are named with their TRUE counts even though the second has no rows yet
    const heads = [...details.querySelectorAll('.board-refused-gate')].map(p => p.textContent)
    expect(heads).toEqual(['score below the required level · 60', 'other ideas ranked higher · 20'])

    const more = within(details).getByRole('button', { name: /show 30 more/i })
    fireEvent.click(more)
    expect(details.querySelectorAll('.board-row')).toHaveLength(80)
    expect(within(details).queryByRole('button', { name: /show more|show \d+ more/i })).not.toBeInTheDocument()
  })

  it('offers nothing to show when the whole trace already fits', async () => {
    const details = await openRefused(rows('dead-zone-core', 3, 'DZ'))
    expect(within(details).queryByRole('button', { name: /show/i })).not.toBeInTheDocument()
  })

  it('carries a chevron that turns with the disclosure', async () => {
    await seedBoard([])
    await seedFunnel('2026-08-14', mkFunnelData([mkFunnelRow({ key: 'AMD' })]))
    withRouter(<Board />)
    await screen.findByText(/the engine said no/i)
    const details = document.getElementById('refused') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('.board-refused-chev')).not.toBeNull()
  })
})
