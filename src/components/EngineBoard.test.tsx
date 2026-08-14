import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EngineBoard } from './EngineBoard'
import type { EngineData } from '../lib/api'

const prediction = {
  id: '2026-07-02:NVDA:short',
  sym: 'NVDA',
  side: 'short' as const,
  composite: -38.9,
  probability: 0.67,
  provisional: false,
  grade: 'A' as const,
  expectedMovePct: 6.1,
  entry: 162,
  stop: 178.2,
  target: 145.8,
  capacityPct: 9.1,
  smallCap: false,
  earningsRisk: false,
  stage: 'weak',
  note: 'technical: weak · momentum: 21d RS vs SPY -20.6pp',
  riskRung: 0,
  riskPct: 1,
  instrument: null,
  paperOnly: true,
  factors: { technical: { score: -30, detail: 'weak', weight: 1 } },
}

const data: EngineData = {
  board: {
    date: '2026-07-02',
    generatedAt: 1,
    regime: 'amber',
    board: [prediction],
    worldTape: { tone: 'risk-off', votes: { on: 1, off: 4 }, detail: 'Asia red, VIX bid' },
    newsTone: { score: -0.3, label: 'cautious', hits: 12 },
  },
  scorecard: null,
  weights: null,
  calibration: null,
  riskState: null,
  roster: null,
  channelCred: {},
}

vi.mock('../lib/api', () => ({ getEngine: () => Promise.resolve(data) }))

