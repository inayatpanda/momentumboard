import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { EnginePanel } from './EnginePanel'
import type { EngineData } from '../lib/api'
import { advanceGateState, gateEligibility, gateStateSummary } from '../../shared/engine/gateState'

// THE API SHAPE, pinned at the type level exactly as the miss-ledger pane is:
// what `/api/engine` serves for `gateState` IS `gateStateSummary`'s return
// (engine.mts calls it directly), and the lines are built by the engine's own
// advance — not written by hand here — so the panel is proved to print the same
// sentence the runlog and the paper print.
const state = (() => {
  const eligibility = gateEligibility([{ gate: 'dead-zone-core', cost: 190, saved: 12, n: 202, unchecked: 4, doubleBooked: false }])
  // the session clock is `predictions-index` itself — the dates, counted
  const index = ['2026-08-11', '2026-08-12']
  const moved = advanceGateState(null, eligibility, index, { date: '2026-08-13' }).state
  return advanceGateState(moved, eligibility, [...index, '2026-08-13'], { date: '2026-08-14' }).state // …and one it earned and could not take
})()

const gateState: EngineData['gateState'] = gateStateSummary(state)

const data: EngineData = {
  board: null,
  ledger: [],
  scorecard: null,
  gateState,
  weights: null,
  calibration: null,
  riskState: null,
  roster: null,
  channelCred: {},
}

vi.mock('../lib/api', () => ({ getEngine: () => Promise.resolve(data) }))

describe('EnginePanel — the gates that moved', () => {
  it('announces the notch with the evidence it stood on, and says once when an eligible gate was held', async () => {
    render(<EnginePanel />)
    await waitFor(() => expect(screen.getByText('Gate moved')).toBeInTheDocument())

    const move = screen.getByText(/dead zone 25 → 22.5/)
    expect(move.textContent).toContain('cost 190 vs saved 12 over 202 attributed outcomes')
    expect(move.textContent).toContain('2026-08-13')

    // the held gate: the machinery is built, the evidence moves it on its own clock
    expect(screen.getByText('Gate held')).toBeInTheDocument()
    expect(screen.getByText(/held by the cadence/).textContent).toContain('own clock')
    // THE STANDING EXPLANATION beside the rows: a reader who sees a published
    // threshold change is told the rule that let it change, and the rule's own
    // constants are read from the mechanism rather than retyped in the copy.
    const rule = screen.getByText(/How a threshold moves/)
    expect(rule.textContent).toContain('at most one notch per 20 sessions')
    expect(rule.textContent).toContain('30 attributed outcomes')
    expect(rule.textContent).toContain('floor and a ceiling it cannot be argued past')
    // …and it renders with no scorecard and no miss ledger at all
    expect(screen.queryByText('Graded predictions')).not.toBeInTheDocument()
    expect(screen.queryByText('Misses (10d)')).not.toBeInTheDocument()
  })
})
