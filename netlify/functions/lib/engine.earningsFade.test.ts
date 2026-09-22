import { afterEach, describe, expect, it } from 'vitest'
import { LANE_SHADOW_RESERVE, buildBoard, pickShadowSide, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { NasdaqEarningsRow } from './nasdaqEarnings'
import { CALIB_DEF_VERSION } from '../../../shared/engine/calibration'
import { DIP_CATALYST_KIND, EARNINGS_FADE_CATALYST_KIND, LANE_CATALYST_KINDS } from '../../../shared/engine/catalyst'
import { funnelTraceKey, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import type { Prediction } from '../../../shared/engine/types'
import type { Candle } from '../../../shared/types'

// THE SHADOW LANE, END TO END.
//
// What a post-earnings pop must do to the board: publish a SHORT that is graded
// and recorded, carries no size, no instrument and no paper position, never
// occupies one of the three trade slots on its side, and disappears entirely
// when the lever says off. The owner's ruling (2026-09-22, "option 1") is that
// the evidence accrues and the reader is never asked to take the trade.

const T0 = Date.parse('2025-06-02T00:00:00Z') / 1000
const dateOf = (c: Candle) => new Date(c.t * 1000).toISOString().slice(0, 10)

const flat = (days: number, price: number): Candle[] =>
  Array.from({ length: days }, (_, i) => ({ t: T0 + i * 86_400, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000 }))

/** …then one bar that OPENS 7% above the prior close and drifts back. The volume
 * is deliberately ORDINARY: a 3× print would open the velocity lane's early door
 * on the same chart, and this test is about one lane. */
const popped = (() => {
  const bars = flat(259, 100)
  const prev = bars[bars.length - 1]
  const o = prev.c * 1.07
  const c = o * 0.99
  bars.push({ t: prev.t + 86_400, o, h: o * 1.005, l: c * 0.995, c, v: 1_200_000 })
  return bars
})()
const PRINT_DATE = dateOf(popped[popped.length - 2]) // reported after THAT close
const REACTION_DATE = dateOf(popped[popped.length - 1])
const NOW = Math.floor(popped[popped.length - 1].t + 86_400)
const TODAY = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

const spyTape = flat(260, 500)

const event = (over: Partial<NasdaqEarningsRow> = {}): NasdaqEarningsRow => ({
  sym: 'POPR',
  date: PRINT_DATE,
  time: 'post',
  epsActual: 1.2,
  epsForecast: 1.0,
  surprisePct: 20,
  noOfEsts: 6,
  marketCapUsdM: 42_000,
  ...over,
})

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => (sym === 'POPR' ? popped : sym === 'SPY' || sym === 'QQQ' ? spyTape : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [{ row: { sym: 'POPR', price: 107, capUsdM: 42_000, changePct: 7, name: null }, source: 'screener:gainers' }],
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
  earningsEvents: async () => [event()],
  worldReads: async () => [],
  holdings: async () => null,
  ...over,
})

const run = async (over: Partial<EngineDeps> = {}) => {
  const store = memoryStore()
  await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
  await store.write('engine-calibration', {
    buckets: { 'short:amber:25-40': { n: 20, hits: 14 }, 'short:amber:40-55': { n: 20, hits: 14 } },
    brier: [],
    defVersion: CALIB_DEF_VERSION,
  })
  const { board } = await buildBoard(store, deps(over), NOW)
  return {
    board,
    ledger: (await store.read<Prediction[]>(`predictions:${TODAY}`)) ?? [],
    trace: await store.read<FunnelTrace>(funnelTraceKey(TODAY)),
  }
}

afterEach(() => {
  delete process.env.EARNINGS_FADE
})

describe('the earnings-fade lane on the board', () => {
  it('publishes a SHADOW short off the snapshot — graded, recorded, unsized', async () => {
    const { board, ledger } = await run()
    const row = ledger.find(p => p.sym === 'POPR' && p.side === 'short')
    expect(row, 'the fade lane published nothing').toBeTruthy()
    expect(row!.catalyst!.kind).toBe(EARNINGS_FADE_CATALYST_KIND)
    // SHADOW, and every consequence of being one
    expect(row!.shadow).toBe(true)
    expect(row!.riskPct).toBe(0)
    expect(row!.instrument).toBeNull()
    expect(row!.accrual).toBe('shadow') // priced against the pooled population, never the sized one
    // …and still a real, graded record: a probability, an id, a horizon, levels
    expect(row!.probability).toBeGreaterThan(0)
    expect(row!.id).toBe(`${TODAY}:POPR:short`)
    expect(row!.stop).toBeGreaterThan(row!.entry)
    expect(row!.target).toBeLessThan(row!.entry)
    expect(row!.setup).toBe('fade')
    // the reader's board never shows it
    expect(board.some(b => b.sym === 'POPR' && b.side === 'short')).toBe(false)
  })

  it('never counts against the trade slots or the side caps', async () => {
    const { board, ledger } = await run()
    const fade = ledger.find(p => p.sym === 'POPR' && p.side === 'short')!
    // `board` is the reader-facing selection: trades, watch rows, near misses.
    // A shadow is in the ledger and in neither of the first two.
    expect(board.map(b => b.id)).not.toContain(fade.id)
    expect(board.filter(b => b.side === 'short' && !b.nearMiss && (b.riskPct ?? 0) > 0).length).toBeLessThanOrEqual(3)
    expect(board.every(b => b.id !== fade.id)).toBe(true)
  })

  it('names itself in the funnel trace as a lane shadow', async () => {
    const { trace } = await run()
    const row = trace?.rows['POPR:short']
    expect(row?.gate).toBe('called-shadow')
    expect(row?.source).toBe(`lane:${EARNINGS_FADE_CATALYST_KIND}`)
    expect(row?.detail).toContain('shadow only, never sized')
  })

  it('EARNINGS_FADE=off leaves the board and the ledger byte-identical', async () => {
    const on = await run()
    process.env.EARNINGS_FADE = 'off'
    const off = await run()
    expect(off.ledger.some(p => p.sym === 'POPR' && p.side === 'short')).toBe(false)
    // …and the rest of the run is untouched: same rows, same order, same ids
    const strip = (rows: Prediction[]) => rows.filter(p => !(p.sym === 'POPR' && p.side === 'short')).map(p => p.id)
    expect(strip(off.ledger)).toEqual(strip(on.ledger))
    expect(off.board.map(b => b.id)).toEqual(on.board.map(b => b.id))
  })

  it('a deployment with no earningsEvents dep builds exactly the same board', async () => {
    const withDep = await run()
    const without = await run({ earningsEvents: undefined })
    expect(without.ledger.some(p => p.sym === 'POPR' && p.side === 'short')).toBe(false)
    const strip = (rows: Prediction[]) => rows.filter(p => !(p.sym === 'POPR' && p.side === 'short')).map(p => p.id)
    expect(strip(without.ledger)).toEqual(strip(withDep.ledger))
  })

  it('a dep that throws, an empty calendar and a miss all publish nothing and break nothing', async () => {
    for (const bad of [
      { earningsEvents: async () => { throw new Error('nasdaq is down') } },
      { earningsEvents: async () => [] },
      { earningsEvents: async () => [event({ surprisePct: -4 })] }, // a MISS is not this cohort
      { earningsEvents: async () => [event({ date: '1999-01-04' })] }, // a print the tape never covered
      { earningsEvents: async () => [event({ date: REACTION_DATE, time: 'post' })] }, // no closed reaction bar yet
    ] as Partial<EngineDeps>[]) {
      const { ledger } = await run(bad)
      expect(ledger.some(p => p.sym === 'POPR' && p.side === 'short')).toBe(false)
    }
  })

  it('the lane kind is in the lane family, so factor-IC never learns from it', async () => {
    // The guard itself lives in gradeOutstanding and reads this set; the row has
    // to carry a kind the set contains or the whole stack trains on a lane the
    // engine refuses to size.
    const { ledger } = await run()
    const row = ledger.find(p => p.sym === 'POPR' && p.side === 'short')!
    expect(LANE_CATALYST_KINDS.has(row.catalyst!.kind)).toBe(true)
    // …and the world-tape stamp records no nudge, for the same family reason:
    // nothing multiplied a composite that was constructed from the gap's size.
    expect(row.worldTape?.mult ?? 1).toBe(1)
  })
})

// THE SHADOW BUDGET WAS STARVING THE LANE IT IS THE ONLY ROUTE FOR.
//
// A fade row is shadow-only by ruling, so `pickShadow` is its entire path into
// the ledger — and `pickShadow` ranked on |composite| alone. The lane builds its
// call from the size of the gap and lands at |25..55|; an ordinary shadow on a
// screener-topping name sits in the 70s and 80s. Five of those and the lane
// published, was counted as published in the funnel trace, and then vanished.
describe('the shadow budget reserves slots for the lanes', () => {
  const row = (id: string, composite: number, kind?: string) => ({ id, composite, ...(kind ? { catalyst: { kind, reason: '' } } : {}) })
  const loud = [row('a', 88), row('b', 84), row('c', 80), row('d', 76), row('e', 72), row('f', 70)]

  it('keeps two of five for lane rows the |composite| sort would always outrank', () => {
    const fade = row('fade', 40, EARNINGS_FADE_CATALYST_KIND)
    const dip = row('dip', 30, DIP_CATALYST_KIND)
    const picked = pickShadowSide([...loud, fade, dip], 5)
    expect(picked.map(p => p.id)).toEqual(['fade', 'dip', 'a', 'b', 'c'])
    expect(picked.length).toBe(5)
    // the reservation is a floor, not the budget: three slots still go to the board
    expect(picked.filter(p => !LANE_CATALYST_KINDS.has(p.catalyst?.kind ?? '')).length).toBe(5 - LANE_SHADOW_RESERVE)
  })

  it('lane rows compete among themselves on |composite| for the two', () => {
    const picked = pickShadowSide(
      [...loud, row('fade-small', 26, EARNINGS_FADE_CATALYST_KIND), row('fade-big', 55, EARNINGS_FADE_CATALYST_KIND), row('dip', 44, DIP_CATALYST_KIND)],
      5,
    )
    expect(picked.slice(0, 2).map(p => p.id)).toEqual(['fade-big', 'dip']) // 55, then 44
    expect(picked.map(p => p.id)).not.toContain('fade-small') // a third lane row waits its turn
  })

  it('an unfilled reservation falls through — a day with no lanes picks what it always did', () => {
    expect(pickShadowSide(loud, 5).map(p => p.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    // …and one lane row takes one slot, not two
    const one = pickShadowSide([...loud, row('fade', 40, EARNINGS_FADE_CATALYST_KIND)], 5)
    expect(one.map(p => p.id)).toEqual(['fade', 'a', 'b', 'c', 'd'])
  })

  it('a lane row that already outranks the board is never counted twice', () => {
    const picked = pickShadowSide([row('x', 20), row('loudFade', 99, EARNINGS_FADE_CATALYST_KIND)], 5)
    expect(picked.map(p => p.id)).toEqual(['loudFade', 'x'])
    expect(new Set(picked.map(p => p.id)).size).toBe(picked.length)
  })

  it('never exceeds the cap, and a cap under the reservation is still respected', () => {
    const pool = [...loud, row('fade', 40, EARNINGS_FADE_CATALYST_KIND), row('dip', 30, DIP_CATALYST_KIND)]
    expect(pickShadowSide(pool, 1).map(p => p.id)).toEqual(['fade'])
    expect(pickShadowSide(pool, 0)).toEqual([])
    expect(pickShadowSide([], 5)).toEqual([])
  })
})
