import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { EnginePanel } from './EnginePanel'
import type { EngineData } from '../lib/api'
import { missLedgerSummary, emptyMissLedger, accrueCausalOutcome, accrueMissEvent, recordMissDay } from '../../shared/engine/missLedger'

// THE CAUSAL LINE (Stage 3d). The line above it — "misses, worst gate" — is a
// stopless upper bound on trades nobody took. This one is the opposite kind of
// number entirely: rows the engine's own gate refused, taken anyway at a quarter
// of the rung with a real stop, and what actually happened. The panel prints them
// as two separate rows on purpose; folding the second into the first would make
// the stronger claim read as more of the weaker one.
const ledger = (() => {
  const l = emptyMissLedger()
  accrueMissEvent(l, { date: '2026-08-03', sym: 'GLW', side: 'long', excessPct: 8, gate: 'dead-zone-core' })
  accrueCausalOutcome(l, { date: '2026-08-03', sym: 'ACME', side: 'long', excessPct: 7.4, gate: 'dead-zone-core', hit: true })
  accrueCausalOutcome(l, { date: '2026-08-07', sym: 'BETA', side: 'short', excessPct: -3.1, gate: 'dead-zone-core', hit: false })
  recordMissDay(l, '2026-08-03', { checked: 30, unchecked: 2, misses: 1 })
  return l
})()

const data: EngineData = {
  board: null,
  ledger: [],
  scorecard: null,
  missLedger: missLedgerSummary(ledger),
  weights: null,
  calibration: null,
  riskState: null,
  roster: null,
  channelCred: {},
}

vi.mock('../lib/api', () => ({ getEngine: () => Promise.resolve(data) }))

describe('EnginePanel — what the experiment slot has actually taken', () => {
  it('prints the causal record per gate, as its own line beside the stopless one', async () => {
    render(<EnginePanel />)
    await waitFor(() => expect(screen.getByText('🃏 Wildcard vs dead-zone-core')).toBeInTheDocument())
    const line = screen.getByText('🃏 Wildcard vs dead-zone-core').closest('.perf-row')!
    expect(line.textContent).toContain('1/2 paid')
    // the caveat says what makes this number different from the one above it
    expect(line.getAttribute('title')).toMatch(/Real outcomes, not upper bounds/)
    // …and the stopless line is still there, unchanged and separate
    expect(screen.getByText(/worst gate/).textContent).toContain('cost 1')
  })
})

// THE SCORECARD'S OWN KEY (Stage 3d fix wave). The experiment never joins a
// letter — its grade is not why it published — so it gets a key of its own, the
// way a shadow already does. Both are populations that carry no reader
// conviction, and neither may be printed as a tier it never earned.
describe('EnginePanel — the experiments have their own line on the scorecard', () => {
  it('names the wildcard key instead of inventing a grade called "wildcard"', async () => {
    data.scorecard = {
      byGrade: {
        A: { n: 4, hits: 3, sumExcess: 12 },
        shadow: { n: 2, hits: 1, sumExcess: 1 },
        wildcard: { n: 2, hits: 1, sumExcess: 4 },
      },
      byRegime: {},
      bySetup: {},
      overlays: {},
      brierTail: [],
      totalGraded: 8,
      updatedAt: 1,
    } as unknown as EngineData['scorecard']
    render(<EnginePanel />)
    await waitFor(() => expect(screen.getByText('🃏 Wildcards')).toBeInTheDocument())
    expect(screen.getByText('Shadows')).toBeInTheDocument()
    expect(screen.getByText('Grade A')).toBeInTheDocument()
    expect(screen.queryByText('Grade wildcard')).toBeNull()
    expect(screen.getByText('🃏 Wildcards').closest('.perf-row')!.textContent).toContain('(1/2)')
  })
})
