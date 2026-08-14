import { describe, expect, it, vi } from 'vitest'
import {
  WILDCARD_CAPACITY_GATES,
  WILDCARD_INELIGIBLE_GATES,
  WILDCARD_NEAR_DEAD_ZONE,
  WILDCARD_SIZE_CAP,
  WILDCARD_UNCOUNTED_GATES,
  gateEvidenceN,
  rungSizedN,
  selectWildcard,
  wildcardDisabled,
  type WildcardInputs,
} from './wildcardLane'
import type { CatalystTag } from './catalyst'
import type { FunnelNearMiss, FunnelTraceRow } from './funnelTrace'
import type { GateAttribution } from './missLedger'
import type { FactorName, FactorScore, GateCode } from './types'

// ---- fixtures ----

const FACTORS = Object.fromEntries(
  (['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as FactorName[]).map(n => [
    n,
    { score: 0, detail: '' } as FactorScore,
  ]),
) as Record<FactorName, FactorScore>

/** A near miss shaped exactly as buildBoard pushes one (engine.ts) — a real core
 * read, printable levels, no earnings print inside the horizon. */
const miss = (sym: string, core: number, over: Partial<FunnelNearMiss> = {}): FunnelNearMiss => ({
  sym,
  core,
  capUsdM: 8000,
  lastClose: 100,
  atrNow: 3,
  capacityPct: 4,
  stage: 'stage2',
  factors: FACTORS,
  ...over,
})

const row = (gate: GateCode, side?: 'long' | 'short', over: Partial<FunnelTraceRow> = {}): FunnelTraceRow => ({ gate, ...(side ? { side } : {}), ...over })

const attrib = (gate: GateCode, over: Partial<GateAttribution> = {}): GateAttribution => ({
  gate,
  cost: 0,
  saved: 0,
  n: 0,
  unchecked: 0,
  doubleBooked: false,
  ...over,
})

/** levMap with a short route on ROUTED only, plus a route ETP of its own. */
const LEV_MAP = { ROUTED: { short2x: 'SRTD', short3x: '3SRT.L', long2x: 'LRTD' } }

const inputs = (over: Partial<WildcardInputs> = {}): WildcardInputs => ({
  traceRows: {},
  nearMisses: [],
  catalystBySym: new Map<string, CatalystTag>(),
  gateStats: [],
  calibration: { buckets: {} },
  regime: 'green',
  deadZone: 30,
  levMap: LEV_MAP,
  outstanding: false,
  ...over,
})

/** The p1 shape used over and over: one long near miss, one trace row naming one
 * ordinary gate, a ledger that has priced that gate. */
const p1Inputs = (over: Partial<WildcardInputs> = {}): WildcardInputs =>
  inputs({
    nearMisses: [miss('AAA', 23)],
    traceRows: { 'AAA:long': row('dead-zone-core', 'long') },
    gateStats: [attrib('dead-zone-core', { cost: 5, saved: 2, n: 7, unchecked: 3 })],
    ...over,
  })

