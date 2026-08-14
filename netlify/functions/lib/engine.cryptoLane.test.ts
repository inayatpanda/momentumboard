import { afterEach, describe, expect, it } from 'vitest'
import { buildBoard, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState } from '../../../shared/engine/calibration'
import { funnelTraceKey, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import type { RosterEntry } from '../../../shared/engine/roster'
import { RUNG_RISK_PCT } from '../../../shared/engine/riskLadder'
import { CRYPTO_SIZE_CAP } from '../../../shared/engine/cryptoLane'
import { atr } from '../../../shared/indicators'

// ₿ THE CRYPTO LANE IN buildBoard (Stage 1c Phase B, Task B2) — Phase-A
// relaxation 3 of 3, and the one the other two exist for.
//
// The claim under test is not "crypto rows appear". It is that they appear as a
// PARTITIONED COHORT: their own tape, their own clock, their own regime, their
// own calibration and rung, one row per side, half the rung, paper only — and
// that the equity board on the same morning is exactly the board it would have
// been without them.

const DAY = 86_400
const T0 = Date.parse('2025-06-02') / 1000
const N = 400

const bars = (fn: (i: number) => number, n = N, vol: (i: number) => number = () => 1_000_000): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * DAY, o: c, h: c * 1.02, l: c * 0.98, c, v: vol(i) }
  })

const NOW = Math.floor(T0 + N * DAY)
const TODAY = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

/** A tape that has trended up all year and is pulling back into its rising
 * 28-bar mean on rising volume — the shape the engine is built to buy, on the
 * crypto clock. Ends on a loud bar so `volumeConfirmed` is true, which is the
 * crypto contract's ONLY confirming leg (no sector ETF, no breadth vote). */
const climber = (base: number) =>
  bars(
    i => base * 1.004 ** i * (1 - (i > N - 12 ? 0.05 * ((i - (N - 12)) / 12) : 0)),
    N,
    i => (i >= N - 3 ? 3_000_000 : 1_000_000),
  )

const btc = climber(20_000)
const eth = climber(1_500)
/** The equity side of the morning: a flat tape everywhere (so the EQUITY regime
 * is amber while BTC's own tape is green — the two must be visibly different
 * numbers, or "the regime is BTC's" is unfalsifiable). */
const flat = bars(() => 500)
const shorty = bars(i => (i < 300 ? 80 + i * 0.6 : 260 - (i - 300) * 2))

const asked = new Set<string>()

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => {
    asked.add(sym)
    return sym === 'BTC-USD' ? btc : sym === 'ETH-USD' ? eth : sym === 'SOL-USD' ? eth : sym === 'NVDA' ? shorty : sym === 'XLK' ? shorty : flat
  },
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
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
})

const storeWith = async (watchlist: string[], levMap: Record<string, { long2x?: string }> = {}) => {
  const store = memoryStore()
  await store.write('config', { watchlist: watchlist.map(symbol => ({ symbol })), rules: [], ytChannels: [], levMap })
  await store.write('engine-calibration', {
    buckets: { 'short:amber:55-70': { n: 32, hits: 22 } },
    brier: [],
    defVersion: CALIB_DEF_VERSION,
    seedGeneration: 4,
  } as CalibrationState)
  return store
}

const runDay = async (watchlist: string[], levMap: Record<string, { long2x?: string }> = {}, over: Partial<EngineDeps> = {}) => {
  asked.clear()
  const store = await storeWith(watchlist, levMap)
  await buildBoard(store, deps(over), NOW)
  return { store, ...(await read(store)) }
}

const read = async (store: AppStore) => ({
  board: (await store.read<{ board: Prediction[]; emptySides?: Record<string, string>; regime: string }>('engine-board'))!,
  ledger: (await store.read<Prediction[]>(`predictions:${TODAY}`))!,
  trace: (await store.read<FunnelTrace>(funnelTraceKey(TODAY)))!,
  roster: (await store.read<RosterEntry[]>('engine-roster'))!,
  fetched: new Set(asked),
})

const cryptoOf = (rows: Prediction[]) => rows.filter(r => r.cohort === 'crypto')

afterEach(() => {
  delete process.env.CRYPTO
})

// ---------------------------------------------------------- the lane runs --

