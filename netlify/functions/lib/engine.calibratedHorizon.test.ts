import { describe, expect, it, vi } from 'vitest'

// THE CALIBRATED HORIZON, 10 → 21 SESSIONS (CALIB_DEF_VERSION v4, owner ruling
// 2026-09-22 "option 1"). The reader holds one to two weeks and up to a month, so
// the grade the engine is scored on has to be struck on that clock.
//
// This file pins the CONTRACT rather than any one call site:
//
//   · a hit IS the 21-session excess vs SPY with no close through the stop inside
//     those 21 sessions — and a row that survives 10 and breaks on 13 is a MISS,
//     which is precisely the population the old horizon could not see;
//   · every equity learning seam reads `CALIBRATED_OUTCOME` and fires ONCE, at the
//     21 lens — never at the 10 one, which is now a ledger lens and trains nothing;
//   · a stored v3 blob is RETIRED, not carried forward, and a v4 engine on empty
//     buckets still answers sensibly (base rate, grade C) rather than throwing or
//     inventing conviction;
//   · the regret ledger measures on the same clock as the hit.
//
// The REFUSAL half of the swap (a seed measuring a retired definition may not
// land, however high its generation) is pinned next door in
// engine.seedGeneration.test.ts, which owns the seed stub. The INSTALL half — the
// committed generation-5 artefact landing into a cold v4 state — is pinned at the
// foot of this file, on the real seed.

import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import {
  CALIB_DEF_VERSION,
  CALIBRATED_HORIZON_SESSIONS,
  CALIBRATED_OUTCOME,
  ENGINE_MODEL_VERSION,
  calibratedOutcomeOf,
  emptyCalibration,
  gradeFor,
  gradePrediction,
  probabilityFor,
  baseHitRate,
  initWeights,
  type CalibrationState,
  type WeightsState,
} from '../../../shared/engine/calibration'
import seedJson from '../../../shared/engine/seed.json'
import { MISS_HORIZON, missExcess } from '../../../shared/engine/missLedger'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'

// ---- the tape ----------------------------------------------------------------
// 120 sessions, one bar a day. Entry is bar 40 in every fixture below, so both
// lenses have room and the difference between them is the whole point.
const T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const BARS = 120
const ENTRY_IDX = 40
const dateOf = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)
const ENTRY = dateOf(ENTRY_IDX)
const NOW = Math.floor(T0 + BARS * DAY)

const tape = (closeAt: (i: number) => number): Candle[] =>
  Array.from({ length: BARS }, (_, i) => {
    const c = closeAt(i)
    return { t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }
  })

const spy = tape(() => 100)

describe('the hit definition — 21 sessions, and a stop anywhere inside them', () => {
  it('the two constants are one fact: the field and the session count move together', () => {
    expect(CALIBRATED_OUTCOME).toBe('outcome21')
    expect(CALIBRATED_HORIZON_SESSIONS).toBe(21)
  })

  it('grades the 21-session excess, not the 10-session one — a name that gives it all back after two weeks is a MISS', () => {
    // +1% a session for ten sessions, then straight back down: a clear winner at
    // the old horizon and flat-to-negative at the new one. SPY is flat, so excess
    // is the raw move.
    const roundTrip = tape(i => (i <= ENTRY_IDX ? 100 : i <= ENTRY_IDX + 10 ? 100 + (i - ENTRY_IDX) : 110 - (i - ENTRY_IDX - 10)))
    const row = { date: ENTRY, side: 'long' as const, priceAtPrediction: 100, stop: 80 }

    const at10 = gradePrediction(row, roundTrip, spy, 10)!
    const at21 = gradePrediction(row, roundTrip, spy, CALIBRATED_HORIZON_SESSIONS)!

    expect(at10.hit).toBe(true) // +10pp over the old horizon
    expect(at21.hit).toBe(false) // …and −1pp over the one it is now graded on
    expect(at21.excessPct).toBeLessThan(at10.excessPct)
  })

  it('a close through the stop on session 13 is a miss FOREVER, however the name recovers by 21', () => {
    // down through the stop at day 13, then a full recovery to +12% by day 21
    const breakThenRecover = tape(i => {
      if (i <= ENTRY_IDX) return 100
      const d = i - ENTRY_IDX
      if (d <= 10) return 100 - 0.5 * d // drifts to 95 — never near the 92 stop
      if (d <= 13) return 95 - (d - 10) // …then gives way, closing AT 92 on day 13
      return 92 + (d - 13) * 3 // …and runs to +16% by day 21
    })
    const row = { date: ENTRY, side: 'long' as const, priceAtPrediction: 100, stop: 92 }

    const at10 = gradePrediction(row, breakThenRecover, spy, 10)!
    const at21 = gradePrediction(row, breakThenRecover, spy, CALIBRATED_HORIZON_SESSIONS)!

    // the 10 lens never saw the break — the tape was still above the stop at day 10
    expect(at10.stopped).toBe(false)
    // …and the calibrated lens does, which is the exposure the old horizon hid
    expect(at21.stopped).toBe(true)
    expect(at21.excessPct).toBeGreaterThan(0) // it recovered…
    expect(at21.hit).toBe(false) // …and a stop is a miss forever regardless
  })

  it('needs a full 21 sessions of BOTH series — a short tape or a short benchmark grades nothing', () => {
    const runner = tape(i => (i <= ENTRY_IDX ? 100 : 100 + (i - ENTRY_IDX)))
    const row = { date: ENTRY, side: 'long' as const, priceAtPrediction: 100, stop: 80 }
    expect(gradePrediction(row, runner.slice(0, ENTRY_IDX + 21), spy, 21)).toBeNull()
    expect(gradePrediction(row, runner, spy.slice(0, ENTRY_IDX + 21), 21)).toBeNull()
    expect(gradePrediction(row, runner, spy, 21)).not.toBeNull()
  })
})

