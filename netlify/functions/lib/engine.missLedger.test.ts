import { describe, expect, it, vi } from 'vitest'
import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import type { Candle } from '../../../shared/types'
import type { GateCode } from '../../../shared/engine/types'
import { MODERATE_GATES } from '../../../shared/engine/catalyst'
import { FUNNEL_TRACE_INDEX_KEY, funnelTraceKey, type FunnelTrace, type FunnelTraceRow } from '../../../shared/engine/funnelTrace'
import { MISS_LEDGER_KEY, type MissLedger } from '../../../shared/engine/missLedger'
import { GATE_STATE_KEY, effectiveGates, gateStateSummary, type GateState } from '../../../shared/engine/gateState'

// ---- fixtures ----

const T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const BARS = 60
const dateOf = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)
/** flat SPY has 60 bars and MISS_HORIZON is the CALIBRATED horizon, 21 sessions
 * since CALIB_DEF_VERSION v4 — so idx + 21 < 60 ⇒ the newest matured trace day is
 * 38, where it used to be 49 at the 10-session clock. The regret ledger runs
 * further behind the board than it did, deliberately: a miss and a hit have to be
 * measured over the same window or `cost` vs `saved` compares two questions. */
const TRACE_DATE = dateOf(38)
const NOW = Math.floor(T0 + BARS * DAY)

const tape = (closeAt: (i: number) => number, openAt: (i: number) => number = closeAt): Candle[] =>
  Array.from({ length: BARS }, (_, i) => {
    const c = closeAt(i)
    const o = openAt(i)
    return { t: T0 + i * DAY, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1_000_000 }
  })

const flat = tape(() => 100)
const runner = tape(i => (i < 38 ? 100 : 100 * 1.03 ** (i - 38)))
const faller = tape(i => (i < 38 ? 100 : 100 * 0.97 ** (i - 38)))

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
const GRADING_KEYS = ['predictions-pending', 'engine-scorecard', 'engine-weights', 'engine-calibration', 'risk-state']

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
      [traceOf({ date: dateOf(55) }), [dateOf(55)]], // 55 + 21 ≥ 60: nothing has matured
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

  it('REGRET=off measures nothing at all — the parity seam, on the day it would have measured', async () => {
    // The same matured trace day the first test walks. With the seam off the pass
    // writes exactly the six grading keys, fetches not one candle for a refusal,
    // and leaves no blob behind — which is what makes the window walk's
    // published-output comparison a comparison of two different engines' output
    // rather than of one engine with itself.
    vi.stubEnv('REGRET', 'off')
    const store = await seeded(traceOf())
    try {
      await gradeOutstanding(store, deps(), NOW)
    } finally {
      vi.unstubAllEnvs()
    }
    expect([...store.keys].sort()).toEqual([...GRADING_KEYS].sort())
    expect(await store.read(MISS_LEDGER_KEY)).toBeNull()
    expect(fetched.filter(s => s !== 'SPY')).toEqual([]) // the pass's own tape, and not one refusal priced
  })
})

// ---- …and the gate that ledger has been charging ----

/** A trace day whose dead zone refused `n` names that then all ran — the shape of
 * the evidence the live ledger has been accruing since 3a deployed. */
const deadZoneDay = (n: number) => {
  const rows: Record<string, FunnelTraceRow> = {}
  for (let i = 0; i < n; i++) rows[`R${i}:long`] = { gate: 'dead-zone-core', side: 'long', core: 18 + i / 100 }
  return traceOf({ rows })
}
const allRun = () => deps({ candles: async (s: string) => (s === 'SPY' ? flat : runner) })

describe('gradeOutstanding → the gates move', () => {
  it('moves the dead zone one notch on its own evidence, writes the history, and says so in the runlog', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const store = await seeded(deadZoneDay(31))
    let logged: unknown[] = []
    try {
      await gradeOutstanding(store, allRun(), NOW)
      logged = log.mock.calls.flat() // read BEFORE restoring — mockRestore drops the record
    } finally {
      log.mockRestore()
    }
    const state = (await store.read<GateState>(GATE_STATE_KEY))!
    expect(state.gates.deadZone!.delta).toBe(-2.5)
    expect(state.gates.deadZone!.history).toHaveLength(1)
    expect(state.gates.deadZone!.history[0]).toMatchObject({ from: 25, to: 22.5 })
    expect(effectiveGates({}, state).deadZone).toBe(22.5)
    // the announcement, in the run's own log
    expect(logged.filter(l => typeof l === 'string' && l.startsWith('GATE:')).join('|')).toContain('dead zone 25 → 22.5')
    // …and only the ONE new key beyond the grading pass's own
    expect([...store.keys].sort()).toEqual([...GRADING_KEYS, MISS_LEDGER_KEY, GATE_STATE_KEY].sort())
  })

  it('29 attributed outcomes move nothing, and write no blob at all', async () => {
    const store = await seeded(deadZoneDay(29))
    await gradeOutstanding(store, allRun(), NOW)
    expect(store.keys.has(GATE_STATE_KEY)).toBe(false)
    expect(await store.read(GATE_STATE_KEY)).toBeNull()
  })

  it('an owner override pins the gate, and the panel note says so once', async () => {
    const store = await seeded(deadZoneDay(31))
    await gradeOutstanding(store, allRun(), NOW, { watchlist: [], rules: [], ytChannels: [], capital: 5000, gateOverride: { deadZone: 25 } })
    const state = (await store.read<GateState>(GATE_STATE_KEY))!
    expect(state.gates.deadZone!.delta).toBe(0)
    expect(state.gates.deadZone!.blocked).toMatchObject({ why: 'override' })
    expect(gateStateSummary(state)!.notes[0]).toContain('override')
  })

  it('GATES=off is the rollback lever: the ledger still measures, the gate still cannot move', async () => {
    vi.stubEnv('GATES', 'off')
    const store = await seeded(deadZoneDay(31))
    try {
      await gradeOutstanding(store, allRun(), NOW)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(store.keys.has(MISS_LEDGER_KEY)).toBe(true) // the measurement is untouched…
    expect(store.keys.has(GATE_STATE_KEY)).toBe(false) // …and the lever is dead
  })
})
