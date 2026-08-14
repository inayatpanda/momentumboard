import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import type { CalibrationState, WeightsState } from '../../../shared/engine/calibration'
import { CRYPTO_CALIB_KEY, CRYPTO_GRADE_HORIZON, type CryptoCalibrationState } from '../../../shared/engine/cryptoCalibration'
import { CRYPTO_RISK_KEY } from '../../../shared/engine/cryptoLane'
import type { CohortRung, RiskState } from '../../../shared/engine/riskLadder'

// PHASE-A RELAXATION 1 — THE CRYPTO PARTITION GRADES ITSELF (Stage 1c Phase B).
//
// Phase A's promise was "watched, never graded against a market it doesn't trade
// in", and it is kept here in full for every LEGACY crypto row. What is relaxed,
// at exactly one site and under exactly one condition, is the row the crypto
// LANE published and stamped `cohort: 'crypto'`: it grades on the crypto basis
// (absolute, 14 crypto bars, completed bars only) and accrues into the crypto
// blob and the crypto rung — and into nothing else. Every equity learning
// surface reads exactly as it does without the coin beside it, which is the
// same assertion engine.crypto.test.ts makes and is deliberately made again
// here against the row that DID get the new path.

const DAY = 86_400
const T0 = Date.parse('2026-01-05') / 1000
const ENTRY_IDX = 30
const ENTRY = new Date((T0 + ENTRY_IDX * DAY) * 1000).toISOString().slice(0, 10)

const tape = (at: (i: number) => number, n = 60): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = at(i)
    return { t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }
  })

const flat = tape(() => 100)
/** Flat through the call, then +1/bar from the crypto ENTRY BAR on. The crypto
 * entry is the first bar OPENING after the call (index 31), so the return leg is
 * based at 100 and the 14th bar after it closes at 114. */
const winner = tape(i => (i <= ENTRY_IDX + 1 ? 100 : 100 + (i - ENTRY_IDX - 1)))

const NOW = T0 + 60 * DAY

