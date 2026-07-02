import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EngineReadStrip, EngineFactors } from './EngineRead'
import { technicalStage } from '../../shared/technicals'
import type { Candle } from '../../shared/types'
import type { EnginePrediction } from '../lib/api'

// A deterministic rising fixture — 120 daily bars, gentle uptrend — so the
// client-side read is non-null and stable.
function risingCandles(n = 120): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const c = 100 + i * 0.5
    const o = i === 0 ? c : 100 + (i - 1) * 0.5
    out.push({
      t: 1_600_000_000 + i * 86400,
      o,
      h: Math.max(o, c) * 1.01,
      l: Math.min(o, c) * 0.99,
      c,
      v: 1_000_000 + (i % 5) * 100_000,
    })
  }
  return out
}

const call: EnginePrediction = {
  id: '2026-07-02:NVDA:short',
  sym: 'NVDA',
  side: 'short',
  composite: -38.9,
  probability: 0.67,
  provisional: false,
  grade: 'A',
  expectedMovePct: 6.1,
  entry: 162,
  stop: 178.2,
  target: 145.8,
  capacityPct: 9.1,
  smallCap: false,
  earningsRisk: false,
  stage: 'weak',
  note: 'technical: weak',
  riskRung: 0,
  riskPct: 1,
  instrument: null,
  paperOnly: true,
  factors: {
    momentum: { score: -30, detail: '21d RS vs SPY -20.6pp', weight: 2 },
    technical: { score: -10, detail: 'below the 50-day', weight: 1 },
    quiet: { score: null, detail: 'no signal', weight: 1 },
  },
}

describe('EngineReadStrip', () => {
  it('renders the client-side read (stage + note) from a fixture candle set', () => {
    const read = technicalStage('TEST', risingCandles())
    expect(read).not.toBeNull()
    render(<EngineReadStrip read={read} />)
    expect(screen.getByText('Engine read')).toBeInTheDocument()
    // the plain-English note is drawn verbatim next to the tape
    expect(screen.getByText(read!.note)).toBeInTheDocument()
    // the rising fixture reads as a trending / neutral entry
    expect(screen.getByText('Trending')).toBeInTheDocument()
  })

  it('renders nothing when there is no read', () => {
    const { container } = render(<EngineReadStrip read={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('EngineFactors', () => {
  it('renders grade, probability, composite, capacity and weight-sorted factor rows for a live call', () => {
    render(<EngineFactors call={call} hasRead />)
    expect(screen.getByText('NVDA')).toBeInTheDocument()
    expect(screen.getByLabelText('Grade A')).toBeInTheDocument()
    expect(screen.getByText(/67%/)).toBeInTheDocument()
    expect(screen.getByText(/composite -38.9/)).toBeInTheDocument()
    expect(screen.getByText(/capacity 9.1%/)).toBeInTheDocument()
    // per-factor rows carry the signed score + detail; null-score factors drop out
    expect(screen.getByText(/21d RS vs SPY -20.6pp/)).toBeInTheDocument()
    expect(screen.getByText(/below the 50-day/)).toBeInTheDocument()
    expect(screen.queryByText(/no signal/)).not.toBeInTheDocument()
  })

  it('weights-sorts factors so the heaviest evidence leads', () => {
    render(<EngineFactors call={call} hasRead />)
    const rows = document.querySelectorAll('.engine-factor-row')
    // |−30 × 2| = 60 (momentum) outranks |−10 × 1| = 10 (technical)
    expect(rows[0].textContent).toContain('momentum')
    expect(rows[1].textContent).toContain('technical')
  })

  it('falls back to a muted one-liner when there is a read but no live call', () => {
    render(<EngineFactors call={null} hasRead />)
    expect(screen.getByText(/no live engine call/i)).toBeInTheDocument()
  })

  it('renders nothing when there is neither a call nor a read', () => {
    const { container } = render(<EngineFactors call={null} hasRead={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
