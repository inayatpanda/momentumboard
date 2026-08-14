import { describe, expect, it } from 'vitest'
import {
  type AuditRow,
  accrualOf,
  auditCalibration,
  auditGates,
  auditHistory,
  auditIc,
  auditLadder,
  bucketKeyFor,
  evidenceSourceOf,
  isCryptoRow,
  readOnly,
  renderReport,
  rowsFromArtefact,
  setupKeyFor,
  AUDIT_KEYS,
  type TraceLike,
} from './crypto-audit'
import { initWeights, updateCalibration, updateIcStats, type CalibrationState } from '../shared/engine/calibration'
import { DEFAULT_WEIGHTS } from '../shared/engine/composite'
import type { FactorName, PredOutcome, Prediction } from '../shared/engine/types'

/** The audit reads the three fields every source carries; the real grader wants
 * the whole `PredOutcome`. Widened here, once, so the equality pins can drive
 * the actual `updateCalibration`/`updateIcStats` rather than a lookalike. */
const po = (o: AuditRow['outcome10']): PredOutcome => ({ ...o!, rawPct: o!.excessPct, spyPct: 0 })

const emptyCal = (): CalibrationState => ({ buckets: {}, setupBuckets: {}, brier: [], evidence: { seed: { n: 0, hits: 0 }, live: { n: 0, hits: 0 }, shadow: { n: 0, hits: 0 } } })

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  date: '2026-07-17',
  sym: 'ETH-USD',
  side: 'long',
  regime: 'amber',
  composite: 36.4,
  capUsdM: null,
  setup: 'continuation',
  accrual: 'sized',
  riskPct: 0,
  outcome10: { hit: false, excessPct: -2.5, stopped: false },
  ...over,
})

// ============================ THE EQUALITY PINS ============================
// The audit's whole claim is "this is what the grader did". It earns that by
// running the grader's own arithmetic, so the two must be pinned against each
// other on shared fixtures — an audit that derived its own keys would report a
// contamination that never happened, or miss one that did.

describe('bucketKeyFor / setupKeyFor / evidenceSourceOf — the grader’s own arithmetic, replayed', () => {
  const cases: { name: string; r: AuditRow }[] = [
    { name: 'cap-unknown crypto (the legacy cohortless tail)', r: row() },
    { name: 'a known large cap', r: row({ capUsdM: 900_000, composite: 62 }) },
    { name: 'a known small cap', r: row({ capUsdM: 400, composite: 88, side: 'short', regime: 'red' }) },
    { name: 'a shadow row with no setup', r: row({ setup: null, accrual: 'shadow', composite: 41.2 }) },
    { name: 'the band boundaries, low', r: row({ composite: 25 }) },
    { name: 'the band boundaries, high', r: row({ composite: 70, regime: 'green' }) },
    { name: 'a negative composite (short conviction)', r: row({ composite: -47, side: 'short' }) },
  ]
  for (const { name, r } of cases) {
    it(`agrees with updateCalibration for ${name}`, () => {
      const state = emptyCal()
      updateCalibration(state, { ...r, capUsdM: r.capUsdM, accrual: r.accrual ?? undefined, riskPct: r.riskPct ?? undefined, setup: r.setup }, po(r.outcome10))
      expect(Object.keys(state.buckets)).toEqual([bucketKeyFor(r).key])
      expect(Object.keys(state.setupBuckets!)).toEqual(setupKeyFor(r) ? [setupKeyFor(r)] : [])
      const booked = (['seed', 'live', 'shadow'] as const).filter(s => state.evidence![s].n > 0)
      expect(booked).toEqual([evidenceSourceOf(r)])
    })
  }

  it('books the same shadow sub-count the grader does, under the stamp AND under the legacy riskPct fallback', () => {
    for (const [r, expected] of [
      [row({ accrual: 'shadow' }), 'shadow'],
      [row({ accrual: 'sized', riskPct: 0 }), 'sized'], // the stamp WINS over riskPct 0 — the 3c partition's whole point
      [row({ accrual: null, riskPct: 0 }), 'shadow'],
      [row({ accrual: null, riskPct: 1.25 }), 'sized'],
      [row({ accrual: null, riskPct: null }), 'unstamped'],
    ] as const) {
      expect(accrualOf(r as AuditRow), JSON.stringify(r)).toBe(expected)
      const state = emptyCal()
      const pred = { ...(r as AuditRow), accrual: (r as AuditRow).accrual ?? undefined, riskPct: (r as AuditRow).riskPct ?? undefined }
      updateCalibration(state, pred, po((r as AuditRow).outcome10))
      const bucket = state.buckets[bucketKeyFor(r as AuditRow).key]
      // the grader stamps an explicit zero for a partitioned sized row and leaves
      // both counters absent for an unstamped one — the audit's own count must
      // agree with which of the three it was
      const audited = auditCalibration([r as AuditRow], state, 0)
      expect(audited.buckets[0].shadowN).toBe(bucket.shadowN ?? 0)
    }
  })
})

