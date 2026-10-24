// GatesLearning (plan Task 21). Same local-first pattern as Record.test.tsx:
// getLearning is mocked to never resolve, every case seeds the `learning`
// Dexie slice directly and asserts on the cached paint.

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import type { LearningSlice } from '../lib/apiViews'
import { GATE_BOUNDS } from '../../shared/engine/gateState'
import type { GateStructuredEntry, TunableGate } from '../../shared/engine/gateState'
import GatesLearning, { churnLines, gatePosition } from './GatesLearning'

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
    expect(await screen.findByRole('heading', { name: /how predictions work/i })).toBeInTheDocument()
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

    it('renders the history timeline with date and from→to, as one sentence', async () => {
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
      // owner iteration 2: the move now says what it DID to the funnel, in one
      // line with its reason. Derived from the gate's own `loosen` sign — a
      // deadZone move DOWN is a loosening because loosen is −1.
      const prose = within(gates).getByText(/cost 12 vs saved 3/)
      const word = GATE_BOUNDS.deadZone.loosen === -1 ? 'loosened' : 'tightened'
      expect(prose).toHaveTextContent(new RegExp(`${word}\\s*25 → 22\\.5`))
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

  // OWNER ITERATION 2: "Gates and Learning is illegible - cant make anything
  // out of it." The data is unchanged; every word around it is new.
  describe('legibility', () => {
    it('opens with two sentences saying what the whole page is', async () => {
      await seedLearning(mkLearning())
      withRouter()
      expect(await screen.findByText(/Every idea must pass a set of checks/i)).toBeInTheDocument()
      expect(screen.getByText(/before it becomes a published prediction/i)).toBeInTheDocument()
      expect(screen.getByText(/stricter or looser as past results accumulate/i)).toBeInTheDocument()
    })

    it('says in plain English what each gate IS', async () => {
      await seedLearning(
        mkLearning({
          gateState: {
            gates: [
              mkGate({ gate: 'deadZone', label: 'dead zone' }),
              mkGate({ gate: 'minExpectedMovePct', label: 'expected-move floor', base: 1.5, current: 1.25, bounds: { min: 1, max: 1.5 } }),
              mkGate({ gate: 'contextCap', label: 'context cap', base: 16, current: 14, bounds: { min: 12, max: 16 } }),
            ],
          },
        }),
      )
      withRouter()
      const gates = await screen.findByLabelText('Gates')
      expect(within(gates).getByText(/the conviction bar — below this composite score, no call/i)).toBeInTheDocument()
      expect(within(gates).getByText(/the payoff floor — a setup must promise at least this much move/i)).toBeInTheDocument()
      expect(within(gates).getByText(/how much soft evidence \(news, social\) can add on top of the chart/i)).toBeInTheDocument()
    })

    // DERIVED, NOT HARDCODED: `loosen` is the sign that loosens the funnel, so
    // −1 puts "looser" on the MINIMUM end. If a gate's rule ever flips, this
    // test flips with it and the screen has to as well.
    it('labels which end of each gate’s bar is looser, from GATE_BOUNDS itself', async () => {
      const gates: TunableGate[] = ['deadZone', 'minExpectedMovePct', 'contextCap']
      await seedLearning(
        mkLearning({ gateState: { gates: gates.map(g => mkGate({ gate: g, label: g, bounds: { min: GATE_BOUNDS[g].min, max: GATE_BOUNDS[g].max } })) } }),
      )
      withRouter()
      const section = await screen.findByLabelText('Gates')
      const cards = [...section.querySelectorAll('.gl-gate')]
      expect(cards).toHaveLength(gates.length)
      cards.forEach((card, i) => {
        const ends = [...card.querySelectorAll('.gl-gate-end')].map(el => el.textContent)
        const expected = GATE_BOUNDS[gates[i]].loosen === -1 ? ['looser', 'tighter'] : ['tighter', 'looser']
        expect(ends).toEqual(expected)
      })
    })
  })

  describe('factor trust', () => {
    it('renders base vs current per factor, and says what the change MEANS', async () => {
      await seedLearning(mkLearning({ weights: { base: { technical: 1.0, momentum: 0.5 }, current: { technical: 0.8, momentum: 0.6 }, history: [] } }))
      withRouter()
      const weights = await screen.findByLabelText('Factor trust')
      expect(within(weights).getByText('technical')).toBeInTheDocument()
      expect(within(weights).getByText('1.00 → 0.80')).toBeInTheDocument()
      expect(within(weights).getByText('momentum')).toBeInTheDocument()
      expect(within(weights).getByText('0.50 → 0.60')).toBeInTheDocument()
      // (0.8 − 1.0) / 1.0 = −20%; (0.6 − 0.5) / 0.5 = +20%
      expect(within(weights).getByText('trusts it 20.0% less than launch')).toBeInTheDocument()
      expect(within(weights).getByText('trusts it 20.0% more than launch')).toBeInTheDocument()
    })

    it('says "unchanged" rather than inventing a 0.0% move', async () => {
      await seedLearning(mkLearning({ weights: { base: { news: 0.4 }, current: { news: 0.4 }, history: [] } }))
      withRouter()
      const weights = await screen.findByLabelText('Factor trust')
      expect(within(weights).getByText('unchanged since launch')).toBeInTheDocument()
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
      expect(within(roster).getByText(/the names the engine actively hunts on/i)).toBeInTheDocument()
    })
  })

  describe('channel credibility', () => {
    it('renders a row per channel with graded, hits, and avgExcess in pp', async () => {
      await seedLearning(mkLearning({ channelCred: { alpha: { graded: 12, hits: 7, avgExcess: 3.4 } } }))
      withRouter()
      const table = await screen.findByLabelText('Channel credibility')
      expect(within(table).getByText(/which YouTube\/Reddit callers have earned trust/i)).toBeInTheDocument()
      expect(within(table).getByText('alpha')).toBeInTheDocument()
      expect(within(table).getByText('12')).toBeInTheDocument()
      expect(within(table).getByText('7')).toBeInTheDocument()
      expect(within(table).getByText('+3.4pp')).toBeInTheDocument()
    })
  })

  describe("daily report's own lines", () => {
    it('renders gateLines moves and notes as a quote block', async () => {
      await seedLearning(mkLearning({ gateLines: { moves: ['dead zone 25 → 22.5 on 2026-07-20'], notes: ['context cap: eligible, held by the cadence'] } }))
      withRouter()
      expect(await screen.findByText('dead zone 25 → 22.5 on 2026-07-20')).toBeInTheDocument()
      expect(screen.getByText('context cap: eligible, held by the cadence')).toBeInTheDocument()
    })
  })
})

