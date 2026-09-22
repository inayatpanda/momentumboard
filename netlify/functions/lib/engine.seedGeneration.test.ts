import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// WHY this file mocks the committed seed instead of using it.
//
// The rule under test is the INSTALL path: a seed regenerated at the SAME
// outcome definition announces itself with a higher `seedGeneration`, and
// loadState then REPLACES the stored calibration and weights with it. The
// committed shared/engine/seed.json is generation 1 (by absence), and it stays
// that way until the walk that produces generation 2 is committed — so there is
// no tape, no store state and no config that can make the real artefact fire
// this rule. The seed module is the thing that has to vary, and loadState reads
// it at call time (`seed.calibration`, `seed.weights`), which is why one mutable
// stub can serve every row of the matrix below.
//
// Every other engine test keeps the real seed — hence a sibling file rather than
// a describe block inside engine.test.ts (engine.velocityFailSoft.test.ts and
// engine.screens.test.ts set the precedent for mocking in a file of its own).
const seedStub = vi.hoisted(() => ({
  generatedAt: '2026-08-13T00:00:00Z',
  symbols: 187,
  weights: {} as unknown,
  calibration: {} as unknown,
}))
vi.mock('../../../shared/engine/seed.json', () => ({ default: seedStub }))

import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import { CALIB_DEF_VERSION, initWeights, type CalibrationState, type WeightsState } from '../../../shared/engine/calibration'
import type { Candle } from '../../../shared/types'

const T0 = Date.parse('2025-06-02') / 1000
const flat: Candle[] = Array.from({ length: 260 }, (_, i) => ({ t: T0 + i * 86_400, o: 500, h: 507.5, l: 492.5, c: 500, v: 1_000_000 }))
const NOW = Math.floor(flat[flat.length - 1].t + 86_400)

// gradeOutstanding needs SPY and nothing else here: the index is empty in every
// case below, so nothing grades and the LOAD is the whole point (the same shape
// engine.test.ts uses for the weights re-base).
const deps = { candles: async (sym: string) => (sym === 'SPY' ? flat : null) } as unknown as EngineDeps

/** The deep seed: one fat bucket no live blob below could have written. */
const SEED_KEY = 'long:green:55-70'
const seedCal = (over: Partial<CalibrationState> = {}): CalibrationState => ({
  buckets: { [SEED_KEY]: { n: 400, hits: 220 } },
  setupBuckets: {},
  brier: [],
  seeded: true,
  defVersion: CALIB_DEF_VERSION,
  modelVersion: 3,
  evidence: { seed: { n: 400, hits: 220 }, live: { n: 0, hits: 0 }, shadow: { n: 0, hits: 0 } },
  ...over,
})

/** What production is carrying: thin, live-provenanced, on the current definition. */
const LIVE_KEY = 'short:amber:25-40'
const storedCal = (over: Partial<CalibrationState> = {}): CalibrationState => ({
  buckets: { [LIVE_KEY]: { n: 12, hits: 5 } },
  setupBuckets: {},
  brier: [{ date: '2026-08-01', mean: 0.21, n: 4 }],
  defVersion: CALIB_DEF_VERSION,
  modelVersion: 3,
  evidence: { seed: { n: 0, hits: 0 }, live: { n: 12, hits: 5 }, shadow: { n: 0, hits: 0 } },
  ...over,
})

/** The seed's weights: base IS the current vector (so rebaseWeights no-ops —
 *  the guarantee the emitter owes, recon §4.4) carrying the walk's measured IC. */
const seedIc = { nAgree: 900, sumAgree: 300, nDisagree: 120, sumDisagree: -40 }
const seedW = (over: Partial<WeightsState> = {}): WeightsState => ({
  ...initWeights(),
  ic: { ...initWeights().ic, technical: { ...seedIc } },
  ...over,
})