describe('selectWildcard — the ladder', () => {
  it('priority 1: the blocked candidate with exactly one gate, and the hypothesis names that gate and its evidence gap', () => {
    const sel = selectWildcard(p1Inputs())
    expect(sel).not.toBeNull()
    expect(sel!.priority).toBe(1)
    expect(sel!.candidate.sym).toBe('AAA')
    expect(sel!.candidate.side).toBe('long')
    expect(sel!.candidate.gate).toBe('dead-zone-core')
    // sidedCost + sidedSaved + unchecked — the thinness arithmetic, carried
    expect(sel!.candidate.gateEvidenceN).toBe(10)
    expect(sel!.hypothesis).toContain('dead-zone-core')
    expect(sel!.hypothesis).toContain('7')
    expect(sel!.hypothesis).toContain('3')
    expect(sel!.hypothesis).toContain('23')
  })

  it('priority 1 prefers the THINNEST gate, not the biggest composite', () => {
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('LOUD', 28), miss('QUIET', 12)],
        traceRows: { 'LOUD:long': row('dead-zone-core', 'long'), 'QUIET:long': row('entry-chase', 'long') },
        gateStats: [attrib('dead-zone-core', { cost: 40, saved: 10, n: 50, unchecked: 100 }), attrib('entry-chase', { cost: 1, saved: 0, n: 1, unchecked: 0 })],
      }),
    )
    expect(sel!.candidate.sym).toBe('QUIET')
    expect(sel!.candidate.gateEvidenceN).toBe(1)
  })

  it('a gate the ledger has never seen is the thinnest gate there is', () => {
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('MEASURED', 29), miss('VIRGIN', 11)],
        traceRows: { 'MEASURED:long': row('expected-move', 'long'), 'VIRGIN:long': row('entry-wait', 'long') },
        gateStats: [attrib('expected-move', { cost: 2, saved: 0, n: 2, unchecked: 0 })],
      }),
    )
    expect(sel!.candidate.sym).toBe('VIRGIN')
    expect(sel!.candidate.gateEvidenceN).toBe(0)
  })

  it('within one gate the highest |core| wins, and a short reads its |core|', () => {
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('SMALL', 9), miss('ROUTED', -28)],
        traceRows: { 'SMALL:long': row('entry-wait', 'long'), 'ROUTED:short': row('entry-wait', 'short') },
        gateStats: [],
      }),
    )
    expect(sel!.candidate.sym).toBe('ROUTED')
    expect(sel!.candidate.side).toBe('short')
  })

  it('priority 2: the rung with no sized evidence, once no single-gate candidate is left', () => {
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('TWOGATE', 26)],
        // two gates across this name's rows ⇒ never a p1 candidate
        traceRows: { 'TWOGATE:long': row('entry-chase', 'long'), 'TWOGATE:short': row('dead-zone-core', 'short') },
        calibration: { buckets: { 'large:long:green:25-40': { n: 0, hits: 0 } } },
      }),
    )
    expect(sel!.priority).toBe(2)
    expect(sel!.candidate.sym).toBe('TWOGATE')
    expect(sel!.hypothesis).toContain('large')
    expect(sel!.hypothesis).toContain('green')
  })

  it('priority 2 refuses a rung that already carries SIZED evidence, and reads the sized slice not the pool', () => {
    const twoGate = { 'TWOGATE:long': row('entry-chase', 'long'), 'TWOGATE:short': row('dead-zone-core', 'short') }
    // pooled 40, ALL of it shadow ⇒ the sized slice is empty ⇒ the rung is empty
    const allShadow = selectWildcard(
      inputs({ nearMisses: [miss('TWOGATE', 26)], traceRows: twoGate, calibration: { buckets: { 'large:long:green:25-40': { n: 40, hits: 12, shadowN: 40, shadowHits: 12 } } } }),
    )
    expect(allShadow!.priority).toBe(2)
    // one sized row in the rung and the rung is no longer unmeasured
    const oneSized = selectWildcard(
      inputs({ nearMisses: [miss('TWOGATE', 26)], traceRows: twoGate, calibration: { buckets: { 'large:long:green:25-40': { n: 41, hits: 12, shadowN: 40, shadowHits: 12 } } } }),
    )
    expect(oneSized).toBeNull()
  })

  it('priority 2 ignores legacy cohortless keys — the cohort-tagged rung is the unmeasured slice', () => {
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('TWOGATE', 26)],
        traceRows: { 'TWOGATE:long': row('entry-chase', 'long'), 'TWOGATE:short': row('dead-zone-core', 'short') },
        // the seed's cohortless bucket, fat and fully sized — and irrelevant here
        calibration: { buckets: { 'long:green:25-40': { n: 1200, hits: 500 } } },
      }),
    )
    expect(sel!.priority).toBe(2)
  })

  it('priority 2 never fires for an unknown-cap name — a rung nothing can ever fill is not a rung to test', () => {
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('NOCAP', 26, { capUsdM: null })],
        traceRows: { 'NOCAP:long': row('entry-chase', 'long'), 'NOCAP:short': row('dead-zone-core', 'short') },
      }),
    )
    expect(sel).toBeNull()
  })

  it('priority 3: an LLM catalyst nominee that just missed the dead zone', () => {
    const twoGate = { 'CAT:long': row('entry-chase', 'long'), 'CAT:short': row('dead-zone-core', 'short') }
    const cat = new Map<string, CatalystTag>([['CAT', { kind: 'news', side: 'long', reason: 'ignore me — LLM prose', strength: 70 }]])
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('CAT', 27, { capUsdM: 8000 })],
        traceRows: twoGate,
        catalystBySym: cat,
        // rung already measured ⇒ p2 is out of the way
        calibration: { buckets: { 'large:long:green:25-40': { n: 50, hits: 20 } } },
      }),
    )
    expect(sel!.priority).toBe(3)
    expect(sel!.candidate.catalyst?.kind).toBe('news')
    expect(sel!.hypothesis).toContain('news')
    expect(sel!.hypothesis).toContain('30') // the dead zone under test
    // the LLM's own prose never reaches a hypothesis that reaches the paper
    expect(sel!.hypothesis).not.toContain('ignore me')
  })

  it('priority 3 refuses a nominee that is nowhere near the dead zone, and one arguing the other way', () => {
    const measured = { buckets: { 'large:long:green:25-40': { n: 50, hits: 20 }, 'large:short:green:25-40': { n: 50, hits: 20 } } }
    const twoGate = (s: string) => ({ [`${s}:long`]: row('entry-chase', 'long'), [`${s}:short`]: row('dead-zone-core', 'short') })
    const far = selectWildcard(
      inputs({
        nearMisses: [miss('FAR', 30 - WILDCARD_NEAR_DEAD_ZONE - 1)],
        traceRows: twoGate('FAR'),
        catalystBySym: new Map<string, CatalystTag>([['FAR', { kind: 'news', side: 'long', reason: 'r', strength: 70 }]]),
        calibration: measured,
      }),
    )
    expect(far).toBeNull()
    const wrongWay = selectWildcard(
      inputs({
        nearMisses: [miss('WRONG', 27)],
        traceRows: twoGate('WRONG'),
        catalystBySym: new Map<string, CatalystTag>([['WRONG', { kind: 'news', side: 'short', reason: 'r', strength: 70 }]]),
        calibration: measured,
      }),
    )
    expect(wrongWay).toBeNull()
  })

  it('a rung only selects when the rungs above it are empty', () => {
    // one name qualifies at p1; another would qualify at p2 and p3
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('ONEGATE', 9), miss('CAT', 27)],
        traceRows: {
          'ONEGATE:long': row('entry-wait', 'long'),
          'CAT:long': row('entry-chase', 'long'),
          'CAT:short': row('dead-zone-core', 'short'),
        },
        catalystBySym: new Map<string, CatalystTag>([['CAT', { kind: 'news', side: 'long', reason: 'r', strength: 90 }]]),
      }),
    )
    expect(sel!.priority).toBe(1)
    expect(sel!.candidate.sym).toBe('ONEGATE')
  })
})

