import { describe, expect, it } from 'vitest'
import { buildBoard, gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState, type WeightsState } from '../../../shared/engine/calibration'
import { EARNINGS_FADE_CATALYST_KIND } from '../../../shared/engine/catalyst'
import { DEFAULT_WEIGHTS } from '../../../shared/engine/composite'
import { directionRungOf, migrateRisk, type CohortRung, type RiskState } from '../../../shared/engine/riskLadder'

// ONE IDEA, ONE VOTE — and one ladder per side.
//
// A daily refresh of the same symbol, side and setup is the same economic
// campaign, not new evidence (docs/ENGINE_V2.md). Every publication keeps its
// own dated receipt, but only the campaign OWNER moves calibration, factor IC,
// the Brier trail and the risk ladder. And the ladder itself is now split: a
// profitable short book cannot finance long risk, so a call sizes at the LOWER
// of its cap-cohort rung and its own side's rung.

const DAY = 86_400
const T0 = Date.parse('2026-01-05') / 1000
const ENTRY_IDX = 30
const ENTRY = new Date((T0 + ENTRY_IDX * DAY) * 1000).toISOString().slice(0, 10)
const REFRESH_IDX = ENTRY_IDX + 1
const REFRESH = new Date((T0 + REFRESH_IDX * DAY) * 1000).toISOString().slice(0, 10)
const NOW = T0 + 60 * DAY

const tape = (at: (i: number) => number, n = 60): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = at(i)
    return { t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }
  })

const flat = tape(() => 100)
/** Flat through the call, then +1/bar — a clean winner on both dates. */
const winner = tape(i => (i <= ENTRY_IDX ? 100 : 100 + (i - ENTRY_IDX)))

const gradeDeps: EngineDeps = {
  candles: async (sym: string) => (sym === 'SPY' ? flat : sym === 'EQ' ? winner : null),
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
} as unknown as EngineDeps

const call = (date: string, over: Partial<Prediction> = {}): Prediction =>
  ({
    id: `${date}:EQ:long`,
    date,
    sym: 'EQ',
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
    capUsdM: 50_000,
    factors: { technical: { score: 30, detail: '', weight: 1 } },
    ...over,
  }) as unknown as Prediction

const totalCalibrated = (cal: CalibrationState | null) =>
  Object.values(cal?.buckets ?? {}).reduce((sum, b) => sum + (b.n ?? 0), 0)

/** Grade both days in one pass and report what each learning surface booked. */
const gradeBoth = async (first: Prediction, second: Prediction) => {
  const store = memoryStore()
  // an EMPTY, already-seeded calibration blob: every bucket count these tests
  // read is therefore evidence this pass booked, not the cold-start prior.
  await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 } satisfies CalibrationState)
  await store.write('engine-weights', {
    base: { ...DEFAULT_WEIGHTS }, current: { ...DEFAULT_WEIGHTS }, ic: {}, gradedSinceNudge: 0, history: [], seedGeneration: 5,
  } as unknown as WeightsState)
  await store.write(`predictions:${ENTRY}`, [first])
  await store.write(`predictions:${REFRESH}`, [second])
  await store.write('predictions-index', [ENTRY, REFRESH])
  const { graded } = await gradeOutstanding(store, gradeDeps, NOW, null)
  return {
    graded,
    day1: (await store.read<Prediction[]>(`predictions:${ENTRY}`))!,
    day2: (await store.read<Prediction[]>(`predictions:${REFRESH}`))!,
    calibration: await store.read<CalibrationState>('engine-calibration'),
    weights: await store.read<{ ic?: Record<string, { nAgree: number; nDisagree: number }>; gradedSinceNudge?: number }>('engine-weights'),
    risk: (await store.read<RiskState>('risk-state'))!,
  }
}