describe('auditIc — updateIcStats’ own admission test, replayed', () => {
  const factors = (spec: Partial<Record<FactorName, { score: number | null; silence?: boolean }>>) =>
    Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(f => [f, spec[f as FactorName] ?? { score: null }])) as Record<FactorName, { score: number | null; silence?: boolean }>

  it('reproduces the per-factor agree/disagree split the weights blob would have taken', () => {
    const rows = [
      row({ factors: factors({ momentum: { score: 40 }, technical: { score: -20 }, news: { score: 0 } }), outcome10: { hit: true, excessPct: 6.2, stopped: false } }),
      row({ date: '2026-07-20', side: 'short', factors: factors({ momentum: { score: 30 }, technical: { score: -55 } }), outcome10: { hit: false, excessPct: -3.4, stopped: false } }),
    ]
    const w = initWeights()
    for (const r of rows) updateIcStats(w, r as unknown as Prediction, po(r.outcome10))
    const audited = auditIc(rows, w)
    expect(audited.exact).toBe(true)
    for (const f of audited.factors) {
      expect(f.nAgree, `${f.name} agree`).toBe(w.ic[f.name as FactorName].nAgree)
      expect(f.nDisagree, `${f.name} disagree`).toBe(w.ic[f.name as FactorName].nDisagree)
      expect(f.sumAgree, `${f.name} Σagree`).toBeCloseTo(w.ic[f.name as FactorName].sumAgree, 5)
    }
    expect(audited.gradedSinceNudge.crypto).toBe(w.gradedSinceNudge)
  })

  it('honours the per-factor zero table and a reading’s own silence veto', () => {
    // `news` zero IS a reading (composite.ts) unless the reading vetoes it;
    // `momentum` zero is not, so it never books either way.
    const booked = auditIc([row({ factors: factors({ news: { score: 0 }, momentum: { score: 0 } }) })], null)
    expect(booked.factors.map(f => f.name)).toEqual(['news'])
    const vetoed = auditIc([row({ factors: factors({ news: { score: 0, silence: true } }) })], null)
    expect(vetoed.factors).toEqual([])
  })

  it('degrades to an explicit BOUND when the rows carry no factor vector', () => {
    const audited = auditIc([row(), row({ date: '2026-07-20' })], null)
    expect(audited.exact).toBe(false)
    expect(audited.factors).toEqual([])
    expect(audited.gradedSinceNudge.crypto).toBe(2)
    expect(audited.bound).toMatch(/Bounded, not exact/)
    expect(audited.bound).toMatch(/2 graded crypto row/)
  })
})

// ======================= WHAT COUNTS AS HAVING TAUGHT =======================

describe('auditHistory — an ungraded row taught nothing, and the census says so', () => {
  it('separates graded from ungraded and never counts an equity row as crypto', () => {
    const h = auditHistory(
      [row(), row({ date: '2026-07-28', outcome10: null }), row({ sym: 'AAPL', outcome10: { hit: true, excessPct: 3, stopped: false } }), row({ sym: 'BT-A.L' })],
      21,
      4,
    )
    expect(h.rows).toBe(4)
    expect(h.cryptoRows).toBe(2) // AAPL is equity; BT-A.L is BT Group, not a coin
    expect(h.graded).toBe(1)
    expect(h.ungraded).toBe(1)
    expect(h.symbols).toEqual([{ sym: 'ETH-USD', n: 2, first: '2026-07-17', last: '2026-07-28' }])
  })

  it('is not fooled by a lower-case symbol out of a stored blob', () => {
    expect(isCryptoRow(row({ sym: 'btc-usd' }))).toBe(true)
  })
})

