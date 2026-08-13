import { describe, expect, it, vi } from 'vitest'
import type { Candle } from '../types'
import { gradePrediction } from './calibration'
import { MODERATE_GATES } from './catalyst'
import type { FunnelTrace, FunnelTraceRow } from './funnelTrace'
import type { GateCode } from './types'
import {
  MISS_EXAMPLES_PER_GATE,
  MISS_EXCESS_MIN,
  MISS_FETCH_BUDGET,
  MISS_HORIZON,
  MISS_LEDGER_DAYS_MAX,
  MISS_SKIP_GATES,
  accrueMissDay,
  accrueMissEvent,
  accrueUnchecked,
  emptyMissLedger,
  maturedTraceDate,
  missCandidates,
  regretDisabled,
  missCheckable,
  missExcess,
  missLedgerSummary,
  normaliseMissLedger,
  recordMissDay,
} from './missLedger'

const T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const dateOf = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)

/** A tape whose OPEN and CLOSE differ, so a mirrored entry basis (the entry
 * session's OPEN, never the prior close) is provable rather than assumed. */
const tape = (closeAt: (i: number) => number, openAt: (i: number) => number, n = 60): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = closeAt(i)
    const o = openAt(i)
    return { t: T0 + i * DAY, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1_000_000 }
  })

const flat = tape(
  () => 100,
  () => 100,
)
/** +2.3% a session from bar 30 on: over 10 sessions from bar 30's open this is a
 * long the engine refused. Opens 3% under the prior close, so close-based and
 * open-based bases disagree loudly. */
const runner = tape(
  i => (i < 30 ? 100 : 100 * 1.023 ** (i - 30)),
  i => (i < 30 ? 100 : 0.97 * 100 * 1.023 ** (i - 30)),
)
const faller = tape(
  i => (i < 30 ? 100 : 100 * 0.977 ** (i - 30)),
  i => (i < 30 ? 100 : 1.03 * 100 * 0.977 ** (i - 30)),
)
/** Drifts less than the miss bar in either direction: neither cost nor saved. */
const quiet = tape(
  i => (i < 30 ? 100 : 100 + (i - 30) * 0.2),
  i => (i < 30 ? 100 : 100 + (i - 30) * 0.2),
)

const ENTRY = dateOf(30)

const traceOf = (rows: Record<string, FunnelTraceRow>, over: Partial<FunnelTrace> = {}): FunnelTrace => ({
  date: ENTRY,
  gates: MODERATE_GATES,
  rows,
  counts: { notCandidate: 0 },
  nearMisses: [],
  emptySides: {},
  ...over,
})

const io = (map: Record<string, Candle[] | null>, free: string[] = []) => {
  const fetched: string[] = []
  return {
    fetched,
    isFree: (sym: string) => free.includes(sym),
    candles: async (sym: string) => {
      if (!free.includes(sym)) fetched.push(sym)
      return map[sym] ?? null
    },
  }
}

describe('missExcess — the entry basis, mirrored', () => {
  it('is byte-identical to gradePrediction on the SAME fixture, on BOTH sides', () => {
    const mine = missExcess(runner, flat, ENTRY)!
    expect(mine).not.toBeNull()
    // A miss has no stop, so the comparison rows are given stops that CANNOT
    // trigger: what is being pinned is the entry basis and the excess arithmetic,
    // not the stop walk (the ledger's excess is stopless by construction).
    const long = gradePrediction({ date: ENTRY, side: 'long', priceAtPrediction: 100, stop: 0 }, runner, flat, MISS_HORIZON)!
    const short = gradePrediction({ date: ENTRY, side: 'short', priceAtPrediction: 100, stop: Number.MAX_VALUE }, runner, flat, MISS_HORIZON)!
    expect(long.stopped).toBe(false)
    expect(short.stopped).toBe(false)
    expect(mine.long).toBe(long.excessPct)
    expect(mine.short).toBe(short.excessPct)
    // …and the same on a tape that fell, so the sign is pinned in both directions
    const down = missExcess(faller, flat, ENTRY)!
    expect(down.long).toBe(gradePrediction({ date: ENTRY, side: 'long', priceAtPrediction: 100, stop: 0 }, faller, flat, MISS_HORIZON)!.excessPct)
    expect(down.short).toBe(
      gradePrediction({ date: ENTRY, side: 'short', priceAtPrediction: 100, stop: Number.MAX_VALUE }, faller, flat, MISS_HORIZON)!.excessPct,
    )
  })

  it('uses the entry session OPEN, not the prior close', () => {
    const base = runner[30].o
    const raw = ((runner[40].c - base) / base) * 100
    expect(missExcess(runner, flat, ENTRY)!.long).toBe(Math.round(raw * 10) / 10)
    // the prior-close basis would have produced a materially different number
    const wrong = ((runner[40].c - runner[29].c) / runner[29].c) * 100
    expect(Math.round(wrong * 10) / 10).not.toBe(missExcess(runner, flat, ENTRY)!.long)
  })

  it('returns null when the horizon has not matured, when the date is off the tape, or when SPY is short', () => {
    expect(missExcess(runner, flat, dateOf(55))).toBeNull() // 55 + 10 >= 60
    expect(missExcess(runner, flat, dateOf(400))).toBeNull()
    expect(missExcess(runner, flat.slice(0, 32), ENTRY)).toBeNull()
    expect(missExcess(runner, flat, 'not-a-date')).toBeNull()
    expect(missExcess([], flat, ENTRY)).toBeNull()
  })

  it('the miss bar is +5pp — deliberately five times the hit bar', () => {
    expect(MISS_EXCESS_MIN).toBe(5)
    expect(MISS_HORIZON).toBe(10)
    expect(MISS_FETCH_BUDGET).toBe(40)
  })
})