describe('campaign-deduplicated grading', () => {
  it('a re-published campaign row keeps its receipt but never books calibration or IC twice', async () => {
    const first = call(ENTRY)
    // the next morning's refresh of the same idea: its own dated id, pointing
    // back at the campaign the first row opened
    const second = call(REFRESH, { campaignId: `${ENTRY}:EQ:long` })
    const arm = await gradeBoth(first, second)

    // BOTH receipts are written — the reader still sees what was published when
    expect(arm.day1[0].outcome10).toBeTruthy()
    expect(arm.day2[0].outcome10).toBeTruthy()
    expect(arm.graded).toBe(2)

    // …and exactly ONE of them taught the engine anything
    expect(totalCalibrated(arm.calibration)).toBe(1)
    // the factor-IC trail counts the same idea once too: one technical reading,
    // not two, and one row on the nudge counter
    const icSamples = Object.values(arm.weights?.ic ?? {}).reduce((sum, f) => sum + f.nAgree + f.nDisagree, 0)
    expect(icSamples).toBe(1)
    expect(arm.weights?.gradedSinceNudge).toBe(1)
  })

  it('two genuinely independent ideas on consecutive days both count', async () => {
    const first = call(ENTRY)
    // a second row that owns its OWN campaign (campaignId === id) is independent
    const second = call(REFRESH, { campaignId: `${REFRESH}:EQ:long` })
    const arm = await gradeBoth(first, second)
    expect(totalCalibrated(arm.calibration)).toBe(2)
  })

  it('the campaign clock is the CALIBRATED one: a day-2 refresh matures at 21 sessions and still votes once', async () => {
    // The seam this pins. Since CALIB_DEF_VERSION v4 the engine learns at 21
    // sessions, not 10 — so a refresh published the morning after its owner is
    // still inside the owner's evidence window when BOTH mature, which is
    // exactly the window in which double-counting used to happen. Both rows
    // fill all three lenses; only the owner moves anything that learns.
    const first = call(ENTRY)
    const second = call(REFRESH, { campaignId: `${ENTRY}:EQ:long` })
    const arm = await gradeBoth(first, second)

    // BOTH rows reached the CALIBRATED lens — the refresh is graded, not skipped
    expect(arm.day1[0].outcome21).toBeTruthy()
    expect(arm.day2[0].outcome21).toBeTruthy()
    // …and its own receipt is complete at every lens the reader can read
    expect(arm.day2[0].outcome5).toBeTruthy()
    expect(arm.day2[0].outcome10).toBeTruthy()
    expect(arm.graded).toBe(2)

    // …and the learning surfaces booked the idea exactly once
    expect(totalCalibrated(arm.calibration)).toBe(1)
    // the RISK LADDER's graded-at-rung counter is the promotion denominator:
    // one campaign, one count, on the combined ladder and on the long side
    expect(arm.risk.gradedAtRung).toBe(1)
    expect(arm.risk.directions!.long.gradedAtRung).toBe(1)
    expect(arm.risk.directions!.short.gradedAtRung).toBe(0)
  })

  it('a legacy row published before campaign ids still counts as independent evidence', async () => {
    const first = call(ENTRY) // no campaignId at all — every pre-migration row
    const second = call(REFRESH)
    expect(first.campaignId).toBeUndefined()
    const arm = await gradeBoth(first, second)
    expect(totalCalibrated(arm.calibration)).toBe(2)
    expect(arm.graded).toBe(2)
  })
})