describe('rowsFromArtefact — the walk’s OWN grade, never the harness’s recomputation', () => {
  const artefact = (ledger: Record<string, unknown>[]) => ({ from: 'a', to: 'b', days: [{ date: '2026-07-28', ledger }] })

  it('prefers storedOutcome10 even when it is null — null means the engine never graded it', () => {
    const { rows } = rowsFromArtefact(
      artefact([{ sym: 'ETH-USD', side: 'long', regime: 'amber', composite: 38.1, storedOutcome10: null, outcome10: { hit: false, excessPct: -3, stopped: false } }]),
    )
    expect(rows[0].outcome10).toBeNull()
  })

  it('falls back to outcome10 only when the key is absent entirely (a pre-3b artefact)', () => {
    const { rows } = rowsFromArtefact(artefact([{ sym: 'ETH-USD', side: 'long', regime: 'amber', composite: 38.1, outcome10: { hit: true, excessPct: 4, stopped: false } }]))
    expect(rows[0].outcome10).toEqual({ hit: true, excessPct: 4, stopped: false })
  })

  it('counts dates that published nothing separately from dates it never saw', () => {
    const { rows, dates, datesWithRows } = rowsFromArtefact({ days: [{ date: 'a', ledger: [] }, { date: 'b', ledger: [{ sym: 'AAPL', side: 'long', regime: 'green', composite: 50 }] }] })
    expect([rows.length, dates, datesWithRows]).toEqual([1, 2, 1])
  })
})

// ============================== THE LADDER ==============================

describe('auditLadder — only the rows engine.ts lets into allOutcomes', () => {
  it('excludes shadow, watch-only and wildcard rows and names the cohort each slot fell in', () => {
    const l = auditLadder([
      row({ riskPct: 0.5 }),
      row({ date: '2026-07-18', watchOnly: true }),
      row({ date: '2026-07-19', shadow: true }),
      row({ date: '2026-07-21', wildcard: true }),
      row({ date: '2026-07-22', capUsdM: 900_000, outcome10: { hit: true, excessPct: 2, stopped: false } }),
    ])
    expect(l.inStream).toBe(2)
    expect(l.hits).toBe(1)
    expect(l.byCohort).toEqual({ unknown: 1, large: 1 })
    expect(l.bound).toMatch(/OCCUPIED A SLOT/)
  })
})

// ============================ THE GATE LEDGER ============================