describe('an EMPTY v4 state still answers sensibly — the engine runs cold until a v4 seed lands', () => {
  const cold = emptyCalibration()

  it('is what a definition change leaves behind: current version, no evidence, generation 0', () => {
    expect(cold.defVersion).toBe(CALIB_DEF_VERSION)
    expect(cold.buckets).toEqual({})
    expect(cold.setupBuckets).toEqual({})
    expect(cold.brier).toEqual([])
    // NOT the legacy "absent means 1": no artefact has installed here, so the first
    // v4 seed of any generation supersedes it
    expect(cold.seedGeneration).toBe(0)
  })

  it('prices every conviction at the cold base rate and never throws', () => {
    for (const composite of [26, 41, 56, 71, 88]) {
      const read = probabilityFor(cold, 'long', 'green', composite)
      expect(Number.isFinite(read.p)).toBe(true)
      expect(read.p).toBe(0.5) // the cold base — nothing has been observed to move it
      expect(read.nEff).toBe(0)
      expect(read.provisional).toBe(true)
    }
    expect(baseHitRate(cold)).toEqual({ rate: 0.5, n: 0 })
  })

  it('grades C on empty buckets — never A, never null', () => {
    const base = baseHitRate(cold).rate
    for (const composite of [26, 56, 88]) {
      const read = probabilityFor(cold, 'long', 'green', composite)
      // p === base, so this is the boundary case: not below the base (null) and
      // nowhere near base+0.05 on nEff 0 (B/A). C is the only honest answer.
      expect(gradeFor(read.p, read.nEff, base, read.belowEvidence)).toBe('C')
    }
  })
})

// ---- the learning loop, end to end ------------------------------------------

const flatFor = (syms: string[], t: Map<string, Candle[]>): EngineDeps =>
  ({
    candles: async (sym: string) => t.get(sym) ?? null,
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
    _syms: syms,
  }) as unknown as EngineDeps

/** A winner on both lenses, so "did it learn?" is never confused with "did it
 * win?": +1% a session from entry, SPY flat, stop far below. */
const winner = tape(i => (i <= ENTRY_IDX ? 100 : 100 + (i - ENTRY_IDX)))

const plantedRow = (over: Partial<Prediction> = {}): Prediction =>
  ({
    id: `${ENTRY}:WIN:long`,
    date: ENTRY,
    sym: 'WIN',
    side: 'long',
    composite: 45,
    regime: 'green',
    probability: 0.6,
    provisional: false,
    grade: 'B',
    setup: 'continuation',
    priceAtPrediction: 100,
    entry: 100,
    stop: 80,
    target: 130,
    instrument: null,
    riskPct: 1,
    capUsdM: 50_000,
    factors: { technical: { score: 30, detail: '', weight: 1 } },
    ...over,
  }) as unknown as Prediction

