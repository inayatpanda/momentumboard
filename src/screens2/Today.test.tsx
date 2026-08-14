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
import type { EnginePrediction } from '../lib/api'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../shared/engine/voice'
import { NO_SIZED_TODAY } from '../lib/copy'
import { CallCard } from './parts/CallCard'
import { CountsRail } from './parts/CountsRail'
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
