import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildBoard, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import type { Candle } from '../../../shared/types'
import type { GateCode, Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState } from '../../../shared/engine/calibration'
import { MODERATE_GATES } from '../../../shared/engine/catalyst'
import { FUNNEL_TRACE_INDEX_KEY, TRACE_DETAIL_MAX, funnelTraceKey, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import { GATE_STATE_KEY } from '../../../shared/engine/gateState'

// ---- fixtures (kept local: the golden below was captured from EXACTLY these) ----

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })

/** A rolled-over name: ran 80→280, now bleeding −2/day. Composites a short. */
const shorty = mk(i => (i < 200 ? 80 + i * 1.0 : 280 - (i - 200) * 2.0))
/** The same skeleton oscillating at its own frequency — five of them are five
 * genuinely different bets (60-day return correlation under 0.1). */
const shortyVariant = (k: number) => mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2) * (1 + 0.04 * Math.sin(i * k)))
const flat = mk(() => 500)
const NOW = Math.floor(shorty[shorty.length - 1].t + 86_400)
const TODAY = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

/** A dip the LANE ITSELF refuses. Triggered and holding (4.1% above the 84.5 dip
 * low on 1.6× volume) — but today opened at 76, so the stop has to hide under 76
 * while the half-retrace target sits at 94: risking 12 to make 6, which dipCall's
 * 1:1 gate declines. Swing capacity is 0, so the composite publishes nothing on it
 * either. The one tape whose whole day ends at the dip lane's own refusal. */
const dipRefusedTape = (() => {
  const bars: Candle[] = []
  const push = (c: number, v = 1_000_000, o = c, h = c, l = c) => bars.push({ t: T0 + bars.length * 86_400, o, h, l, c, v })
  for (let i = 0; i < 60; i++) push(100)
  push(94)
  push(90)
  push(87)
  push(85, 1_000_000, 86, 86, 84.5)
  push(85.5)
  push(88, 1_600_000, 76, 88, 76)
  return bars
})()

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
  social: async () => [],
  sparkCloses: async () => new Map<string, number[]>(),
  insiderCoverage: async () => new Map(),
  smartMoney: async () => [],
  mediaTitles: async () => ['[Bloomberg] NVDA plunges as demand warns mount'],
  newsCatalysts: async () => [],
  dipNewsCached: async () => null,
  dipNews: async () => ({ verdict: 'unclear', reason: 'stub' }),
  recentIpos: async () => [],
  earningsSyms: async () => new Set<string>(),
  earningsCalendar: async () => [],
  worldReads: async () => [],
  holdings: async () => null,
  ...over,
})

const calWith = (key: string, n = 32, hits = 22): CalibrationState => ({
  buckets: { [key]: { n, hits } },
  brier: [],
  defVersion: CALIB_DEF_VERSION,
  seedGeneration: 5,
})

/** A store that remembers WHICH keys were written, so a test can prove the trace
 * added keys and disturbed nothing else. */
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

/** THE GOLDEN DAY. Everything the zero-behaviour-change constraint is pinned on
 * runs against exactly this store + these deps. */
