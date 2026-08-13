import { describe, expect, it } from 'vitest'
import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import type { Candle } from '../../../shared/types'
import type { GateCode } from '../../../shared/engine/types'
import { MODERATE_GATES } from '../../../shared/engine/catalyst'
import { FUNNEL_TRACE_INDEX_KEY, funnelTraceKey, type FunnelTrace, type FunnelTraceRow } from '../../../shared/engine/funnelTrace'
import { MISS_LEDGER_KEY, type MissLedger } from '../../../shared/engine/missLedger'

// ---- fixtures ----

const T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const BARS = 60
const dateOf = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)
/** flat SPY has 60 bars, so idx + 10 < 60 ⇒ the newest matured trace day is 49. */
const TRACE_DATE = dateOf(49)
const NOW = Math.floor(T0 + BARS * DAY)

const tape = (closeAt: (i: number) => number, openAt: (i: number) => number = closeAt): Candle[] =>
  Array.from({ length: BARS }, (_, i) => {
    const c = closeAt(i)
    const o = openAt(i)
    return { t: T0 + i * DAY, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1_000_000 }
  })

const flat = tape(() => 100)
const runner = tape(i => (i < 49 ? 100 : 100 * 1.03 ** (i - 49)))
const faller = tape(i => (i < 49 ? 100 : 100 * 0.97 ** (i - 49)))

const fetched: string[] = []
const deps = (over: Partial<EngineDeps> = {}): EngineDeps =>
  ({
    candles: async (sym: string) => {
      fetched.push(sym)
      return sym === 'SPY' ? flat : sym === 'RUN' || sym === 'BIG' || sym === 'TRIM' ? runner : sym === 'FALL' ? faller : null
    },
    candles5y: async () => null,
    capUsdM: async () => null,
    companyName: async () => null,
    screens: async () => [],
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
    ...over,
  }) as unknown as EngineDeps

const ROWS: Record<string, FunnelTraceRow> = {
  'RUN:long': { gate: 'dead-zone-core', side: 'long', detail: 'core 18 inside the dead zone' },
  'FALL:short': { gate: 'evidence-fail', side: 'short' },
  'BIG:long': { gate: 'called-full', side: 'long' },
  TRIM: { gate: 'trimmed' },
}

const traceOf = (over: Partial<FunnelTrace> = {}): FunnelTrace => ({
  date: TRACE_DATE,
  gates: MODERATE_GATES,
  rows: ROWS,
  counts: { notCandidate: 0 },
  nearMisses: [],
  emptySides: {},
  ...over,
})

/** Remembers which keys the pass wrote, so a test can prove the miss ledger is
 * the ONLY thing that appeared. */
const recordingStore = (): AppStore & { keys: Set<string> } => {
  const inner = memoryStore()
  const keys = new Set<string>()
  return {
    keys,
    read: inner.read,
    async write(key, value) {
      keys.add(key)
      await inner.write(key, value)
    },
  }
}

const seeded = async (trace: FunnelTrace | null, index: string[] = [TRACE_DATE]) => {
  const store = recordingStore()
  await store.write(FUNNEL_TRACE_INDEX_KEY, index)
  if (trace) await store.write(funnelTraceKey(trace.date), trace)
  store.keys.clear()
  fetched.length = 0
  return store
}

/** Everything the grading pass writes with an empty prediction store — the pin
 * for "the miss ledger adds a key and touches nothing". */
const GRADING_KEYS = ['predictions-pending', 'engine-scorecard', 'engine-weights', 'engine-calibration', 'channel-credibility', 'risk-state']