describe('separate long and short risk rungs', () => {
  const rung = (over: Partial<CohortRung> = {}): CohortRung =>
    ({ rung: 0, sinceDate: ENTRY, gradedAtRung: 0, history: [], ...over }) as CohortRung

  it('migrateRisk seeds both directions from the book’s current rung, and they read as cold until they earn', () => {
    const legacy = { rung: 2, sinceDate: ENTRY, gradedAtRung: 40, history: [] } as RiskState
    const migrated = migrateRisk(legacy)
    expect(migrated.directions).toBeTruthy()
    expect(migrated.directions!.long.rung).toBe(2)
    expect(migrated.directions!.short.rung).toBe(2)
    // no own history and no own graded-at-rung evidence → the side ladder has
    // nothing to say yet, so sizing must fall back to the cap cohort
    expect(directionRungOf(migrated, 'long')).toBeNull()
    expect(directionRungOf(migrated, 'short')).toBeNull()
  })

  it('a side that has earned its own rung reports it', () => {
    const state = {
      ...rung({ rung: 3 }),
      cohorts: { large: rung({ rung: 3 }), small: rung({ rung: 3 }) },
      directions: {
        long: rung({ rung: 1, history: [{ date: ENTRY, from: 2, to: 1, evidence: 'cold streak' }] }),
        short: rung({ rung: 3 }),
      },
    } as RiskState
    expect(directionRungOf(state, 'long')).toBe(1)
    expect(directionRungOf(state, 'short')).toBeNull()
  })

  it('a published call sizes at the LOWER of its cap-cohort rung and its side rung', async () => {
    const hotBook = {
      ...rung({ rung: 3 }),
      cohorts: { large: rung({ rung: 3 }), small: rung({ rung: 3 }) },
      // migrated but unearned on both sides: no history, no own evidence
      directions: { long: rung({ rung: 3 }), short: rung({ rung: 3 }) },
    } as RiskState
    const coldShort = {
      ...hotBook,
      directions: {
        // the short book has been demoted on its OWN record; the long book has not,
        // and a profitable long record must not finance the short side back up
        long: rung({ rung: 3, history: [{ date: ENTRY, from: 2, to: 3, evidence: 'long earned it' }] }),
        short: rung({ rung: 1, history: [{ date: ENTRY, from: 3, to: 1, evidence: 'short cold streak' }] }),
      },
    } as RiskState

    const { row: hot } = await publishShort(hotBook)
    const { row: cold } = await publishShort(coldShort)
    // the SAME row, published twice: with no directional evidence it takes the
    // large cohort's R3; with a demoted short ladder it takes the lower R1.
    expect(hot.riskRung).toBe(3)
    expect(cold.riskRung).toBe(1)
  })
})

// ---- the board fixture for the sizing assertion -----------------------------

const BOARD_T0 = Date.parse('2025-06-02') / 1000
const bars = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: BOARD_T0 + i * DAY, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })
/** engine.discovery.test.ts's `shorty`: a long climb that rolls over hard, which
 * composeCall argues the SHORT side on. */
const shorty = bars(i => (i < 200 ? 80 + i * 1.0 : 280 - (i - 200) * 2.0))
const boardFlat = bars(() => 500)
const BOARD_NOW = Math.floor(shorty[shorty.length - 1].t + DAY)

const boardDeps: EngineDeps = {
  ...gradeDeps,
  candles: async (sym: string) => (sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? boardFlat : sym === 'NVDA' || sym === 'XLK' ? shorty : null),
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
} as unknown as EngineDeps

/** Publish one board against a seeded risk blob and hand back NVDA's row.
 * `seed` runs before the build, for the tests that need a prior open row. */
async function publishShort(risk: RiskState | null, seed?: (store: ReturnType<typeof memoryStore>) => Promise<void>) {
  const store = memoryStore()
  // NVDA is routable on the short side, so the day ends at a PUBLISHED row
  // rather than at the route guard — which is what makes its rung readable.
  await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'NVDS' } } })
  await store.write('engine-calibration', {
    buckets: { 'short:amber:25-40': { n: 32, hits: 22 } },
    brier: [],
    defVersion: CALIB_DEF_VERSION,
    seedGeneration: 5,
  } satisfies CalibrationState)
  if (risk) await store.write('risk-state', risk)
  if (seed) await seed(store)
  const { board } = await buildBoard(store, boardDeps, BOARD_NOW)
  const row = board.find(r => r.sym === 'NVDA' && r.side === 'short')
  if (!row) throw new Error(`no NVDA short row published: ${board.map(r => `${r.sym}:${r.side}`).join(', ') || 'empty board'}`)
  return { row, ledger: (await store.read<Prediction[]>(`predictions:${BOARD_TODAY}`)) ?? [] }
}

