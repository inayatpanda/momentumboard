import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EnginePanel } from './EnginePanel'
import type { EngineData, LedgerPrediction } from '../lib/api'

const base: LedgerPrediction = {
  id: '', date: '2026-07-01', sym: '', side: 'long', grade: 'B', probability: 0.61,
  provisional: false, shadow: false, composite: 42, entry: 100, stop: 94, target: 112,
  expectedMovePct: 6, stage: 'early-reversal', regime: 'green', earningsRisk: false,
  instrument: null, paperOnly: false, note: 'technical: base breakout',
}

const hit: LedgerPrediction = {
  ...base, id: '2026-07-01:AAPL:long', sym: 'AAPL',
  outcome5: { excessPct: 3.2, rawPct: 4.1, spyPct: 0.9, stopped: false, hit: true },
}
const stoppedMiss: LedgerPrediction = {
  ...base, id: '2026-07-01:TSLA:short', sym: 'TSLA', side: 'short', grade: 'A',
  outcome5: { excessPct: -1.8, rawPct: -1.2, spyPct: 0.6, stopped: true, hit: false },
}
const shadow: LedgerPrediction = {
  ...base, id: '2026-07-01:GME:long', sym: 'GME', grade: 'C', shadow: true,
}

const data: EngineData = {
  board: null,
  ledger: [{ date: '2026-07-01', predictions: [hit, stoppedMiss, shadow] }],
  scorecard: null,
  weights: null,
  calibration: null,
  riskState: null,
  roster: null,
  channelCred: {},
}

vi.mock('../lib/api', () => ({ getEngine: () => Promise.resolve(data) }))

describe('EnginePanel — the Ledger', () => {
  it('renders a graded prediction with its hit trail visible', async () => {
    render(<EnginePanel />)
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument())
    expect(screen.getByText(/\+3\.2 hit/)).toBeInTheDocument()
    // the 10d horizon never matured
    expect(screen.getAllByText(/pending/).length).toBeGreaterThan(0)
  })

  it('renders a stopped miss plainly', async () => {
    render(<EnginePanel />)
    await waitFor(() => expect(screen.getByText('TSLA')).toBeInTheDocument())
    expect(screen.getByText(/−1\.8 miss/)).toBeInTheDocument()
    expect(screen.getByText('stopped')).toBeInTheDocument()
  })

  it('hides shadows by default and reveals them on toggle', async () => {
    render(<EnginePanel />)
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument())
    expect(screen.queryByText('GME')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /reveal shadows/i }))
    expect(screen.getByText('GME')).toBeInTheDocument()
  })
})