describe('selectWildcard — the exclusions', () => {
  it('a two-gate name never qualifies at priority 1', () => {
    const sel = selectWildcard(
      p1Inputs({
        nearMisses: [miss('AAA', 23)],
        traceRows: { 'AAA:long': row('dead-zone-core', 'long'), 'AAA:short': row('expected-move', 'short') },
        // no rung evidence and no catalyst ⇒ p2 would take it, so measure the rung
        calibration: { buckets: { 'large:long:green:25-40': { n: 9, hits: 3 } } },
      }),
    )
    expect(sel).toBeNull()
  })

  it('a crypto near miss is never pooled — the slot may not spend itself on a market the gate does not govern', () => {
    // Doubly refused, and the test proves BOTH layers: the code the containment
    // guard writes is ineligible, AND the symbol is refused whatever code it
    // carries (a trace row written before the guard shipped).
    expect(WILDCARD_INELIGIBLE_GATES.has('crypto-contained')).toBe(true)
    for (const gate of ['crypto-contained', 'dead-zone-core'] as GateCode[]) {
      const sel = selectWildcard(
        p1Inputs({
          nearMisses: [miss('BTC-USD', 40)], // the loudest read of the day
          traceRows: { 'BTC-USD:long': row(gate, 'long') },
        }),
      )
      expect(sel).toBeNull()
    }
    // …and the equity beside it is untouched: containment refuses a coin, not a lane
    expect(selectWildcard(p1Inputs({ nearMisses: [miss('BTC-USD', 40), miss('AAA', 23)], traceRows: { 'BTC-USD:long': row('dead-zone-core', 'long'), 'AAA:long': row('dead-zone-core', 'long') } }))?.candidate.sym).toBe('AAA')
  })

  it('a publication on the OTHER side is not a second gate — the blocked side stays rung-1 eligible', () => {
    // The mixed case the trace's per-key precedence promises: blocked long at the
    // dead zone, the dip long shadowed (called-shadow) or capped on the short key.
    for (const other of ['called-shadow', 'shadow-capped'] as const) {
      const sel = selectWildcard(
        p1Inputs({ traceRows: { 'AAA:long': row('dead-zone-core', 'long'), 'AAA:short': row(other, 'short') } }),
      )
      expect(sel?.priority).toBe(1)
      expect(sel?.candidate.gate).toBe('dead-zone-core')
    }
  })

  it('a name whose rows repeat ONE gate on both sides is still a single-gate refusal', () => {
    const sel = selectWildcard(p1Inputs({ traceRows: { 'AAA:long': row('dead-zone-core', 'long'), 'AAA:short': row('dead-zone-core', 'short') } }))
    expect(sel!.priority).toBe(1)
  })

  it('a published or shadow-capped row is never a wildcard, at any rung', () => {
    for (const gate of [...WILDCARD_INELIGIBLE_GATES]) {
      const sel = selectWildcard(
        p1Inputs({
          traceRows: { 'AAA:long': row(gate, 'long') },
          // leave every lower rung wide open — the exclusion must hold anyway
          catalystBySym: new Map<string, CatalystTag>([['AAA', { kind: 'news', side: 'long', reason: 'r', strength: 90 }]]),
          nearMisses: [miss('AAA', 27)],
        }),
      )
      expect(sel, gate).toBeNull()
    }
  })

  it('earnings names are NEVER the experiment — by ticker or by base symbol', () => {
    expect(selectWildcard(p1Inputs({ exclusions: { earningsSyms: new Set(['AAA']) } }))).toBeNull()
    const suffixed = p1Inputs({ nearMisses: [miss('AAA.L', 23)], traceRows: { 'AAA.L:long': row('dead-zone-core', 'long') } })
    expect(selectWildcard(suffixed)!.candidate.sym).toBe('AAA.L')
    expect(selectWildcard({ ...suffixed, exclusions: { earningsSyms: new Set(['AAA']) } })).toBeNull()
  })

  it('an unroutable short is SKIPPED, never shadowed — a routable one is taken', () => {
    const shortMiss = (sym: string) => ({ nearMisses: [miss(sym, -27)], traceRows: { [`${sym}:short`]: row('dead-zone-core', 'short') } })
    expect(selectWildcard(p1Inputs(shortMiss('NOROUTE')))).toBeNull()
    expect(selectWildcard(p1Inputs(shortMiss('ROUTED')))!.candidate.sym).toBe('ROUTED')
    // a long needs no ISA route: the reader buys the underlying
    expect(selectWildcard(p1Inputs({ nearMisses: [miss('NOROUTE', 27)], traceRows: { 'NOROUTE:long': row('dead-zone-core', 'long') } }))!.candidate.sym).toBe('NOROUTE')
  })

  it('a route ETP is never an underlying', () => {
    expect(selectWildcard(p1Inputs({ nearMisses: [miss('3SRT.L', 27)], traceRows: { '3SRT.L:long': row('dead-zone-core', 'long') } }))).toBeNull()
    expect(selectWildcard(p1Inputs({ nearMisses: [miss('SRTD', 27)], traceRows: { 'SRTD:long': row('dead-zone-core', 'long') } }))).toBeNull()
  })

  it('a name the board already carries — published on the key, or live on the chart — is not blocked', () => {
    expect(selectWildcard(p1Inputs({ exclusions: { publishedKeys: new Set(['AAA:long']) } }))).toBeNull()
    expect(selectWildcard(p1Inputs({ exclusions: { publishedKeys: new Set(['AAA:short']) } }))!.candidate.sym).toBe('AAA')
    expect(selectWildcard(p1Inputs({ exclusions: { liveSyms: new Set(['AAA']) } }))).toBeNull()
  })

  it('an outstanding wildcard blocks every rung — one slot, always', () => {
    expect(selectWildcard(p1Inputs({ outstanding: true }))).toBeNull()
  })

  it('no candidate ⇒ null, and a near miss with no trace row at all is no candidate', () => {
    expect(selectWildcard(inputs())).toBeNull()
    expect(selectWildcard(inputs({ nearMisses: [miss('GHOST', 23)] }))).toBeNull()
  })
})

