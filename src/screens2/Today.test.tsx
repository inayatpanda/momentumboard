// Today — the home screen (plan Task 13). Tests cover the three part
// components directly (CallCard, CountsRail, YesterdayStrip) and the
// assembled screen's local-first paint. The board fetcher is mocked to NEVER
// resolve for every test in this file — every case seeds Dexie directly and
// asserts on the cached paint, the same pattern src/lib/useSlice.test.tsx
// uses for its "never" fetcher.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import type { BoardSlice, ChannelPick } from '../lib/apiViews'
import type { EnginePrediction, EventRadarEntry, IntradayFlag, IntradayFlagsBlob, OpenTraceEntry } from '../lib/api'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../shared/engine/voice'
import { unsizedReason } from '../lib/boardTaxonomy'
import { NO_BOARD_YET, NO_SIZED_NO_ROUTE, NO_SIZED_TODAY } from '../lib/copy'
import { londonToday } from '../lib/londonDay'
import { resetSeenMarks, writeSeenMarks } from '../lib/lastSeen'
import type { Quote } from '../../shared/types'
import { CallCard, entryDistance } from './parts/CallCard'
import { ChannelPicksStrip } from './parts/ChannelPicksStrip'
import { CountsRail } from './parts/CountsRail'
import { EventRadarStrip } from './parts/EventRadarStrip'
import { IntradayFlagsStrip } from './parts/IntradayFlagsStrip'
import { OpenCallsStrip } from './parts/OpenCallsStrip'
import { YesterdayStrip } from './parts/YesterdayStrip'
import Today from './Today'

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  // A `vi.fn` around the same never-resolving promise: the refresh wiring
  // (dynamism wave) needs to see that a second fetch was ASKED for, and a
  // fetch that never settles is exactly how "refreshing" stays observable.
  return { ...actual, getBoardSlice: vi.fn(() => new Promise<never>(() => {})) }
})

import { getBoardSlice } from '../lib/apiViews'

