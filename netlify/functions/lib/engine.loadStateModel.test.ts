import { describe, expect, it } from 'vitest'
import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import {
  CALIB_DEF_VERSION,
  ENGINE_MODEL_VERSION,
  initWeights,
  type CalibrationState,
  type WeightsState,
} from '../../../shared/engine/calibration'
import type { Candle } from '../../../shared/types'

// THE MODEL-VERSION DOOR, ON THE LOAD PATH ITSELF.
//
// The unit argument lives in shared/engine/calibration.modelVersion.test.ts:
// `rebaseWeights` cannot catch a re-composition because `migrateWeights` has
// already backfilled the new factor's key by the time it looks. This is the
// same claim asserted through `loadState` — the function production actually
// runs — so the wiring is pinned as well as the rule.

const T0 = Date.parse('2026-06-01T00:00:00Z') / 1000
const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 86_400, o: 500, h: 505, l: 495, c: 500, v: 1_000_000 }))
const NOW = Math.floor(flat[flat.length - 1].t + 86_400)

const deps = (): EngineDeps => ({
  candles: async sym => (sym === 'SPY' ? flat : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [],
  sparkCloses: async () => new Map<string, number[]>(),
  social: async () => [],
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
})

/** A stored pair the loader will neither reseed (the definition matches) nor
 * replace (the generation out-ranks any committed seed) — so the ONLY thing that
 * can touch the IC columns is the model-version door. */
const seedStore = async (modelVersion: number | undefined) => {
  const store = memoryStore()
  await store.write('engine-calibration', {
    buckets: {},
    setupBuckets: {},
    brier: [],
    defVersion: CALIB_DEF_VERSION,
    modelVersion: ENGINE_MODEL_VERSION,
    seedGeneration: 999,
  } satisfies CalibrationState)
  const w: WeightsState = { ...initWeights(), seedGeneration: 999, gradedSinceNudge: 9 }
  w.ic.technical = { nAgree: 40, sumAgree: 96, nDisagree: 12, sumDisagree: -18 }
  if (modelVersion != null) w.modelVersion = modelVersion
  await store.write('engine-weights', w)
  return store
}

const loaded = async (modelVersion: number | undefined) => {
  const store = await seedStore(modelVersion)
  await gradeOutstanding(store, deps(), NOW, null)
  return (await store.read<WeightsState>('engine-weights'))!
}

describe('loadState retires factor IC across an engine-model bump', () => {
  it('a blob stamped with the OLD model loses its IC and gains a journal line', async () => {
    const w = await loaded(3)
    expect(w.ic.technical).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
    expect(w.gradedSinceNudge).toBe(0)
    expect(w.modelVersion).toBe(ENGINE_MODEL_VERSION)
    expect(w.history.some(h => h.evidence.includes(`engine model v3 → v${ENGINE_MODEL_VERSION}`))).toBe(true)
  })

  it('an UNSTAMPED blob keeps its evidence and is simply stamped', async () => {
    const w = await loaded(undefined)
    expect(w.ic.technical.nAgree).toBe(40) // absence is not a different epoch
    expect(w.modelVersion).toBe(ENGINE_MODEL_VERSION)
    expect(w.history).toHaveLength(0)
  })

  it('…and a blob already on the current model is left completely alone', async () => {
    const w = await loaded(ENGINE_MODEL_VERSION)
    expect(w.ic.technical.nAgree).toBe(40)
    expect(w.gradedSinceNudge).toBe(9)
    expect(w.history).toHaveLength(0)
  })
})