describe('selectWildcard — determinism', () => {
  const busy = (): WildcardInputs =>
    inputs({
      nearMisses: [miss('AAA', 23), miss('BBB', 23), miss('CCC', -19, { capUsdM: 500 }), miss('ROUTED', -23, { capUsdM: 500 }), miss('DDD', 11)],
      traceRows: {
        'AAA:long': row('entry-chase', 'long'),
        'BBB:long': row('entry-chase', 'long'),
        'CCC:short': row('entry-wait', 'short'),
        'ROUTED:short': row('entry-chase', 'short'),
        'DDD:long': row('entry-chase', 'long'),
      },
      gateStats: [attrib('entry-chase', { cost: 1, saved: 1, n: 2, unchecked: 0 }), attrib('entry-wait', { cost: 1, saved: 1, n: 2, unchecked: 0 })],
    })

  it('two runs over one day pick the same wildcard', () => {
    expect(selectWildcard(busy())).toEqual(selectWildcard(busy()))
  })

  it('the pick survives a shuffled near-miss list and a re-keyed trace', () => {
    const a = selectWildcard(busy())
    const shuffled = busy()
    const b = selectWildcard({
      ...shuffled,
      nearMisses: [...shuffled.nearMisses].reverse(),
      traceRows: Object.fromEntries(Object.entries(shuffled.traceRows).reverse()),
      gateStats: [...shuffled.gateStats].reverse(),
    })
    expect(b).toEqual(a)
    // …and the tiebreak is the candidateSyms convention: |core| ties break by name
    expect(a!.candidate.sym).toBe('AAA')
  })

  it('reads its inputs and mutates none of them', () => {
    const before = busy()
    const snapshot = JSON.stringify({ nm: before.nearMisses, rows: before.traceRows, stats: before.gateStats, cal: before.calibration })
    selectWildcard(before)
    expect(JSON.stringify({ nm: before.nearMisses, rows: before.traceRows, stats: before.gateStats, cal: before.calibration })).toBe(snapshot)
  })
})