describe('EngineBoard', () => {
  it('renders a call with grade, probability, levels and paper-only tag', async () => {
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument())
    expect(screen.getByText(/67%/)).toBeInTheDocument()
    expect(screen.getByText(/stop 178.2/)).toBeInTheDocument()
    expect(screen.getByText(/paper-only/)).toBeInTheDocument()
  })

  // a halved rung risk is 1.25 / 2 = 0.625 — a number no card should print raw
  it('rounds a halved risk to 2dp rather than printing 0.625%', async () => {
    data.board!.board = [{ ...prediction, riskRung: 1, riskPct: 0.625, paperOnly: false }]
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText(/risk 0.63%/)).toBeInTheDocument())
    expect(screen.getByText(/half size/)).toBeInTheDocument()
    expect(screen.queryByText(/0.625/)).toBeNull()
    data.board!.board = [prediction] // restore for any later test
  })

  it('shows the world-tape header strip when the board provides one', async () => {
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText(/Asia red, VIX bid/)).toBeInTheDocument())
    expect(screen.getByText(/world tape risk-off/)).toBeInTheDocument()
    expect(screen.getByText(/news cautious/)).toBeInTheDocument()
  })

  // The copy has to match the REASON the engine recorded. "Nothing cleared the
  // gates" on a side emptied by routing is simply false, and the reader can see
  // the graded observation sitting right underneath it.
  it('says the side has no ISA route when that is what emptied it', async () => {
    data.board!.emptySides = { short: 'no-route' }
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText(/no ISA route/)).toBeInTheDocument())
    expect(screen.getByText(/Nothing tradeable on the short side today/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing cleared the gates/)).toBeNull()
    delete data.board!.emptySides
  })

  // A promoted observation is watch-only, so it fell into "Watch — short-term
  // observations", whose line says its rows sit "below the sizing bar". This row
  // cleared the sizing bar and every gate above it; the only thing it lacks is a
  // route. Filed under that heading, the board explained it with someone else's
  // reason — the same leak the paper and the PDF had.
  it('gives a route-blocked observation its own section instead of filing it under thin-evidence watch rows', async () => {
    data.board!.board = [
      { ...prediction, id: 'obs', sym: 'OBS', watchOnly: true, riskPct: 0, paperOnly: false, observation: true, horizon: 'week' as const },
      { ...prediction, id: 'wtch', sym: 'WTCH', watchOnly: true, riskPct: 0, paperOnly: false, horizon: 'week' as const },
    ]
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('Observations — no ISA route')).toBeInTheDocument())
    expect(screen.getByText(/Cleared every gate and fully graded/)).toBeInTheDocument()
    expect(screen.getByText('no ISA route — observation only')).toBeInTheDocument()
    // the ordinary watch row still gets its own heading and its own honest reason
    expect(screen.getByText('Watch — short-term observations')).toBeInTheDocument()
    expect(screen.getByText('watch — no size')).toBeInTheDocument()
    data.board!.board = [prediction]
  })

  // THE EXPERIMENT (Stage 3d). This row is on the board BECAUSE a gate refused
  // it — quarter-size reader money buying the engine one causal outcome — so a
  // card that looked like every other card would have mis-sold it.
  it('badges a wildcard as an experiment, and leaves every ordinary row unbadged', async () => {
    data.board!.board = [
      {
        ...prediction,
        id: 'wild',
        sym: 'WILD',
        riskPct: 0.25,
        paperOnly: false,
        thesis: '🃏 Wildcard · Short WILD — quarter size, testing a gate: expected-move has 0 priced outcomes. Experiments lose more often than the board does. Wrong if it closes above 178.2.',
        wildcard: { gate: 'expected-move', priority: 1, hypothesis: 'expected-move has 0 priced outcomes.', gateEvidenceN: 0 },
      },
      prediction,
    ]
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('🃏 wildcard')).toBeInTheDocument())
    expect(screen.getAllByText('🃏 wildcard')).toHaveLength(1) // the ordinary row beside it is untouched
    expect(screen.getByText('🃏 wildcard').getAttribute('title')).toContain('expected-move')
    // the warning is not a badge — it rides the row's own sentence, where a
    // reader cannot miss it
    expect(screen.getByText(/Experiments lose more often than the board does/)).toBeInTheDocument()
    data.board!.board = [prediction]
  })

  it('names no observation section when the board has none', async () => {
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument())
    expect(screen.queryByText('Observations — no ISA route')).toBeNull()
  })

  it('keeps the gates wording when the gates really are what emptied the side', async () => {
    data.board!.emptySides = { long: 'gates' }
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText(/Nothing cleared the gates on the long side today/)).toBeInTheDocument())
    expect(screen.queryByText(/no ISA route/)).toBeNull()
    delete data.board!.emptySides
  })
  // THE VOICE (voice.ts). The board used to lead with `note` — the machine's own
  // factor names in front of a reader. The thesis leads now; the note survives
  // as the evidence line, one tap down, exactly where the breakdown belongs.
  it('leads with the thesis, and keeps the factor line behind the evidence toggle', async () => {
    data.board!.board = [{ ...prediction, thesis: 'Short NVDA — the chart is broken. Wrong if it closes above 178.2.', falsifier: 'Wrong if it closes above 178.2.' }]
    const { container } = render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument())
    expect(screen.getByText('Short NVDA — the chart is broken. Wrong if it closes above 178.2.')).toBeInTheDocument()
    expect(screen.queryByText(/technical: weak/)).toBeNull() // still behind the toggle
    // the node is marked, so the row that has NO thesis can be shown to have no
    // node rather than merely no matching text
    expect(container.querySelector('[data-thesis]')?.textContent).toBe('Short NVDA — the chart is broken. Wrong if it closes above 178.2.')
    data.board!.board = [prediction]
  })

  it('a row with no thesis renders exactly as it did — near misses have none', async () => {
    const { container } = render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument())
    expect(screen.getByText(/stop 178.2/)).toBeInTheDocument()
    // "exactly as it did" has to mean the thesis node is ABSENT, not merely that
    // the levels line survived: an empty div in its place is a gap above the
    // levels on every card the engine did not speak for, and `undefined` rendered
    // as text is the same bug with a word in it.
    expect(container.textContent).not.toContain('undefined')
    expect(container.querySelector('[data-thesis]')).toBeNull()
  })

  it('warns about daily decay on a GEARED route only — a 1× tracker is the asset, and telling a reader it decays is false [1c-R]', async () => {
    // the warning lives behind the evidence toggle, so each arm opens it first
    data.board!.board = [{ ...prediction, instrument: { ticker: '3NVD.L', leverage: 2 } }]
    const geared = render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument())
    fireEvent.click(screen.getByText('evidence'))
    expect(screen.getByText(/decay daily — max hold 10 sessions/)).toBeInTheDocument()
    geared.unmount()

    data.board!.board = [{ ...prediction, sym: 'BTC-USD', id: '2026-07-02:BTC-USD:short', instrument: { ticker: 'XBTS.L', leverage: 1 }, paperOnly: false }]
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText('BTC-USD')).toBeInTheDocument())
    fireEvent.click(screen.getByText('evidence'))
    expect(screen.getByText(/XBTS.L 1x/)).toBeInTheDocument() // the route IS shown…
    expect(screen.queryByText(/decay daily/)).toBeNull() // …the false decay clock is not
    data.board!.board = [prediction]
  })
})
