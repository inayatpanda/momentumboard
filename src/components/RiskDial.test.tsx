import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RiskDial } from './RiskDial'
import type { EngineData } from '../lib/api'

const riskState: EngineData['riskState'] = {
  rung: 1,
  sinceDate: '2026-06-20',
  gradedAtRung: 12,
  history: [{ date: '2026-06-20', from: 0, to: 1, evidence: '3 straight graded hits at R0' }],
}

describe('RiskDial', () => {
  it('shows the current rung, its per-idea risk %, graded count and last-change evidence', () => {
    const { container } = render(<RiskDial riskState={riskState} />)
    expect(screen.getByText(/R1 · 1\.25% per idea/)).toBeInTheDocument()
    // all four rung markers render
    expect(container.querySelectorAll('.risk-rung').length).toBe(4)
    // the current rung is the lit one
    expect(container.querySelector('.risk-rung.is-current')!.textContent).toContain('R1')
    expect(screen.getByText(/12 graded at R1/)).toBeInTheDocument()
    expect(screen.getByText(/R0→R1 — 3 straight graded hits at R0/)).toBeInTheDocument()
  })

  it('renders nothing without risk state', () => {
    const { container } = render(<RiskDial riskState={null} />)
    expect(container.firstChild).toBeNull()
  })
})