describe('the arithmetic the ladder stands on', () => {
  it('gateEvidenceN is sidedCost + sidedSaved + unchecked, and an unseen gate reads 0', () => {
    const stats = [attrib('dead-zone-core', { cost: 4, saved: 3, n: 7, unchecked: 5 })]
    expect(gateEvidenceN(stats, 'dead-zone-core')).toBe(12)
    expect(gateEvidenceN(stats, 'entry-wait')).toBe(0)
    expect(gateEvidenceN(stats, null)).toBe(0)
  })

  it('rungSizedN sums the cohort-tagged keys of one rung, in the sized slice only', () => {
    const buckets = {
      'large:long:green:25-40': { n: 10, hits: 4, shadowN: 4, shadowHits: 2 },
      'large:long:green:55-70': { n: 5, hits: 2 },
      'large:long:red:25-40': { n: 99, hits: 40 }, // another regime
      'small:long:green:25-40': { n: 99, hits: 40 }, // another cohort
      'long:green:25-40': { n: 99, hits: 40 }, // legacy cohortless
      'large:short:green:25-40': { n: 99, hits: 40 }, // the other side
    }
    expect(rungSizedN(buckets, 'large', 'long', 'green')).toBe(11)
    expect(rungSizedN(buckets, 'small', 'short', 'green')).toBe(0)
    // a corrupt blob reads as LESS evidence, never negative
    expect(rungSizedN({ 'large:long:green:25-40': { n: 2, hits: 1, shadowN: 9 } }, 'large', 'long', 'green')).toBe(0)
  })

  it('the wildcard is quarter size, and that is a cap below 1 — leverage is structurally unreachable', () => {
    expect(WILDCARD_SIZE_CAP).toBe(0.25)
    expect(WILDCARD_SIZE_CAP).toBeLessThan(1)
  })
})