describe('the lane publishes a partitioned cohort onto the same board', () => {
  it('stamps the row, and the stamp is the only thing that says which partition measured it', async () => {
    const { board, ledger } = await runDay(['BTC-USD'])
    const rows = cryptoOf(board.board)
    expect(rows.length).toBe(1)
    expect(rows[0].sym).toBe('BTC-USD')
    expect(rows[0].cohort).toBe('crypto')
    expect(cryptoOf(ledger).length).toBe(1) // …and it is in the ledger, so it will grade
    for (const r of board.board.filter(b => b.cohort !== 'crypto')) expect(r.cohort).toBeUndefined()
  })

  it('carries BTC’s OWN regime, not the equity tape’s — computed before composeCall and never relabelled', async () => {
    const { board } = await runDay(['BTC-USD'])
    // BTC has trended up all year, so its own tape is green; the equity tape on
    // the same morning is not, and the two numbers on one board are what makes
    // "the regime is BTC's" falsifiable.
    expect(cryptoOf(board.board)[0].regime).toBe('green')
    expect(board.regime).not.toBe('green')
    // …and every equity row still carries the equity read
    for (const r of board.board.filter(b => b.cohort !== 'crypto')) expect(r.regime).toBe(board.regime)
  })

  it('is capped at HALF the rung — a cap taken with Math.min, never multiplied into the tier', async () => {
    const { board } = await runDay(['BTC-USD'])
    const row = cryptoOf(board.board)[0]
    expect(CRYPTO_SIZE_CAP).toBe(0.5)
    expect(row.riskRung).toBe(0)
    expect(row.riskPct).toBe(RUNG_RISK_PCT[0] * CRYPTO_SIZE_CAP)
    expect(row.grade).toBe('C') // the cold start: ~50 outcomes before a letter means anything
  })

  it('CAN clear the evidence contract — an unreachable contract is the A-grade bug in a different costume', async () => {
    const { board } = await runDay(['BTC-USD'])
    const row = cryptoOf(board.board)[0]
    // What the contract MEANS for a coin (B1's binding 4): technical AND the
    // absolute momentum both scored and both agree with the side, BTC's tape is
    // known, and the only available confirming leg — today's volume — paid for
    // it. No sector ETF, no breadth vote, so it is strictly harder than the
    // equity version in one respect: an equity row can pass on breadth alone.
    expect(row.evidence.contract).toBe(true)
    expect(row.evidence.famAgree).toBeGreaterThanOrEqual(2)
    expect(row.factors.technical.score).not.toBeNull()
    expect(row.factors.momentum.score).not.toBeNull()
    expect(row.factors.momentum.detail).toContain('29-bar move') // absolute, no SPY leg
    expect(row.factors.sector.score).toBeNull()
    expect(row.factors.seasonality.detail).toContain('252 sessions')
    // …and a C WITH the contract is a half-tier trade, which is exactly why the
    // cap has something to bite on: 0.5 tier × capped at 0.5 → 0.5 of the rung.
    expect(row.watchOnly).toBeUndefined()
    expect(row.riskPct).toBeGreaterThan(0)
  })

  it('is PAPER ONLY until the owner maps a tracker, and never carries a leveraged instrument', async () => {
    const { board } = await runDay(['BTC-USD'])
    const row = cryptoOf(board.board)[0]
    expect(row.paperOnly).toBe(true)
    expect(row.instrument).toBeNull()
  })

  it('says so in the reader’s own words — the cohort, the cold start, the route', async () => {
    const { board } = await runDay(['BTC-USD'])
    const row = cryptoOf(board.board)[0]
    expect(row.note).toContain('crypto cohort')
    expect(row.note).toContain('designed floor, not a verdict')
    expect(row.note).toContain('paper only')
    expect(row.evidence.detail).toContain('crypto cohort')
  })

  it('never claims to have beaten a benchmark it has none of — the thesis, the book and the ledger all know', async () => {
    const { board } = await runDay(['BTC-USD'])
    const row = cryptoOf(board.board)[0]
    for (const s of [row.thesis ?? '', row.falsifier ?? '', row.note, row.evidence.detail]) {
      expect(s).not.toMatch(/S&P|SPY|outperformance|underperformance/)
    }
  })

  it('takes the 1.5×ATR stop arm — CHOSEN, because a 24/7 pair is the opposite of a gapping small cap', async () => {
    const { board } = await runDay(['BTC-USD'])
    const row = cryptoOf(board.board)[0]
    const a = atr(btc, 20)[btc.length - 1]!
    expect(row.smallCap).toBe(false)
    expect(Math.abs(row.entry - row.stop)).toBeCloseTo(1.5 * a, 0)
  })

  it('records its verdict in the funnel trace, cohort-labelled, on a SIDED key', async () => {
    const { trace } = await runDay(['BTC-USD'])
    const row = trace.rows['BTC-USD:long']
    expect(row).toBeTruthy()
    expect(row.gate.startsWith('called-')).toBe(true)
    expect(row.detail).toContain('crypto cohort')
  })
})

