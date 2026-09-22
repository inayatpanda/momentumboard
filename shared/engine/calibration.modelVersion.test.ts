import { describe, expect, it } from 'vitest'
import { DEFAULT_WEIGHTS } from './composite'
import {
  ENGINE_MODEL_VERSION,
  initWeights,
  migrateWeights,
  rebaseWeights,
  retireIcOnModelBump,
  type WeightsState,
} from './calibration'

// THE MODEL-VERSION DOOR, AND THE HOLE IT WAS WRITTEN TO CLOSE.
//
// ENGINE_MODEL_VERSION's comment claimed the deploy was protected by
// `rebaseWeights`: a new core factor means a key the stored base does not carry,
// so the re-base fires, drops the vector and zeroes the IC. That is not what
// happens on the load path. `loadState` runs `migrateWeights` FIRST, and its
// whole job is to backfill exactly that missing key — so by the time
// `rebaseWeights` looks, the fingerprint matches and it returns the blob
// untouched, IC and all. A four-core model's agreements would have gone on
// steering a five-core one, silently and indefinitely.
//
// The two claims below are the reason `retireIcOnModelBump` exists, and the
// first is a pin on the mechanism rather than on a preference: if it ever starts
// passing, the door can be removed.

const banked = (over: Partial<WeightsState> = {}): WeightsState => ({
  ...initWeights(),
  ic: {
    ...initWeights().ic,
    technical: { nAgree: 40, sumAgree: 96, nDisagree: 12, sumDisagree: -18 },
    momentum: { nAgree: 25, sumAgree: 30, nDisagree: 9, sumDisagree: -11 },
  },
  gradedSinceNudge: 7,
  ...over,
})

/** the four-core blob this deploy actually inherits: no `bandwidth` anywhere */
const fourCore = (): WeightsState => {
  const w = banked({ modelVersion: 3 })
  delete (w.base as Partial<Record<string, number>>).bandwidth
  delete (w.current as Partial<Record<string, number>>).bandwidth
  delete (w.ic as Partial<Record<string, unknown>>).bandwidth
  return w
}

const icTotal = (w: WeightsState) => Object.values(w.ic).reduce((s, c) => s + c.nAgree + c.nDisagree, 0)

describe('the claim the old comment made', () => {
  it('is FALSE on the load path: migrateWeights backfills the key before rebaseWeights can see it', () => {
    const w = rebaseWeights(migrateWeights(fourCore(), DEFAULT_WEIGHTS, '2026-09-22'), DEFAULT_WEIGHTS, '2026-09-22')
    expect(w.base.bandwidth).toBe(DEFAULT_WEIGHTS.bandwidth) // the backfill happened…
    expect(icTotal(w)).toBe(86) // …and the four-core IC survived it, whole
    expect(w.gradedSinceNudge).toBe(7)
    expect(w.history.some(h => h.evidence.includes('re-base'))).toBe(false) // rebaseWeights never fired
  })
})

describe('retireIcOnModelBump', () => {
  it('retires the IC measured on a superseded model, and says so in the journal', () => {
    const w = retireIcOnModelBump(banked({ modelVersion: 3 }), '2026-09-22')
    expect(icTotal(w)).toBe(0)
    expect(w.gradedSinceNudge).toBe(0)
    expect(w.modelVersion).toBe(ENGINE_MODEL_VERSION)
    const line = w.history.at(-1)!
    expect(line.date).toBe('2026-09-22')
    expect(line.changes).toEqual({}) // nothing was measured and no weight moved
    expect(line.evidence).toContain(`engine model v3 → v${ENGINE_MODEL_VERSION}`)
    expect(line.evidence).toContain('86 factor observation(s) retired')
  })

  it('KEEPS the vector — a model change may not smuggle a re-base through', () => {
    const before = banked({ modelVersion: 3 })
    before.current.technical = 1.2
    const w = retireIcOnModelBump(before, '2026-09-22')
    expect(w.current.technical).toBe(1.2)
    expect(w.base).toEqual(DEFAULT_WEIGHTS)
  })

  it('an ABSENT stamp is backfilled, never retired — the seed install path is untouched', () => {
    // Every blob written before this field existed, the live one and the
    // committed seed included, has no claim to be from a different epoch.
    // Treating absence as a bump would strip a seed's measured factor evidence
    // on the very first load after this ships.
    const w = retireIcOnModelBump(banked(), '2026-09-22')
    expect(w.modelVersion).toBe(ENGINE_MODEL_VERSION)
    expect(icTotal(w)).toBe(86)
    expect(w.gradedSinceNudge).toBe(7)
    expect(w.history).toHaveLength(0)
  })

  it('is idempotent and silent once stamped — it runs on every load, not every write', () => {
    const once = retireIcOnModelBump(banked({ modelVersion: 3 }), '2026-09-22')
    const twice = retireIcOnModelBump(once, '2026-09-23')
    expect(twice.history).toHaveLength(1)
    expect(twice.modelVersion).toBe(ENGINE_MODEL_VERSION)
    // …and a blob already on the current model is left completely alone
    const current = retireIcOnModelBump(banked({ modelVersion: ENGINE_MODEL_VERSION }), '2026-09-22')
    expect(icTotal(current)).toBe(86)
    expect(current.history).toHaveLength(0)
  })

  it('a blob with nothing banked is a no-op even across a real bump', () => {
    const w = retireIcOnModelBump({ ...initWeights(), modelVersion: 2 }, '2026-09-22')
    expect(w.modelVersion).toBe(ENGINE_MODEL_VERSION)
    expect(w.history).toHaveLength(0) // retireIcEvidence owns this test; nothing to say
  })
})