// Today reaches past its own board slice now (dynamism wave): the headline
// strip reads `intel:news` and the cards read a live quote batch. Both reject
// here — every case paints from a seeded Dexie slice, and nothing in this file
// may put a real request on the wire.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return { ...actual, getNewsDesk: vi.fn(notMocked), getQuotes: vi.fn(notMocked) }
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
  await Promise.all([db.slices.clear(), db.quotes.clear(), db.settings.clear()])
  resetSeenMarks() // the new-since snapshot is module-level and outlives a test
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

  // THE LIVE LINE (dynamism wave, feature 4a).
  describe('the live line', () => {
    const OPEN = Date.parse('2026-08-17T15:00:00Z') // Monday, mid-session
    const SHUT = Date.parse('2026-08-15T15:00:00Z') // Saturday
    const mkQuote = (price: number, overrides: Partial<Quote> = {}): Quote => ({
      symbol: 'NVDA',
      price,
      prevClose: price,
      changePct: 0,
      currency: 'USD',
      todayVolume: null,
      asOf: Math.floor(Date.parse('2026-08-14T20:00:00Z') / 1000), // a Friday close
      source: 'finnhub',
      ...overrides,
    })

    it('renders nothing new at all without a quote — the card is byte-identical', () => {
      withRouter(<CallCard row={mkRow()} />)
      expect(document.querySelector('.cc-live')).toBeNull()
    })

    it('says what the name is trading at and how far that is from the entry', () => {
      withRouter(<CallCard row={mkRow({ entry: 130.9 })} quote={mkQuote(128.4)} now={OPEN} />)
      expect(document.querySelector('.cc-live')?.textContent).toBe('now 128.40 · 1.9% below entry')
    })

    it('out of hours it is a CLOSE, named by its own day, never a fake tick', () => {
      withRouter(<CallCard row={mkRow({ entry: 130.9 })} quote={mkQuote(128.4)} now={SHUT} />)
      expect(document.querySelector('.cc-live')?.textContent).toBe('Fri close 128.40 · 1.9% below entry')
    })

    it('a quote with no stamp says so rather than inventing a weekday', () => {
      withRouter(<CallCard row={mkRow({ entry: 130.9 })} quote={mkQuote(128.4, { asOf: 0 })} now={SHUT} />)
      expect(document.querySelector('.cc-live')?.textContent).toContain('last close 128.40')
    })

    it('leaves the grade and the probability exactly as they were', () => {
      withRouter(<CallCard row={mkRow()} quote={mkQuote(128.4)} now={OPEN} />)
      expect(screen.getByLabelText('Grade A')).toHaveClass('pill', 'accent')
      expect(screen.getByLabelText(/^probability/i)).toHaveClass('num')
    })
  })

  // The arithmetic itself, side by side.
  describe('entryDistance', () => {
    it('measures a long against its entry from below, and calls the trigger past', () => {
      expect(entryDistance(128.4, 130.9, 'long')).toBe('1.9% below entry')
      expect(entryDistance(133.0, 130.9, 'long')).toBe('past entry')
    })

    it('inverts for a short: not yet triggered means ABOVE the entry', () => {
      expect(entryDistance(133.0, 130.9, 'short')).toBe('1.6% above entry')
      expect(entryDistance(128.4, 130.9, 'short')).toBe('past entry')
    })

    it('within 0.3% either way it is simply at entry, both sides', () => {
      expect(entryDistance(130.9, 130.9, 'long')).toBe('at entry')
      expect(entryDistance(131.2, 130.9, 'long')).toBe('at entry')
      expect(entryDistance(130.6, 130.9, 'long')).toBe('at entry')
      expect(entryDistance(130.6, 130.9, 'short')).toBe('at entry')
    })

    it('refuses a nonsense level rather than dividing by it', () => {
      expect(entryDistance(128.4, 0, 'long')).toBeNull()
      expect(entryDistance(0, 130.9, 'long')).toBeNull()
      expect(entryDistance(Number.NaN, 130.9, 'long')).toBeNull()
    })
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

// THE OPEN BOOK (owner iteration 2). Today painted only what was published this
// morning; the calls already on the table were one tap deep on a per-symbol
// journey. Three verdict states, three colours — a shared hedge would be the
// screen lying by compression (OpenTraceCard's own rule, in one line).
describe('OpenCallsStrip', () => {
  const mkTrace = (o: Partial<OpenTraceEntry> = {}): OpenTraceEntry => ({
    id: 'o1',
    sym: 'NVDA',
    side: 'long',
    callDate: '2026-08-11',
    grade: 'A',
    entry: 118,
    stop: 111,
    target: 131,
    status: 'in-play',
    crossedDate: null,
    last: 121.8,
    movePct: 3.2,
    progressPct: 41,
    day: 4,
    gradesInSessions: 6,
    stage: 'trending',
    requalified: false,
    verdict: 'still-on',
    note: 'walking',
    ...o,
  })

  it('renders nothing at all — never a skeleton — with no entries', () => {
    const { container } = withRouter(<OpenCallsStrip entries={[]} />)
    expect(container).toBeEmptyDOMElement()
    const undef = withRouter(<OpenCallsStrip entries={undefined} />)
    expect(undef.container).toBeEmptyDOMElement()
  })

  it('renders one row per open call: sym link, side, day, move as .num, and a progress bar', () => {
    withRouter(<OpenCallsStrip entries={[mkTrace()]} />)
    expect(screen.getByRole('link', { name: 'NVDA' })).toHaveAttribute('href', '/app/stock/NVDA')
    expect(screen.getByText('long')).toBeInTheDocument()
    expect(screen.getByText('day 4')).toHaveClass('num')
    expect(screen.getByText('+3.2%')).toHaveClass('num')
    expect(document.querySelector('.oc-bar > i')).toHaveStyle({ width: '41%' })
  })

  it('gives each verdict its own word and its own colour class', () => {
    withRouter(
      <OpenCallsStrip
        entries={[
          mkTrace({ id: 'a', sym: 'NVDA', verdict: 'still-on' }),
          mkTrace({ id: 'b', sym: 'AMD', verdict: 'intact' }),
          mkTrace({ id: 'c', sym: 'COIN', verdict: 'weakening' }),
        ]}
      />,
    )
    expect(screen.getByText('still on')).toHaveClass('oc-verdict', 'on')
    expect(screen.getByText('intact')).toHaveClass('oc-verdict', 'flat')
    expect(screen.getByText('weakening')).toHaveClass('oc-verdict', 'weak')
    // three distinct classes, never one shared hedge
    const classes = [...document.querySelectorAll('.oc-verdict')].map(el => el.className)
    expect(new Set(classes).size).toBe(3)
  })

  it('says what happened on a crossed row, which carries no verdict', () => {
    withRouter(<OpenCallsStrip entries={[mkTrace({ status: 'stopped', verdict: null, crossedDate: '2026-08-13' })]} />)
    expect(screen.getByText('stopped out')).toBeInTheDocument()
  })
})

// THE EVENT RADAR (owner iteration 2). The board slice has carried it since the
// radar shipped and no v2 screen read a character of it — so a dated binary the
// engine already knew about was invisible until it printed.
describe('EventRadarStrip', () => {
  // THE CLOCK IS PINNED (dynamism wave, feature 5): the day distance is now
  // computed from each entry's DATE against the reader's clock, so a test that
  // let the real clock in would pass today and fail tomorrow — which is
  // precisely the staleness this recompute exists to fix.
  const NOW = Date.parse('2026-08-17T09:00:00Z') // Monday morning, London
  const mkEvent = (o: Partial<EventRadarEntry> = {}): EventRadarEntry => ({
    sym: 'AVGO',
    name: 'Broadcom',
    date: '2026-08-20',
    daysToPrint: 3,
    stage: 'trending',
    entryQuality: null,
    rs21: null,
    note: null,
    ...o,
  })

  it('renders nothing when the radar is empty or absent', () => {
    expect(withRouter(<EventRadarStrip radar={null} />).container).toBeEmptyDOMElement()
    expect(withRouter(<EventRadarStrip radar={{ entries: [] }} />).container).toBeEmptyDOMElement()
  })

  it('renders a dated row per print, symbol linked, stage shown', () => {
    withRouter(<EventRadarStrip radar={{ entries: [mkEvent()] }} now={NOW} />)
    expect(screen.getByRole('link', { name: 'AVGO' })).toHaveAttribute('href', '/app/stock/AVGO')
    expect(screen.getByText('reports in 3d')).toBeInTheDocument()
    expect(screen.getByText(/20 Aug/)).toHaveClass('num')
    expect(screen.getByText('trending')).toBeInTheDocument()
  })

  it('counts from the reader’s own day, ignoring the number the blob was baked with', () => {
    withRouter(<EventRadarStrip radar={{ entries: [mkEvent({ date: '2026-08-20', daysToPrint: 0 })] }} now={NOW} />)
    expect(screen.getByText('reports in 3d')).toBeInTheDocument()
    expect(screen.queryByText('reports today')).not.toBeInTheDocument()
  })

  it('never prints "in 0d" — a same-day print says so in English', () => {
    withRouter(<EventRadarStrip radar={{ entries: [mkEvent({ date: '2026-08-17' }), mkEvent({ sym: 'AMD', date: '2026-08-18' })] }} now={NOW} />)
    expect(screen.getByText('reports today')).toBeInTheDocument()
    expect(screen.getByText('reports tomorrow')).toBeInTheDocument()
  })

  // THE SATURDAY BUG (dynamism wave): Friday's blob said "reports today" about
  // a print whose result the reader could already look up.
  it('a print already past says so, instead of claiming it is today', () => {
    withRouter(<EventRadarStrip radar={{ entries: [mkEvent({ date: '2026-08-14', daysToPrint: 0 })] }} now={NOW} />)
    expect(screen.getByText("reported — awaiting the print's read")).toBeInTheDocument()
  })

  it('turns over at LONDON midnight, not the reader’s and not UTC’s', () => {
    const justAfterMidnight = Date.parse('2026-08-17T23:30:00Z') // 00:30 on the 18th, London
    withRouter(
      <EventRadarStrip radar={{ entries: [mkEvent({ date: '2026-08-18' }), mkEvent({ sym: 'AMD', date: '2026-08-17' })] }} now={justAfterMidnight} />,
    )
    expect(screen.getByText('reports today')).toBeInTheDocument()
    expect(screen.getByText("reported — awaiting the print's read")).toBeInTheDocument()
  })

  it('sorts nearest first, pushes the already-reported to the back, and caps at six', () => {
    const entries = [
      mkEvent({ sym: 'FAR', date: '2026-08-27' }),
      mkEvent({ sym: 'PAST1', date: '2026-08-14' }),
      mkEvent({ sym: 'SOON', date: '2026-08-18' }),
      mkEvent({ sym: 'PAST2', date: '2026-08-10' }),
      mkEvent({ sym: 'TODAY', date: '2026-08-17' }),
      mkEvent({ sym: 'MID', date: '2026-08-20' }),
      mkEvent({ sym: 'LATER', date: '2026-08-24' }),
      mkEvent({ sym: 'LAST', date: '2026-08-25' }),
    ]
    withRouter(<EventRadarStrip radar={{ entries }} now={NOW} />)
    const syms = [...document.querySelectorAll('.er-sym')].map(el => el.textContent)
    expect(syms).toEqual(['TODAY', 'SOON', 'MID', 'LATER', 'LAST', 'FAR'])
  })

  it('falls back to the blob’s own count when an entry has no readable date', () => {
    withRouter(<EventRadarStrip radar={{ entries: [mkEvent({ date: '', daysToPrint: 2 })] }} now={NOW} />)
    expect(screen.getByText('reports in 2d')).toBeInTheDocument()
  })
})

// THE CHANNELS' PICKS (owner request). What the tracked channels are pushing
// this week, each name beside the engine's OWN stance on it — the whole point
// is the disagreement, so a name the engine has no read on must say exactly
// that rather than borrow a grade from anywhere.
describe('ChannelPicksStrip', () => {
  const mkPick = (o: Partial<ChannelPick> = {}): ChannelPick => ({
    sym: 'NVDA',
    mentions7d: 4,
    mentionsPrior7d: 2,
    channels: 3,
    bulls: 3,
    bears: 1,
    net: 2,
    crowded: false,
    shifted: false,
    ...o,
  })

  it('renders nothing at all — never a skeleton — with no picks', () => {
    expect(withRouter(<ChannelPicksStrip picks={null} board={[]} openCalls={undefined} />).container).toBeEmptyDOMElement()
    expect(withRouter(<ChannelPicksStrip picks={undefined} board={[]} openCalls={undefined} />).container).toBeEmptyDOMElement()
    expect(withRouter(<ChannelPicksStrip picks={[]} board={[]} openCalls={undefined} />).container).toBeEmptyDOMElement()
  })

  it('renders the street’s read: symbol linked, bulls and bears in their own direction colours', () => {
    withRouter(<ChannelPicksStrip picks={[mkPick()]} board={[]} openCalls={undefined} />)
    expect(screen.getByRole('link', { name: 'NVDA' })).toHaveAttribute('href', '/app/stock/NVDA')
    expect(screen.getByText('3 bulls')).toHaveClass('cp-bull')
    expect(screen.getByText('1 bear')).toHaveClass('cp-bear')
    expect(screen.getByText(/3 channels/)).toBeInTheDocument()
  })

  it('says nothing about a side nobody took, and counts one channel in the singular', () => {
    withRouter(<ChannelPicksStrip picks={[mkPick({ bulls: 0, bears: 1, channels: 1 })]} board={[]} openCalls={undefined} />)
    expect(screen.queryByText(/bull/)).not.toBeInTheDocument()
    expect(screen.getByText('1 bear')).toBeInTheDocument()
    expect(screen.getByText(/1 channel$/)).toBeInTheDocument()
  })

  it('a name the engine has no read on says so — no grade borrowed from anywhere', () => {
    withRouter(<ChannelPicksStrip picks={[mkPick({ sym: 'GME' })]} board={[]} openCalls={undefined} />)
    expect(screen.getByText('no view')).toHaveClass('cp-noview')
    expect(screen.queryByLabelText(/^grade/i)).not.toBeInTheDocument()
  })

  it('a sized board row shows the engine’s side and its grade', () => {
    withRouter(<ChannelPicksStrip picks={[mkPick()]} board={[mkRow({ sym: 'NVDA', side: 'long', grade: 'A' })]} openCalls={undefined} />)
    expect(screen.getByLabelText('Grade A')).toHaveTextContent('A')
    expect(screen.getByText('long')).toHaveClass('pill', 'long')
    expect(screen.queryByText('no view')).not.toBeInTheDocument()
  })

  // THE HARD RULE (CX-13), carried into the strip: a letter grade is a read on
  // evidence only a sized row ever cleared.
  it('an unsized board row shows its real state and NEVER a grade', () => {
    withRouter(
      <ChannelPicksStrip
        picks={[mkPick({ sym: 'AMD' }), mkPick({ sym: 'PLTR' }), mkPick({ sym: 'ASML' })]}
        board={[
          mkRow({ id: 'w', sym: 'AMD', watchOnly: true, horizon: 'week' }),
          mkRow({ id: 'n', sym: 'PLTR', watchOnly: true, nearMiss: true }),
          mkRow({ id: 'o', sym: 'ASML', watchOnly: true, observation: true }),
        ]}
        openCalls={undefined}
      />,
    )
    expect(screen.getByText('watch')).toBeInTheDocument()
    expect(screen.getByText('nearest miss')).toBeInTheDocument()
    expect(screen.getByText('observation')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^grade/i)).not.toBeInTheDocument()
    // …and the row-kind law's own sentence rides along, so the two can't drift
    expect(screen.getByText('nearest miss')).toHaveAttribute('title', unsizedReason('near-miss'))
  })

  it('a wildcard row carries the experiment label and its standing warning', () => {
    withRouter(
      <ChannelPicksStrip
        picks={[mkPick({ sym: 'COIN' })]}
        board={[mkRow({ sym: 'COIN', side: 'short', grade: 'B', wildcard: { gate: 'dead-zone-core', priority: 1, hypothesis: 'h', gateEvidenceN: 7 } })]}
        openCalls={undefined}
      />,
    )
    expect(screen.getByText(WILDCARD_LABEL)).toBeInTheDocument()
    expect(screen.getByText(WILDCARD_WARNING)).toBeInTheDocument()
  })

  it('a name already walking in the open book shows the day and the verdict, in the verdict’s colour', () => {
    const open: OpenTraceEntry = {
      id: 'o1', sym: 'TSLA', side: 'long', callDate: '2026-08-11', grade: 'A', entry: 300, stop: 280, target: 340,
      status: 'in-play', crossedDate: null, last: 312, movePct: 4, progressPct: 30, day: 4, gradesInSessions: 6,
      stage: 'trending', requalified: false, verdict: 'weakening', note: '',
    }
    withRouter(<ChannelPicksStrip picks={[mkPick({ sym: 'TSLA' })]} board={[]} openCalls={[open]} />)
    expect(screen.getByText(/open call · day 4/)).toBeInTheDocument()
    expect(screen.getByText('weakening')).toHaveClass('weak')
    expect(screen.queryByLabelText(/^grade/i)).not.toBeInTheDocument()
  })

  // today's board is the fresher stance: a name on it AND in the open book
  // reads as what the engine says this morning, not what it said last week
  it('prefers today’s board row over the open book', () => {
    const open: OpenTraceEntry = {
      id: 'o1', sym: 'NVDA', side: 'long', callDate: '2026-08-11', grade: 'A', entry: 300, stop: 280, target: 340,
      status: 'in-play', crossedDate: null, last: 312, movePct: 4, progressPct: 30, day: 4, gradesInSessions: 6,
      stage: 'trending', requalified: true, verdict: 'still-on', note: '',
    }
    withRouter(<ChannelPicksStrip picks={[mkPick()]} board={[mkRow({ sym: 'NVDA', grade: 'B' })]} openCalls={[open]} />)
    expect(screen.getByLabelText('Grade B')).toBeInTheDocument()
    expect(screen.queryByText(/open call/)).not.toBeInTheDocument()
  })

  // the channels say "BTC"; the engine trades the pair. Only crypto pairs are
  // aliased — BRK-B's dash is a share class, not a quote currency.
  it('matches a channel’s coin ticker to the engine’s traded pair', () => {
    withRouter(<ChannelPicksStrip picks={[mkPick({ sym: 'BTC' })]} board={[mkRow({ sym: 'BTC-USD', cohort: 'crypto', grade: 'C' })]} openCalls={undefined} />)
    expect(screen.getByLabelText('Grade C')).toBeInTheDocument()
  })

  it('marks a crowded name as crowded — one-sided coverage is a warning, not a signal', () => {
    withRouter(<ChannelPicksStrip picks={[mkPick({ crowded: true })]} board={[]} openCalls={undefined} />)
    expect(screen.getByText('crowded')).toBeInTheDocument()
  })
})

describe('Today', () => {
  it('paints a cached board slice without waiting for the network', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() - 200_000 })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: /today/i })).toBeInTheDocument()
  })

  // THE TIME-AWARENESS LINE (dynamism wave). The board has always carried its
  // own `generatedAt` and no screen printed a character of it; the session
  // state is computed here, client-side, and ticks (parts/SessionLine.tsx owns
  // both, and its own test file pins the clock — this one only checks the seam).
  it('renders the session line under the heading, stamped with the board’s own generatedAt', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    const line = document.querySelector('.session-line')
    expect(line?.textContent).toMatch(/^US /)
    expect(line?.textContent).toContain('board struck')
  })

  it('still says where the session stands on a morning with no board at all', async () => {
    await db.slices.put({ key: 'board', data: { ...mkBoardData([]), board: null }, fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(NO_BOARD_YET)).toBeInTheDocument()
    const line = document.querySelector('.session-line')
    expect(line?.textContent).toMatch(/^US /)
    expect(line?.textContent).not.toContain('board struck')
  })

  // WIRED REFRESH (dynamism wave). `useSlice` has always returned refresh()
  // and `refreshing`, and no screen called either. The gesture itself lives in
  // src/lib/usePullRefresh.test.tsx; this is the seam.
  it('the refresh affordance asks the board slice for fresh bytes and shows it working', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    // the count BEFORE the press — this file shares one module mock across
    // every case, so what matters is the delta the press causes
    const before = vi.mocked(getBoardSlice).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
    await waitFor(() => expect(vi.mocked(getBoardSlice).mock.calls.length).toBe(before + 1))
    // …and the fetch never settles, so the busy bar is still up
    expect(await screen.findByRole('status', { name: /refreshing/i })).toBeInTheDocument()
    expect(screen.getByText('NVDA')).toBeInTheDocument() // the cached paint is untouched
  })

  // NEW SINCE THE LAST VISIT (dynamism wave, feature 7). Keyed on the board's
  // own generatedAt — a re-fetch of the same morning's board is not new.
  it('dots the heading when the board itself turned over since the last visit', async () => {
    const data = mkBoardData([mkRow()])
    data.board!.generatedAt = Date.parse('2026-08-17T05:42:00Z')
    await writeSeenMarks({ boardGeneratedAt: Date.parse('2026-08-14T05:40:00Z'), newsTopAt: null })
    await db.slices.put({ key: 'board', data, fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByLabelText(/new board since your last visit/i)).toBeInTheDocument()
  })

  it('does not dot the same board seen again — nor anything at all on a first visit', async () => {
    const data = mkBoardData([mkRow()])
    data.board!.generatedAt = Date.parse('2026-08-17T05:42:00Z')
    await db.slices.put({ key: 'board', data, fetchedAt: Date.now() })
    const { unmount } = withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.queryByLabelText(/new board/i)).not.toBeInTheDocument() // first visit
    unmount()

    resetSeenMarks()
    await writeSeenMarks({ boardGeneratedAt: Date.parse('2026-08-17T05:42:00Z'), newsTopAt: null })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.queryByLabelText(/new board/i)).not.toBeInTheDocument()
  })

  // THREE HEADLINES (dynamism wave, feature 6), at the seam: the strip's own
  // rules live in parts/TodayHeadlines.test.tsx.
  it('carries the desk’s three newest headlines, and nothing when the desk is cold', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() })
    const { unmount } = withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.queryByLabelText('Headlines')).not.toBeInTheDocument()
    unmount()

    await db.slices.put({
      key: 'intel:news',
      data: [{ title: 'Chipmaker lifts guidance', url: 'https://x.com/1', syms: ['NVDA'], score: 80, why: 'guidance', at: Math.floor(Date.now() / 1000), source: 'Reuters' }],
      fetchedAt: Date.now(),
    })
    withRouter(<Today />)
    expect(await screen.findByLabelText('Headlines')).toBeInTheDocument()
    expect(screen.getByText('Chipmaker lifts guidance')).toBeInTheDocument()
  })

  // THE LIVE LINE, at the seam (dynamism wave). The hook's own rules — the
  // beat, the market-hours gate, saveData, the idle backoff — are pinned in
  // src/lib/useLiveQuotes.test.tsx; here we only prove the cached quote batch
  // reaches the card it belongs to.
  it('feeds each sized card the quote its symbol already has cached', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow({ entry: 130.9 })]), fetchedAt: Date.now() })
    await db.quotes.put({
      key: 'quotes:NVDA',
      data: [{ symbol: 'NVDA', price: 128.4, prevClose: 130, changePct: -1.2, currency: 'USD', todayVolume: null, asOf: 1_755_201_600, source: 'finnhub' }],
      fetchedAt: Date.now(),
    })
    withRouter(<Today />)
    // the label's first word is the reader's own session state, so match the
    // half of the line that is the same at every hour
    await waitFor(() => expect(document.querySelector('.cc-live')?.textContent).toMatch(/128\.40 · 1\.9% below entry$/))
  })

  // THE STALE-BOARD BANNER (dynamism wave). The seeded board is dated
  // 2026-08-14 — a Friday, and permanently in the past — so the banner is the
  // honest read of it whenever this suite runs. parts/StaleBoardNote.test.tsx
  // pins the clock and covers the day arithmetic itself.
  it('labels a board struck on an earlier day, above the cards', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(/Friday's board \(14 Aug/)).toBeInTheDocument()
    expect(screen.getByText(/Friday's board \(14 Aug/)).toHaveClass('stale-board')
  })

  it('says nothing about staleness when the board is today’s', async () => {
    const data = mkBoardData([mkRow()])
    data.board!.date = londonToday()
    await db.slices.put({ key: 'board', data, fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.queryByText(/the engine publishes on weekday mornings/)).not.toBeInTheDocument()
  })

  // A1 (walkthrough): a RESOLVED slice with no board is an answer — the cold
  // store / pre-run morning must say so, never sit on a skeleton forever.
  it('a resolved slice with board:null renders the no-board-yet state, not a skeleton', async () => {
    await db.slices.put({ key: 'board', data: { ...mkBoardData([]), board: null }, fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText(NO_BOARD_YET)).toBeInTheDocument()
    expect(document.querySelector('.skeleton')).toBeNull()
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

  // …and the three new sections, from the ONE slice Today has always read.
  it('mounts the open book and the event radar from the board slice', async () => {
    const data = mkBoardData([mkRow()])
    data.openTrace = {
      date: '2026-08-14',
      generatedAt: Date.now(),
      entries: [
        {
          id: 'o1', sym: 'PLTR', side: 'long', callDate: '2026-08-11', grade: 'A', entry: 30, stop: 28, target: 35,
          status: 'in-play', crossedDate: null, last: 31.2, movePct: 4, progressPct: 24, day: 4, gradesInSessions: 6,
          stage: 'trending', requalified: false, verdict: 'weakening', note: 'thinning',
        },
      ],
    }
    // the print's date is THREE DAYS FROM THE READER'S TODAY, computed rather
    // than hardcoded: the strip counts from the reader's own clock now
    // (dynamism wave), so a fixed date would make this assertion expire
    const inThreeDays = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    data.eventRadar = {
      date: '2026-08-14',
      generatedAt: Date.now(),
      entries: [{ sym: 'AVGO', name: 'Broadcom', date: inThreeDays, daysToPrint: 9, stage: 'trending', entryQuality: null, rs21: null, note: null }],
    }
    await db.slices.put({ key: 'board', data, fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByLabelText('Open calls')).toBeInTheDocument()
    expect(screen.getByText('weakening')).toHaveClass('weak')
    expect(screen.getByLabelText('Event radar')).toBeInTheDocument()
    expect(screen.getByText('reports in 3d')).toBeInTheDocument()
  })

  it('renders neither section — and does not crash — when the slice carries neither', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.queryByLabelText('Open calls')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Event radar')).not.toBeInTheDocument()
  })

  // THE CHANNELS' PICKS (owner request), from the same one slice — and read
  // against the board rows and the open book already in it.
  it('mounts the channels’ picks and pairs each name with the engine’s own stance', async () => {
    const data = mkBoardData([mkRow({ sym: 'NVDA', grade: 'A' })])
    data.channelPicks = [
      { sym: 'NVDA', mentions7d: 4, mentionsPrior7d: 1, channels: 3, bulls: 3, bears: 1, net: 2, crowded: false, shifted: false },
      { sym: 'GME', mentions7d: 2, mentionsPrior7d: 0, channels: 2, bulls: 2, bears: 0, net: 2, crowded: false, shifted: false },
    ]
    await db.slices.put({ key: 'board', data, fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByLabelText('Channel picks')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'GME' })).toBeInTheDocument()
    expect(screen.getByText('no view')).toBeInTheDocument() // GME — the engine has no read
    expect(screen.getAllByLabelText('Grade A').length).toBeGreaterThan(0) // NVDA — it does
  })

  it('renders no picks section when the slice predates the field', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() })
    withRouter(<Today />)
    expect(await screen.findByText('NVDA')).toBeInTheDocument()
    expect(screen.queryByLabelText('Channel picks')).not.toBeInTheDocument()
  })

  it('prints the tape line — the world tape’s own sentence plus the day’s news tone', async () => {
    const data = mkBoardData([mkRow()])
    data.board!.worldTape = { tone: 'risk-on', votes: { on: 3, off: 1 }, detail: 'Breadth firm, credit calm' }
    data.board!.newsTone = { score: 0.4, label: 'constructive', hits: 12 }
    await db.slices.put({ key: 'board', data, fetchedAt: Date.now() })
    withRouter(<Today />)
    const line = await screen.findByText(/Breadth firm, credit calm/)
    expect(line).toHaveTextContent(/news tone: constructive/)
    expect(line).toHaveClass('today-tape')
  })

  it('prints no tape line at all when the board blob carries neither reading', async () => {
    await db.slices.put({ key: 'board', data: mkBoardData([mkRow()]), fetchedAt: Date.now() })
    withRouter(<Today />)
    await screen.findByText('NVDA')
    expect(document.querySelector('.today-tape')).toBeNull()
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
