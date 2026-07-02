import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  it('shows the world-tape header strip when the board provides one', async () => {
    render(<EngineBoard />)
    await waitFor(() => expect(screen.getByText(/Asia red, VIX bid/)).toBeInTheDocument())
    expect(screen.getByText(/world tape risk-off/)).toBeInTheDocument()
    expect(screen.getByText(/news cautious/)).toBeInTheDocument()
  })
})