// ------------------------------------------------------------ the slot rule --

describe('one row per side, and the loser is cut before it can reach the ledger', () => {
  it('publishes the strongest pair and slot-cuts the rest', async () => {
    const { board, ledger, trace } = await runDay(['BTC-USD', 'ETH-USD'])
    const rows = cryptoOf(board.board)
    expect(rows.length).toBe(1)
    expect(cryptoOf(ledger).length).toBe(1)
    const cut = Object.entries(trace.rows).find(([k, r]) => k.startsWith('ETH-USD') && r.gate === 'slot-cut')
    expect(cut?.[1].detail).toContain('one row per side')
  })
})

// ------------------------------------------------ the equity day is intact --

describe('the equity board on the same morning is the board it would have been', () => {
  it('never consumes an equity slot, a roster place, or a near-miss seat', async () => {
    const withCoin = await runDay(['BTC-USD', 'ETH-USD'])
    const without = await runDay([])
    const equity = (rows: Prediction[]) => JSON.stringify(rows.filter(r => r.cohort !== 'crypto'))
    expect(equity(withCoin.board.board)).toBe(equity(without.board.board))
    expect(equity(withCoin.ledger)).toBe(equity(without.ledger))
    expect(withCoin.roster).toEqual(without.roster)
    expect(withCoin.roster.some(e => e.sym.includes('-USD'))).toBe(false)
    expect(withCoin.trace.nearMisses.some(n => n.sym.includes('-USD'))).toBe(false)
  })

  it('does not move the EQUITY regime — a coin never enters the breadth read', async () => {
    expect((await runDay(['BTC-USD', 'ETH-USD'])).board.regime).toBe((await runDay([])).board.regime)
  })
})

// ------------------------------------------------------------- empty sides --

describe('a side a crypto row seated on is not "nothing tradeable"', () => {
  it('drops the reader-facing empty-side copy for that side, and keeps the funnel’s own record', async () => {
    const { board, trace } = await runDay(['BTC-USD'])
    const side = cryptoOf(board.board)[0].side
    expect(board.emptySides?.[side]).toBeUndefined()
    // …and the funnel's own answer is untouched: the ORDINARY funnel really did
    // empty that side, and the walk reads this one.
    expect(trace.emptySides).toBeTruthy()
  })
})

// -------------------------------------------------------------- the lever --

describe('CRYPTO=off kills the lane entirely', () => {
  it('publishes no crypto row, spends no crypto fetch, and restores the containment record', async () => {
    process.env.CRYPTO = 'off'
    const { board, ledger, trace, fetched } = await runDay(['BTC-USD', 'ETH-USD'])
    expect(cryptoOf(board.board)).toEqual([])
    expect(cryptoOf(ledger)).toEqual([])
    expect([...fetched].filter(s => s.endsWith('-USD'))).toEqual([])
    expect(trace.rows['BTC-USD']).toMatchObject({ gate: 'crypto-contained' })
  })

  it('leaves the equity board byte-identical to the run with the lane on', async () => {
    process.env.CRYPTO = 'off'
    const off = await runDay(['BTC-USD', 'ETH-USD'])
    delete process.env.CRYPTO
    const on = await runDay(['BTC-USD', 'ETH-USD'])
    const equity = (rows: Prediction[]) => JSON.stringify(rows.filter(r => r.cohort !== 'crypto'))
    expect(equity(off.board.board)).toBe(equity(on.board.board))
    expect(equity(off.ledger)).toBe(equity(on.ledger))
  })
})