describe('the adjudication — which rows are even miss candidates', () => {
  it('never checks a SIZED call, a shadow, or a shadow the cap dropped', () => {
    for (const g of ['called-full', 'called-half', 'called-shadow', 'route-blocked', 'shadow-capped'] as GateCode[]) {
      expect(missCheckable(g)).toBe(false)
      expect(MISS_SKIP_GATES.has(g)).toBe(true)
    }
  })

  it('DOES check the three unsized published codes — the reader saw the row and could not act on it', () => {
    for (const g of ['called-watch', 'called-below-base', 'called-observation'] as GateCode[]) expect(missCheckable(g)).toBe(true)
  })

  it('checks every ordinary refusal', () => {
    for (const g of ['trimmed', 'no-candles', 'no-data', 'dead-zone-core', 'dead-zone-context', 'evidence-fail', 'dip-refused', 'diversity', 'slot-cut'] as GateCode[])
      expect(missCheckable(g)).toBe(true)
  })

  it('orders sided rows by near-miss conviction first, then the bare rows', () => {
    const trace = traceOf(
      {
        AAA: { gate: 'trimmed' },
        'BBB:long': { gate: 'dead-zone-core', side: 'long' },
        'CCC:short': { gate: 'evidence-fail', side: 'short' },
        'DDD:long': { gate: 'slot-cut', side: 'long' },
        'EEE:long': { gate: 'called-full', side: 'long' },
      },
      {
        nearMisses: [
          { sym: 'CCC', core: -61, capUsdM: null, lastClose: 1, atrNow: 1, capacityPct: null, stage: null, factors: {} as never },
          { sym: 'BBB', core: 22, capUsdM: null, lastClose: 1, atrNow: 1, capacityPct: null, stage: null, factors: {} as never },
        ],
      },
    )
    expect(missCandidates(trace).map(c => c.key)).toEqual(['CCC:short', 'BBB:long', 'DDD:long', 'AAA'])
  })
})

