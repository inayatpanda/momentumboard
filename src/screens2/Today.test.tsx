// Today — the home screen (plan Task 13). Tests cover the three part
// components directly (CallCard, CountsRail, YesterdayStrip) and the
// assembled screen's local-first paint. The board fetcher is mocked to NEVER
// resolve for every test in this file — every case seeds Dexie directly and
// asserts on the cached paint, the same pattern src/lib/useSlice.test.tsx
// uses for its "never" fetcher.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import type { BoardSlice } from '../lib/apiViews'
import type { EnginePrediction, IntradayFlag, IntradayFlagsBlob } from '../lib/api'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../shared/engine/voice'
import { NO_SIZED_NO_ROUTE, NO_SIZED_TODAY } from '../lib/copy'
import { CallCard } from './parts/CallCard'
import { CountsRail } from './parts/CountsRail'
import { IntradayFlagsStrip } from './parts/IntradayFlagsStrip'
import { YesterdayStrip } from './parts/YesterdayStrip'
import Today from './Today'

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  return { ...actual, getBoardSlice: () => new Promise<never>(() => {}) }
})

const withRouter = (ui: React.ReactElement) => render(<Router base="/app" hook={memoryLocation({ path: '/app/' }).hook}>{ui}</Router>)

const FACTOR_NAMES = ['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as const
const emptyFactors = () =>
  Object.fromEntries(FACTOR_NAMES.map(n => [n, { score: null, detail: '', weight: 0 }])) as EnginePrediction['factors']

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

const mkBoardData = (board: EnginePrediction[], yesterday: BoardSlice['yesterday'] = null): BoardSlice => ({
  board: { date: '2026-08-14', generatedAt: Date.now(), regime: 'green', board },
  intradayFlags: null,
  eventRadar: null,
  runStatus: null,
  riskState: null,
  referenceBase: null,
  yesterday,
})

beforeEach(async () => {
  await db.slices.clear()
})

describe('CallCard', () => {
  it('renders a sized row: symbol, side word, grade pill, entry/stop/target as .num', () => {
    withRouter(<CallCard row={mkRow()} />)
    expect(screen.getByText('NVDA')).toBeInTheDocument()
    expect(screen.getByText(/long/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Grade A')).toBeInTheDocument()
    expect(screen.getByLabelText(/^probability/i)).toBeInTheDocument()
    expect(screen.getByText('128.4')).toHaveClass('num')
    expect(screen.getByText('121.1')).toHaveClass('num')
    expect(screen.getByText('141')).toHaveClass('num')
  })

  it('a near-miss row shows no grade pill and no probability text', () => {
    withRouter(<CallCard row={mkRow({ nearMiss: true, watchOnly: true })} />)
    expect(screen.queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^probability/i)).not.toBeInTheDocument()
    expect(screen.getByText(/nearest miss/i)).toBeInTheDocument()
  })

  it('an observation row shows no grade pill and no probability text', () => {
    withRouter(<CallCard row={mkRow({ observation: true, watchOnly: true })} />)
    expect(screen.queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^probability/i)).not.toBeInTheDocument()
    expect(screen.getByText(/no ISA route/i)).toBeInTheDocument()
  })

  it('a plain watch-only row shows no grade pill and no probability text', () => {
    withRouter(<CallCard row={mkRow({ watchOnly: true, horizon: 'developing' })} />)
    expect(screen.queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^probability/i)).not.toBeInTheDocument()
    expect(screen.getByText(/watch/i)).toBeInTheDocument()
  })

  it('a wildcard row shows the wildcard label and standing warning', () => {
    withRouter(
      <CallCard
        row={mkRow({
          sym: 'COIN',
          side: 'short',
          grade: 'B',
          wildcard: { gate: 'dead-zone-core', priority: 1, hypothesis: 'dead-zone-core has 7 priced outcomes, none causal', gateEvidenceN: 7 },
        })}
      />,
    )
    expect(screen.getByText(WILDCARD_LABEL)).toBeInTheDocument()
    expect(screen.getByText(WILDCARD_WARNING)).toBeInTheDocument()
    // wildcard rows ARE sized/live (quarter size, real levels) — grade still shows
    expect(screen.getByLabelText('Grade B')).toBeInTheDocument()
  })

  it('navigates to the stock page on click', () => {
    withRouter(<CallCard row={mkRow()} />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/app/stock/NVDA')
  })

  // THE ROUTE DISCLAIMER (crypto-v2 wave, finding 3). The levels printed beside
  // a routed ticker are the UNDERLYING's, not the tracker's own price — and the
  // decay/hold-clock half belongs to geared routes alone (src/components/
  // EngineBoard.tsx:140-151, the wording this component inherits).
  it('a geared route warns about decay AND says the exit is on the underlying', () => {
    withRouter(<CallCard row={mkRow({ instrument: { ticker: '3LNV.L', leverage: 3 } })} />)
    expect(screen.getByText(/decay daily/i)).toBeInTheDocument()
    expect(screen.getByText(/10 sessions/i)).toBeInTheDocument()
    expect(screen.getByText(/underlying/i)).toBeInTheDocument()
  })

  it('a 1× tracker says the exit is on the underlying and that it has NEITHER decay nor a hold clock', () => {
    withRouter(<CallCard row={mkRow({ instrument: { ticker: 'BTCE.L', leverage: 1 } })} />)
    const note = screen.getByText(/tracker route/i)
    expect(note).toBeInTheDocument()
    expect(note).toHaveTextContent(/no daily decay and no hold clock/i)
    expect(screen.queryByText(/decay daily/i)).not.toBeInTheDocument()
  })

  it('an unrouted row carries no route disclaimer at all', () => {
    withRouter(<CallCard row={mkRow({ paperOnly: true })} />)
    expect(screen.queryByText(/tracker route/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/decay daily/i)).not.toBeInTheDocument()
  })

  // THE COHORT MARK (finding 7) and THE COHORT'S OWN EXPLANATION (finding 6).
  // The server stamps the 14-bar calibration, the ~50-outcome cold start, the
  // C/half-size designed floor and the missing-tracker cause into `note`; v2
  // dropped every word of it and left an unexplained C at half size.
  it('a cohort row is marked crypto and can explain why it is sized like this', () => {
    const note = 'crypto cohort — its own calibration, its own 14-bar clock, its own tape; this cohort has graded 12 of the ~50 outcomes it needs, so C at half size is the designed floor, not a verdict'
    withRouter(<CallCard row={mkRow({ sym: 'BTC-USD', cohort: 'crypto', grade: 'C', note })} />)
    expect(screen.getByText('crypto')).toBeInTheDocument()
    expect(screen.getByText(/why sized like this/i)).toBeInTheDocument()
    expect(screen.getByText(note)).toBeInTheDocument()
  })

  it('an equity row is neither marked nor given the explanation line', () => {
    withRouter(<CallCard row={mkRow({ note: 'ordinary factor line' })} />)
    expect(screen.queryByText('crypto')).not.toBeInTheDocument()
    expect(screen.queryByText(/why sized like this/i)).not.toBeInTheDocument()
  })

  it('keeps the row-kind law on a cohort row — an unsized coin still shows no grade', () => {
    withRouter(<CallCard row={mkRow({ sym: 'ETH-USD', cohort: 'crypto', watchOnly: true })} />)
    expect(screen.getByText('crypto')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^probability/i)).not.toBeInTheDocument()
  })
})

