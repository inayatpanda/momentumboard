import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import type { EngineLabSnapshot, StrategyObservation } from '../../../shared/engine/strategyLab'
import { StrategyLabPanel } from './StrategyLabPanel'

const short: StrategyObservation = {
  id: 'short:GOOGL:2026-08-21',
  sleeve: 'short-horizon',
  sym: 'GOOGL',
  side: 'long',
  state: 'setup',
  score: 73,
  entry: 201,
  stop: null,
  target: null,
  detectedAt: 1,
  availableAt: 1,
  reasons: ['similar historical states finished higher 7 times', 'volume is expanding'],
  risks: ['earnings are inside the forecast window'],
  dataGaps: ['social breadth not confirmed'],
  metrics: {},
  forecast: {
    definition: 'three-session-direction-v1',
    label: 'three-session direction',
    horizonSessions: 3,
    probabilityUp: 0.64,
    probabilityDown: 0.29,
    probabilityFlat: 0.07,
    expectedMovePct: 1.8,
    expectedLowPct: -1.2,
    expectedHighPct: 4.6,
    calibratedN: 18,
    provisional: false,
  },
}

const lab: EngineLabSnapshot = {
  version: 2,
  date: '2026-08-21',
  generatedAt: 1,
  mode: 'shadow',
  cadence: 'daily',
  sleeves: [
    { key: 'short-horizon', label: '2–3 day direction', status: 'shadow', purpose: 'short read', evidenceN: 18, promotionRule: 'earn calibration' },
    { key: 'composite-control', label: 'Main engine', status: 'control', purpose: 'board', evidenceN: 144, promotionRule: 'control' },
  ],
  observations: [short],
}

const mount = () => render(
  <Router base="/app" hook={memoryLocation({ path: '/app/' }).hook}>
    <StrategyLabPanel lab={lab} />
  </Router>,
)

describe('StrategyLabPanel', () => {
  it('shows an honest first-run placeholder instead of hiding the new engine', () => {
    render(<StrategyLabPanel lab={null} />)
    expect(screen.getByLabelText('Research lab')).toHaveTextContent('waiting for its first post-upgrade engine run')
    expect(screen.getByLabelText('Forecast sleeves awaiting first run')).toHaveTextContent('Social ignition')
  })

  it('surfaces sleeve status and its independently matured evidence', () => {
    mount()
    const statuses = screen.getByLabelText('Strategy sleeve status')
    expect(within(statuses).getByText('2–3 day direction')).toBeInTheDocument()
    expect(within(statuses).getByText('18 matured')).toBeInTheDocument()
    expect(within(statuses).getByText('144 matured')).toBeInTheDocument()
  })

  it('shows the forecast, reasons, risk, missing evidence and stock link', () => {
    mount()
    const panel = screen.getByLabelText('Research lab')
    expect(panel).toHaveTextContent('Up 64%')
    expect(panel).toHaveTextContent('Down 29%')
    expect(panel).toHaveTextContent('Range -1.2% to +4.6%')
    expect(panel).toHaveTextContent('similar historical states finished higher 7 times')
    expect(panel).toHaveTextContent('earnings are inside the forecast window')
    expect(panel).toHaveTextContent('social breadth not confirmed')
    expect(within(panel).getByRole('link')).toHaveAttribute('href', '/app/stock/GOOGL')
  })
})