describe('accrual — both sides, always', () => {
  it('charges a sided LONG row that ran, and a sided SHORT row that fell, to the row’s own gate', async () => {
    const ledger = emptyMissLedger()
    const trace = traceOf({
      'RUN:long': { gate: 'dead-zone-core', side: 'long' },
      'FALL:short': { gate: 'evidence-fail', side: 'short' },
    })
    await accrueMissDay(ledger, trace, flat, io({ RUN: runner, FALL: faller }))
    expect(ledger.gates['dead-zone-core']!.cost).toBe(1)
    expect(ledger.gates['dead-zone-core']!.costExcessSum).toBeGreaterThan(MISS_EXCESS_MIN)
    expect(ledger.gates['evidence-fail']!.cost).toBe(1)
    // …and neither gate was charged the other's row
    expect(ledger.gates['dead-zone-core']!.saved).toBe(0)
    expect(ledger.gates['evidence-fail']!.saved).toBe(0)
    expect(ledger.days[ENTRY]).toEqual({ checked: 2, unchecked: 0, misses: 2 })
  })

  it('a sided LONG row that fell is a SAVE for the gate that blocked it', async () => {
    const ledger = emptyMissLedger()
    await accrueMissDay(ledger, traceOf({ 'FALL:long': { gate: 'entry-chase', side: 'long' } }), flat, io({ FALL: faller }))
    const g = ledger.gates['entry-chase']!
    expect(g.cost).toBe(0)
    expect(g.saved).toBe(1)
    expect(g.savedExcessSum).toBeLessThan(-MISS_EXCESS_MIN)
    expect(ledger.days[ENTRY]).toEqual({ checked: 1, unchecked: 0, misses: 0 })
  })

  it('a BARE row is evaluated BOTH ways: one side’s cost is the other side’s save', async () => {
    const ledger = emptyMissLedger()
    await accrueMissDay(ledger, traceOf({ RUN: { gate: 'trimmed' } }), flat, io({ RUN: runner }))
    const g = ledger.gates.trimmed!
    expect(g.cost).toBe(1)
    expect(g.saved).toBe(1)
    expect(g.examples.map(e => e.side).sort()).toEqual(['long', 'short'])
    expect(g.examples.every(e => e.sym === 'RUN' && e.gate === 'trimmed' && e.date === ENTRY)).toBe(true)
    // the day counts one ROW checked and one MISS (the cost side)
    expect(ledger.days[ENTRY]).toEqual({ checked: 1, unchecked: 0, misses: 1 })
  })

  it('a row that drifted inside the ±5pp bar is neither', async () => {
    const ledger = emptyMissLedger()
    await accrueMissDay(ledger, traceOf({ QUIET: { gate: 'trimmed' } }), flat, io({ QUIET: quiet }))
    expect(ledger.gates.trimmed).toBeUndefined()
    expect(ledger.days[ENTRY]).toEqual({ checked: 1, unchecked: 0, misses: 0 })
  })

  it('never even looks at a called-full row, and does look at a called-watch one', async () => {
    const ledger = emptyMissLedger()
    const t = io({ RUN: runner, WATCH: runner })
    await accrueMissDay(
      ledger,
      traceOf({ 'RUN:long': { gate: 'called-full', side: 'long' }, 'WATCH:long': { gate: 'called-watch', side: 'long' } }),
      flat,
      t,
    )
    expect(t.fetched).toEqual(['WATCH'])
    expect(ledger.gates['called-full']).toBeUndefined()
    expect(ledger.gates['called-watch']!.cost).toBe(1)
  })
})

describe('the budget — truncation is COUNTED, never silent', () => {
  it('spends nothing on names already in today’s cache, caps the fetches, and books the remainder as unchecked', async () => {
    const rows: Record<string, FunnelTraceRow> = { FREE: { gate: 'trimmed' } }
    const map: Record<string, Candle[] | null> = { FREE: runner }
    for (let i = 0; i < 6; i++) {
      rows[`P${i}:long`] = { gate: 'dead-zone-core', side: 'long' }
      map[`P${i}`] = runner
    }
    const ledger = emptyMissLedger()
    const t = io(map, ['FREE'])
    await accrueMissDay(ledger, traceOf(rows), flat, t, 2)
    expect(t.fetched).toHaveLength(2)
    // 2 paid + 1 free evaluated; the other 4 sided rows are UNCHECKED, on the record
    expect(ledger.days[ENTRY]).toEqual({ checked: 3, unchecked: 4, misses: 3 })
    expect(ledger.gates['dead-zone-core']!.cost).toBe(2)
  })

  it('a fetch that fails or a tape too short to mature is unchecked, not a silent zero', async () => {
    const ledger = emptyMissLedger()
    await accrueMissDay(
      ledger,
      traceOf({ 'GONE:long': { gate: 'no-candles', side: 'long' }, 'SHORTTAPE:long': { gate: 'trimmed', side: 'long' } }),
      flat,
      io({ GONE: null, SHORTTAPE: runner.slice(0, 35) }),
    )
    expect(ledger.days[ENTRY]).toEqual({ checked: 0, unchecked: 2, misses: 0 })
    // …and the gate itself carries the unpriced count: a gate that was never
    // measured must never read downstream as a gate that cost nothing
    expect(ledger.gates['no-candles']!).toMatchObject({ cost: 0, saved: 0, unchecked: 1 })
    expect(ledger.gates['trimmed']!).toMatchObject({ cost: 0, saved: 0, unchecked: 1 })
  })

  it("budget truncation charges each starved row's gate, and the rank-0 tiebreak rotates by date", async () => {
    const rows: Record<string, { gate: 'trimmed'; side: 'long' }> = {}
    for (let i = 0; i < 45; i++) rows[`SYM${String(i).padStart(2, '0')}:long`] = { gate: 'trimmed', side: 'long' }
    const l1 = emptyMissLedger()
    await accrueMissDay(l1, traceOf(rows), flat, io(Object.fromEntries(Object.keys(rows).map(k => [k.split(':')[0], runner]))))
    expect(l1.gates['trimmed']!.unchecked).toBe(5) // 45 rows, budget 40
    // …and the rank-0 tiebreak ROTATES: a different trace date orders the same
    // rows differently, so the starved tail is not the same names every day
    const t2 = traceOf(rows)
    ;(t2 as { date: string }).date = '2026-07-21'
    const order1 = missCandidates(traceOf(rows)).map(c => c.key)
    const order2 = missCandidates(t2).map(c => c.key)
    expect(order1).not.toEqual(order2)
    expect([...order1].sort()).toEqual([...order2].sort()) // same population, different spend order
  })

  it('a candles() that throws is unchecked, and never takes the day down with it', async () => {
    const ledger = emptyMissLedger()
    await accrueMissDay(ledger, traceOf({ 'BOOM:long': { gate: 'trimmed', side: 'long' } }), flat, {
      isFree: () => false,
      candles: async () => {
        throw new Error('upstream 502')
      },
    })
    expect(ledger.days[ENTRY]).toEqual({ checked: 0, unchecked: 1, misses: 0 })
  })
})