describe('CountsRail', () => {
  it('counts developing and watch rows from the board, and renders Refused with no count', () => {
    const board = [
      mkRow({ id: 'd1', watchOnly: true, horizon: 'developing' }),
      mkRow({ id: 'd2', watchOnly: true, horizon: 'developing' }),
      mkRow({ id: 'w1', watchOnly: true, horizon: 'week' }),
      mkRow({ id: 'nm1', watchOnly: true, nearMiss: true }), // excluded from both counts
    ]
    withRouter(<CountsRail board={board} />)
    expect(screen.getByText(/developing/i)).toBeInTheDocument()
    expect(screen.getByText('2')).toHaveClass('num')
    expect(screen.getByText(/watch/i)).toBeInTheDocument()
    expect(screen.getByText('1')).toHaveClass('num')
    expect(screen.getByText(/^refused$/i)).toBeInTheDocument()
  })
})

describe('YesterdayStrip', () => {
  it('renders wins/losses and the biggest regret symbol when present', () => {
    withRouter(<YesterdayStrip yesterday={{ date: '2026-08-13', wins: 2, losses: 1, topRegret: { sym: 'PLTR', excessPct: 6.1, gate: 'dead-zone-core' } }} />)
    expect(screen.getByText(/2 wins? · 1 loss/i)).toBeInTheDocument()
    expect(screen.getByText(/PLTR/)).toBeInTheDocument()
  })

  it('renders nothing when yesterday is null', () => {
    const { container } = withRouter(<YesterdayStrip yesterday={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  // THE PARTITION IN THE STRIP (crypto-v2 wave, finding 5). An equity verdict is
  // an excess over SPY across ten sessions; a cohort verdict is an absolute move
  // across fourteen crypto bars. One line summing both means neither.
  it('splits the verdicts when the day carried cohort rows', () => {
    withRouter(
      <YesterdayStrip
        yesterday={{ date: '2026-08-13', wins: 3, losses: 2, equity: { wins: 2, losses: 1 }, crypto: { wins: 1, losses: 1 }, topRegret: null }}
      />,
    )
    expect(screen.getByText(/equity/i)).toBeInTheDocument()
    expect(screen.getByText(/2 wins? · 1 loss/i)).toBeInTheDocument()
    expect(screen.getByText(/crypto/i)).toBeInTheDocument()
    expect(screen.getByText(/1 win · 1 loss/i)).toBeInTheDocument()
  })

  it('a crypto-only weekend says so rather than reading as a generic engine result', () => {
    withRouter(
      <YesterdayStrip yesterday={{ date: '2026-08-16', wins: 1, losses: 0, equity: { wins: 0, losses: 0 }, crypto: { wins: 1, losses: 0 }, topRegret: null }} />,
    )
    expect(screen.getByText(/crypto/i)).toBeInTheDocument()
    expect(screen.queryByText(/equity/i)).not.toBeInTheDocument() // nothing equity graded — say nothing about it
  })

  it('falls back to the flat count for a slice cached before the split existed', () => {
    withRouter(<YesterdayStrip yesterday={{ date: '2026-08-13', wins: 2, losses: 1, topRegret: null }} />)
    expect(screen.getByText(/2 wins? · 1 loss/i)).toBeInTheDocument()
    expect(screen.queryByText(/crypto/i)).not.toBeInTheDocument()
  })
})

// THE LIVE FLAGS (crypto-v2 wave, finding 8). The board slice has always carried
// today's intraday flags — with crypto correctly excluded server-side — and no
// v2 screen consumed them, so deleting the legacy board deletes the display.
// Ported from src/components/EngineBoard.tsx's IntradayFlagsStrip.
describe('IntradayFlagsStrip', () => {
  const mkFlag = (o: Partial<IntradayFlag> = {}): IntradayFlag => ({
    sym: 'NVDA',
    name: 'NVIDIA',
    kind: 'entry-zone',
    price: 128.9,
    level: 128.4,
    detail: 'back in the entry band',
    at: 1_755_000_000,
    ...o,
  })
  const mkBlob = (flags: IntradayFlag[], date = '2026-08-14'): IntradayFlagsBlob => ({
    date,
    scans: [{ at: 1_755_000_000, window: 'london-open', flags }],
  })

  it('renders nothing before the first scan of the day', () => {
    const { container } = withRouter(<IntradayFlagsStrip blob={null} />)
    expect(container).toBeEmptyDOMElement()
    const empty = withRouter(<IntradayFlagsStrip blob={{ date: '2026-08-14', scans: [] }} />)
    expect(empty.container).toBeEmptyDOMElement()
  })

  it('says "scanned — nothing" once a scan has actually run empty', () => {
    withRouter(<IntradayFlagsStrip blob={mkBlob([])} />)
    expect(screen.getByText(/no clean intraday entries/i)).toBeInTheDocument()
  })

  it('renders one row per symbol with the kind badge, the level and the honest not-a-new-call line', () => {
    withRouter(<IntradayFlagsStrip blob={mkBlob([mkFlag(), mkFlag({ sym: 'AMD', kind: 'breakout', price: 171.2, level: 170.5, detail: 'through the 20-day high' })])} />)
    expect(screen.getByText('NVDA')).toBeInTheDocument()
    expect(screen.getByText('AMD')).toBeInTheDocument()
    expect(screen.getByText(/entry zone/i)).toBeInTheDocument()
    expect(screen.getByText(/breakout/i)).toBeInTheDocument()
    expect(screen.getByText(/128.9 vs 128.4/)).toHaveClass('num')
    expect(screen.getByText(/not new calls/i)).toBeInTheDocument()
  })

  it('keeps only the FRESHEST flag per symbol across the day’s scans', () => {
    const blob: IntradayFlagsBlob = {
      date: '2026-08-14',
      scans: [
        { at: 1_755_010_000, window: 'power-hour', flags: [mkFlag({ detail: 'the newest read' })] },
        { at: 1_755_000_000, window: 'london-open', flags: [mkFlag({ detail: 'the older read' })] },
      ],
    }
    withRouter(<IntradayFlagsStrip blob={blob} />)
    expect(screen.getByText(/the newest read/)).toBeInTheDocument()
    expect(screen.queryByText(/the older read/)).not.toBeInTheDocument()
  })
})

describe('Today', () => {
  it('paints a cached board slice without waiting for the network', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() - 200_000 })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: /today/i })).toBeInTheDocument()
  })

  it('shows the empty-board sentence when nothing sized today', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(NO_SIZED_TODAY)).toBeInTheDocument()
  })

  // T13a: an observation-only day was told with the empty-board sentence —
  // "nothing cleared its gates", printed directly above a rail counting rows
  // that had. Two days, two sentences.
  it('an observation-only day says the routes ran out, not that the gates did', async () => {
    const observation = mkRow({ id: 'o1', sym: 'ASML', watchOnly: true, observation: true })
    await db.slices.put({ key: 'board', data: mkBoardData([observation]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(NO_SIZED_NO_ROUTE)).toBeInTheDocument()
    expect(screen.queryByText(NO_SIZED_TODAY)).not.toBeInTheDocument()
  })

  it('a watch-only day says the same', async () => {
    const watching = mkRow({ id: 'w1', sym: 'AMD', watchOnly: true, horizon: 'week' })
    await db.slices.put({ key: 'board', data: mkBoardData([watching]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(NO_SIZED_NO_ROUTE)).toBeInTheDocument()
  })

  // …but a board of nothing but near misses cleared no gate, so the original
  // sentence is the true one there.
  it('a near-miss-only day keeps the empty-board sentence', async () => {
    const miss = mkRow({ id: 'n1', sym: 'PLTR', watchOnly: true, nearMiss: true })
    await db.slices.put({ key: 'board', data: mkBoardData([miss]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(NO_SIZED_TODAY)).toBeInTheDocument()
  })

  it('mounts the intraday flags from the same board slice, under the call cards', async () => {
    const data = mkBoardData([mkRow()])
    data.intradayFlags = {
      date: '2026-08-14',
      scans: [{ at: 1_755_000_000, window: 'london-open', flags: [{ sym: 'AMD', name: 'Advanced Micro Devices', kind: 'second-chance', price: 171.2, level: 170.5, detail: 'back at the entry', at: 1_755_000_000 }] }],
    }
    await db.slices.put({ key: 'board', data, fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(/intraday flags/i)).toBeInTheDocument()
    expect(screen.getByText('AMD')).toBeInTheDocument()
  })

  it('renders the yesterday strip from the board slice alone', async () => {
    await db.slices.put({
      key: 'board',
      data: mkBoardData([], { date: '2026-08-13', wins: 2, losses: 1, topRegret: { sym: 'PLTR', excessPct: 6.1, gate: 'dead-zone-core' } }),
      fetchedAt: Date.now(),
    })
    withRouter(<Today />)
    expect(await screen.findByText(/PLTR/)).toBeInTheDocument()
  })
})
