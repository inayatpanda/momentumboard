import { describe, expect, it } from 'vitest'
import type { BoardSlice } from './apiViews'
import { comparisonStatus, independentEngineRead } from './socialComparison'

const engine = (overrides: Partial<BoardSlice> = {}): BoardSlice => ({
  board: null, intradayFlags: null, eventRadar: null, runStatus: null, riskState: null,
  referenceBase: null, yesterday: null,
  ...overrides,
})

describe('social claim versus independent engine comparison', () => {
  it('does not use the social-ignition sleeve as independent confirmation', () => {
    const data = engine({ engineLab: {
      version: 2, date: '2026-08-21', generatedAt: 1, mode: 'shadow', cadence: '', sleeves: [],
      observations: [{
        id: 'social', sleeve: 'social-ignition', sym: 'ABC', side: 'long', state: 'setup', score: 90,
        entry: 10, stop: 9, target: 12, detectedAt: 1, availableAt: 1, reasons: ['viral'], risks: [], dataGaps: [],
        metrics: {}, forecast: { definition: 'target-before-stop-v1', label: '', horizonSessions: 10, calibratedN: 0, provisional: true },
      }],
    } })
    const read = independentEngineRead('ABC', data)
    expect(read.source).toBe('none')
    expect(comparisonStatus(3, read)).toBe('unconfirmed')
  })

  it('calls opposite YouTube and established-engine directions a conflict', () => {
    const data = engine({ board: { date: '2026-08-21', generatedAt: 1, regime: 'risk-on', board: [{
      id: 'abc', sym: 'ABC', side: 'short', composite: -40, probability: 0.62, provisional: false, grade: 'B',
      expectedMovePct: -8, entry: 10, stop: 11, target: 8, capacityPct: 1, smallCap: false, earningsRisk: false,
      stage: null, note: 'price and volume are deteriorating', riskRung: 0, riskPct: 0, instrument: null, paperOnly: true, factors: {},
    }] } })
    const read = independentEngineRead('ABC', data)
    expect(read.side).toBe('short')
    expect(comparisonStatus(2, read)).toBe('conflict')
  })
})

