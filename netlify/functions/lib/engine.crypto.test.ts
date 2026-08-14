import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildBoard, gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState, type WeightsState } from '../../../shared/engine/calibration'
import { funnelTraceKey, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import { MISS_LEDGER_KEY, type MissLedger } from '../../../shared/engine/missLedger'
import { WILDCARD_CATALYST_KIND } from '../../../shared/engine/catalyst'
import type { RiskState } from '../../../shared/engine/riskLadder'
import type { RosterEntry } from '../../../shared/engine/roster'
import { STARTER_WATCHLIST } from '../../../src/lib/starter'

// CRYPTO IS CONTAINED — watched, never graded against a market it doesn't trade in.
//
// Stage 1c Phase A. The engine REFUSES a crypto pair as a candidate, a roster
// member, an evaluated row, an outcome in the risk ladder / factor-IC / scorecard,
// a miss-ledger charge, a wildcard experiment or a replay universe member — while
// the reader goes on WATCHING the price. Every one of the recon's twelve leak
// sites is pinned; the parity test below is the whole claim in one assertion.

// ---- fixtures (the golden day of engine.funnelTrace.test.ts, verbatim) ----

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })

/** A rolled-over name: ran 80→280, now bleeding −2/day. Composites a short. */
const shorty = mk(i => (i < 200 ? 80 + i * 1.0 : 280 - (i - 200) * 2.0))
const flat = mk(() => 500)
/** A crypto tape with EVERYTHING a candidate needs — 260 bars, real capacity, a
 * clean momentum signature. If containment ever lapses this tape is good enough
 * to produce a row, which is what makes its absence evidence. */
const coin = mk(i => 20_000 + i * 200)
const NOW = Math.floor(shorty[shorty.length - 1].t + 86_400)
const TODAY = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

const CRYPTO = ['BTC-USD', 'ETH-USD', 'SOL-USD']

/** Every symbol the run asked for a tape on — the proof that a contained name
 * costs no fetch budget either. */
const asked = new Set<string>()

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => {
    asked.add(sym)
    return sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : CRYPTO.includes(sym) ? coin : null
  },
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
  seedGeneration: 4,
})

