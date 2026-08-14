import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Ledger } from './Ledger'
import type { LedgerPrediction } from '../lib/api'

// THE LEDGER TABLE IS A SURFACE THE READER IS SENT TO JUDGE THE ENGINE BY.
// Every row already says whether it was a shadow (" sh"), because a suppressed
// call and a taken one are not the same claim. A wildcard is the other row that
// is not an ordinary call — quarter size, published on a trade the engine's own
// gates refused — and until the final review of Stage 3d it sat in this table
// wearing nothing but the letter C it never earned. Same convention, same column.

const pred = (over: Partial<LedgerPrediction> & { id: string }): LedgerPrediction =>
  ({
    date: '2026-08-11',
    sym: 'SOFI',
    side: 'long',
    grade: 'C',
    probability: 0.5,
    provisional: false,
    shadow: false,
    composite: 20,
    entry: 14.8,
    stop: 13.9,
    target: 17.2,
    expectedMovePct: 6,
    stage: 'trending',
    regime: 'amber',
    earningsRisk: false,
    instrument: null,
    paperOnly: false,
    ...over,
  }) as LedgerPrediction

const ledger: { predictions: LedgerPrediction[] }[] = [{ predictions: [] }]
vi.mock('../lib/api', () => ({ getEngine: () => Promise.resolve({ ledger }) }))

describe('the ledger row marks the experiment beside the shadow', () => {
  it('a wildcard row wears 🃏 and names the gate under test', async () => {
    ledger[0].predictions = [pred({ id: 'w', sym: 'WILD', wildcard: { gate: 'expected-move', priority: 1, hypothesis: 'h', gateEvidenceN: 0 } })]
    render(<Ledger onBack={() => {}} onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('WILD')).toBeInTheDocument())
    expect(screen.getByText('🃏')).toBeInTheDocument()
    expect(screen.getByText('🃏').getAttribute('title')).toContain('expected-move')
  })

  it('an ordinary row and a shadow are untouched', async () => {
    ledger[0].predictions = [pred({ id: 'o', sym: 'PLAIN' }), pred({ id: 's', sym: 'SHADE', shadow: true })]
    render(<Ledger onBack={() => {}} onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('PLAIN')).toBeInTheDocument())
    expect(screen.getByText('sh')).toBeInTheDocument() // the convention it stands beside
    expect(screen.queryByText('🃏')).toBeNull()
  })

  it('a shadowed wildcard says both — it was declined AND it was the experiment', async () => {
    ledger[0].predictions = [pred({ id: 'sw', sym: 'BOTH', shadow: true, wildcard: { gate: 'entry-wait', priority: 1, hypothesis: 'h', gateEvidenceN: 0 } })]
    render(<Ledger onBack={() => {}} onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('BOTH')).toBeInTheDocument())
    expect(screen.getByText('sh')).toBeInTheDocument()
    expect(screen.getByText('🃏')).toBeInTheDocument()
  })
})