describe('auditGates — the upper bound from the trace, the lower bound from the ledger', () => {
  const traces: TraceLike[] = [
    { date: '2026-07-14', rows: { 'ETH-USD:long': { gate: 'dead-zone-core' }, 'AAPL:long': { gate: 'dead-zone-core' } } },
    { date: '2026-07-23', rows: { 'ETH-USD:long': { gate: 'called-half' } } }, // a publication — MISS_SKIP_GATES
    { date: '2026-08-11', rows: { 'ETH-USD:long': { gate: 'slot-cut' } } }, // never matured
  ]
  const measured = new Set(['2026-07-14', '2026-07-23'])

  it('counts only crypto refusals on days the ledger actually measured, and says what it skipped', () => {
    const g = auditGates(traces, measured, null, null)
    expect(g.candidates).toEqual([{ date: '2026-07-14', key: 'ETH-USD:long', gate: 'dead-zone-core', priced: 'unknown', excessPct: null, charge: 'unknown' }])
    expect(g.byGate).toEqual({ 'dead-zone-core': 1 })
    expect(g.skippedPublished).toBe(1)
    expect(g.skippedUnmatured).toBe(1)
    expect(g.provenCharges).toEqual({ cost: 0, saved: 0, neither: 0 })
  })

  // The sharpening that turns an upper bound into a fact: a gate whose lifetime
  // `unchecked` is ZERO never left a refusal unpriced, so it did not leave THIS
  // one unpriced — and the refused side's own graded excess then says which
  // column the charge landed in, against the same ±5pp band the miss walk uses.
  it('proves the charge where the gate never left a row unpriced, and classifies it', () => {
    const ledger = { gates: { 'dead-zone-core': { unchecked: 0 }, 'slot-cut': { unchecked: 9 } } }
    const graded = [
      row({ date: '2026-07-14', outcome10: { hit: false, excessPct: -7.5, stopped: false } }),
      row({ date: '2026-08-11', outcome10: { hit: false, excessPct: -9, stopped: false } }),
    ]
    const g = auditGates(traces, new Set(['2026-07-14', '2026-08-11']), ledger, null, graded)
    expect(g.candidates).toEqual([
      { date: '2026-07-14', key: 'ETH-USD:long', gate: 'dead-zone-core', priced: 'proven', excessPct: -7.5, charge: 'saved' },
      { date: '2026-08-11', key: 'ETH-USD:long', gate: 'slot-cut', priced: 'unknown', excessPct: -9, charge: 'saved' },
    ])
    // only the PROVEN one is claimed — the budgeted gate's charge stays a bound
    expect(g.provenCharges).toEqual({ cost: 0, saved: 1, neither: 0 })
  })

  it('classifies a refusal inside the ±5pp band as neither — it still moved the gate’s checked population', () => {
    const g = auditGates(
      [{ date: '2026-07-14', rows: { 'ETH-USD:long': { gate: 'called-watch' } } }],
      new Set(['2026-07-14']),
      { gates: { 'called-watch': { unchecked: 0 } } },
      null,
      [row({ date: '2026-07-14', outcome10: { hit: false, excessPct: 0.8, stopped: false } })],
    )
    expect(g.candidates[0]).toMatchObject({ priced: 'proven', excessPct: 0.8, charge: 'neither' })
    expect(g.provenCharges).toEqual({ cost: 0, saved: 0, neither: 1 })
  })

  it('reads a cost event off a refusal that ran the refused way', () => {
    const g = auditGates(
      [{ date: '2026-07-14', rows: { 'ETH-USD:long': { gate: 'entry-wait' } } }],
      new Set(['2026-07-14']),
      { gates: { 'entry-wait': { unchecked: 0 } } },
      null,
      [row({ date: '2026-07-14', outcome10: { hit: true, excessPct: 7.8, stopped: false } })],
    )
    expect(g.provenCharges).toEqual({ cost: 1, saved: 0, neither: 0 })
  })

  it('surfaces a crypto row still visible in the stored ledger’s examples as the PROVEN lower bound', () => {
    const ledger = {
      gates: {
        'called-watch': { examples: [{ date: '2026-07-27', sym: 'ETH-USD', side: 'long', excessPct: -6.4 }, { date: '2026-07-27', sym: 'MU', side: 'short', excessPct: 11.4 }] },
      },
    }
    const g = auditGates([], measured, ledger, null)
    expect(g.provenExamples).toEqual([{ gate: 'called-watch', date: '2026-07-27', sym: 'ETH-USD', side: 'long', excessPct: -6.4 }])
  })

  it('distinguishes "contaminated evidence" from "contaminated evidence that moved a constant"', () => {
    expect(auditGates([], measured, null, null).gateStateMoves).toBeNull()
    const moved = auditGates([], measured, null, { gates: { deadZone: { history: [{ date: '2026-08-01', from: 25, to: 22.5 }] } } })
    expect(moved.gateStateMoves).toEqual([{ gate: 'deadZone', date: '2026-08-01', from: 25, to: 22.5, why: undefined }])
  })
})

// ============================== READ-ONLY ==============================

describe('readOnly — the audit is read-only as a property of the object, not of my care', () => {
  it('forwards reads and rejects every write', async () => {
    const backing = { read: async <T,>(k: string) => ({ k }) as T }
    const store = readOnly(backing)
    expect(await store.read('engine-calibration')).toEqual({ k: 'engine-calibration' })
    await expect(store.write('engine-calibration')).rejects.toThrow(/READ-ONLY/)
  })

  it('names every key it will ever touch, and they are the engine’s own', () => {
    expect(Object.values(AUDIT_KEYS).filter(v => typeof v === 'string').sort()).toEqual([
      'engine-calibration',
      'engine-weights',
      'funnel-trace-index',
      'gate-state',
      'miss-ledger',
      'predictions-index',
    ])
    expect(AUDIT_KEYS.predictions('2026-07-14')).toBe('predictions:2026-07-14')
    expect(AUDIT_KEYS.trace('2026-07-14')).toBe('funnel-trace:2026-07-14')
  })
})

// ============================== THE REPORT ==============================

