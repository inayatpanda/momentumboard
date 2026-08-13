import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { EnginePanel } from './EnginePanel'
import type { EngineData } from '../lib/api'
import { missLedgerSummary, emptyMissLedger, accrueMissEvent, accrueUnchecked, recordMissDay } from '../../shared/engine/missLedger'

// THE API SHAPE, pinned at the type level: what `/api/engine` serves for
// `missLedger` IS `missLedgerSummary`'s return (engine.mts calls it directly),
// so this assignment failing to compile is the contract breaking.
const ledger = (() => {
  const l = emptyMissLedger()
  for (const excess of [6, 8, 22]) accrueMissEvent(l, { date: '2026-08-03', sym: 'GLW', side: 'long', excessPct: excess, gate: 'dead-zone-core' })
  accrueMissEvent(l, { date: '2026-08-03', sym: 'ACME', side: 'short', excessPct: -9, gate: 'diversity' })
  accrueUnchecked(l, 'dead-zone-core')
  accrueUnchecked(l, 'dead-zone-core')
  recordMissDay(l, '2026-08-03', { checked: 30, unchecked: 2, misses: 3 })
  return l
})()

const missLedger: EngineData['missLedger'] = missLedgerSummary(ledger)

const data: EngineData = {
  board: null,
  ledger: [],
  scorecard: null,
  missLedger,
  weights: null,
  calibration: null,
  riskState: null,
  roster: null,
  channelCred: {},
}

vi.mock('../lib/api', () => ({ getEngine: () => Promise.resolve(data) }))

describe('EnginePanel — the calls it never made', () => {
  it('prints the miss count and the worst gate, and NEVER the cost without the unchecked count beside it', async () => {
    render(<EnginePanel />)
    await waitFor(() => expect(screen.getByText('Misses (10d)')).toBeInTheDocument())

    const line = screen.getByText(/worst gate/)
    expect(line.textContent).toContain('3') // the day window's cost events
    expect(line.textContent).toContain('worst gate: dead-zone-core')
    expect(line.textContent).toContain('cost 3')
    // the non-negotiable half: an unmeasured gate must not display as a costless one
    expect(line.textContent).toContain('unchecked 2')
    // …and the caveat travels with it
    expect(line.closest('.perf-row')!.getAttribute('title')).toMatch(/unmeasured gate is not a costless one/)
    // it renders with no scorecard at all — a measured fact is not hidden by an
    // unrelated blob being absent
    expect(screen.queryByText('Graded predictions')).not.toBeInTheDocument()
  })
})
