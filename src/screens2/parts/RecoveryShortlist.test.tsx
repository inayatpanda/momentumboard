import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import type { EngineLabSnapshot, StrategyObservation } from '../../../shared/engine/strategyLab'
import { RecoveryShortlist } from './RecoveryShortlist'

const row = (sym: string, state: StrategyObservation['state']): StrategyObservation => ({
  id: sym, sym, sleeve: 'quality-dip', side: 'long', state, score: 70, entry: 100, stop: 90, target: 120,
  detectedAt: 1, availableAt: 1, reasons: [], risks: [], dataGaps: [],
  metrics: { financialHealth: 'unknown', drawdownPct: -18, reportTrend: 'stable', reportObservations: 3 },
  forecast: { definition: 'target-before-stop-v1', horizonSessions: 63, label: 'Recovery scenario', provisional: true, calibratedN: 0 },
})
const lab = (observations: StrategyObservation[]): EngineLabSnapshot => ({ version: 2, date: '2026-10-21', generatedAt: 1, mode: 'shadow', cadence: 'daily', sleeves: [], observations })

describe('recovery shortlist', () => {
  it('shows missing evidence, excludes refused ideas and opens the matching stock/research', () => {
    const onResearch = vi.fn()
    render(<Router base="/app" hook={memoryLocation({ path: '/app/today' }).hook}>
      <RecoveryShortlist lab={lab([row('REVIEW', 'watch'), row('REFUSED', 'avoid')])} onResearch={onResearch} />
    </Router>)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/app/stock/REVIEW')
    expect(screen.getByText('Financial evidence needs review')).toBeInTheDocument()
    expect(screen.queryByText('REFUSED')).not.toBeInTheDocument()
    expect(screen.getByText(/1\/5 checks met/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /View research/ }))
    expect(onResearch).toHaveBeenCalledOnce()
  })

  it('explains an empty screen instead of inventing a candidate', () => {
    render(<RecoveryShortlist lab={lab([])} onResearch={() => {}} />)
    expect(screen.getByText(/No recovery candidate currently meets/)).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