const currentEpoch = (): CalibrationState => ({ buckets: {}, setupBuckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })

/** Runs a grading pass over a tape TRUNCATED to `bars` sessions after entry, so a
 * test can stand the engine exactly between the two lenses. */
const gradeOver = async (barsAfterEntry: number) => {
  const store = memoryStore()
  const cut = ENTRY_IDX + barsAfterEntry + 1
  const deps = flatFor(['WIN', 'SPY'], new Map([
    ['WIN', winner.slice(0, cut)],
    ['SPY', spy.slice(0, cut)],
  ]))
  await store.write('engine-calibration', currentEpoch())
  await store.write('engine-weights', { ...initWeights(), seedGeneration: 5 })
  await store.write(`predictions:${ENTRY}`, [plantedRow()])
  await store.write('predictions-index', [ENTRY])
  const res = await gradeOutstanding(store, deps, NOW, null)
  return {
    graded: res.graded,
    row: (await store.read<Prediction[]>(`predictions:${ENTRY}`))![0],
    cal: (await store.read<CalibrationState>('engine-calibration'))!,
    w: (await store.read<WeightsState>('engine-weights'))!,
    risk: await store.read<{ gradedAtRung: number }>('risk-state'),
    pending: await store.read<string[]>('predictions-pending'),
    scorecard: await store.read<{ byGrade: Record<string, { n: number }>; lifetime: { live: { graded: number } } }>('engine-scorecard'),
  }
}

describe('every equity learning seam fires ONCE, at the 21 lens — and never at the 10 one', () => {
  it('fills the 5 and 10 lenses and teaches NOTHING while the calibrated grade is still out', async () => {
    const r = await gradeOver(15) // past 10, short of 21

    expect(r.row.outcome5).toBeDefined()
    expect(r.row.outcome10).toBeDefined() // the ledger lens landed…
    expect(r.row.outcome21).toBeUndefined()
    expect(calibratedOutcomeOf(r.row)).toBeUndefined()

    // …and not one learner moved
    expect(r.graded).toBe(0)
    expect(r.cal.buckets).toEqual({}) // no calibration bucket
    expect(r.cal.setupBuckets).toEqual({}) // no setup-family bucket
    expect(r.cal.brier).toEqual([]) // no Brier point
    expect(r.w.ic.technical).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }) // no factor IC
    expect(r.w.gradedSinceNudge).toBe(0)
    expect(r.risk?.gradedAtRung ?? 0).toBe(0) // no risk-ladder counter
    expect(r.row.postMortem).toBeUndefined() // and no verdict on a row with no grade
    expect(r.pending).toEqual([ENTRY]) // it stays pending, which is the point
  })

  it('teaches every seam exactly once when the 21-session grade lands', async () => {
    const r = await gradeOver(CALIBRATED_HORIZON_SESSIONS + 1)

    expect(r.row.outcome21).toBeDefined()
    expect(r.row.outcome21!.hit).toBe(true)
    expect(r.graded).toBe(1)

    // the calibration bucket books the CALIBRATED outcome, once
    expect(r.cal.buckets['large:long:green:40-55']).toEqual({ n: 1, hits: 1, shadowN: 0, shadowHits: 0 })
    expect(r.cal.setupBuckets!['continuation:long:40-55']).toEqual({ n: 1, hits: 1, shadowN: 0, shadowHits: 0 })
    // the factor IC books the calibrated excess, once
    expect(r.w.ic.technical.nAgree).toBe(1)
    expect(r.w.ic.technical.sumAgree).toBe(r.row.outcome21!.excessPct)
    expect(r.w.ic.technical.sumAgree).not.toBe(r.row.outcome10!.excessPct) // …the 10 lens is a different number
    expect(r.w.gradedSinceNudge).toBe(1)
    // the Brier trail scores the probability against the horizon it predicted
    expect(r.cal.brier).toHaveLength(1)
    expect(r.cal.brier[0]).toMatchObject({ n: 1, mean: Math.round((0.6 - 1) ** 2 * 1000) / 1000 })
    // the risk ladder's counter, and the lifetime/by-grade scorecard
    expect(r.risk!.gradedAtRung).toBe(1)
    expect(r.scorecard!.byGrade.B.n).toBe(1)
    expect(r.scorecard!.lifetime.live.graded).toBe(1)
    // …and the date leaves the pending queue only now
    expect(r.pending).toEqual([])
  })

  it('is idempotent: a second pass over the same matured tape teaches nothing further', async () => {
    const store = memoryStore()
    const cut = ENTRY_IDX + CALIBRATED_HORIZON_SESSIONS + 2
    const deps = flatFor(['WIN', 'SPY'], new Map([
      ['WIN', winner.slice(0, cut)],
      ['SPY', spy.slice(0, cut)],
    ]))
    await store.write('engine-calibration', currentEpoch())
    await store.write('engine-weights', { ...initWeights(), seedGeneration: 5 })
    await store.write(`predictions:${ENTRY}`, [plantedRow()])
    await store.write('predictions-index', [ENTRY])

    await gradeOutstanding(store, deps, NOW, null)
    const second = await gradeOutstanding(store, deps, NOW, null)

    expect(second.graded).toBe(0)
    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['large:long:green:40-55']).toEqual({ n: 1, hits: 1, shadowN: 0, shadowHits: 0 })
    const w = (await store.read<WeightsState>('engine-weights'))!
    expect(w.ic.technical.nAgree).toBe(1)
    expect(cal.brier).toHaveLength(1)
  })
})


