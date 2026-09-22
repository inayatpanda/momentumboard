import { describe, expect, it } from 'vitest'
import type { BoardSlice } from './apiViews'
import type { EnginePrediction } from './api'
import { boardChangeLine, decisionCockpitRead } from './decisionCockpit'

const call = (sym: string, side: 'long' | 'short', watchOnly = false): EnginePrediction => ({
  id: sym, sym, side, watchOnly, composite: 40, probability: 0.6, provisional: false, grade: 'B', expectedMovePct: 5,
  entry: 10, stop: 9, target: 12, capacityPct: 5, smallCap: false, earningsRisk: false, stage: null,
  note: '', riskRung: 1, riskPct: watchOnly ? 0 : 1, instrument: null, paperOnly: false, factors: {},
})

const data = (rows: EnginePrediction[]): BoardSlice => ({
  board: { date: '2026-08-21', generatedAt: 1_000, regime: 'green', board: rows },
  intradayFlags: null, eventRadar: null, runStatus: null, riskState: { rung: 1 }, referenceBase: 0.4, yesterday: null,
  decision: { priorDate: '2026-08-20', priorRows: [{ sym: 'AAA', side: 'short' }, { sym: 'OLD', side: 'long' }], liveGraded: 10, liveHits: 6, latestBrier: 0.21 },
})

describe('decision cockpit', () => {
  it('counts only takeable rows and compares with the prior completed run', () => {
    const read = decisionCockpitRead(data([call('AAA', 'long'), call('NEW', 'short'), call('WATCH', 'long', true)]), 1_600)!
    expect(read.sized).toBe(2)
    expect(read.flips).toEqual([{ sym: 'AAA', from: 'short', to: 'long' }])
    expect(read.newSymbols).toEqual(['NEW'])
    expect(read.removedSymbols).toEqual(['OLD'])
    expect(read.liveHitRate).toBe(0.6)
    expect(boardChangeLine(read)).toContain('AAA short→long')
  })

  it('marks an old or failed run honestly', () => {
    expect(decisionCockpitRead(data([]), 1_000 + 37 * 3600)?.freshness).toBe('stale')
    const failed = data([])
    failed.runStatus = { startedAt: 900, updatedAt: 1_100, phase: 'failed', failedAt: 1_100 }
    expect(decisionCockpitRead(failed, 1_200)?.freshness).toBe('failed')
  })
})