const boardStore = async (watchlist: { symbol: string }[]) => {
  const store = memoryStore()
  await store.write('config', { watchlist, rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' } } })
  await store.write('engine-calibration', calWith('short:amber:55-70'))
  await store.write('video-extracts', [
    { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
  ])
  return store
}

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const readTrace = (store: AppStore) => store.read<FunnelTrace>(funnelTraceKey(TODAY))
const isCryptoKey = (k: string) => CRYPTO.some(c => k.startsWith(c))

const runDay = async (watchlist: { symbol: string }[], over: Partial<EngineDeps> = {}) => {
  asked.clear()
  const store = await boardStore(watchlist)
  await buildBoard(store, deps(over), NOW)
  return {
    board: (await store.read<{ board: Prediction[] }>('engine-board'))!.board,
    ledger: (await store.read<Prediction[]>(`predictions:${TODAY}`))!,
    trace: (await readTrace(store))!,
    roster: (await store.read<RosterEntry[]>('engine-roster'))!,
    fetched: new Set(asked),
  }
}

// ---------------------------------------------------------------- the claim --

describe('crypto containment — the parity proof', () => {
  it('a crypto watchlist changes NOTHING about the day: same board, same ledger, same trace bar the contained rows', async () => {
    const without = await runDay([{ symbol: 'INV' }])
    const with_ = await runDay([{ symbol: 'INV' }, { symbol: 'BTC-USD' }, { symbol: 'ETH-USD' }])

    // the two published collections are byte-identical — not "similar", identical
    expect(sha(with_.board)).toBe(sha(without.board))
    expect(sha(with_.ledger)).toBe(sha(without.ledger))
    expect(with_.board.some(b => isCryptoKey(b.sym))).toBe(false)
    expect(with_.roster).toEqual(without.roster)

    // …and the trace differs by exactly the contained rows and nothing else
    const strip = (t: FunnelTrace) => ({ ...t, rows: Object.fromEntries(Object.entries(t.rows).filter(([k]) => !isCryptoKey(k))) })
    expect(sha(strip(with_.trace))).toBe(sha(strip(without.trace)))
    expect(Object.keys(with_.trace.rows).filter(isCryptoKey).sort()).toEqual(['BTC-USD', 'ETH-USD'])
    // a NAMED code, not `not-candidate`: phase B's relaxation has to diff cleanly
    expect(with_.trace.rows['BTC-USD']).toEqual({ gate: 'crypto-contained', source: 'watchlist', detail: expect.stringContaining('crypto') })
    // exactly once per name — a row, never also a count (funnelTrace's invariant)
    expect(with_.trace.counts).toEqual(without.trace.counts)
  })

  it('never spends a candle fetch on a contained name — containment is upstream of the budget', async () => {
    const { fetched } = await runDay([{ symbol: 'BTC-USD' }])
    expect([...fetched].filter(isCryptoKey)).toEqual([])
  })

  it('KEEPS the starter watchlist as it is: the reader may watch a coin the engine refuses to grade', () => {
    expect(STARTER_WATCHLIST.map(s => s.symbol)).toEqual(expect.arrayContaining(['BTC-USD', 'ETH-USD']))
  })
})

// ------------------------------------------------------- site 1: admission --

describe('site 1 — candidate admission refuses crypto at EVERY door', () => {
  const doors: [string, Partial<EngineDeps>, string][] = [
    ['screener', { screens: async () => [{ row: { sym: 'BTC-USD', price: 60_000, capUsdM: null, changePct: 4, name: null }, source: 'screener:gainers' }] }, 'screener:gainers'],
    ['social', { social: async () => [{ sym: 'ETH-USD', redditRank: 1, surgeMultiple: 4, sources: ['reddit'] }] as never }, 'social'],
    ['news catalyst', { newsCatalysts: async () => [{ sym: 'SOL-USD', side: 'long', reason: 'ETF approved', strength: 70 }] as never }, 'catalyst:news'],
    ['holdings', { holdings: async () => [{ symbol: 'BTC-USD', quantity: 1, pplPct: 3 }] as never }, 'holding'],
  ]
  for (const [label, over, source] of doors) {
    it(`refuses a coin arriving through the ${label} door`, async () => {
      const { board, ledger, trace, fetched } = await runDay([], over)
      expect(board.some(b => isCryptoKey(b.sym))).toBe(false)
      expect(ledger.some(p => isCryptoKey(p.sym))).toBe(false)
      const row = Object.entries(trace.rows).find(([k]) => isCryptoKey(k))!
      expect(row[1]).toMatchObject({ gate: 'crypto-contained', source })
      expect([...fetched].filter(isCryptoKey)).toEqual([])
    })
  }
})

// ---------------------------------------------------------- site 2: roster --

describe('site 2 — the roster refuses crypto, and purges what slipped in before the guard', () => {
  it('drops a stored crypto member and never re-admits it through the watchlist ride-through', async () => {
    asked.clear()
    const store = await boardStore([{ symbol: 'BTC-USD' }])
    await store.write('engine-roster', [
      { sym: 'BTC-USD', joined: '2026-01-01', source: 'watchlist', capUsdM: null, lastCapacity: 40, lastQualified: '2026-01-01' },
      { sym: 'NVDA', joined: '2026-01-01', source: 'screener:gainers', capUsdM: 50_000, lastCapacity: 40, lastQualified: '2026-01-01' },
    ])
    await buildBoard(store, deps(), NOW)
    const roster = (await store.read<RosterEntry[]>('engine-roster'))!
    expect(roster.map(e => e.sym)).not.toContain('BTC-USD')
    expect(roster.map(e => e.sym)).toContain('NVDA') // and nothing else was evicted
  })
})

// ------------------------------------------------------- site 4: eval loop --

describe('site 4 — the eval loop never scores a coin, even one already on the roster', () => {
  it('a crypto roster entry produces no composite read, no near miss and no row', async () => {
    asked.clear()
    const store = await boardStore([])
    await store.write('engine-roster', [
      { sym: 'ETH-USD', joined: '2026-01-01', source: 'roster', capUsdM: null, lastCapacity: 40, lastQualified: '2026-01-01' },
    ])
    await buildBoard(store, deps(), NOW)
    const trace = (await readTrace(store))!
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    expect(ledger.some(p => isCryptoKey(p.sym))).toBe(false)
    expect(trace.nearMisses.some(n => isCryptoKey(n.sym.toUpperCase()))).toBe(false)
    expect(Object.entries(trace.rows).filter(([k]) => isCryptoKey(k)).map(([, r]) => r.gate)).toEqual(['crypto-contained'])
  })
})

// ---- sites 5, 8, 9, 10: what a LEGACY crypto row may still move once graded ----

const GRADE_T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const ENTRY_IDX = 30
const gTape = (at: (i: number) => number): Candle[] =>
  Array.from({ length: 60 }, (_, i) => {
    const c = at(i)
    return { t: GRADE_T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }
  })
const ENTRY = new Date((GRADE_T0 + ENTRY_IDX * DAY) * 1000).toISOString().slice(0, 10)
const GRADE_NOW = Math.floor(GRADE_T0 + 60 * DAY)
const gFlat = gTape(() => 100)
/** +12% after the entry bar: a clean hit on both sides of the ledger. */
const gWinner = gTape(i => (i <= ENTRY_IDX ? 100 : 112))

const gradeDeps = (): EngineDeps =>
  ({
    candles: async (sym: string) => (sym === 'SPY' ? gFlat : sym === 'EQ' || CRYPTO.includes(sym) ? gWinner : null),
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
  }) as unknown as EngineDeps

const gCall = (sym: string, over: Partial<Prediction> = {}): Prediction =>
  ({
    id: `${ENTRY}:${sym}:long`,
    date: ENTRY,
    sym,
    side: 'long',
    composite: 33,
    regime: 'amber',
    probability: 0.55,
    provisional: false,
    grade: 'B',
    riskRung: 0,
    riskPct: 1,
    priceAtPrediction: 100,
    entry: 100,
    stop: 90,
    target: 120,
    instrument: null,
    setup: 'continuation',
    factors: { technical: { score: 30, detail: '', weight: 1 } },
    ...over,
  }) as unknown as Prediction

const icTotal = (w: WeightsState) => Object.values(w.ic).reduce((s, f) => s + f.nAgree + f.nDisagree, 0)

/** Grade one population and read back EVERY learning surface it could have moved. */
const gradeArm = async (rows: Prediction[]) => {
  const store = memoryStore()
  await store.write(`predictions:${ENTRY}`, rows)
  await store.write('predictions-index', [ENTRY])
  const { graded } = await gradeOutstanding(store, gradeDeps(), GRADE_NOW, null)
  return {
    graded,
    ic: icTotal((await store.read<WeightsState>('engine-weights'))!),
    risk: (await store.read<RiskState>('risk-state'))!,
    card: (await store.read<{
      byGrade: Record<string, { n: number }>
      byRegime: Record<string, { n: number }>
      bySetup: Record<string, { n: number }>
      byPostMortem: Record<string, number>
      totalGraded: number
      lifetime: { live: { graded: number }; shadow: { graded: number } }
    }>('engine-scorecard'))!,
    brier: (await store.read<CalibrationState>('engine-calibration'))!.brier,
    ledger: await store.read<MissLedger>(MISS_LEDGER_KEY),
    rows: (await store.read<Prediction[]>(`predictions:${ENTRY}`))!,
  }
}

const EQ_ROW = () => gCall('EQ')
const COIN_ROW = () => gCall('BTC-USD', { id: `${ENTRY}:BTC-USD:long` })

describe('sites 5, 8, 9, 10 — a legacy crypto row grades, and teaches the equity engine nothing', () => {
  it('grades it (containment never strands an outstanding row ungraded — the ledger still closes)', async () => {
    const arm = await gradeArm([EQ_ROW(), COIN_ROW()])
    expect(arm.graded).toBe(2)
    for (const r of arm.rows) expect(r.outcome10).toBeTruthy()
  })

  it('…and every learning surface reads EXACTLY as it does without the coin beside it', async () => {
    const pair = await gradeArm([EQ_ROW(), COIN_ROW()])
    const equityOnly = await gradeArm([EQ_ROW()])
    expect(pair.ic).toBe(equityOnly.ic) // site 9 — factor IC
    expect(pair.risk).toEqual(equityOnly.risk) // site 10 — the rung streams
    expect(pair.card).toEqual(equityOnly.card) // site 8 — every scorecard pane + lifetime
    expect(pair.brier).toEqual(equityOnly.brier) // …and the trail that gates promotion
  })

  it('a coin ALONE moves nothing at all: no IC, no rung evidence, no pane, no Brier point', async () => {
    const cryptoOnly = await gradeArm([COIN_ROW()])
    const nothing = await gradeArm([])
    expect(cryptoOnly.graded).toBe(1) // it graded…
    expect(cryptoOnly.rows[0].outcome10).toBeTruthy()
    expect(cryptoOnly.ic).toBe(nothing.ic) // …and taught nothing
    expect(cryptoOnly.risk.gradedAtRung).toBe(0)
    expect(cryptoOnly.card.totalGraded).toBe(0)
    expect([cryptoOnly.card.lifetime.live.graded, cryptoOnly.card.lifetime.shadow.graded]).toEqual([0, 0])
    expect(cryptoOnly.brier).toEqual([])
  })

  it('site 5 — a crypto wildcard’s outcome is never charged to an equity gate, and leaves no unsettled debt', async () => {
    const arm = await gradeArm([
      gCall('BTC-USD', {
        id: `${ENTRY}:BTC-USD:long`,
        catalyst: { kind: WILDCARD_CATALYST_KIND, reason: 'testing dead-zone-core' },
        wildcard: { gate: 'dead-zone-core', priority: 1, hypothesis: 'h', gateEvidenceN: 0 },
      } as Partial<Prediction>),
    ])
    expect(arm.ledger?.gates['dead-zone-core']?.causal ?? null).toBeNull()
    expect(arm.rows[0].outcome10).toBeTruthy()
    // `booked: false` is a DEBT the collection pass settles — a contained row must
    // never be handed one, or it is outstanding forever
    expect(arm.rows[0].wildcard?.booked).not.toBe(false)
  })
})