// ---- …AND THE v4 SEED LANDED (generation 5, 2026-09-22) ----------------------
// The block above pins what a v4 engine does with NO seed to load: empty buckets,
// everything at the base rate, every row a C. That was the honest cost of moving
// the horizon, and it was always meant to be temporary. This block is the other
// end of it, driven through the REAL `loadState` rather than a stub, because the
// two failures it guards against are both silent:
//
//   · A COMMITTED SEED THAT CANNOT INSTALL. `loadState` gates the swap on
//     `seedCal.defVersion === CALIB_DEF_VERSION`, so an artefact walked at the
//     wrong horizon is refused however high its generation — and the engine then
//     runs cold with nothing but a runlog line to say why. Generation 4 sat in the
//     tree in exactly that state. A stamp assertion is cheap; a quarter of C-graded
//     boards is not.
//   · A v3 BLOB CARRIED FORWARD. Retiring the old buckets and installing the seed
//     are two steps in one load, and the order matters: the stale buckets must be
//     GONE, not merged under the new ones, because they counted a different hit.
//
// It drives `gradeOutstanding` with an empty ledger. That is not a detour — the
// pass persists whatever `loadState` returned as its last act, so a store read
// afterwards is the installed state exactly as tomorrow's board would find it.
const coldRun = async (stored?: { cal?: unknown; weights?: unknown }) => {
  const store = memoryStore()
  const deps = flatFor(['SPY'], new Map([['SPY', spy]]))
  if (stored?.cal) await store.write('engine-calibration', stored.cal)
  if (stored?.weights) await store.write('engine-weights', stored.weights)
  const logged: string[] = []
  const quiet = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
  try {
    await gradeOutstanding(store, deps, NOW, null)
  } finally {
    quiet.mockRestore()
  }
  return {
    cal: (await store.read<CalibrationState>('engine-calibration'))!,
    w: (await store.read<WeightsState>('engine-weights'))!,
    log: logged.join('\n'),
  }
}

