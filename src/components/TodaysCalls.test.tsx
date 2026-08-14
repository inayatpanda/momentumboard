import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TodaysCalls, visibleCalls } from './TodaysCalls'
import { fmtRiskPct } from '../lib/format'
import type { EnginePrediction } from '../lib/api'

const row = (over: Partial<EnginePrediction> & { sym: string }): EnginePrediction =>
  ({
    id: `2026-08-11:${over.sym}:${over.side ?? 'long'}`,
    side: 'long',
    composite: 30,
    probability: 0.6,
    provisional: false,
    grade: 'B',
    expectedMovePct: 5,
    entry: 10,
    stop: 9,
    target: 12,
    capacityPct: 8,
    smallCap: false,
    earningsRisk: false,
    stage: 'trending',
    note: 'n',
    riskRung: 1,
    riskPct: 1,
    instrument: null,
    paperOnly: false,
    factors: {},
    ...over,
  }) as EnginePrediction

describe('visibleCalls — the six-row cut never silences a side', () => {
  it('trades lead, watch rows fill the rest', () => {
    const board = [row({ sym: 'W1', watchOnly: true }), row({ sym: 'T1' }), row({ sym: 'T2' })]
    expect(visibleCalls(board).map(p => p.sym)).toEqual(['T1', 'T2', 'W1'])
  })

  it('a lone SHORT keeps a slot even when six longs would fill the card', () => {
    const board = [
      ...Array.from({ length: 6 }, (_, i) => row({ sym: `L${i}` })),
      row({ sym: 'SHORTY', side: 'short', watchOnly: true }),
    ]
    const shown = visibleCalls(board)
    expect(shown).toHaveLength(6)
    expect(shown.some(p => p.side === 'short')).toBe(true) // the side is NOT cut away
    expect(shown.filter(p => p.side === 'long')).toHaveLength(5) // it cost the weakest long its slot
    expect(shown[0].sym).toBe('L0') // …and the strongest rows are untouched
  })

  it('mirrors: a lone LONG survives a board of shorts', () => {
    const board = [
      ...Array.from({ length: 8 }, (_, i) => row({ sym: `S${i}`, side: 'short' })),
      row({ sym: 'LONELY', side: 'long', watchOnly: true }),
    ]
    const shown = visibleCalls(board)
    expect(shown.some(p => p.side === 'long')).toBe(true)
    expect(shown).toHaveLength(6)
  })

  it('a one-sided board is left exactly as it was', () => {
    const board = Array.from({ length: 3 }, (_, i) => row({ sym: `L${i}` }))
    expect(visibleCalls(board).map(p => p.sym)).toEqual(['L0', 'L1', 'L2'])
  })

  it('an empty board stays empty', () => {
    expect(visibleCalls([])).toEqual([])
  })
})

describe('fmtRiskPct', () => {
  it('rounds a halved rung risk to 2dp instead of printing 0.625%', () => {
    expect(fmtRiskPct(0.625)).toBe('0.63')
    expect(fmtRiskPct(0.375)).toBe('0.38')
  })

  it('leaves clean numbers clean — no trailing zeros bolted on', () => {
    expect(fmtRiskPct(1)).toBe('1')
    expect(fmtRiskPct(1.5)).toBe('1.5')
    expect(fmtRiskPct(0)).toBe('0')
  })
})

// ---- the rendered card: counters and empty-side copy ----

const board: { date: string; generatedAt: number; regime: string; board: EnginePrediction[]; emptySides?: Record<string, string> } = {
  date: new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }),
  generatedAt: 1,
  regime: 'amber',
  board: [],
}
vi.mock('../lib/api', () => ({ getEngine: () => Promise.resolve({ board }) }))

describe('TodaysCalls — what the footer counts and what the copy claims', () => {
  it('"+N more" counts CALLS: a near miss cleared no gate and is not one', async () => {
    board.board = [
      ...Array.from({ length: 6 }, (_, i) => row({ sym: `L${i}` })),
      row({ sym: 'WATCHED', watchOnly: true }),
      row({ sym: 'NM1', nearMiss: true, watchOnly: true, riskPct: 0 }),
      row({ sym: 'NM2', nearMiss: true, watchOnly: true, riskPct: 0 }),
    ]
    board.emptySides = undefined
    render(<TodaysCalls onOpen={() => {}} />)
    // nine rows, six shown — but only ONE of the three unshown rows is a call
    await waitFor(() => expect(screen.getByText(/\+1 more on the full board/)).toBeInTheDocument())
  })

  it('names the ISA route when routing is what emptied a side, not the gates', async () => {
    board.board = [row({ sym: 'L0' })]
    board.emptySides = { short: 'no-route' }
    render(<TodaysCalls onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Nothing tradeable on the short side today/)).toBeInTheDocument())
    expect(screen.getByText(/no ISA route/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing cleared the gates/)).toBeNull()
  })
})

// THE VOICE (voice.ts). The card leads with what the engine believes and what
// would end it; the machine-voiced factor line stays beneath it as the evidence.
describe('TodaysCalls — the thesis leads, the evidence line survives', () => {
  it('shows the thesis above the note when the row has one', async () => {
    const spoken = row({
      sym: 'ABBV',
      note: 'technical: pullback · momentum: +6.4pp',
      thesis: 'Long ABBV — it has pulled back into support with volume behind it. Wrong if it closes below 178.2.',
    })
    board.board = [spoken]
    board.emptySides = undefined
    render(<TodaysCalls onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABBV')).toBeInTheDocument())
    expect(screen.getByText(spoken.thesis!)).toBeInTheDocument()
    expect(screen.getByText(spoken.note)).toBeInTheDocument() // …and the evidence line is still there
  })

  it('a row with no thesis still shows its note — a near miss has no belief to state', async () => {
    const miss = row({ sym: 'MISS', nearMiss: true, watchOnly: true, riskPct: 0, note: 'nearest miss — the engine looked and said no' })
    board.board = [miss]
    board.emptySides = undefined
    render(<TodaysCalls onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('MISS')).toBeInTheDocument())
    expect(screen.getByText(miss.note)).toBeInTheDocument()
    expect(screen.queryByText(/Wrong if it closes/)).toBeNull()
  })
})

// THE EXPERIMENT, ON THE CARD THE READER ACTUALLY OPENS FIRST (Stage 3d fix
// wave). EngineBoard has carried the chip since the slot shipped; this is the
// watchlist card, and a wildcard shown here without it is a quarter-size bet on
// a row the engine's own gates refused, printed as if it were an ordinary call.
describe('TodaysCalls — the wildcard is chipped here too', () => {
  const wild = () =>
    row({ sym: 'WILD', riskPct: 0.25, wildcard: { gate: 'expected-move', priority: 1, hypothesis: 'testing the gate', gateEvidenceN: 0 } })

  it('shows the 🃏 chip and names the gate under test', async () => {
    board.board = [wild()]
    board.emptySides = undefined
    render(<TodaysCalls onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('🃏 wildcard')).toBeInTheDocument())
    expect(screen.getByText('🃏 wildcard').getAttribute('title')).toContain('expected-move')
  })

  it('…on that row and no other, and a board without one shows no chip at all', async () => {
    board.board = [wild(), row({ sym: 'ORDINARY' })]
    board.emptySides = undefined
    const { unmount } = render(<TodaysCalls onOpen={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('🃏 wildcard')).toHaveLength(1))
    unmount()

    board.board = [row({ sym: 'ORDINARY' })]
    render(<TodaysCalls onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('ORDINARY')).toBeInTheDocument())
    expect(screen.queryByText('🃏 wildcard')).toBeNull()
  })
})