describe('gradeOutstanding → the miss ledger', () => {
  it('walks the trace day that just matured, charges each row to ITS OWN gate, and adds exactly one key', async () => {
    const store = await seeded(traceOf())
    await gradeOutstanding(store, deps(), NOW)

    expect([...store.keys].sort()).toEqual([...GRADING_KEYS, MISS_LEDGER_KEY].sort())
    const ledger = (await store.read<MissLedger>(MISS_LEDGER_KEY))!
    expect(ledger.days[TRACE_DATE]).toEqual({ checked: 3, unchecked: 0, misses: 3 })

    // the refused long that ran, charged to the dead zone
    expect(ledger.gates['dead-zone-core']!.cost).toBe(1)
    expect(ledger.gates['dead-zone-core']!.saved).toBe(0)
    expect(ledger.gates['dead-zone-core']!.examples[0]).toMatchObject({ sym: 'RUN', side: 'long', gate: 'dead-zone-core', date: TRACE_DATE })
    expect(ledger.gates['dead-zone-core']!.examples[0].excessPct).toBeGreaterThanOrEqual(5)

    // the refused short that fell, charged to the evidence contract
    expect(ledger.gates['evidence-fail']!.cost).toBe(1)

    // the bare row, both ways at once
    expect(ledger.gates.trimmed).toEqual(expect.objectContaining({ cost: 1, saved: 1 }))

    // …and the SIZED call was never even priced
    expect(ledger.gates['called-full']).toBeUndefined()
    expect(fetched).not.toContain('BIG')
    expect(fetched).toContain('RUN')
  })

  it('is idempotent: a second pass on the same day does not charge a gate twice', async () => {
    const store = await seeded(traceOf())
    await gradeOutstanding(store, deps(), NOW)
    const first = JSON.stringify(await store.read<MissLedger>(MISS_LEDGER_KEY))
    fetched.length = 0
    await gradeOutstanding(store, deps(), NOW)
    expect(JSON.stringify(await store.read<MissLedger>(MISS_LEDGER_KEY))).toBe(first)
    expect(fetched.filter(s => s !== 'SPY')).toEqual([]) // it did not even re-price the day
  })

  it('a TOMBSTONE day is skipped entirely — an empty trace is no data, never zero refusals', async () => {
    const store = await seeded(traceOf({ rows: {}, disabled: true }))
    await gradeOutstanding(store, deps(), NOW)
    expect(store.keys.has(MISS_LEDGER_KEY)).toBe(false)
    expect(await store.read<MissLedger>(MISS_LEDGER_KEY)).toBeNull()
    // …and it is not "checked with nothing in it" either
    expect([...store.keys].sort()).toEqual([...GRADING_KEYS].sort())
  })

  it('no trace, no index and an unmatured index are all silent no-ops', async () => {
    for (const [trace, index] of [
      [null, [TRACE_DATE]],
      [null, []],
      [traceOf({ date: dateOf(55) }), [dateOf(55)]], // 55 + 10 ≥ 60: nothing has matured
    ] as [FunnelTrace | null, string[]][]) {
      const store = await seeded(trace, index)
      await expect(gradeOutstanding(store, deps(), NOW)).resolves.toEqual({ graded: 0 })
      expect(store.keys.has(MISS_LEDGER_KEY)).toBe(false)
    }
  })

  it('fails soft: a store that cannot serve the trace leaves grading complete and every learning blob written', async () => {
    const store = await seeded(traceOf())
    const boom: AppStore & { keys: Set<string> } = {
      keys: store.keys,
      read: async <T,>(key: string) => {
        if (key.startsWith('funnel-trace')) throw new Error('blobs 503')
        return store.read<T>(key)
      },
      write: store.write,
    }
    await expect(gradeOutstanding(boom, deps(), NOW)).resolves.toEqual({ graded: 0 })
    expect([...store.keys].sort()).toEqual([...GRADING_KEYS].sort())
  })

  it('honours the fetch budget by counting what it could not reach', async () => {
    const rows: Record<string, FunnelTraceRow> = {}
    for (let i = 0; i < 45; i++) rows[`N${i}:long`] = { gate: 'slot-cut' as GateCode, side: 'long' }
    const store = await seeded(traceOf({ rows }))
    await gradeOutstanding(store, deps({ candles: async (s: string) => (s === 'SPY' ? flat : runner) }), NOW)
    const day = (await store.read<MissLedger>(MISS_LEDGER_KEY))!.days[TRACE_DATE]
    expect(day.checked).toBe(40)
    expect(day.unchecked).toBe(5)
    expect(day.checked + day.unchecked).toBe(45) // nothing vanished
  })
})