describe('the committed seed INSTALLS — the v4 engine is no longer cold', () => {
  const seedCal = seedJson.calibration as unknown as CalibrationState
  const seedW = seedJson.weights as unknown as WeightsState

  it('is stamped for the definition the engine actually grades', () => {
    // The refusal gate is `defVersion`, not generation: this is the one assertion
    // that would have caught the committed generation-4 artefact standing in the
    // tree unable to load.
    expect(seedCal.defVersion).toBe(CALIB_DEF_VERSION)
    expect(seedCal.modelVersion).toBe(ENGINE_MODEL_VERSION)
    expect(seedCal.seedGeneration).toBe(5)
    expect(seedW.seedGeneration).toBe(seedCal.seedGeneration) // both halves, one walk
    expect(seedCal.seeded).toBe(true)
    expect(Object.keys(seedCal.buckets).length).toBeGreaterThan(0)
    expect(seedCal.referenceBase).toBeGreaterThan(0)
  })

  it('installs into an EMPTY v4 state — a cold store comes back carrying the seed', async () => {
    const r = await coldRun()

    expect(r.cal.buckets).toEqual(seedCal.buckets)
    expect(r.cal.setupBuckets).toEqual(seedCal.setupBuckets)
    expect(r.cal.referenceBase).toBe(seedCal.referenceBase)
    expect(r.cal.seedGeneration).toBe(seedCal.seedGeneration)
    expect(r.cal.defVersion).toBe(CALIB_DEF_VERSION)
    // the WEIGHTS half lands with it — installing buckets while leaving the IC
    // behind would grade tomorrow with a yardstick from another scoring epoch
    expect(r.w.seedGeneration).toBe(seedW.seedGeneration)
    expect(r.w.ic.technical).toEqual(seedW.ic.technical)
    // …and `rebaseWeights` found nothing to strip on the way in (§4.4): the
    // measurement survives the load, which is the whole point of committing it
    expect(r.w.ic.technical.nAgree + r.w.ic.technical.nDisagree).toBeGreaterThan(0)
    expect(r.w.base).toEqual(seedW.base)
    // a real read off installed evidence, not the cold-start 0.5 cliff
    expect(baseHitRate(r.cal).n).toBeGreaterThan(0)
    expect(probabilityFor(r.cal, 'long', 'green', 47.5).nEff).toBeGreaterThan(0)
  })

  it('RETIRES a stored v3 blob first, then installs — the old buckets are gone, not merged', async () => {
    // A blob from the 10-session epoch, carrying a bucket the seed does not have
    // so its survival would be unmistakable.
    const stale: CalibrationState = {
      buckets: { 'long:green:70+': { n: 4_000, hits: 3_000 }, 'short:teal:25-40': { n: 90, hits: 80 } } as CalibrationState['buckets'],
      setupBuckets: { 'continuation:long:70+': { n: 500, hits: 400 } },
      brier: [{ date: '2026-01-01', n: 10, mean: 0.2 }],
      defVersion: CALIB_DEF_VERSION - 1,
      seedGeneration: 4,
      evidence: { seed: { n: 0, hits: 0 }, live: { n: 77, hits: 40 }, shadow: { n: 0, hits: 0 } },
    }
    const r = await coldRun({ cal: stale, weights: { ...initWeights(), seedGeneration: 4 } })

    expect(r.cal.defVersion).toBe(CALIB_DEF_VERSION)
    expect(r.cal.buckets['short:teal:25-40']).toBeUndefined() // the invented key proves nothing was merged
    expect(r.cal.buckets).toEqual(seedCal.buckets) // …and what stands there is the seed, whole
    expect(r.cal.setupBuckets).toEqual(seedCal.setupBuckets)
    expect(r.cal.brier).toEqual(seedCal.brier) // the trail scored probabilities against the retired horizon
    expect(r.cal.evidence!.live.n).toBe(0) // the 77 live rows went with the definition
    // the runlog says both halves out loud — a silent reseed is a support ticket
    expect(r.log).toContain(`outcome definition v${CALIB_DEF_VERSION - 1} → v${CALIB_DEF_VERSION}`)
    expect(r.log).toContain(`reseeded from the committed generation ${seedCal.seedGeneration} seed`)
    expect(r.log).not.toContain('CANNOT install')
  })
})

describe('the regret ledger runs on the same clock as the hit', () => {
  it('MISS_HORIZON is the calibrated horizon, and a miss is measured over exactly it', () => {
    expect(MISS_HORIZON).toBe(CALIBRATED_HORIZON_SESSIONS)

    const runner = tape(i => (i <= ENTRY_IDX ? 100 : 100 + (i - ENTRY_IDX)))
    const mine = missExcess(runner, spy, ENTRY)!
    // the stopless mirror of gradePrediction, over the SAME window — the equality
    // is what makes `cost` and `saved` comparable with a hit at all
    const long = gradePrediction({ date: ENTRY, side: 'long', priceAtPrediction: 100, stop: 0 }, runner, spy, CALIBRATED_HORIZON_SESSIONS)!
    expect(long.stopped).toBe(false)
    expect(mine.long).toBe(long.excessPct)
    // …and it refuses a window that has not matured, on the new clock
    expect(missExcess(runner.slice(0, ENTRY_IDX + CALIBRATED_HORIZON_SESSIONS), spy, ENTRY)).toBeNull()
  })
})