describe('wildcardDisabled — the parity seam', () => {
  it('is OFF by default and reads only the exact opt-in string', () => {
    // The default is what production runs: nothing has to be set for the slot to
    // be live. The seam exists so the 3a and 3b parity walks stay claims about
    // the recorder and the regret machinery rather than about this lane, which
    // reads the one and writes into the other.
    expect(wildcardDisabled()).toBe(false)
    for (const v of ['off', 'OFF', 'false', '0', '1', 'on', '', 'offf']) {
      vi.stubEnv('WILDCARD', v)
      try {
        expect(`${v}:${wildcardDisabled()}`).toBe(`${v}:${v === 'off'}`)
      } finally {
        vi.unstubAllEnvs()
      }
    }
  })
})

describe('WILDCARD_INELIGIBLE_GATES tracks the publication set', () => {
  it('a name the slot has ALREADY taken can never be offered to it again', () => {
    // `called-wildcard` joined PUBLISHED_GATES (funnelTrace.ts) and this set is
    // built from that one, so the exclusion came for free — which is the whole
    // point of deriving it rather than re-listing it.
    expect(WILDCARD_INELIGIBLE_GATES.has('called-wildcard')).toBe(true)
  })
})

// A CAPACITY VERDICT IS NOT A SECOND OPINION (final review, minor 2). Rung 1
// asks "was this name blocked by exactly ONE thing an experiment could test".
// `diversity` and `slot-cut` answer a different question — the board had no room
// for another one of these — so counting one against a name retired a genuinely
// single-gate candidate on the strength of a verdict about the BOARD.
describe('the board’s capacity verdicts are not blocks on the name', () => {
  it('a diversity or slot-cut row on the other side leaves the blocked side rung-1 eligible', () => {
    for (const other of ['diversity', 'slot-cut'] as const) {
      const sel = selectWildcard(p1Inputs({ traceRows: { 'AAA:long': row('dead-zone-core', 'long'), 'AAA:short': row(other, 'short') } }))
      expect(sel?.priority, other).toBe(1)
      expect(sel?.candidate.gate, other).toBe('dead-zone-core')
    }
  })

  it('…and they are the ONLY additions — every other refusal still counts as a gate', () => {
    expect([...WILDCARD_CAPACITY_GATES].sort()).toEqual(['diversity', 'slot-cut'])
    expect([...WILDCARD_UNCOUNTED_GATES].sort()).toEqual([...new Set([...WILDCARD_INELIGIBLE_GATES, ...WILDCARD_CAPACITY_GATES])].sort())
    // an ordinary second refusal still retires the name (the guard above stands)
    expect(selectWildcard(p1Inputs({
      traceRows: { 'AAA:long': row('dead-zone-core', 'long'), 'AAA:short': row('expected-move', 'short') },
      calibration: { buckets: { 'large:long:green:25-40': { n: 9, hits: 3 } } },
    }))).toBeNull()
  })

  it('a candidate whose OWN row is a capacity verdict is STILL a rung-1 test of that verdict', () => {
    // the gate under test always counts as the one block: "no room" is a refusal a
    // causal outcome can price, and a row refused by it alone is a clean test of it
    for (const gate of ['diversity', 'slot-cut'] as const) {
      const sel = selectWildcard(p1Inputs({ traceRows: { 'AAA:long': row(gate, 'long') }, gateStats: [attrib(gate, { cost: 1, saved: 0, n: 1, unchecked: 2 })] }))
      expect(sel?.priority, gate).toBe(1)
      expect(sel?.candidate.gate, gate).toBe(gate)
    }
  })

  it('…and a capacity verdict plus a real refusal elsewhere is still two things standing against the name', () => {
    const sel = selectWildcard(
      p1Inputs({
        traceRows: { 'AAA:long': row('diversity', 'long'), 'AAA:short': row('expected-move', 'short') },
        gateStats: [attrib('diversity', { cost: 1, saved: 0, n: 1, unchecked: 2 })],
        calibration: { buckets: { 'large:long:green:25-40': { n: 9, hits: 3 } } }, // close rung 2
      }),
    )
    expect(sel).toBeNull()
  })
})