const deps = (candlesFor: (sym: string) => Candle[] | null): EngineDeps =>
  ({
    candles: async (sym: string) => candlesFor(sym),
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

const tapes = (sym: string) => (sym === 'SPY' ? flat : sym === 'EQ' || sym === 'BTC-USD' ? winner : null)

const call = (sym: string, over: Partial<Prediction> = {}): Prediction =>
  ({
    id: `${ENTRY}:${sym}:long`,
    date: ENTRY,
    sym,
    side: 'long',
    composite: 33,
    regime: 'amber',
    probability: 0.55,
    provisional: false,
    grade: 'C',
    riskRung: 0,
    riskPct: 0.5,
    priceAtPrediction: 100,
    entry: 100,
    stop: 90,
    target: 120,
    instrument: null,
    setup: 'continuation',
    factors: { technical: { score: 30, detail: '', weight: 1 } },
    ...over,
  }) as unknown as Prediction

const EQ = () => call('EQ')
const LEGACY_COIN = () => call('BTC-USD')
const LANE_COIN = () => call('BTC-USD', { cohort: 'crypto', capUsdM: null })

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex')

const run = async (rows: Prediction[], nowSec = NOW, seed?: (s: AppStore) => Promise<void>) => {
  const store = memoryStore()
  await store.write(`predictions:${ENTRY}`, rows)
  await store.write('predictions-index', [ENTRY])
  if (seed) await seed(store)
  const { graded } = await gradeOutstanding(store, deps(tapes), nowSec, null)
  return {
    graded,
    rows: (await store.read<Prediction[]>(`predictions:${ENTRY}`))!,
    cryptoCal: await store.read<CryptoCalibrationState>(CRYPTO_CALIB_KEY),
    cryptoRisk: await store.read<CohortRung>(CRYPTO_RISK_KEY),
    equityCal: (await store.read<CalibrationState>('engine-calibration'))!,
    equityRisk: (await store.read<RiskState>('risk-state'))!,
    weights: (await store.read<WeightsState>('engine-weights'))!,
    card: (await store.read<{ totalGraded: number; byGrade: Record<string, { n: number }> }>('engine-scorecard'))!,
  }
}

afterEach(() => {
  delete process.env.CRYPTO
})

// -------------------------------------------------- the relaxation itself --

describe('RELAXED: a stamped crypto-lane row grades on the crypto clock, into the crypto blob', () => {
  it('grades it ABSOLUTE over 14 crypto bars — no benchmark subtracted, spyPct a structural 0', () => {
    expect(CRYPTO_GRADE_HORIZON).toBe(14)
  })

  it('writes the outcome on the crypto basis and books it into crypto-calibration', async () => {
    const arm = await run([LANE_COIN()])
    const o = arm.rows[0].outcome10!
    expect(o).toBeTruthy()
    // base = the first bar OPENING after the call (100), close 14 bars on = 114
    expect(o.rawPct).toBe(14)
    expect(o.excessPct).toBe(14)
    expect(o.spyPct).toBe(0) // nothing was subtracted
    expect(o.hit).toBe(true)
    // …and it landed in the crypto blob, branded, with one bucket
    expect(arm.cryptoCal!.basis).toBe('absolute')
    expect(Object.values(arm.cryptoCal!.buckets).reduce((s, b) => s + b.n, 0)).toBe(1)
    // the key is COHORTLESS — the only scheme this blob will ever hold
    for (const k of Object.keys(arm.cryptoCal!.buckets)) expect(k.split(':').length).toBe(3)
    expect(arm.cryptoCal!.brier.length).toBe(1)
  })

  it('measures a DIFFERENT number from the equity path on the identical tape — the two clocks are really two', async () => {
    const lane = await run([LANE_COIN()])
    const legacy = await run([LEGACY_COIN()])
    expect(lane.rows[0].outcome10!.excessPct).toBe(14) // 14 bars from D+1's open
    expect(legacy.rows[0].outcome10!.excessPct).toBe(9) // 10 bars from D's own open, minus a flat SPY
    expect(lane.rows[0].outcome10!.excessPct).not.toBe(legacy.rows[0].outcome10!.excessPct)
  })

  it('moves the crypto rung’s own counter and NOTHING in the equity ladder', async () => {
    const arm = await run([LANE_COIN()])
    expect(arm.cryptoRisk).toMatchObject({ rung: 0, gradedAtRung: 1 })
    expect(arm.equityRisk.gradedAtRung).toBe(0)
  })

  it('refuses to inherit the equity book’s earned rung — the cohort starts cold however rich the book is', async () => {
    const arm = await run([LANE_COIN()], NOW, async s => {
      await s.write('risk-state', { rung: 3, sinceDate: '2026-01-01', gradedAtRung: 400, history: [], cohorts: { large: { rung: 3, sinceDate: '2026-01-01', gradedAtRung: 400, history: [] }, small: { rung: 3, sinceDate: '2026-01-01', gradedAtRung: 400, history: [] } } })
    })
    expect(arm.cryptoRisk!.rung).toBe(0)
  })
})

// -------------------------------------- what the relaxation did NOT relax --

describe('UNRELAXED: everything Phase A contained is still contained', () => {
  it('teaches the equity engine exactly nothing — every learning blob reads as it does without the coin', async () => {
    const pair = await run([EQ(), LANE_COIN()])
    const alone = await run([EQ()])
    expect(sha(pair.equityCal)).toBe(sha(alone.equityCal))
    expect(sha(pair.weights)).toBe(sha(alone.weights))
    expect(sha(pair.equityRisk)).toBe(sha(alone.equityRisk))
    expect(sha(pair.card)).toBe(sha(alone.card))
    expect(pair.graded).toBe(2) // …and it still graded
  })

  it('appears in NO equity pane, and carries no post-mortem struck off a benchmark it has none of', async () => {
    const arm = await run([LANE_COIN()])
    expect(arm.card.totalGraded).toBe(0)
    expect(arm.rows[0].postMortem).toBeUndefined()
  })

  it('leaves a LEGACY crypto row on the Phase-A path — SPY-graded, and the crypto blobs untouched', async () => {
    const arm = await run([LEGACY_COIN()])
    expect(arm.rows[0].outcome10!.spyPct).toBe(0) // a flat SPY, not an absent one
    expect(arm.rows[0].outcome10!.excessPct).toBe(9)
    expect(arm.cryptoCal).toBeNull()
    expect(arm.cryptoRisk).toBeNull()
  })

  it('writes no crypto blob at all on an equity-only pass — the pass’s footprint is what it always was', async () => {
    const arm = await run([EQ()])
    expect(arm.cryptoCal).toBeNull()
    expect(arm.cryptoRisk).toBeNull()
  })
})

// ------------------------------------------------------ the completed cut --

describe('completed bars only — the grade never reads a bar that is still moving', () => {
  it('waits for the outcome bar to CLOSE, and grades on the run after it', async () => {
    // 46 bars: the outcome bar (entry 31 + 14 = 45) is the last one.
    const short = tape(i => (i <= ENTRY_IDX + 1 ? 100 : 100 + (i - ENTRY_IDX - 1)), 46)
    const shortTapes = (sym: string) => (sym === 'SPY' ? flat : sym === 'BTC-USD' ? short : null)
    const at = async (nowSec: number) => {
      const store = memoryStore()
      await store.write(`predictions:${ENTRY}`, [LANE_COIN()])
      await store.write('predictions-index', [ENTRY])
      await gradeOutstanding(store, deps(shortTapes), nowSec, null)
      return (await store.read<Prediction[]>(`predictions:${ENTRY}`))![0]
    }
    // mid-way through the outcome bar's own day: that bar does not exist yet
    expect((await at(T0 + 45 * DAY + 6 * 3600)).outcome10).toBeUndefined()
    // the next day: it has closed, and the grade lands
    expect((await at(T0 + 46 * DAY)).outcome10).toBeTruthy()
  })
})

// -------------------------------------------------------------- the lever --

describe('CRYPTO=off restores the Phase-A guard exactly', () => {
  it('grades a stamped row the legacy way and writes no crypto blob', async () => {
    process.env.CRYPTO = 'off'
    const off = await run([LANE_COIN()])
    delete process.env.CRYPTO
    const legacy = await run([LEGACY_COIN()])
    expect(off.rows[0].outcome10).toEqual(legacy.rows[0].outcome10)
    expect(off.cryptoCal).toBeNull()
    expect(off.cryptoRisk).toBeNull()
  })

  it('leaves every equity blob identical to the run with the lane on — the lever is a no-op for equities', async () => {
    process.env.CRYPTO = 'off'
    const off = await run([EQ(), LANE_COIN()])
    delete process.env.CRYPTO
    const on = await run([EQ(), LANE_COIN()])
    expect(sha(off.equityCal)).toBe(sha(on.equityCal))
    expect(sha(off.equityRisk)).toBe(sha(on.equityRisk))
    expect(sha(off.card)).toBe(sha(on.card))
  })
})
