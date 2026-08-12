import { describe, expect, it, vi } from 'vitest'

// WHY this file mocks the lane set instead of publishing a velocity row.
//
// A lane composite is STRUCTURAL — dipLane/velocityLane derive it from the tape
// itself, so the composite loop's worldMult re-score never touches it. The row
// must therefore record the multiplier it truly ran at (1), not the nudge it
// never received. That stamp used to test the dip LITERAL; it now tests the lane
// FAMILY (LANE_CATALYST_KINDS).
//
// Proving "family, not literal" needs a lane-tagged row that is NOT one of the
// lanes the engine already publishes — otherwise a passing test cannot tell a
// family rule from two literals. So this file hands the engine a DIFFERENT
// membership — 'ipo' declared a lane kind — and pins the consequence: the
// ipo-tagged row records mult 1 while its untagged neighbour on the same board,
// same tone, same side still takes the 1.1 nudge. Under the old
// `cat?.kind === DIP_CATALYST_KIND` literal the ipo row would print 1.1 and this
// test fails. The velocity lane's own row is pinned where it is produced
// (engine.test.ts, the quarter-size breakout test); this file guards the rule that
// the NEXT lane will be right for free.
vi.mock('../../../shared/engine/catalyst', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../shared/engine/catalyst')>()
  return { ...actual, LANE_CATALYST_KINDS: new Set([...actual.LANE_CATALYST_KINDS, 'ipo']) }
})

import { buildBoard, type EngineDeps } from './engine'
import { memoryStore } from './store'
import { CALIB_DEF_VERSION } from '../../../shared/engine/calibration'
import type { Candle } from '../../../shared/types'

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })

// two rolled-over names oscillating at different frequencies, so they are two
// genuinely different bets and the correlation gate culls neither
const rolledOver = (k: number) => mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2) * (1 + 0.04 * Math.sin(i * k)))
const flat = mk(() => 500)
const NVDA_TAPE = rolledOver(0.7)
const FRESH_TAPE = rolledOver(1.9)
const NOW = Math.floor(NVDA_TAPE[NVDA_TAPE.length - 1].t + 86_400)

// every index/future red, VIX spiking → an unambiguous risk-off overnight tape,
// which lifts a SHORT's conviction by 1.1 (worldTape.ts)
const riskOffReads = async () => [
  { sym: '^N225', name: 'Nikkei', changePct: -1.2 },
  { sym: '^HSI', name: 'Hang Seng', changePct: -1.5 },
  { sym: '^GDAXI', name: 'DAX', changePct: -1.1 },
  { sym: '^FTSE', name: 'FTSE 100', changePct: -1.0 },
  { sym: 'ES=F', name: 'S&P fut', changePct: -1.3 },
  { sym: 'NQ=F', name: 'Nasdaq fut', changePct: -1.4 },
  { sym: '^VIX', name: 'VIX', changePct: 8 },
]

// six flat fillers so the candidate pool clears breadthAbove50's 10-series minimum
const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']

const deps = (): EngineDeps => ({
  candles: async sym => (sym === 'NVDA' ? NVDA_TAPE : sym === 'FRESH' ? FRESH_TAPE : fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
  candles5y: async () => null,
  capUsdM: async () => 50_000,
  companyName: async () => null,
  screens: async () =>
    ['NVDA', ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' as const })),
  social: async () => [],
  sparkCloses: async () => new Map<string, number[]>(),
  insiderCoverage: async () => new Map(),
  smartMoney: async () => [],
  mediaTitles: async () => [],
  newsCatalysts: async () => [],
  dipNewsCached: async () => null,
  dipNews: async () => ({ verdict: 'unclear', reason: 'stub' }),
  recentIpos: async () => [{ sym: 'FRESH', date: '2026-05-20' }], // FRESH's ONLY candidate source
  earningsSyms: async () => new Set<string>(),
  earningsCalendar: async () => [],
  worldReads: riskOffReads,
  holdings: async () => null,
})

describe('the world-tape stamp is keyed on the lane FAMILY', () => {
  it('a lane-tagged row records the multiplier it actually ran at (1); its untagged neighbour still takes the nudge', async () => {
    const store = memoryStore()
    // both names need a short route, or the route guard shadows them off the board
    // before publishCall ever stamps a multiplier
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INVD' }, FRESH: { short2x: 'IFRE' } } })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION })

    const { board } = await buildBoard(store, deps(), NOW)

    const lane = board.find(b => b.sym === 'FRESH')!
    expect(lane).toBeDefined()
    expect(lane.catalyst?.kind).toBe('ipo') // standing in for a lane kind, per the note above
    expect(lane.worldTape).toEqual({ tone: 'risk-off', mult: 1 })

    const ordinary = board.find(b => b.sym === 'NVDA')!
    expect(ordinary).toBeDefined()
    expect(ordinary.catalyst).toBeUndefined()
    expect(ordinary.side).toBe(lane.side) // same side, same tone — the tag is the only difference
    expect(ordinary.worldTape).toEqual({ tone: 'risk-off', mult: 1.1 })
  })
})
