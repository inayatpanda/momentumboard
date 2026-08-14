// missLedgerExamples (PWA rebuild, plan Task 5): the REGRET surface's read —
// missLedgerSummary's exact maths and ordering, but each top gate keeps its
// named examples ("dead-zone refused PLTR on 04 Aug; it ran +6.1pp") and the
// default topN widens. The summary itself stays byte-identical for the paper
// and the legacy panel.

import { describe, expect, it } from 'vitest'
import { missLedgerExamples, missLedgerSummary } from './missLedger'

const RAW = {
  gates: {
    'dead-zone-core': {
      cost: 2,
      costExcessSum: 15.3,
      saved: 1,
      savedExcessSum: 2.0,
      unchecked: 3,
      examples: [
        { date: '2026-08-04', sym: 'PLTR', side: 'long', excessPct: 6.1, gate: 'dead-zone-core' },
        { date: '2026-08-06', sym: 'NVDA', side: 'long', excessPct: 9.2, gate: 'dead-zone-core' },
      ],
      causal: { n: 4, hits: 1 },
    },
    'entry-chase': { cost: 1, costExcessSum: 3.0, saved: 0, unchecked: 0, examples: [] },
  },
  days: { '2026-08-10': { checked: 5, unchecked: 3, misses: 2 } },
}

describe('missLedgerExamples', () => {
  it('keeps the summary maths and attaches each gate’s named examples', () => {
    const r = missLedgerExamples(RAW)!
    const summary = missLedgerSummary(RAW, 8)!
    expect(r.days).toBe(summary.days)
    expect(r.unchecked).toBe(summary.unchecked)
    expect(r.note).toBe(summary.note)
    expect(r.topGates.map(g => g.gate)).toEqual(summary.topGates.map(g => g.gate))

    const dz = r.topGates.find(g => g.gate === 'dead-zone-core')!
    expect(dz.examples).toHaveLength(2)
    expect(dz.examples[0]).toMatchObject({ sym: 'PLTR', date: '2026-08-04', excessPct: 6.1 })
    expect(dz.causal).toEqual({ n: 4, hits: 1 })
    // cost/saved are EVENT COUNTS (CX-15) — the averages carry the magnitudes,
    // and both averages travel so the UI can never print a count with "pp" on it.
    expect(dz.cost).toBe(2)
    expect(dz.avgCostExcessPct).toBe(7.7) // 15.3 / 2, rounded to 1dp
    expect(dz.avgSavedExcessPct).toBe(2) // 2.0 / 1
    const ec = r.topGates.find(g => g.gate === 'entry-chase')!
    expect(ec.avgSavedExcessPct).toBeNull() // saved 0 → no average, never a zero
  })

  it('returns null on an empty ledger, exactly like the summary', () => {
    expect(missLedgerExamples({})).toBeNull()
  })
})
