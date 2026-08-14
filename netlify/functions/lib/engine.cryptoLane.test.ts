import { afterEach, describe, expect, it } from 'vitest'
import { buildBoard, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import type { Candle } from '../../../shared/types'
import type { FactorName, Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState } from '../../../shared/engine/calibration'
import { funnelTraceKey, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import type { RosterEntry } from '../../../shared/engine/roster'
import { RUNG_RISK_PCT } from '../../../shared/engine/riskLadder'
import { DEFAULT_WEIGHTS } from '../../../shared/engine/composite'
import { channelsFactor, socialFactor } from '../../../shared/engine/factors'
import { CRYPTO_CHART_ONLY_DIRECTIVE, CRYPTO_SIZE_CAP, CRYPTO_WEIGHTS } from '../../../shared/engine/cryptoLane'
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

const storeWith = async (watchlist: string[], levMap: Record<string, { long1x?: string; long2x?: string; short1x?: string; short2x?: string }> = {}) => {
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

const runDay = async (
  watchlist: string[],
  levMap: Record<string, { long1x?: string; long2x?: string; short1x?: string; short2x?: string }> = {},
  over: Partial<EngineDeps> = {},
  seed?: (store: AppStore) => Promise<void>,
) => {
  asked.clear()
  const store = await storeWith(watchlist, levMap)
  await seed?.(store)
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

  it('a MAPPED tracker does not lift the label while the cap holds — routed-but-capped is still paper only', async () => {
    // the trap this pins: `levMap` gains BTC-USD, but an instrument only mints
    // on a full-size row and the cohort cap holds crypto at 0.5 until its own
    // rung earns the full one — so the row must keep the paper-only label and
    // say WHY, not publish as placeable with no instrument and no route named
    const { board } = await runDay(['BTC-USD'], { 'BTC-USD': { long2x: '3BTL.L' } })
    const row = cryptoOf(board.board)[0]
    expect(row.paperOnly).toBe(true)
    expect(row.instrument).toBeNull()
    expect(row.note).toContain('tracker configured; it routes when the cohort\'s record earns the full rung')
    expect(row.note).not.toContain('no BTC-USD tracker configured')
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

// ------------------------------------------------- the chart-only policy --

/** A stored weights blob whose CURRENT vector has been nudged away from base —
 * exactly the shape the equity IC loop writes. `base` still fingerprints
 * DEFAULT_WEIGHTS so `rebaseWeights` finds nothing to do, and the nudge sits at
 * the [0.5×, 1.5×] band edge so `migrateWeights` does not clamp it away. */
const nudged = (name: FactorName, mult: number) => async (store: AppStore) => {
  await store.write('engine-weights', {
    base: { ...DEFAULT_WEIGHTS },
    current: { ...DEFAULT_WEIGHTS, [name]: DEFAULT_WEIGHTS[name] * mult },
    ic: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(n => [n, { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }])),
    gradedSinceNudge: 0,
    history: [],
    seedGeneration: 99,
  })
}

const LOUD_SOCIAL = {
  sym: 'BTC-USD',
  redditRank: 1,
  redditMentions: 900,
  surging: true,
  surgeMultiple: 3,
  stocktwits: true,
  channelNet: 2,
  sources: 3,
  onWatchlist: true,
}
const LOUD_STANCES = [
  { url: 'u1', channel: 'ChannelA', at: NOW - 3_600, tickers: [{ sym: 'BTC-USD', stance: 'bull' as const }] },
  { url: 'u2', channel: 'ChannelB', at: NOW - 7_200, tickers: [{ sym: 'BTC-USD', stance: 'bull' as const }] },
]

describe('a coin is priced off chart parameters and a little major news — nothing else', () => {
  it('hears the alias headline the equity base-ticker matcher misses', async () => {
    const titles = ['Bitcoin surges to a record high as ETF inflows accelerate']
    const { board } = await runDay(['BTC-USD'], {}, { mediaTitles: async () => titles })
    const row = cryptoOf(board.board)[0]
    expect(row.factors.news.detail).toContain('1 headline(s)')
    expect(row.factors.news.score).toBeGreaterThan(0)
    // the SAME tape read by the equity book: `\bBTC\b` matches nothing in it, so
    // every equity row on this board still reads a quiet tape. That contrast is
    // the whole claim — the alias is a crypto-lane matcher, not a global one.
    for (const r of board.board.filter(b => b.cohort !== 'crypto')) expect(r.factors.news.detail).toBe('quiet tape')
  })

  it('retires social and channels with the directive at the site — and a signal that WOULD have scored moves nothing', async () => {
    // the fixtures are real readings: both factors score on them today
    expect(socialFactor(LOUD_SOCIAL, 50).score).not.toBeNull()
    expect(channelsFactor(LOUD_STANCES.flatMap(e => e.tickers.map(t => ({ channel: e.channel, stance: t.stance }))), () => 0.5).score).not.toBeNull()

    const quiet = await runDay(['BTC-USD'])
    const loud = await runDay(['BTC-USD'], {}, { social: async () => [LOUD_SOCIAL] }, async store => {
      await store.write('video-extracts', LOUD_STANCES)
    })
    const row = cryptoOf(loud.board.board)[0]
    expect(row.factors.social.score).toBeNull()
    expect(row.factors.channels.score).toBeNull()
    expect(row.factors.social.detail).toContain(CRYPTO_CHART_ONLY_DIRECTIVE)
    expect(row.factors.channels.detail).toContain(CRYPTO_CHART_ONLY_DIRECTIVE)
    // …and the row itself is the row the quiet morning published, to the byte
    expect(JSON.stringify(row)).toBe(JSON.stringify(cryptoOf(quiet.board.board)[0]))
  })

  it('prices off the FROZEN vector — an IC-nudged weights.current moves the equity board and not the coin', async () => {
    const plain = await runDay(['BTC-USD'])
    const learned = await runDay(['BTC-USD'], {}, {}, nudged('technical', 0.5))
    const equity = (rows: Prediction[]) => JSON.stringify(rows.filter(r => r.cohort !== 'crypto'))
    // the nudge is REAL: halving the heaviest factor re-prices the equity board
    expect(equity(learned.board.board)).not.toBe(equity(plain.board.board))
    for (const r of learned.board.board.filter(b => b.cohort !== 'crypto')) expect(r.factors.technical.weight).toBe(DEFAULT_WEIGHTS.technical * 0.5)
    // …and the crypto row on the same morning never saw it
    expect(JSON.stringify(cryptoOf(learned.board.board))).toBe(JSON.stringify(cryptoOf(plain.board.board)))
    expect(cryptoOf(learned.board.board)[0].factors.technical.weight).toBe(CRYPTO_WEIGHTS.technical)
    expect(cryptoOf(learned.board.board)[0].factors.news.weight).toBe(CRYPTO_WEIGHTS.news)
  })

  it('bounds the little: a maxed polarity tape moves the composite by ≤ the halved weight over the core', async () => {
    const loud = Array.from({ length: 8 }, (_, i) => `Bitcoin surges to a record high, beats every estimate (${i})`)
    const { board } = await runDay(['BTC-USD'], {}, { mediaTitles: async () => loud })
    const row = cryptoOf(board.board)[0]
    expect(row.factors.news.score).toBe(50) // the factor's own ±50 clamp, saturated
    // composite.ts: ctxPts = ctxNum / coreDen. News is the whole context
    // numerator on a crypto row and technical+momentum the whole core
    // denominator, so this is the tightest of the two bounds (the context cap is
    // the other, and it is looser).
    const bound = (50 * CRYPTO_WEIGHTS.news) / (CRYPTO_WEIGHTS.technical + CRYPTO_WEIGHTS.momentum)
    expect(Math.abs(row.evidence.contextPts)).toBeGreaterThan(0)
    expect(Math.abs(row.evidence.contextPts)).toBeLessThanOrEqual(bound + 0.05) // +0.05: contextPts is rounded to 1dp
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
