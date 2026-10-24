// splitBoardRows (Task 14 review, Fix 3) — one fixture row per bucket, each
// must land in exactly its own bucket and nowhere else. Predicates are a
// verbatim extraction from src/screens2/Board.tsx:72-76; this file exists so
// Board, Today, and CountsRail share one taxonomy instead of three copies
// that can drift.

import { describe, expect, it } from 'vitest'
import { rowKind, splitBoardRows, unsizedReason, type BoardRowSplit } from './boardTaxonomy'
import type { EnginePrediction } from './api'

const FACTOR_NAMES = ['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as const
const emptyFactors = () => Object.fromEntries(FACTOR_NAMES.map(n => [n, { score: null, detail: '', weight: 0 }])) as EnginePrediction['factors']

function mkRow(overrides: Partial<EnginePrediction> = {}): EnginePrediction {
  return {
    id: 'r1',
    sym: 'TEST',
    side: 'long',
    composite: 50,
    probability: 0.5,
    provisional: false,
    grade: 'B',
    expectedMovePct: 3,
    entry: 10,
    stop: 9,
    target: 12,
    capacityPct: 100,
    smallCap: false,
    earningsRisk: false,
    stage: null,
    note: '',
    riskRung: 1,
    riskPct: 1,
    instrument: null,
    paperOnly: false,
    factors: emptyFactors(),
    ...overrides,
  }
}

describe('splitBoardRows', () => {
  const sizedRow = mkRow({ id: 'sized', watchOnly: false })
  const developingRow = mkRow({ id: 'developing', watchOnly: true, horizon: 'developing' })
  const watchRow = mkRow({ id: 'watch', watchOnly: true, horizon: 'week' })
  const observationRow = mkRow({ id: 'observation', watchOnly: true, observation: true })
  const nearMissRow = mkRow({ id: 'nearMiss', watchOnly: true, nearMiss: true })

  const rows = [sizedRow, developingRow, watchRow, observationRow, nearMissRow]
  const split = splitBoardRows(rows)

  it('sorts each fixture into its own bucket', () => {
    expect(split.sized).toEqual([sizedRow])
    expect(split.developing).toEqual([developingRow])
    expect(split.watch).toEqual([watchRow])
    expect(split.observations).toEqual([observationRow])
    expect(split.nearMisses).toEqual([nearMissRow])
  })

  it('lands each fixture row in exactly one bucket, never zero or two', () => {
    const buckets = Object.keys(split) as (keyof BoardRowSplit)[]
    for (const row of rows) {
      const memberships = buckets.filter(b => split[b].includes(row))
      expect(memberships, `${row.id} landed in [${memberships.join(', ')}]`).toHaveLength(1)
    }
  })
})

// The ROW-KIND LAW (Task 17 review, I7): CallCard and VerdictHero each carried
// their own copy of it and the copies had already drifted apart on the wording.
// One source, one set of sentences, both cards rewired onto it.
describe('rowKind', () => {
  it('names each shape, with nearMiss and observation beating a bare watchOnly', () => {
    expect(rowKind(mkRow())).toBe('sized-live')
    expect(rowKind(mkRow({ watchOnly: true }))).toBe('watch')
    expect(rowKind(mkRow({ watchOnly: true, observation: true }))).toBe('observation')
    expect(rowKind(mkRow({ watchOnly: true, nearMiss: true }))).toBe('near-miss')
    // a near miss beats an observation on the same row: it cleared no gate at all
    expect(rowKind(mkRow({ watchOnly: true, nearMiss: true, observation: true }))).toBe('near-miss')
  })

  it('refuses "sized-live" to a nearMiss/observation row even when watchOnly is missing from the wire', () => {
    expect(rowKind(mkRow({ nearMiss: true }))).toBe('near-miss')
    expect(rowKind(mkRow({ observation: true }))).toBe('observation')
  })
})

describe('unsizedReason', () => {
  it('gives each unsized kind its own sentence, and never a grade or a probability', () => {
    expect(unsizedReason('near-miss')).toBe('Close to qualifying, but did not pass the required checks. No trade plan or probability estimate.')
    expect(unsizedReason('observation')).toBe('Passed the checks, but no suitable ISA investment is available. Watching only.')
    expect(unsizedReason('watch')).toBe('Watching only. No trade plan yet.')
    expect(unsizedReason('watch', true)).toBe('Watching only. The estimated success rate is below its usual level.')
  })

  it('has nothing to say about a sized row — that one carries its grade instead', () => {
    expect(unsizedReason('sized-live')).toBe('')
  })
})
