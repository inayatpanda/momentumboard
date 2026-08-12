import { describe, expect, it, vi } from 'vitest'

// WHY this file mocks the lane instead of feeding buildBoard a poisoned tape.
//
// The rule under test is the narrow one: a velocity read that THROWS costs that
// symbol its call and nothing else. One symbol must never be able to silence a
// lane that has already found other real breakouts, which is what a try/catch
// around the whole pass would allow.
//
// classifyVelocity and velocityCall are pure and defensive, so there is no candle
// array that makes only them throw — every field they read (c, v, l) is also read
// by technicalStage, atr, swingCapacity or the pattern sweep, and poisoning one
// would take the whole run down instead of one lane. So the throw is injected at
// the lane boundary, per symbol, with the real implementation running for every
// other name in the same board.
const poison: { sym: string | null } = { sym: null }
vi.mock('../../../shared/engine/velocityLane', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../shared/engine/velocityLane')>()
  return {
    ...actual,
    velocityCall: (sym: string, ...rest: unknown[]) => {
      if (sym === poison.sym) throw new Error('velocity lane blew up on this tape')
      return (actual.velocityCall as (...a: unknown[]) => unknown)(sym, ...rest)
    },
  }
})

import { VELOCITY_SHADOW_FIRST, buildBoard, type EngineDeps } from './engine'
import { memoryStore } from './store'
import { CALIB_DEF_VERSION } from '../../../shared/engine/calibration'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })
const append = (bars: Candle[], c: number, v = 1_000_000) => {
  const prev = bars[bars.length - 1]
  bars.push({ t: prev.t + 86_400, o: prev.c, h: Math.max(c, prev.c) * 1.005, l: Math.min(c, prev.c) * 0.995, c, v })
}
const flat = mk(() => 500)
const NOW = Math.floor(flat[flat.length - 1].t + 86_400)

// Two velocity names that are NOT one bet: a first paid break of the 20-session
// high (the early door) and an established, paid, paused run (the confirmation
// door). Different doors, different shapes, uncorrelated returns — so the
// diversity gates cull neither and each row stands on its own.
const breakTape = (() => {
  const bars = mk(() => 100, 259)
  append(bars, 105, 3_000_000)
  return bars
})()
const runTape = (() => {
  const bars = mk(() => 200, 255)
  append(bars, 208)
  append(bars, 216)
  append(bars, 224, 2_500_000)
  append(bars, 234)
  append(bars, 232)
  return bars
})()

const deps = (): EngineDeps => ({
  candles: async sym => (sym === 'VELO' ? breakTape : sym === 'RUNR' ? runTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [
    { row: { sym: 'VELO', price: 105, capUsdM: 5_000, changePct: 5, name: null }, source: 'screener:gainers' },
    { row: { sym: 'RUNR', price: 232, capUsdM: 8_000, changePct: 4, name: null }, source: 'screener:gainers' },
  ],
  social: async () => [],
  sparkCloses: async () => new Map<string, number[]>(),
  insiderCoverage: async () => new Map(),
  smartMoney: async () => [],
  mediaTitles: async () => [],
  newsCatalysts: async () => [],
  dipNewsCached: async () => null,
  dipNews: async () => ({ verdict: 'unclear', reason: 'stub' }),
  recentIpos: async () => [],
  earningsSyms: async () => new Set<string>(),
  earningsCalendar: async () => [],
  worldReads: async () => [],
  holdings: async () => null,
})

const run = async (poisonSym: string | null) => {
  poison.sym = poisonSym
  const store = memoryStore()
  await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
  await store.write('engine-calibration', {
    buckets: { 'long:amber:25-40': { n: 20, hits: 14 }, 'long:amber:40-55': { n: 20, hits: 14 } },
    brier: [],
    defVersion: CALIB_DEF_VERSION,
  })
  const { board } = await buildBoard(store, deps(), NOW)
  poison.sym = null
  const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  return { board, ledger: (await store.read<Prediction[]>(`predictions:${today}`))! }
}

// The fail-soft rule itself is mode-independent — one symbol's blow-up costs that
// symbol its call and nothing else — so the assertions below live in the LEDGER,
// which carries the lane's rows whether they are sized or shadowed. Only the
// reader-facing consequence branches on VELOCITY_SHADOW_FIRST (the lane ships
// shadow-first, so its rows are graded and unsized; engine.ts).
describe('the velocity lane fails soft per SYMBOL', () => {
  it('a read that throws costs that symbol its call and nothing else', async () => {
    const healthy = await run(null)
    expect(healthy.ledger.map(p => p.sym).sort()).toEqual(['RUNR', 'VELO']) // both lanes published
    const cleanVelo = healthy.ledger.find(p => p.sym === 'VELO')!
    expect(cleanVelo.catalyst!.kind).toBe('velocity')
    if (VELOCITY_SHADOW_FIRST) {
      expect(cleanVelo.shadow).toBe(true)
      expect(cleanVelo.riskPct).toBe(0)
    } else {
      expect(cleanVelo.riskPct).toBeGreaterThan(0)
    }

    const broken = await run('RUNR')
    expect(broken.ledger.some(p => p.sym === 'RUNR')).toBe(false) // the thrower is skipped…
    // …and the OTHER name's row is byte-identical: same grade, size, levels, flags.
    // A try around the whole pass would have lost this row too. This is the claim,
    // and it holds in both modes because the ledger holds shadows.
    expect(broken.ledger.find(p => p.sym === 'VELO')).toEqual(cleanVelo)
    if (VELOCITY_SHADOW_FIRST) expect(broken.board.filter(b => b.riskPct > 0)).toEqual([]) // no sized rows exist at all while shadowed
    else expect(broken.board.filter(b => b.riskPct > 0).map(b => b.sym)).toEqual(['VELO'])
  })
})

describe('the candle fill fails soft per SYMBOL', () => {
  it('a candidate whose candle read REJECTS costs one candidate, never the board', async () => {
    // Task-5 re-review gap: the fill's .catch(() => null) had no test — deleting
    // it survived the suite. This pins it: an outright rejection (not a null)
    // from deps.candles on one screener name must skip that name and leave the
    // other row byte-identical. Without the catch, mapLimit's Promise.all
    // rejects and the whole board build throws.
    const healthy = await run(null)
    const cleanVelo = healthy.ledger.find(p => p.sym === 'VELO')!

    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', {
      buckets: { 'long:amber:25-40': { n: 20, hits: 14 }, 'long:amber:40-55': { n: 20, hits: 14 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
    })
    const rejecting = deps()
    const base = rejecting.candles
    rejecting.candles = async sym => {
      if (sym === 'RUNR') throw new Error('blob replica refused the read')
      return base(sym)
    }
    const { board } = await buildBoard(store, rejecting, NOW)
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.some(p => p.sym === 'RUNR')).toBe(false)
    expect(ledger.find(p => p.sym === 'VELO')).toEqual(cleanVelo)
    if (VELOCITY_SHADOW_FIRST) expect(board.filter(b => b.riskPct > 0)).toEqual([])
    else expect(board.filter(b => b.riskPct > 0).map(b => b.sym)).toEqual(['VELO'])
  })
})
