import { describe, expect, it } from 'vitest'
import { visibleCalls } from './TodaysCalls'
import { fmtRiskPct } from '../lib/format'
import type { EnginePrediction } from '../lib/api'

const row = (over: Partial<EnginePrediction> & { sym: string }): EnginePrediction =>
  ({
    id: `2026-08-11:${over.sym}:${over.side ?? 'long'}`,
    side: 'long',
    composite: 30,
    probability: 0.6,
    provisional: false,
    grade: 'B',
    expectedMovePct: 5,
    entry: 10,
    stop: 9,
    target: 12,
    capacityPct: 8,
    smallCap: false,
    earningsRisk: false,
    stage: 'trending',
    note: 'n',
    riskRung: 1,
    riskPct: 1,
    instrument: null,
    paperOnly: false,
    factors: {},
    ...over,
  }) as EnginePrediction

describe('visibleCalls — the six-row cut never silences a side', () => {
  it('trades lead, watch rows fill the rest', () => {
    const board = [row({ sym: 'W1', watchOnly: true }), row({ sym: 'T1' }), row({ sym: 'T2' })]
    expect(visibleCalls(board).map(p => p.sym)).toEqual(['T1', 'T2', 'W1'])
  })

  it('a lone SHORT keeps a slot even when six longs would fill the card', () => {
    const board = [
      ...Array.from({ length: 6 }, (_, i) => row({ sym: `L${i}` })),
      row({ sym: 'SHORTY', side: 'short', watchOnly: true }),
    ]
    const shown = visibleCalls(board)
    expect(shown).toHaveLength(6)
    expect(shown.some(p => p.side === 'short')).toBe(true) // the side is NOT cut away
    expect(shown.filter(p => p.side === 'long')).toHaveLength(5) // it cost the weakest long its slot
    expect(shown[0].sym).toBe('L0') // …and the strongest rows are untouched
  })

  it('mirrors: a lone LONG survives a board of shorts', () => {
    const board = [
      ...Array.from({ length: 8 }, (_, i) => row({ sym: `S${i}`, side: 'short' })),
      row({ sym: 'LONELY', side: 'long', watchOnly: true }),
    ]
    const shown = visibleCalls(board)
    expect(shown.some(p => p.side === 'long')).toBe(true)
    expect(shown).toHaveLength(6)
  })

  it('a one-sided board is left exactly as it was', () => {
    const board = Array.from({ length: 3 }, (_, i) => row({ sym: `L${i}` }))
    expect(visibleCalls(board).map(p => p.sym)).toEqual(['L0', 'L1', 'L2'])
  })

  it('an empty board stays empty', () => {
    expect(visibleCalls([])).toEqual([])
  })
})

describe('fmtRiskPct', () => {
  it('rounds a halved rung risk to 2dp instead of printing 0.625%', () => {
    expect(fmtRiskPct(0.625)).toBe('0.63')
    expect(fmtRiskPct(0.375)).toBe('0.38')
  })

  it('leaves clean numbers clean — no trailing zeros bolted on', () => {
    expect(fmtRiskPct(1)).toBe('1')
    expect(fmtRiskPct(1.5)).toBe('1.5')
    expect(fmtRiskPct(0)).toBe('0')
  })
})