/** The stored weights: on the current vector too, with a small learned drift. */
const liveIc = { nAgree: 5, sumAgree: 2, nDisagree: 1, sumDisagree: -1 }
const storedW = (over: Partial<WeightsState> = {}): WeightsState => {
  const w = initWeights()
  w.current.technical = 1.07
  w.ic.technical = { ...liveIc }
  w.gradedSinceNudge = 3
  return { ...w, ...over }
}

const load = async (cal: CalibrationState, weights: WeightsState) => {
  const store = memoryStore()
  await store.write('engine-calibration', cal)
  await store.write('engine-weights', weights)
  await gradeOutstanding(store, deps, NOW, null)
  return {
    cal: (await store.read<CalibrationState>('engine-calibration'))!,
    w: (await store.read<WeightsState>('engine-weights'))!,
  }
}

// an install ANNOUNCES itself — the swap line is the only trace of it in a
// production runlog — so the log is captured rather than left to the console.
let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => log.mockRestore())
const logged = () => log.mock.calls.flat().join(' ')

describe('the generation-keyed seed install', () => {
  describe('calibration', () => {
    it('replaces the stored blob wholesale when the seed announces a higher generation', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { cal } = await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 1 }))

      // REPLACED, not merged — the live bucket is gone, not summed into the seed's
      expect(cal.buckets[LIVE_KEY]).toBeUndefined()
      expect(cal.buckets[SEED_KEY]).toEqual({ n: 400, hits: 220 })
      expect(cal.evidence).toEqual({ seed: { n: 400, hits: 220 }, live: { n: 0, hits: 0 }, shadow: { n: 0, hits: 0 } })
      expect(cal.seedGeneration).toBe(2) // …and the install is recorded, so it happens once
      expect(cal.brier).toEqual([]) // the live Brier trail measured the retired buckets

      // the runlog says what was displaced, so a production install is auditable
      expect(logged()).toContain('CALIBRATION: seed generation 1 → 2 — replacing 12 live rows')
    })

    it('leaves the stored blob alone when the seed is the SAME generation — the swap fires once', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { cal } = await load(storedCal({ seedGeneration: 2 }), storedW({ seedGeneration: 2 }))

      expect(cal.buckets[LIVE_KEY]).toEqual({ n: 12, hits: 5 })
      expect(cal.buckets[SEED_KEY]).toBeUndefined()
      expect(cal.evidence!.live).toEqual({ n: 12, hits: 5 })
      expect(logged()).not.toContain('seed generation')
    })

    it('never regresses to an OLDER seed than the one already installed', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 1 })
      seedStub.weights = seedW({ seedGeneration: 1 })

      const { cal } = await load(storedCal({ seedGeneration: 3 }), storedW({ seedGeneration: 3 }))

      expect(cal.buckets[LIVE_KEY]).toEqual({ n: 12, hits: 5 })
      expect(cal.seedGeneration).toBe(3)
    })

    it('reads a blob with no generation as 1 — a generation-2 seed installs over it', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { cal } = await load(storedCal(), storedW()) // legacy: neither blob has the field

      expect(cal.buckets[SEED_KEY]).toEqual({ n: 400, hits: 220 })
      expect(cal.seedGeneration).toBe(2)
    })

    it('does NOT install a generation-1-by-absence seed over a generation-1-by-absence blob', async () => {
      seedStub.calibration = seedCal() // today's committed artefact: no field at all
      seedStub.weights = seedW()

      const { cal } = await load(storedCal(), storedW())

      expect(cal.buckets[LIVE_KEY]).toEqual({ n: 12, hits: 5 })
      expect(cal.buckets[SEED_KEY]).toBeUndefined()
      expect(cal.seedGeneration).toBe(1) // backfilled, so tomorrow's generation 2 can see it
    })

    it('carries the seed’s referenceBase in with it — the grade anchor travels with the buckets it grades', async () => {
      // spec §9. The anchor is measured by the same walk that filled these buckets
      // and is only meaningful beside them, so the wholesale replace is exactly the
      // right vehicle — but it is worth pinning, because the field is new and a
      // shallow merge somewhere upstream would install the population without the
      // yardstick and silently reproduce the all-C board.
      seedStub.calibration = seedCal({ seedGeneration: 2, referenceBase: 0.3712 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { cal } = await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 1 }))

      expect(cal.referenceBase).toBe(0.3712)
      expect(cal.buckets[SEED_KEY]).toEqual({ n: 400, hits: 220 })
    })

    it('…and does NOT arrive when the stored blob wins — the two move together or not at all', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2, referenceBase: 0.3712 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { cal } = await load(storedCal({ seedGeneration: 2 }), storedW({ seedGeneration: 2 }))

      expect(cal.buckets[LIVE_KEY]).toEqual({ n: 12, hits: 5 }) // no swap…
      expect(cal.referenceBase).toBeUndefined() // …so no anchor from a population this blob never measured
    })

    it('refuses a seed on a STALE outcome definition however high its generation', async () => {
      // a bad artefact — regenerated against a different hit rule and mis-stamped.
      // Its buckets count a different thing; generation must not be able to buy
      // it a way past the definition gate.
      seedStub.calibration = seedCal({ seedGeneration: 9, defVersion: CALIB_DEF_VERSION - 1 })
      seedStub.weights = seedW({ seedGeneration: 9 })

      const { cal, w } = await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 1 }))

      expect(cal.buckets[LIVE_KEY]).toEqual({ n: 12, hits: 5 })
      expect(cal.buckets[SEED_KEY]).toBeUndefined()
      expect(w.ic.technical.nAgree).toBe(liveIc.nAgree) // and neither half of it lands
    })

    it('installs once and then lets live evidence accrue on top', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })
      const store = memoryStore()
      await store.write('engine-calibration', storedCal({ seedGeneration: 1 }))
      await store.write('engine-weights', storedW({ seedGeneration: 1 }))

      await gradeOutstanding(store, deps, NOW, null)
      const installed = (await store.read<CalibrationState>('engine-calibration'))!
      installed.buckets['short:red:40-55'] = { n: 3, hits: 2 } // a week of real grading
      installed.evidence!.live = { n: 3, hits: 2 }
      await store.write('engine-calibration', installed)
      log.mockClear()
      await gradeOutstanding(store, deps, NOW, null)
      expect(logged()).not.toContain('seed generation') // the second load is silent

      const after = (await store.read<CalibrationState>('engine-calibration'))!
      expect(after.buckets['short:red:40-55']).toEqual({ n: 3, hits: 2 }) // NOT wiped a second time
      expect(after.evidence!.live).toEqual({ n: 3, hits: 2 })
      expect(after.buckets[SEED_KEY]).toEqual({ n: 400, hits: 220 })
    })
  })

  describe('weights', () => {
    it('replaces the stored vector and its IC when the seed announces a higher generation', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { w } = await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 1 }))

      expect(w.ic.technical).toEqual(seedIc) // the walk's measured IC, not the live 5
      expect(w.current.technical).toBe(1) // the 1.07 drift belonged to the retired epoch
      expect(w.seedGeneration).toBe(2)
      // rebaseWeights still runs after the swap and must find nothing to do —
      // the seed's base IS DEFAULT_WEIGHTS, so the IC it just installed survives
      expect(w.history).toHaveLength(0)
      expect(w.gradedSinceNudge).toBe(0)
    })

    it('leaves the stored vector alone at the SAME generation, and never regresses to an older one', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })
      const same = await load(storedCal({ seedGeneration: 2 }), storedW({ seedGeneration: 2 }))
      expect(same.w.ic.technical).toEqual(liveIc)
      expect(same.w.current.technical).toBe(1.07)

      seedStub.calibration = seedCal({ seedGeneration: 1 })
      seedStub.weights = seedW({ seedGeneration: 1 })
      const older = await load(storedCal({ seedGeneration: 3 }), storedW({ seedGeneration: 3 }))
      expect(older.w.ic.technical).toEqual(liveIc)
    })

    it('reads a snapshot with no generation as 1 — a generation-2 seed installs over it', async () => {
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { w } = await load(storedCal(), storedW())

      expect(w.ic.technical).toEqual(seedIc)
      expect(w.seedGeneration).toBe(2)
    })

    it('does not install a generation-1-by-absence seed, and backfills the stored snapshot to 1', async () => {
      seedStub.calibration = seedCal()
      seedStub.weights = seedW()

      const { w } = await load(storedCal(), storedW())

      expect(w.ic.technical).toEqual(liveIc)
      expect(w.current.technical).toBe(1.07)
      expect(w.seedGeneration).toBe(1)
    })

    it('is keyed on the WEIGHTS blob’s own generation, not calibration’s', async () => {
      // the half-installed store: a previous load swapped weights and died before
      // the calibration write. Only the half that is behind may move.
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = seedW({ seedGeneration: 2 })

      const { cal, w } = await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 2 }))

      expect(cal.buckets[SEED_KEY]).toEqual({ n: 400, hits: 220 }) // behind → installs
      expect(w.ic.technical).toEqual(liveIc) // level → untouched
      expect(logged()).toContain('CALIBRATION: seed generation')
      expect(logged()).not.toContain('WEIGHTS: seed generation')
    })
  })

  // The generation rule is an ADDITION. The definition swap is the older, sharper
  // rule — stored buckets that counted a different thing are not probabilities —
  // and it must keep firing on its own terms, generations equal or not.
  describe('the defVersion swap it was added beside', () => {
    it('still swaps a stored blob on a retired outcome definition for the committed seed', async () => {
      seedStub.calibration = seedCal() // no generation on either side
      seedStub.weights = seedW()

      const { cal } = await load(storedCal({ defVersion: CALIB_DEF_VERSION - 1 }), storedW())

      expect(cal.buckets[SEED_KEY]).toEqual({ n: 400, hits: 220 })
      expect(cal.buckets[LIVE_KEY]).toBeUndefined()
      expect(cal.defVersion).toBe(CALIB_DEF_VERSION)
    })

    // …and when there is no seed to swap in, the stored blob is RETIRED rather
    // than kept. That is the sharper half of the same rule and the v4 (10→21
    // session) case exactly: the committed artefact still measures the old hit, so
    // it may not install — and buckets counted under a definition the engine has
    // moved past are not probabilities about the new one, so they may not stand
    // either. The honest state is cold, and the engine says so in the runlog.
    it('retires the stored blob to an EMPTY current-definition state when no seed can replace it', async () => {
      seedStub.calibration = seedCal({ defVersion: CALIB_DEF_VERSION - 1, seedGeneration: 9 })
      seedStub.weights = seedW({ seedGeneration: 9 })

      const { cal } = await load(storedCal({ defVersion: CALIB_DEF_VERSION - 1 }), storedW())

      expect(cal.buckets).toEqual({}) // the retired live bucket is gone…
      expect(cal.buckets[SEED_KEY]).toBeUndefined() // …and the stale seed did NOT regress it
      expect(cal.setupBuckets).toEqual({})
      expect(cal.brier).toEqual([]) // the trail scored a probability against the old horizon
      expect(cal.defVersion).toBe(CALIB_DEF_VERSION)
      // seedGeneration 0, not the legacy "absent means 1": no artefact has installed
      // here, so the FIRST seed on the new definition — whatever its generation —
      // supersedes this cold state.
      expect(cal.seedGeneration).toBe(0)
      expect(logged()).toContain(`outcome definition v${CALIB_DEF_VERSION - 1} → v${CALIB_DEF_VERSION}`)
      expect(logged()).toContain('CANNOT install')
    })

    // …and the generation channel cannot talk its way past the definition gate.
    // The generation-4 `seed.json` announced 4 on defVersion 3 and would have
    // out-ranked a cold v4 state on generation alone; it was refused because a
    // generation says WHICH walk measured the buckets and defVersion says WHAT it
    // measured. The committed seed is generation 5 on defVersion 4 now — this pins
    // the rule that let the tree survive the gap.
    it('refuses a HIGHER-generation seed that measures a retired definition, and says so in the runlog', async () => {
      seedStub.calibration = seedCal({ defVersion: CALIB_DEF_VERSION - 1, seedGeneration: 4 })
      seedStub.weights = seedW({ seedGeneration: 4 })

      const { cal, w } = await load(storedCal({ defVersion: CALIB_DEF_VERSION - 1, seedGeneration: 1 }), storedW({ seedGeneration: 1 }))

      expect(cal.buckets[SEED_KEY]).toBeUndefined()
      expect(w.ic.technical).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }) // the seed's IC never landed…
      expect(logged()).toContain('is REFUSED')
      expect(logged()).toContain(`defVersion ${CALIB_DEF_VERSION - 1}`)
    })

    // THE FACTOR IC GOES WITH THE BUCKETS. Every column is a sum of
    // `outcome.excessPct` measured under the retired definition, so letting it
    // steer the nudge loop would have the old yardstick set the new one's weights.
    // The ratified VECTOR is kept — that is `rebaseWeights`'s call, on its own
    // trigger, and a horizon change may not smuggle a model change through.
    it('retires the factor IC alongside the buckets, keeps the weight vector, and journals why', async () => {
      seedStub.calibration = seedCal({ defVersion: CALIB_DEF_VERSION - 1 })
      seedStub.weights = seedW({ defVersion: undefined } as Partial<WeightsState>)

      const { w } = await load(storedCal({ defVersion: CALIB_DEF_VERSION - 1 }), storedW())

      expect(w.ic.technical).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
      expect(w.gradedSinceNudge).toBe(0)
      expect(w.current.technical).toBe(1.07) // the learned drift is NOT collateral damage
      expect(w.history.at(-1)!.evidence).toContain('outcome definition')
      expect(w.history.at(-1)!.evidence).toContain('IC evidence reset')
    })
  })

  // The two invariants the task review found correct but UNPINNED — each of
  // these fails if its line of engine.ts is "harmlessly" refactored.
  describe('ordering and clone discipline', () => {
    it('rebases the swapped-in seed on the SAME load — an off-vector base is stripped immediately, not a day later', async () => {
      // A malformed artefact (Task 2 owes base === DEFAULT_WEIGHTS; suppose it
      // slips): rebaseWeights must run AFTER the install so the stripping — and
      // its history entry — happen before anything grades against these weights.
      // With the old ordering (rebase before the swap) the bad base would sit
      // live until the NEXT load.
      const offVector = seedW({ seedGeneration: 2 })
      ;(offVector as WeightsState & { base: Record<string, number> }).base = { ...(initWeights() as WeightsState & { base: Record<string, number> }).base, technical: 0.5 }
      seedStub.calibration = seedCal({ seedGeneration: 2 })
      seedStub.weights = offVector

      const { w } = await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 1 }))

      const rebased = w as WeightsState & { base: Record<string, number>; history: unknown[] }
      expect(rebased.base.technical).not.toBe(0.5) // stripped to the current vector
      expect(rebased.history.length).toBeGreaterThan(0) // and the rebase left its record
    })

    it('installs a CLONE — grading after the install never mutates the imported seed module', async () => {
      const cal = seedCal({ seedGeneration: 2 })
      const snapshot = JSON.stringify(cal)
      seedStub.calibration = cal
      seedStub.weights = seedW({ seedGeneration: 2 })

      await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 1 }))
      // load twice more — a warm container reuses the module object
      await load(storedCal({ seedGeneration: 1 }), storedW({ seedGeneration: 1 }))

      expect(JSON.stringify(seedStub.calibration)).toBe(snapshot)
    })
  })
})