describe('renderReport — the bound is on the page, not in a footnote', () => {
  it('prints the increments AND the reason they cannot be un-attributed', () => {
    const rows = [row(), row({ date: '2026-07-20', outcome10: { hit: true, excessPct: 1, stopped: false } })]
    const cal = emptyCal()
    cal.buckets['long:amber:25-40'] = { n: 1022, hits: 443 }
    const text = renderReport({
      source: { kind: 'artefact', ref: 'fixture.json', window: { from: '2026-07-14', to: '2026-08-11' } },
      at: '2026-08-14T00:00:00.000Z',
      history: auditHistory(rows, 21, 21),
      calibration: auditCalibration(rows, cal, 10),
      ic: auditIc(rows, null),
      ladder: auditLadder(rows),
      gates: auditGates([], new Set(), null, null),
      notes: ['a note'],
    })
    expect(text).toContain('long:amber:25-40')
    expect(text).toMatch(/\+2n\/\+1h/)
    expect(text).toMatch(/crypto share\s+0\.20%/)
    expect(text).toMatch(/NOT a subtraction/)
    expect(text).toMatch(/cannot be un-attributed/)
    expect(text).toContain('a note')
  })

  it('says so plainly when nothing is contaminated at all', () => {
    const text = renderReport({
      source: { kind: 'live', ref: 'store=d1', window: { from: 'a', to: 'b' } },
      at: 'now',
      history: auditHistory([row({ sym: 'AAPL' })], 1, 1),
      calibration: auditCalibration([], null, 0),
      ic: auditIc([], null),
      ladder: auditLadder([]),
      gates: auditGates([], new Set(), null, null),
      notes: [],
    })
    expect(text).toContain('crypto 0 (0.00%)')
    expect(text).toContain('no crypto row ever booked a bucket.')
  })
})

// ================== THE ARTEFACT OF RECORD, END TO END ==================
// The shape the local run reported, pinned as a fixture so a future change to
// either the projection or the arithmetic has to explain itself against the
// numbers that went into the ship evidence.

describe('the 2026-07-14 … 08-11 acceptance window, as the walk artefact holds it', () => {
  const days = [
    { d: '2026-07-17', c: 36.4, s: 'continuation', r: 0, o: { hit: false, excessPct: 0.8, stopped: false } },
    { d: '2026-07-20', c: 31.4, s: 'continuation', r: 0, o: { hit: true, excessPct: 1, stopped: false } },
    { d: '2026-07-22', c: 36.6, s: 'continuation', r: 0, o: { hit: false, excessPct: -7.5, stopped: false } },
    { d: '2026-07-23', c: 38.4, s: 'continuation', r: 0.5, o: { hit: false, excessPct: -6.6, stopped: false } },
    { d: '2026-07-27', c: 27.7, s: 'continuation', r: 0, o: { hit: false, excessPct: -6.4, stopped: true } },
    { d: '2026-07-28', c: 38.1, s: 'reversal', r: 0.5, o: null },
  ]
  const run = {
    from: '2026-07-14',
    to: '2026-08-11',
    days: days.map(x => ({
      date: x.d,
      ledger: [{ sym: 'ETH-USD', side: 'long', regime: 'amber', composite: x.c, setup: x.s, accrual: 'sized', riskPct: x.r, watchOnly: x.r === 0, storedOutcome10: x.o }],
    })),
  }

  it('reports five taught rows, one hit, and the two buckets they landed in', () => {
    const { rows } = rowsFromArtefact(run)
    const graded = rows.filter(isCryptoRow).filter(r => r.outcome10 != null)
    expect(graded).toHaveLength(5)
    const cal: CalibrationState = { ...emptyCal(), buckets: { 'long:amber:25-40': { n: 1022, hits: 443 } }, setupBuckets: { 'continuation:long:25-40': { n: 1209, hits: 500 } } }
    const a = auditCalibration(graded, cal, 10)
    expect(a.buckets).toEqual([{ key: 'long:amber:25-40', n: 5, hits: 1, shadowN: 0, currentN: 1022, currentHits: 443, sharePct: 0.49 }])
    expect(a.setupBuckets).toEqual([{ key: 'continuation:long:25-40', n: 5, hits: 1, shadowN: 0, currentN: 1209, currentHits: 500, sharePct: 0.41 }])
    // the 07-28 reversal never graded, so the reversal family is UNTOUCHED —
    // the one row a census reading the recomputed outcome would have wronged
    expect(a.setupBuckets.some(b => b.key.startsWith('reversal'))).toBe(false)
  })

  it('puts exactly one crypto outcome into the risk ladder’s deciding window', () => {
    const { rows } = rowsFromArtefact(run)
    const l = auditLadder(rows.filter(isCryptoRow).filter(r => r.outcome10 != null))
    expect(l.inStream).toBe(1)
    expect(l.hits).toBe(0)
    expect(l.rows[0]).toMatchObject({ date: '2026-07-23', sym: 'ETH-USD', hit: false, excessPct: -6.6, cohort: 'unknown' })
  })
})