describe('the tombstone', () => {
  it('a disabled trace day is skipped ENTIRELY — no day entry, no counters, nothing', async () => {
    const ledger = emptyMissLedger()
    const t = io({ RUN: runner })
    await accrueMissDay(ledger, traceOf({ RUN: { gate: 'trimmed' } }, { disabled: true }), flat, t)
    expect(ledger).toEqual(emptyMissLedger())
    expect(ledger.days[ENTRY]).toBeUndefined()
    expect(t.fetched).toEqual([])
  })
})

describe('bounds', () => {
  it('keeps ten examples per gate, newest winning', () => {
    const ledger = emptyMissLedger()
    for (let i = 0; i < MISS_EXAMPLES_PER_GATE + 4; i++)
      accrueMissEvent(ledger, { date: dateOf(i), sym: `S${i}`, side: 'long', excessPct: 9, gate: 'trimmed' })
    const g = ledger.gates.trimmed!
    expect(g.cost).toBe(14)
    expect(g.examples).toHaveLength(MISS_EXAMPLES_PER_GATE)
    expect(g.examples[0].sym).toBe('S4')
    expect(g.examples[MISS_EXAMPLES_PER_GATE - 1].sym).toBe('S13')
  })

  it('keeps sixty days, newest winning', () => {
    const ledger = emptyMissLedger()
    for (let i = 0; i < MISS_LEDGER_DAYS_MAX + 5; i++) recordMissDay(ledger, dateOf(i), { checked: i, unchecked: 0, misses: 0 })
    const days = Object.keys(ledger.days).sort()
    expect(days).toHaveLength(MISS_LEDGER_DAYS_MAX)
    expect(days[0]).toBe(dateOf(5))
    expect(days[MISS_LEDGER_DAYS_MAX - 1]).toBe(dateOf(MISS_LEDGER_DAYS_MAX + 4))
  })

  it('normalises a missing or malformed blob into an empty ledger rather than throwing', () => {
    expect(normaliseMissLedger(null)).toEqual(emptyMissLedger())
    expect(normaliseMissLedger('nonsense')).toEqual(emptyMissLedger())
    expect(normaliseMissLedger({ gates: null, days: 7 })).toEqual(emptyMissLedger())
    const live = { gates: { trimmed: { cost: 1, costExcessSum: 9, saved: 0, savedExcessSum: 0, examples: [] } }, days: { x: { checked: 1, unchecked: 0, misses: 1 } } }
    expect(normaliseMissLedger(live)).toEqual(live)
  })
})