// THE EMPTY LEDGER MUST NOT FAKE A MEASUREMENT (final review, I-1). On a cold
// start every gate reads 0 because NOTHING has been priced — and the rung-1
// sentence said "<gate> has 0 priced outcomes and 0 unpriced", which is a claim
// about the named gate when it is really a claim about the ledger.
describe('the rung-1 hypothesis tells the truth about an empty ledger', () => {
  it('says the ledger has not matured, and never attributes a zero to the gate', () => {
    const sel = selectWildcard(p1Inputs({ gateStats: [] }))
    expect(sel!.priority).toBe(1)
    expect(sel!.hypothesis).toContain('the miss ledger has not matured its first day')
    expect(sel!.hypothesis).toContain('dead-zone-core')
    expect(sel!.hypothesis).toContain('23') // the composite it is spending
    expect(sel!.hypothesis).toContain('highest-conviction refusal')
    // the one thing it must never say: a per-gate measurement nobody made
    expect(sel!.hypothesis).not.toContain('priced outcome')
    expect(sel!.hypothesis).not.toContain('unpriced')
    expect(sel!.hypothesis).not.toMatch(/\b0 /)
  })

  it('…but a gate reading 0 inside a ledger that HAS evidence keeps the measured contrast', () => {
    // stats exist and this gate genuinely carries nothing — that IS a measurement,
    // and it is the contrast the thinness rung was built to spend the slot on.
    const sel = selectWildcard(
      inputs({
        nearMisses: [miss('AAA', 23)],
        traceRows: { 'AAA:long': row('entry-wait', 'long') },
        gateStats: [attrib('dead-zone-core', { cost: 40, saved: 10, n: 50, unchecked: 100 })],
      }),
    )
    expect(sel!.candidate.gate).toBe('entry-wait')
    expect(sel!.hypothesis).toBe(
      'entry-wait has 0 priced outcomes and 0 unpriced in the miss ledger, none of them causal; this takes the long it blocked, core read 23, for one real outcome with a stop.',
    )
    expect(sel!.hypothesis).not.toContain('has not matured')
  })
})