// VISIBILITY WAVE (2026-08-17) — three things the live desk caught: a gate at
// its own minimum drew an empty bar that read as a broken widget, the roster's
// churn lines said a name joined and was dropped on the same day, and a market
// cap printed as `$16487M`.
describe('GatesLearning — the numbers stop lying about themselves', () => {
  describe('gatePosition', () => {
    it('is the same fraction for every gate — (current − min) / (max − min)', () => {
      expect(gatePosition(20, 20, 25)).toBe(0)
      expect(gatePosition(22.5, 20, 25)).toBe(50)
      expect(gatePosition(25, 20, 25)).toBe(100)
      expect(gatePosition(12, 12, 16)).toBe(0)
      expect(gatePosition(14, 12, 16)).toBe(50)
    })

    it('clamps a value outside its own ratified bounds rather than running off the track', () => {
      expect(gatePosition(30, 20, 25)).toBe(100)
      expect(gatePosition(10, 20, 25)).toBe(0)
    })

    it('a degenerate range is 0, never NaN or Infinity', () => {
      expect(gatePosition(12, 12, 12)).toBe(0)
      expect(gatePosition(12, 16, 12)).toBe(0)
    })
  })

  describe('the gate bar', () => {
    it('marks a position on a track instead of filling one, for every gate alike', async () => {
      await seedLearning(
        mkLearning({
          gateState: {
            gates: [
              mkGate({ gate: 'deadZone', label: 'dead zone', current: 25, bounds: { min: 20, max: 25 } }),
              mkGate({ gate: 'contextCap', label: 'context cap', current: 12, bounds: { min: 12, max: 16 } }),
            ],
          },
        }),
      )
      withRouter()
      const gates = await screen.findByLabelText('Gates')
      const tracks = [...gates.querySelectorAll('.gl-gate-track')] as HTMLElement[]
      expect(tracks).toHaveLength(2)
      // no fill anywhere — the same primitive for both, whatever the value
      expect(gates.querySelector('.convbar')).toBeNull()
      expect(tracks.map(t => t.dataset.position)).toEqual(['100', '0'])
      // a gate at its own minimum still renders a marker: the widget is visibly alive
      const markers = [...gates.querySelectorAll('.gl-gate-marker')] as HTMLElement[]
      expect(markers).toHaveLength(2)
      expect(markers[1].style.left).toBe('0%')
    })

    it('the track says out loud where the gate sits in its range', async () => {
      await seedLearning(mkLearning({ gateState: { gates: [mkGate({ gate: 'contextCap', label: 'context cap', current: 12, bounds: { min: 12, max: 16 } })] } }))
      withRouter()
      const gates = await screen.findByLabelText('Gates')
      expect(within(gates).getByLabelText('context cap sits at 12 on a scale from 12 to 16')).toBeInTheDocument()
    })
  })

  describe('churnLines', () => {
    it('a name that joined AND was dropped the same day is one honest line', () => {
      expect(
        churnLines({
          joined: ['AVGO', 'LLY'],
          dropped: [
            { sym: 'AVGO', why: 'roster full' },
            { sym: 'LLY', why: 'roster full' },
          ],
        }),
      ).toEqual(['AVGO, LLY knocked — roster full, not admitted'])
    })

    it('keeps the real joins and the real drops apart from the knocked', () => {
      expect(
        churnLines({
          joined: ['AVGO', 'NEW'],
          dropped: [
            { sym: 'AVGO', why: 'roster full' },
            { sym: 'OLD', why: 'quiet 21 days' },
          ],
        }),
      ).toEqual(['AVGO knocked — roster full, not admitted', 'joined NEW', 'dropped OLD (quiet 21 days)'])
    })

    it('groups the knocked by the reason they were shed, one line per reason', () => {
      expect(
        churnLines({
          joined: ['A', 'B', 'C'],
          dropped: [
            { sym: 'A', why: 'roster full' },
            { sym: 'B', why: 'larger caps shed first' },
            { sym: 'C', why: 'roster full' },
          ],
        }),
      ).toEqual(['A, C knocked — roster full, not admitted', 'B knocked — larger caps shed first, not admitted'])
    })

    it('a quiet day with neither is no clauses at all', () => {
      expect(churnLines({ joined: [], dropped: [] })).toEqual([])
    })
  })

  describe('the roster', () => {
    it('renders the same-day churn as one knocked line, never as join-then-drop', async () => {
      await seedLearning(
        mkLearning({
          roster: {
            entries: [{ sym: 'NVDA', joined: '2026-01-05', source: 'screener', capUsdM: 3_000_000, lastCapacity: 9, lastQualified: '2026-08-10' }],
            changes: [
              {
                date: '2026-08-17',
                joined: ['AVGO', 'LLY'],
                dropped: [
                  { sym: 'AVGO', why: 'roster full' },
                  { sym: 'LLY', why: 'roster full' },
                ],
              },
            ],
          },
        }),
      )
      withRouter()
      const roster = await screen.findByLabelText('Roster')
      expect(within(roster).getByText(/AVGO, LLY knocked — roster full, not admitted/)).toBeInTheDocument()
      expect(within(roster).queryByText(/joined AVGO/)).not.toBeInTheDocument()
    })

    it('prints a market cap a reader can hold, not a raw million count', async () => {
      await seedLearning(
        mkLearning({
          roster: {
            entries: [
              { sym: 'QNT', joined: '2026-08-13', source: 'screener:gainers', capUsdM: 16487, lastCapacity: 9, lastQualified: '2026-08-13' },
              { sym: 'RR', joined: '2026-07-14', source: 'holding', capUsdM: 360, lastCapacity: 9, lastQualified: '2026-07-14' },
            ],
            changes: [],
          },
        }),
      )
      withRouter()
      const roster = await screen.findByLabelText('Roster')
      expect(within(roster).getByText('$16.5B')).toBeInTheDocument()
      expect(within(roster).queryByText('$16487M')).not.toBeInTheDocument()
      expect(within(roster).getByText('$360.0M')).toBeInTheDocument()
    })
  })
})
