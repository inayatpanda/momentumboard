import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The refusal line is a fact about the COMMITTED ARTEFACT, and `loadState` runs
// on every board build AND every grading pass — so it printed several times a
// run, several times a scheduled job, and dozens of times in a test file,
// burying the lines that say what the run actually did. It is now logged once
// per refused artefact per process.
//
// The seed is mocked for the same reason engine.seedGeneration.test.ts mocks it:
// the committed artefact installs cleanly (defVersion 4), so nothing a store or
// a tape can do will make the real one refuse.
const seedStub = vi.hoisted(() => ({
  generatedAt: '2026-09-22T00:00:00Z',
  symbols: 187,
  weights: {} as unknown,
  calibration: {} as unknown,
}))
vi.mock('../../../shared/engine/seed.json', () => ({ default: seedStub }))

import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import { CALIB_DEF_VERSION, initWeights, type CalibrationState, type WeightsState } from '../../../shared/engine/calibration'
import type { Candle } from '../../../shared/types'

const T0 = Date.parse('2026-06-01T00:00:00Z') / 1000
const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 86_400, o: 500, h: 505, l: 495, c: 500, v: 1_000_000 }))
const NOW = Math.floor(flat[flat.length - 1].t + 86_400)
const deps = { candles: async (sym: string) => (sym === 'SPY' ? flat : null) } as unknown as EngineDeps

const storedCal = (): CalibrationState => ({ buckets: {}, setupBuckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 1 })
const storedW = (): WeightsState => ({ ...initWeights(), seedGeneration: 1 })

let lines: string[]
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

const load = async () => {
  const store = memoryStore()
  await store.write('engine-calibration', storedCal())
  await store.write('engine-weights', storedW())
  await gradeOutstanding(store, deps, NOW, null)
}
const refusals = () => lines.filter(l => l.includes('is REFUSED'))

describe('the seed-refusal runlog', () => {
  it('prints once per process, not once per load', async () => {
    // a stale artefact: it announces a generation but measures the retired hit
    seedStub.calibration = { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION - 1, seedGeneration: 7 } satisfies CalibrationState
    seedStub.weights = { ...initWeights(), seedGeneration: 7 } satisfies WeightsState

    await load()
    expect(refusals()).toHaveLength(1)
    expect(refusals()[0]).toContain(`defVersion ${CALIB_DEF_VERSION - 1}`)

    // four more loads — two board builds and two grading passes is an ordinary day
    for (let i = 0; i < 4; i++) await load()
    expect(refusals()).toHaveLength(1)
  })

  it('…but a DIFFERENT refused artefact still gets a line — silence would cost information', async () => {
    seedStub.calibration = { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION - 1, seedGeneration: 11 } satisfies CalibrationState
    seedStub.weights = { ...initWeights(), seedGeneration: 11 } satisfies WeightsState
    await load()
    expect(refusals()).toHaveLength(1)
    expect(refusals()[0]).toContain('generation 11')
  })
})