const goldenStore = async () => {
  const store = recordingStore()
  await store.write('config', {
    // INV is NVDA's inverse route, so the watchlist door offers a name that
    // isRouteEtp refuses: the one bounded population `not-candidate` can count.
    watchlist: [{ symbol: 'INV' }],
    rules: [],
    ytChannels: [],
    levMap: { NVDA: { short2x: 'INV' } },
  })
  await store.write('engine-calibration', calWith('short:amber:55-70'))
  // TWO bearish channels, not one, and the second is load-bearing: this fixture's
  // job includes proving that MOVING the context cap moves what publishes, which
  // only one video could do while the core had four factors to divide by. A fifth
  // core weight (`bandwidth`, 2026-09-22) grew coreDen ~18%, which shrank the
  // same context vote below the 12-point cap and quietly turned that assertion
  // into a tautology. A second stance puts the context layer back ON the cap.
  await store.write('video-extracts', [
    { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    { url: 'yt/2', channel: 'The Chart Room', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
  ])
  return store
}

const readTrace = (store: AppStore) => store.read<FunnelTrace>(funnelTraceKey(TODAY))
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex')

// THE GOLDEN, captured at BASE 458c6c4 — before a single line of the trace
// existed — by running the fixture above and hashing `{board, ledger}`. To
// regenerate after an INTENDED engine change: log `sha({board, ledger})` from
// this fixture and paste it back, and say in the commit why the board moved.
// Naming the noes may never change a yes.
//
// RE-STAMPED ONCE, at stage 3c's accrual field: every published row now carries
// `accrual: 'sized' | 'shadow'` — which population its outcome will teach — so the
// serialisation moved by exactly one key per row. Nothing the reader sees moved,
// and the readable half of this pin (GOLDEN_ROWS: id, grade, composite, riskPct,
// entry, stop, target, watch/shadow/near) is unchanged and was NOT re-stamped —
// which is the evidence that the hash moved for a new field and not for a new
// decision. d065d21… was the pre-3c value.
// Re-stamped for the research-lab port: each published row now carries a
// sleeve, an explicit forecast contract and detection/availability timestamps.
// The readable decision projection below remains unchanged.
//
// RE-STAMPED AGAIN on 2026-09-22, and this time THE DECISION MOVED — so the
// readable projection moved with it and the reason is written down rather than
// hashed away. `bandwidth` joined the CORE (ENGINE_MODEL_VERSION 3 → 4), which
// puts a fifth weight in the denominator every core composite is divided by, and
// `momentum` grew a 60-session relative-strength leg. On this tape those two
// changes read: technical −45, momentum −80 (clamped either way), bandwidth −50 —
// a name in a straight-line slide prints the WIDEST Bollinger width of its own
// last 120 sessions, and the study's positive IC on that percentile puts the
// widest decile at its better-performing end, so it DEEPENS the read. The short
// goes −64.8 → −63.5. The grade, the rung, the entry, the stop, the target and
// the planted band (55-70, whose 62.5 midpoint the read still clears) are all
// unchanged. 96a4ccbc… was the pre-bandwidth value.
const GOLDEN_SHA = '6d221d1760fca88fbaaf29b71f0267bbe52c1852e19ab72e7d11385eb59a7d45'
const GOLDEN_ROWS = ['2026-02-17:NVDA:short A c=-63.5 r=1 e=162 s=170.44 t=150.75 ']
/** Every key the golden day wrote at BASE. The trace may ADD to this list and
 * may touch nothing in it. */
const GOLDEN_KEYS = [
  'engine-board',
  'engine-lab',
  'engine-lab-ledger',
  'engine-lab-social-history',
  'engine-roster',
  'engine-roster-log',
  'event-radar',
  'news-tone-history',
  'pattern-sightings',
  'predictions-index',
  'predictions-pending',
  `predictions:${TODAY}`,
]

const projection = (rows: Prediction[]) =>
  rows.map(
    p =>
      `${p.id} ${p.grade} c=${p.composite} r=${p.riskPct} e=${p.entry} s=${p.stop} t=${p.target} ${p.watchOnly ? 'watch' : ''}${p.shadow ? 'shadow' : ''}${p.nearMiss ? 'near' : ''}`,
  )

describe('the funnel trace', () => {
  it('changes nothing it publishes: the board and the ledger are byte-identical, and funnel-trace:* is the only new key', async () => {
    const store = await goldenStore()
    const seeded = new Set(store.keys)
    await buildBoard(store, deps(), NOW)

    const board = (await store.read<{ board: Prediction[] }>('engine-board'))!.board
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    // the readable half of the pin — a failure says WHICH row moved…
    expect(projection(board)).toEqual(GOLDEN_ROWS)
    expect(projection(ledger)).toEqual(GOLDEN_ROWS)
    // …and the byte-exact half: every field of every row, including the ten
    // weighted factors, the evidence block, the thesis and the falsifier.
    expect(sha({ board, ledger })).toBe(GOLDEN_SHA)

    const written = [...store.keys].filter(k => !seeded.has(k)).sort()
    expect(written.filter(k => !k.startsWith('funnel-trace'))).toEqual(GOLDEN_KEYS)
    expect(written.filter(k => k.startsWith('funnel-trace')).sort()).toEqual([FUNNEL_TRACE_INDEX_KEY, funnelTraceKey(TODAY)])
  })

  it('names every candidate’s fate exactly once — and counts the name that never became one', async () => {
    const store = await goldenStore()
    await buildBoard(store, deps(), NOW)
    const trace = (await readTrace(store))!

    expect(trace.date).toBe(TODAY)
    expect(trace.gates).toEqual(MODERATE_GATES) // the thresholds this run was judged against
    // NVDA cleared everything and traded at the full rung — keyed by SIDE.
    expect(trace.rows['NVDA:short']).toMatchObject({ gate: 'called-full', side: 'short', source: 'screener:gainers' })
    // EXACTLY ONCE per (name, side-or-none) — a name is a row or a count, never
    // both. INV is NVDA's inverse route, so addSource refused it as a candidate;
    // but the watchlist rides into the roster unconditionally (roster.ts), so it
    // was scored anyway and earned a row of its own. It is therefore NOT in the
    // count. Its tape never arrived, so it died before it had a side: bare key.
    expect(trace.rows.INV).toBeDefined()
    expect(trace.counts).toEqual({ notCandidate: 0 })
    // Every published row is accounted for, and no (name, side) twice.
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    for (const p of ledger) expect(trace.rows[`${p.sym.toUpperCase()}:${p.side}`]).toBeDefined()
    expect(Object.keys(trace.rows)).toEqual([...new Set(Object.keys(trace.rows))])
    // …and every name the run touched IS in the trace: the rotation door alone
    // puts both top sectors' members in the pool, and every one of them is named.
    expect(Object.keys(trace.rows).length).toBeGreaterThan(10)
    for (const [key, row] of Object.entries(trace.rows)) {
      const [sym, side] = key.split(':')
      expect(sym).toBe(sym.toUpperCase())
      expect(side).toBe(row.side) // the key IS the (name, side) pair — never out of step with the row
      expect(row.detail == null || row.detail.length <= TRACE_DETAIL_MAX).toBe(true)
    }
    // the empty long side keeps its reason, beside the near-miss array verbatim
    expect(trace.emptySides.long).toBe('gates')
    expect(Array.isArray(trace.nearMisses)).toBe(true)
  })

  it('the run is judged against the gates FEEDBACK earned, and the trace records which ones they were', async () => {
    // Nothing moves while the blob is absent — that is the golden day above, whose
    // trace stamps MODERATE_GATES exactly. Here the blob says three gates have
    // moved, and the run must be judged against those values and record them.
    const store = await goldenStore()
    // …written in the LEGACY shape on purpose (`lastMoveSession`, the session
    // count the cadence clock used before it counted index dates): a blob from
    // before that fix must still judge a run, and only the deltas decide these
    // thresholds.
    await store.write(GATE_STATE_KEY, {
      gates: {
        deadZone: { delta: -5, lastMoveSession: 3, history: [] },
        minExpectedMovePct: { delta: -0.25, lastMoveSession: 3, history: [] },
        contextCap: { delta: 2, lastMoveSession: 3, history: [] },
      },
    })
    await buildBoard(store, deps(), NOW)
    const trace = (await readTrace(store))!
    expect(trace.gates).toEqual({ deadZone: 20, minExpectedMovePct: 1.25, contextMaxPts: 14 })
    // …and the move is VISIBLE in what published, by exactly the amount the moved
    // gate allows and not a point more: this day's context layer sits ON the cap,
    // so raising it 12 → 14 moves the composite −63.5 → −65.5. The grade, the
    // rung and every level are untouched — the dead zone at 20 changes what a
    // MARGINAL name does, and NVDA at −65.5 was never marginal.
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    expect(projection(ledger)).toEqual(GOLDEN_ROWS.map(r => r.replace('c=-63.5', 'c=-65.5')))
  })

  it('a name a door offered and the pool refused is counted, never listed', async () => {
    const store = recordingStore()
    // The inverse route arrives through the SCREENS door this time, which has no
    // unconditional ride into the roster — so INV is refused outright and never
    // scored. That is the whole bounded population `not-candidate` can honestly
    // count: the universe of names nobody nominated is infinite.
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    await buildBoard(
      store,
      deps({
        screens: async () =>
          ['NVDA', 'INV'].map(sym => ({ row: { sym, price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' })),
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    expect(trace.counts).toEqual({ notCandidate: 1 })
    expect(Object.keys(trace.rows).filter(k => k.startsWith('INV'))).toEqual([])
    expect(trace.rows['NVDA:short'].gate).toMatch(/^called-/) // …while the name beside it published normally
  })

  it('a tape that never arrived is no-candles, not no-data: a supply failure is not a scoring failure', async () => {
    const store = await goldenStore()
    await buildBoard(store, deps(), NOW)
    const trace = (await readTrace(store))!

    // XLK and XLU are the day's top two sectors, so their members enter the pool
    // through the rotation door — and the fixture serves candles for none of them.
    const noCandles = Object.entries(trace.rows).filter(([, r]) => r.gate === 'no-candles')
    expect(noCandles.length).toBeGreaterThan(5)
    expect(noCandles[0][1].detail).toContain('no candles')
    expect(noCandles[0][1].source).toBeTruthy() // the door it came in through survives
    // …and NOTHING in this run is `no-data`, which belongs to composeCall's
    // `!coreDen` — the chart was there and no core factor scored. The two are
    // separate codes precisely so a data outage can never read as a scoring bug.
    expect(Object.values(trace.rows).some(r => r.gate === 'no-data')).toBe(false)
  })

  it('a called-half row records its size class, and a row the trade cut sent to the WATCH list reads called-watch — carrying the cut that sent it', async () => {
    const store = recordingStore()
    // Five uncorrelated rolled-over names, all half-size C trades (empty
    // calibration → base rate 0.5 → every band grades C; the contract passes on
    // breadth plus two agreeing core families). Five actionable rows, three slots.
    const fives: [string, number][] = [
      ['AAA', 0.7],
      ['BBB', 1.1],
      ['CCC', 1.9],
      ['DDD', 2.5],
      ['EEE', 1.5],
    ]
    const tapes = new Map(fives.map(([sym, k]) => [sym, shortyVariant(k)]))
    const syms = fives.map(([sym]) => sym)
    await store.write('config', {
      watchlist: syms.map(symbol => ({ symbol })),
      rules: [],
      ytChannels: [],
      levMap: Object.fromEntries(syms.map(s => [s, { short2x: `I${s}` }])),
    })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']
    await buildBoard(
      store,
      deps({
        screens: async () =>
          [...syms, ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' })),
        mediaTitles: async () => [],
        candles: async sym => tapes.get(sym) ?? (fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    const gates = syms.map(s => trace.rows[`${s}:short`].gate)
    expect(gates.filter(g => g === 'called-half')).toHaveLength(3) // the three that kept a slot
    // …and the two the 3-a-side cap demoted, which then LANDED on the watch list
    // (6 slots a side, two takers) — so what the reader gets is what the trace says
    expect(gates.filter(g => g === 'called-watch')).toHaveLength(2)
    const cut = syms.filter(s => trace.rows[`${s}:short`].gate === 'called-watch')
    for (const s of cut) {
      expect(trace.rows[`${s}:short`]).toMatchObject({ side: 'short', source: 'screener:losers' })
      expect(trace.rows[`${s}:short`].detail).toContain('3 per side already filled')
    }
    for (const s of syms.filter(x => !cut.includes(x))) expect(trace.rows[`${s}:short`].detail).toContain('grade C')
    // and the demoted rows are on the board and in the ledger exactly as before —
    // the trace records the cut, it does not perform one
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    expect(ledger.filter(p => syms.includes(p.sym))).toHaveLength(5)
  })

  it('the correlation gate’s own why survives into the trace — the wildcard lane reads exactly these rows', async () => {
    const store = recordingStore()
    // Four names on ONE tape shape: perfectly correlated, so the first is picked
    // and the rest are refused for redundancy rather than for want of a slot.
    const twin = shortyVariant(0.7)
    const syms = ['AAA', 'BBB', 'CCC', 'DDD']
    await store.write('config', {
      watchlist: syms.map(symbol => ({ symbol })),
      rules: [],
      ytChannels: [],
      levMap: Object.fromEntries(syms.map(s => [s, { short2x: `I${s}` }])),
    })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']
    await buildBoard(
      store,
      deps({
        screens: async () =>
          [...syms, ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' })),
        mediaTitles: async () => [],
        candles: async sym => (syms.includes(sym) ? twin : fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    const blocked = syms.filter(s => /corr>0\.75 with [A-Z]{3}/.test(trace.rows[`${s}:short`].detail ?? ''))
    expect(blocked.length).toBeGreaterThanOrEqual(3)
    // the ones the WATCH cut also refused keep the gate; the one it seated reads
    // called-watch and still carries the correlation partner that cost it its trade
    for (const s of blocked) expect(['diversity', 'called-watch']).toContain(trace.rows[`${s}:short`].gate)
    expect(syms.filter(s => trace.rows[`${s}:short`].gate === 'diversity').length).toBeGreaterThanOrEqual(1)
  })

  it('a dip the lane itself refused is named dip-refused, not left as the composite’s gate', async () => {
    const store = recordingStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await buildBoard(
      store,
      deps({
        candles: async sym => (sym === 'GLW' ? dipRefusedTape : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null),
        screens: async () => [],
        sparkCloses: async () => new Map([['GLW', dipRefusedTape.map(c => c.c)]]),
        mediaTitles: async () => [],
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    expect(trace.rows['GLW:long']).toMatchObject({ gate: 'dip-refused', side: 'long' })
    expect(trace.rows['GLW:long'].detail).toContain('dip lane declined to build')
    // the composite's own verdict on the same chart is what the dip refusal
    // replaced — the expected-move floor, which published nothing
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    expect(ledger.some(p => p.sym === 'GLW')).toBe(false)
  })

  it('a name the world-tape re-score pushed back under says so: the second pass owns the gate, and the trace says it was the second', async () => {
    const store = recordingStore()
    // Two mild slides, both shorts, both dying in the dead zone — and they die at
    // different PASSES. Under a risk-on tape a short is nudged ×0.85, so SB's core
    // (−27.3) clears the gate on pass 1 and is dragged back under to −23.2 by the
    // re-score, while SA (−24.7) never cleared it at all. Same code, materially
    // different evidence, and Task 1's seam is exactly that the row records the
    // SECOND pass's verdict — so the row has to admit which pass it was.
    const drift = (r: number, amp = 0.05) => mk(j => (200 - j * r) * (1 + amp * Math.sin(j / 3)))
    // SA's oscillation was narrowed 5% → 3% on 2026-09-22. `bandwidth` reads the
    // width of that oscillation against the name's own year, so at 5% BOTH tapes
    // composited past the gate on pass 1 and the fixture lost the contrast it is
    // built on — the whole point is one name that never cleared and one that
    // cleared and was dragged back. A quieter SA restores it, on the same shape.
    const tapes = new Map([
      ['SA', drift(0.05, 0.03)],
      ['SB', drift(0.15)],
    ])
    await store.write('config', { watchlist: [{ symbol: 'SA' }, { symbol: 'SB' }], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    await buildBoard(
      store,
      deps({
        screens: async () => [],
        mediaTitles: async () => [],
        candles: async sym => tapes.get(sym) ?? (sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null),
        worldReads: async () => [
          { sym: '^N225', name: 'Nikkei', changePct: 1.2 },
          { sym: '^HSI', name: 'Hang Seng', changePct: 1.5 },
          { sym: '^GDAXI', name: 'DAX', changePct: 1.1 },
          { sym: '^FTSE', name: 'FTSE 100', changePct: 1.0 },
          { sym: 'ES=F', name: 'S&P fut', changePct: 1.3 },
          { sym: 'NQ=F', name: 'Nasdaq fut', changePct: 1.4 },
          { sym: '^VIX', name: 'VIX', changePct: -8 },
        ],
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    expect(trace.rows['SA:short']).toMatchObject({ gate: 'dead-zone-core', side: 'short' })
    expect(trace.rows['SA:short'].detail).not.toContain('second-pass')
    expect(trace.rows['SB:short']).toMatchObject({ gate: 'dead-zone-core', side: 'short' })
    expect(trace.rows['SB:short'].detail).toMatch(/^second-pass · core -2[0-9.]+ inside ±25$/)
  })

  it('a short the dip lane outranked records the demotion — and the sized LONG that outranked it survives beside it', async () => {
    const store = recordingStore()
    // ONE tape, two lanes, opposite sides: a rolled-over name whose last session
    // is a volume-paid bounce off the low. The composite calls a live short; the
    // dip lane calls a long on the same chart and wins the reader-facing row, and
    // the short is demoted to a shadow AFTER it published.
    const dipAndShortTape = (() => {
      const bars = mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2), 259)
      const prev = bars[bars.length - 1]
      const c = prev.c * 1.045
      bars.push({ t: prev.t + 86_400, o: prev.c, h: c, l: prev.c * 0.995, c, v: 1_600_000 })
      return bars
    })()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' } } })
    await store.write('engine-calibration', {
      buckets: { 'short:amber:40-55': { n: 32, hits: 22 }, 'long:amber:25-40': { n: 16, hits: 11 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
    })
    await buildBoard(
      store,
      deps({
        screens: async () => [],
        mediaTitles: async () => [],
        candles: async sym => (sym === 'GLW' ? dipAndShortTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
        sparkCloses: async () => new Map([['GLW', dipAndShortTape.map(c => c.c)]]),
        dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }),
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    // TWO rows, because two different things happened to this chart. Under one key
    // per symbol the demotion's `revise` landed on the row the dip long had just
    // written, and the reader-facing LONG — the only sized call on the name —
    // vanished from the record of the run. Keyed by side, both survive.
    expect(trace.rows['GLW:short']).toMatchObject({ gate: 'called-shadow', side: 'short' })
    expect(trace.rows['GLW:short'].detail).toContain("the dip lane's read on the same chart outranked it")
    expect(trace.rows['GLW:long'].gate).toMatch(/^called-(full|half)$/)
    expect(trace.rows['GLW:long'].side).toBe('long')
    expect(trace.emptySides.short).toBe('dip-lane')
    // …and the trace agrees with the ledger, which carries both rows too
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    expect(ledger.find(p => p.sym === 'GLW' && p.side === 'long')!.riskPct).toBeGreaterThan(0)
    expect(ledger.find(p => p.sym === 'GLW' && p.side === 'short')!.shadow).toBe(true)
  })

  it('a short an ISA cannot place is route-blocked, and the one the board promotes becomes a called-observation', async () => {
    const store = recordingStore()
    const syms = ['AAA', 'BBB', 'CCC', 'DDD']
    const tapes = new Map(syms.map((s, i) => [s, shortyVariant(0.7 + i * 0.4)]))
    await store.write('config', { watchlist: syms.map(symbol => ({ symbol })), rules: [], ytChannels: [], levMap: {} }) // NO routes at all
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']
    await buildBoard(
      store,
      deps({
        screens: async () =>
          [...syms, ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' })),
        mediaTitles: async () => [],
        candles: async sym => tapes.get(sym) ?? (fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    const gates = syms.map(s => trace.rows[`${s}:short`].gate)
    expect(gates.filter(g => g === 'route-blocked').length).toBe(3)
    // its own code, not `called-watch`: a promoted observation and a graded watch
    // row are two different reasons to be on the board at zero size
    expect(gates.filter(g => g === 'called-observation').length).toBe(1) // the best of them, promoted to the empty side
    const promoted = syms.find(s => trace.rows[`${s}:short`].gate === 'called-observation')!
    expect(trace.rows[`${promoted}:short`].detail).toContain('promoted observation')
    for (const s of syms.filter(x => x !== promoted)) expect(trace.rows[`${s}:short`].detail).toContain('no ISA short route')
    expect(trace.emptySides.short).toBe('no-route')
  })

  it('everything past the 180-candidate budget is trimmed, and says so', async () => {
    const store = recordingStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    const many = Array.from({ length: 240 }, (_, i) => `Z${String(i).padStart(3, '0')}`)
    await buildBoard(
      store,
      deps({
        screens: async () => many.map(sym => ({ row: { sym, price: 10, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' })),
        mediaTitles: async () => [],
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    const trimmed = Object.entries(trace.rows).filter(([, r]) => r.gate === 'trimmed' && r.detail?.includes('180-candidate'))
    expect(trimmed.length).toBeGreaterThan(50) // 240 offered, 180 evaluated
    // and the trimmed names never reached the candle fetch, so none of them is
    // ALSO recorded as no-candles — one fate per name, and it is the first one
    // that actually ended the run
    for (const [sym] of trimmed) expect(trace.rows[sym].gate).toBe('trimmed')
  })

  it('a store that refuses the trace costs the day’s evidence and nothing else', async () => {
    const inner = await goldenStore()
    const attempted: string[] = []
    const refusing: AppStore = {
      read: inner.read,
      async write(key, value) {
        attempted.push(key)
        if (key.startsWith('funnel-trace')) throw new Error('blob refused the trace')
        await inner.write(key, value)
      },
    }
    // it RESOLVES — no throw escapes the fail-soft
    const { board } = await buildBoard(refusing, deps(), NOW)
    expect(board).toHaveLength(1)
    // the board and the ledger are the golden ones, untouched
    const written = (await refusing.read<{ board: Prediction[] }>('engine-board'))!.board
    const ledger = (await refusing.read<Prediction[]>(`predictions:${TODAY}`))!
    expect(sha({ board: written, ledger })).toBe(GOLDEN_SHA)
    // …the write was genuinely attempted, and refused…
    expect(attempted).toContain(funnelTraceKey(TODAY))
    expect(await refusing.read(funnelTraceKey(TODAY))).toBeNull()
    // …and the run carried on past it: the sweeps AFTER the trace still ran
    expect(await refusing.read('event-radar')).not.toBeNull()
    expect(await refusing.read('pattern-sightings')).not.toBeNull()
  })

  it('the index mirrors predictions-index — appended once, bounded at 250', async () => {
    const store = await goldenStore()
    const old = Array.from({ length: 250 }, (_, i) => `2020-01-${String((i % 28) + 1).padStart(2, '0')}#${i}`)
    await store.write(FUNNEL_TRACE_INDEX_KEY, old)
    await buildBoard(store, deps(), NOW)

    const index = (await store.read<string[]>(FUNNEL_TRACE_INDEX_KEY))!
    expect(index).toHaveLength(250)
    expect(index.at(-1)).toBe(TODAY)
    expect(index).not.toContain(old[0]) // the oldest fell off the front
    expect(index.filter(d => d === TODAY)).toHaveLength(1)

    // a rerun of the same day appends nothing (the predictions-index rule)
    await buildBoard(store, deps(), NOW)
    expect(await store.read<string[]>(FUNNEL_TRACE_INDEX_KEY)).toHaveLength(250)
  })

  it('every gate the run wrote is a code the taxonomy declares', async () => {
    const store = await goldenStore()
    await buildBoard(store, deps(), NOW)
    const trace = (await readTrace(store))!
    const known: GateCode[] = [
      'not-candidate',
      'trimmed',
      'no-candles',
      'no-data',
      'dead-zone-core',
      'dead-zone-context',
      'capacity-data',
      'expected-move',
      'entry-wait',
      'entry-chase',
      'entry-reversal',
      'evidence-fail',
      'dip-refused',
      'grade-watchonly',
      'route-blocked',
      'diversity',
      'slot-cut',
      'shadow-capped',
      'called-full',
      'called-half',
      'called-shadow',
      'called-watch',
      'called-below-base',
      'called-observation',
    ]
    for (const row of Object.values(trace.rows)) expect(known).toContain(row.gate)
  })

  it('a row the trade cut sent to the watch list and the WATCH cut then dropped keeps slot-cut — called-* is only ever what the reader gets', async () => {
    const store = recordingStore()
    // Eleven uncorrelated rolled-over names against three trade slots and six
    // watch slots: three trade, six land on the watch list, and the rest fall off
    // the board entirely. The first six must not keep reading `slot-cut` (the
    // reader has them) and the last must not read `called-*` (the reader doesn't).
    const syms = Array.from({ length: 11 }, (_, i) => `S${String(i).padStart(2, '0')}`)
    const tapes = new Map(syms.map((s, i) => [s, shortyVariant(0.6 + i * 0.37)]))
    await store.write('config', {
      watchlist: syms.map(symbol => ({ symbol })),
      rules: [],
      ytChannels: [],
      levMap: Object.fromEntries(syms.map(s => [s, { short2x: `I${s}` }])),
    })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    await buildBoard(
      store,
      deps({
        screens: async () => [],
        mediaTitles: async () => [],
        candles: async sym => tapes.get(sym) ?? (sym === 'SPY' || sym === 'QQQ' ? flat : null),
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    const board = (await store.read<{ board: Prediction[] }>('engine-board'))!.board
    const seen = new Set(board.filter(p => !p.nearMiss).map(p => `${p.sym.toUpperCase()}:${p.side}`))
    const rows = syms.map(s => [s, trace.rows[`${s}:short`]] as const)

    // the reader's rows and the trace's called-* rows are the SAME set
    for (const [s, row] of rows) {
      if (seen.has(`${s}:short`)) expect(row.gate).toMatch(/^called-/)
      else expect(row.gate).not.toMatch(/^called-/)
    }
    // the trade cut's casualties that the watch list SEATED say so, and still
    // carry the cut that sent them there
    const seated = rows.filter(([s, r]) => seen.has(`${s}:short`) && r.gate === 'called-watch')
    expect(seated.length).toBeGreaterThanOrEqual(1)
    for (const [, r] of seated) expect(r.detail).toContain('trade cut')
    // …and the ones that fell off the board entirely keep the cut's own verdict
    const dropped = rows.filter(([s]) => !seen.has(`${s}:short`))
    expect(dropped.length).toBeGreaterThanOrEqual(1)
    for (const [, r] of dropped) expect(['slot-cut', 'diversity']).toContain(r.gate)
    expect(dropped.some(([, r]) => r.gate === 'slot-cut')).toBe(true)
  })

  it('a shadow past the 5-per-side budget never reaches the ledger, so it reads shadow-capped rather than called-shadow', async () => {
    const store = recordingStore()
    // Nine unroutable shorts: every one publishes as a route-blocked shadow, one is
    // promoted to fill the empty side, and pickShadow then takes the best five of
    // the remaining eight. The three the budget dropped are in NOTHING the reader
    // or the ledger ever sees — and must stop claiming they published.
    const syms = Array.from({ length: 9 }, (_, i) => `R${String(i).padStart(2, '0')}`)
    const tapes = new Map(syms.map((s, i) => [s, shortyVariant(0.7 + i * 0.4)]))
    await store.write('config', { watchlist: syms.map(symbol => ({ symbol })), rules: [], ytChannels: [], levMap: {} }) // NO routes at all
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']
    await buildBoard(
      store,
      deps({
        screens: async () =>
          [...syms, ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' })),
        mediaTitles: async () => [],
        candles: async sym => tapes.get(sym) ?? (fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
      }),
      NOW,
    )
    const trace = (await readTrace(store))!
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    const gates = syms.map(s => trace.rows[`${s}:short`].gate)

    expect(ledger.filter(p => p.shadow && p.side === 'short')).toHaveLength(5)
    expect(gates.filter(g => g === 'shadow-capped')).toHaveLength(3)
    expect(gates.filter(g => g === 'route-blocked' || g === 'called-shadow')).toHaveLength(5)
    expect(gates.filter(g => g === 'called-observation')).toHaveLength(1)
    for (const s of syms.filter(x => trace.rows[`${x}:short`].gate === 'shadow-capped')) {
      expect(ledger.some(p => p.sym === s)).toBe(false) // …and they are genuinely absent
      expect(trace.rows[`${s}:short`].detail).toContain('shadow budget')
    }
    // the invariant Task 4 asserts: a called-* row is a row the reader gets
    const seen = new Set([...ledger.map(p => `${p.sym.toUpperCase()}:${p.side}`)])
    for (const [key, row] of Object.entries(trace.rows)) if (row.gate.startsWith('called-') || row.gate === 'route-blocked') expect(seen.has(key)).toBe(true)
  })
})
