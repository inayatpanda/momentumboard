// GatesLearning (plan Task 21). Same local-first pattern as Record.test.tsx:
// getLearning is mocked to never resolve, every case seeds the `learning`
// Dexie slice directly and asserts on the cached paint.

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import type { LearningSlice } from '../lib/apiViews'
import type { GateStructuredEntry } from '../../shared/engine/gateState'
import GatesLearning from './GatesLearning'

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  return { ...actual, getLearning: () => new Promise<never>(() => {}) }
})

const withRouter = () => render(<Router base="/app" hook={memoryLocation({ path: '/app/more/gates' }).hook}>{<GatesLearning />}</Router>)

function mkGate(overrides: Partial<GateStructuredEntry> = {}): GateStructuredEntry {
  return {
    gate: 'deadZone',
    label: 'dead zone',
    base: 25,
    current: 22.5,
    bounds: { min: 20, max: 25 },
    history: [],
    ...overrides,
  }
}

function mkLearning(overrides: Partial<LearningSlice> = {}): LearningSlice {
  return {
    gateState: { gates: [mkGate()] },
    gateLines: null,
    regrets: null,
    weights: null,
    scorecard: null,
    roster: null,
    channelCred: {},
    calibration: null,
    ...overrides,
  }
}

async function seedLearning(learning: LearningSlice) {
  await db.slices.put({ key: 'learning', data: learning, fetchedAt: Date.now() })
}

beforeEach(async () => {
  await db.slices.clear()
})

describe('GatesLearning', () => {
  it('has a heading containing "Gates"', async () => {
    await seedLearning(mkLearning())
    withRouter()
    expect(await screen.findByRole('heading', { name: /gates/i })).toBeInTheDocument()
  })

  describe('a gate card', () => {
    it('renders the label, current value, and bounds min/max', async () => {
      await seedLearning(mkLearning({ gateState: { gates: [mkGate({ label: 'dead zone', current: 22.5, bounds: { min: 20, max: 25 } })] } }))
      withRouter()
      const gates = await screen.findByLabelText('Gates')
      expect(within(gates).getByText('dead zone')).toBeInTheDocument()
      expect(within(gates).getByText('22.5')).toBeInTheDocument()
      const barRow = gates.querySelector('.gl-gate-bar-row') as HTMLElement
      expect(within(barRow).getByText('20')).toBeInTheDocument()
      expect(within(barRow).getByText('25')).toBeInTheDocument()
    })

    it('renders the history timeline with date and from→to', async () => {
      await seedLearning(
        mkLearning({
          gateState: {
            gates: [mkGate({ history: [{ date: '2026-07-20', from: 25, to: 22.5, why: 'cost 12 vs saved 3 over 34 attributed outcomes' }] })],
          },
        }),
      )
      withRouter()
      const gates = await screen.findByLabelText('Gates')
      expect(within(gates).getByText('20 Jul 2026')).toBeInTheDocument()
      expect(within(gates).getByText(/25 → 22.5/)).toBeInTheDocument()
      expect(within(gates).getByText(/cost 12 vs saved 3/)).toBeInTheDocument()
    })

    it('shows the override pin badge only when the gate carries one', async () => {
      await seedLearning(mkLearning({ gateState: { gates: [mkGate({ override: 21 })] } }))
      const { unmount } = withRouter()
      const gates = await screen.findByLabelText('Gates')
      expect(within(gates).getByText(/pinned by you at/)).toBeInTheDocument()
      expect(within(gates).getByText('21')).toBeInTheDocument()
      unmount()

      await db.slices.clear()
      await seedLearning(mkLearning({ gateState: { gates: [mkGate()] } }))
      withRouter()
      const gates2 = await screen.findByLabelText('Gates')
      expect(within(gates2).queryByText(/pinned by you at/)).not.toBeInTheDocument()
    })

    it('renders a human sentence for each blocked reason', async () => {
      await seedLearning(mkLearning({ gateState: { gates: [mkGate({ blocked: { why: 'cadence', date: '2026-08-01' } })] } }))
      const { unmount } = withRouter()
      const gates = await screen.findByLabelText('Gates')
      expect(within(gates).getByText(/held by the cadence/)).toBeInTheDocument()
      unmount()

      await db.slices.clear()
      await seedLearning(mkLearning({ gateState: { gates: [mkGate({ blocked: { why: 'bound', date: '2026-08-01' } })] } }))
      const { unmount: unmount2 } = withRouter()
      const gatesB = await screen.findByLabelText('Gates')
      expect(within(gatesB).getByText(/hard bound/)).toBeInTheDocument()
      unmount2()

      await db.slices.clear()
      await seedLearning(mkLearning({ gateState: { gates: [mkGate({ blocked: { why: 'override', date: '2026-08-01' } })] } }))
      withRouter()
      const gatesC = await screen.findByLabelText('Gates')
      expect(within(gatesC).getByText(/pinned by your override/)).toBeInTheDocument()
    })
  })

  describe('weights', () => {
    it('renders base vs current per factor', async () => {
      await seedLearning(mkLearning({ weights: { base: { technical: 1.0, momentum: 0.5 }, current: { technical: 0.8, momentum: 0.6 }, history: [] } }))
      withRouter()
      const weights = await screen.findByLabelText('Weights')
      expect(within(weights).getByText('technical')).toBeInTheDocument()
      expect(within(weights).getByText('1.00 → 0.80')).toBeInTheDocument()
      expect(within(weights).getByText('momentum')).toBeInTheDocument()
      expect(within(weights).getByText('0.50 → 0.60')).toBeInTheDocument()
    })
  })

  describe('roster', () => {
    it('renders entries and last changes', async () => {
      await seedLearning(
        mkLearning({
          roster: {
            entries: [{ sym: 'NVDA', joined: '2026-01-05', source: 'screener', capUsdM: 3000000, lastCapacity: 9, lastQualified: '2026-08-10' }],
            changes: [{ date: '2026-08-10', joined: ['NVDA'], dropped: [{ sym: 'OLD', why: 'quiet 21 days' }] }],
          },
        }),
      )
      withRouter()
      const roster = await screen.findByLabelText('Roster')
      expect(within(roster).getByText('NVDA')).toBeInTheDocument()
      expect(within(roster).getByText(/joined NVDA/)).toBeInTheDocument()
      expect(within(roster).getByText(/dropped OLD \(quiet 21 days\)/)).toBeInTheDocument()
    })
  })

  describe('channel credibility', () => {
    it('renders a row per channel with graded, hits, and avgExcess in pp', async () => {
      await seedLearning(mkLearning({ channelCred: { alpha: { graded: 12, hits: 7, avgExcess: 3.4 } } }))
      withRouter()
      const table = await screen.findByLabelText('Channel credibility')
      expect(within(table).getByText('alpha')).toBeInTheDocument()
      expect(within(table).getByText('12')).toBeInTheDocument()
      expect(within(table).getByText('7')).toBeInTheDocument()
      expect(within(table).getByText('+3.4pp')).toBeInTheDocument()
    })
  })

  describe("the paper's own lines", () => {
    it('renders gateLines moves and notes as a quote block', async () => {
      await seedLearning(mkLearning({ gateLines: { moves: ['dead zone 25 → 22.5 on 2026-07-20'], notes: ['context cap: eligible, held by the cadence'] } }))
      withRouter()
      expect(await screen.findByText('dead zone 25 → 22.5 on 2026-07-20')).toBeInTheDocument()
      expect(screen.getByText('context cap: eligible, held by the cadence')).toBeInTheDocument()
    })
  })
})