const BOARD_TODAY = new Date(BOARD_NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const BOARD_YESTERDAY = new Date((BOARD_NOW - DAY) * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

describe('the campaign stamp at publication', () => {
  it('a fresh row opens and owns its own campaign', async () => {
    const { row } = await publishShort(null)
    expect(row.campaignId).toBe(row.id)
  })

  it('today’s copy of a still-open idea inherits the FIRST row’s campaign id', async () => {
    const first = (await publishShort(null)).row
    // yesterday's publication of the same sleeve/symbol/side/setup, ungraded —
    // the campaign this morning's copy joins rather than opens
    const yesterdayId = `${BOARD_YESTERDAY}:NVDA:short`
    const { row } = await publishShort(null, async store => {
      await store.write('predictions-index', [BOARD_YESTERDAY])
      await store.write(`predictions:${BOARD_YESTERDAY}`, [
        { ...first, id: yesterdayId, campaignId: yesterdayId, date: BOARD_YESTERDAY, outcome5: undefined, outcome10: undefined, outcome21: undefined },
      ])
    })
    expect(row.id).toBe(`${BOARD_TODAY}:NVDA:short`) // its own dated receipt, unchanged
    expect(row.campaignId).toBe(yesterdayId) // …pointing at the idea it refreshes
  })

  it('an earnings-fade SHADOW row is stamped too — every lane row the ledger will grade carries a campaign', async () => {
    // The fade lane publishes last, through `shadows` rather than `liveCalls`,
    // so it is the publish path most easily missed by a stamp written for the
    // board's live rows. A lane row that reached the ledger unstamped would read
    // as independent evidence for ever.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', {
      buckets: { 'short:amber:25-40': { n: 20, hits: 14 }, 'short:amber:40-55': { n: 20, hits: 14 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
    } satisfies CalibrationState)
    await buildBoard(store, fadeDeps, FADE_NOW)
    const ledger = (await store.read<Prediction[]>(`predictions:${FADE_TODAY}`)) ?? []
    const fade = ledger.find(p => p.sym === 'POPR' && p.side === 'short')
    expect(fade, 'the fade lane published nothing').toBeTruthy()
    expect(fade!.shadow).toBe(true)
    expect(fade!.catalyst!.kind).toBe(EARNINGS_FADE_CATALYST_KIND)
    // stamped, and on a cold book it owns the campaign it opened
    expect(fade!.campaignId).toBeDefined()
    expect(fade!.campaignId).toBe(fade!.id)
    // …and every other row the ledger will grade is stamped with it
    expect(ledger.every(p => !!p.campaignId)).toBe(true)
  })
})

// ---- the earnings-fade fixture (engine.earningsFade.test.ts's tape) ---------

const fadeFlat = (days: number, price: number): Candle[] =>
  Array.from({ length: days }, (_, i) => ({ t: BOARD_T0 + i * DAY, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000 }))
/** …then one bar that OPENS 7% above the prior close and drifts back. */
const popped = (() => {
  const b = fadeFlat(259, 100)
  const prev = b[b.length - 1]
  const o = prev.c * 1.07
  const c = o * 0.99
  b.push({ t: prev.t + DAY, o, h: o * 1.005, l: c * 0.995, c, v: 1_200_000 })
  return b
})()
const fadeSpy = fadeFlat(260, 500)
const PRINT_DATE = new Date(popped[popped.length - 2].t * 1000).toISOString().slice(0, 10)
const FADE_NOW = Math.floor(popped[popped.length - 1].t + DAY)
const FADE_TODAY = new Date(FADE_NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

const fadeDeps: EngineDeps = {
  ...gradeDeps,
  candles: async (sym: string) => (sym === 'POPR' ? popped : sym === 'SPY' || sym === 'QQQ' ? fadeSpy : null),
  screens: async () => [{ row: { sym: 'POPR', price: 107, capUsdM: 42_000, changePct: 7, name: null }, source: 'screener:gainers' }],
  earningsEvents: async () => [
    { sym: 'POPR', date: PRINT_DATE, time: 'post', epsActual: 1.2, epsForecast: 1.0, surprisePct: 20, noOfEsts: 6, marketCapUsdM: 42_000 },
  ],
} as unknown as EngineDeps