describe('maturedTraceDate — SESSIONS back, never calendar days', () => {
  it('picks the newest trace date with a full ten sessions of SPY after it', () => {
    const index = [dateOf(40), dateOf(45), dateOf(48), dateOf(49), dateOf(52)]
    // flat has 60 bars: idx + 10 < 60 ⇒ idx ≤ 49
    expect(maturedTraceDate(index, flat)).toBe(dateOf(49))
  })

  it('returns null when nothing has matured, and ignores junk dates', () => {
    expect(maturedTraceDate([dateOf(55), dateOf(58)], flat)).toBeNull()
    expect(maturedTraceDate([], flat)).toBeNull()
    expect(maturedTraceDate(['', 'yesterday', dateOf(20)], flat)).toBe(dateOf(20))
  })

  it('is unmoved by a GAP in the index — an outage day shifts positions, sessions do not', () => {
    expect(maturedTraceDate([dateOf(10), dateOf(49)], flat)).toBe(dateOf(49))
    expect(maturedTraceDate([dateOf(49), dateOf(10)], flat)).toBe(dateOf(49))
  })
})

describe('missLedgerSummary — the bounded read every surface prints', () => {
  const ledgerWith = () => {
    const l = emptyMissLedger()
    // dead-zone-core: three costs, one big; expected-move: one cost, two saves
    for (const excess of [6, 8, 22]) accrueMissEvent(l, { date: ENTRY, sym: 'A', side: 'long', excessPct: excess, gate: 'dead-zone-core' })
    accrueMissEvent(l, { date: ENTRY, sym: 'B', side: 'long', excessPct: 7, gate: 'expected-move' })
    for (const excess of [-9, -11]) accrueMissEvent(l, { date: ENTRY, sym: 'C', side: 'short', excessPct: excess, gate: 'expected-move' })
    accrueUnchecked(l, 'dead-zone-core')
    accrueUnchecked(l, 'diversity')
    recordMissDay(l, ENTRY, { checked: 12, unchecked: 2, misses: 4 })
    recordMissDay(l, dateOf(31), { checked: 8, unchecked: 1, misses: 1 })
    return l
  }

  it('totals the day window, ranks the gates by cost and carries the average of what each refused', () => {
    const s = missLedgerSummary(ledgerWith())!
    expect(s).toMatchObject({ days: 2, checked: 20, unchecked: 3, misses: 5 })
    expect(s.topGates[0]).toEqual({ gate: 'dead-zone-core', cost: 3, avgCostExcessPct: 12, saved: 0, unchecked: 1 })
    expect(s.topGates[1]).toEqual({ gate: 'expected-move', cost: 1, avgCostExcessPct: 7, saved: 2, unchecked: 0 })
    // a gate that has only ever been UNCHECKED still appears — it is the one the
    // ledger knows least about, and hiding it is how it would read as costless
    expect(s.topGates[2]).toEqual({ gate: 'diversity', cost: 0, avgCostExcessPct: null, saved: 0, unchecked: 1 })
    expect(s.topGates).toHaveLength(3)
  })

  it('the caveat is not optional: it names the unpriced population and the stopless bound', () => {
    const s = missLedgerSummary(ledgerWith())!
    expect(s.note).toContain('3 of 23 refusals went unpriced')
    expect(s.note).toMatch(/unmeasured gate is not a costless one/)
    expect(s.note).toMatch(/stopless upper bounds/)
  })

  it('is null on a ledger nothing has ever been written to — a surface must not announce a confident zero', () => {
    expect(missLedgerSummary(null)).toBeNull()
    expect(missLedgerSummary(emptyMissLedger())).toBeNull()
    expect(missLedgerSummary('nonsense')).toBeNull()
  })

  it('survives a half-written blob and honours topN', () => {
    const l = emptyMissLedger()
    l.gates['trimmed'] = { cost: 2 } as unknown as (typeof l.gates)['trimmed']
    recordMissDay(l, ENTRY, {} as unknown as { checked: number; unchecked: number; misses: number })
    const s = missLedgerSummary(l, 1)!
    expect(s.topGates).toEqual([{ gate: 'trimmed', cost: 2, avgCostExcessPct: 0, saved: 0, unchecked: 0 }])
    expect(s).toMatchObject({ days: 1, checked: 0, unchecked: 0, misses: 0 })
  })
})

describe('regretDisabled — the parity seam', () => {
  it('is OFF by default and reads only the exact opt-in string', () => {
    // The default is what production runs, so it is pinned first: nothing has to
    // be set for the engine to measure its own regret.
    expect(regretDisabled()).toBe(false)
    for (const v of ['off', 'OFF', 'false', '0', '1', 'on', '', 'offf']) {
      vi.stubEnv('REGRET', v)
      try {
        expect(`${v}:${regretDisabled()}`).toBe(`${v}:${v === 'off'}`)
      } finally {
        vi.unstubAllEnvs()
      }
    }
  })
})
