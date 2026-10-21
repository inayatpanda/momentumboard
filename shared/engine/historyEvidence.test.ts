import { describe, expect, it } from 'vitest'
import { applyHistoryGate, withFinancialHistory, historyGate, HISTORY_CORE_MODEL, HISTORY_GATED_MODEL, HISTORY_VERSION, type HistoricalStudy, type HistoricalTrade } from './historyEvidence'
import type { StrategyObservation } from './strategyLab'

const now = Date.UTC(2026, 9, 21) / 1000
const prior: HistoricalTrade[] = Array.from({ length: 96 }, (_, i) => ({ sym: 'AAPL', signalAt: Date.UTC(2024 + Math.floor(i / 48), Math.floor(i % 48 / 4), 2 + i % 4 * 5) / 1000, endAt: Date.UTC(2024 + Math.floor(i / 48), Math.floor(i % 48 / 4), 5 + i % 4 * 5) / 1000, returnPct: 2, marketPct: 1, brier: .1, baselineBrier: .2 }))
const obs: StrategyObservation = { id: 'x', sym: 'AAPL', sleeve: 'short-horizon', side: 'long', state: 'setup', score: 70, entry: 100, stop: 95, target: 110, detectedAt: now, availableAt: now, reasons: [], risks: [], dataGaps: [], metrics: { historySessionN: 250 }, forecast: { definition: 'three-session-direction-v1', modelVersion: HISTORY_CORE_MODEL, label: 'test', horizonSessions: 3, calibratedN: 40, provisional: true } }
const study = (): HistoricalStudy => ({ version: HISTORY_VERSION, coreModel: HISTORY_CORE_MODEL, generatedAt: now - 60, dataThrough: now - 86400, dataFrom: 1, evaluationFrom: 1, symbols: ['AAPL'], missingSymbols: [], strategies: [], gates: [], liveGate: historyGate(prior, 2026), costBpsPerSide: 10, dataDigest: 'test', caveats: [], unavailable: [] })

describe('historical learning without future leakage', () => {
  it('adds comparable financial context without inventing probabilities or promoting setups', () => {
    const s = study(), recovery = { ...obs, sleeve: 'quality-dip' as const, state: 'watch' as const }
    s.financialCoverage = { version: 'sec-asof-annual-v1', symbols: ['AAPL'], unavailableSymbols: [], snapshots: 100 }
    s.strategies = [{ key: 'healthy-value-drop', label: 'test', horizon: 63, description: 'test', status: 'uncertain', stats: { n: 3, quarters: 2, meanReturnPct: 2, meanMarketPct: 1, excessPp: 1, beatRate: .5, brier: null, baselineBrier: null, uncertaintyPp: null }, years: [], cancelledN: 0, missingN: 0 }]
    const context = withFinancialHistory(recovery, s, now)
    expect(context.state).toBe('watch')
    expect(context.forecast).toEqual(recovery.forecast)
    expect(context.score).toBe(recovery.score)
    expect(context.metrics.historicalFinancialStatus).toBe('uncertain')
    expect(context.risks.at(-1)).toContain('does not validate')
    s.generatedAt = now - 46 * 86400
    expect(withFinancialHistory(recovery, s, now).metrics.historicalFinancialStatus).toBe('unavailable')
  })
  it('purges outcomes that cross the training boundary and ignores later winners', () => {
    const future = { ...prior[0], signalAt: Date.UTC(2026, 0, 2) / 1000, endAt: Date.UTC(2026, 0, 6) / 1000, returnPct: 10000 }
    const crossing = { ...future, signalAt: Date.UTC(2025, 11, 30) / 1000 }
    expect(historyGate([...prior, future, crossing], 2026)).toEqual(historyGate(prior, 2026))
    expect(historyGate(prior, 2026)).toMatchObject({ allow: true, n: 96, months: 24, excessPp: 1, brierSkill: .5 })
  })
  it('refuses profitable but badly calibrated forecasts and insufficient independent dates', () => {
    expect(historyGate(prior.map(t => ({ ...t, brier: .3 })), 2026).allow).toBe(false)
    expect(historyGate(prior.map(t => ({ ...t, returnPct: 0 })), 2026).allow).toBe(false)
    expect(historyGate(Array(100).fill(prior[0]), 2026).allow).toBe(false)
  })
  it('only vetoes setups, versions the new rule, and never upgrades a watch idea', () => {
    const s = study()
    expect(applyHistoryGate(obs, s, now)).toMatchObject({ state: 'setup', forecast: { modelVersion: HISTORY_GATED_MODEL } })
    expect(applyHistoryGate({ ...obs, state: 'watch' }, s, now).state).toBe('watch')
    s.liveGate.allow = false
    expect(applyHistoryGate(obs, s, now)).toMatchObject({ state: 'watch', metrics: { historyGate: 'not-supported' } })
    expect(obs.state).toBe('setup')
  })
  it.each(['stale', 'future', 'wrong-year', 'wrong-model', 'missing-symbol', 'outside-panel'])('fails closed for %s evidence', kind => {
    const s = study()
    if (kind === 'stale') s.generatedAt = now - 46 * 86400
    if (kind === 'future') s.generatedAt = now + 1
    if (kind === 'wrong-year') s.liveGate.year = 2025
    if (kind === 'wrong-model') s.coreModel = 'other'
    if (kind === 'missing-symbol') s.missingSymbols = ['AAPL']
    if (kind === 'outside-panel') s.symbols = ['MSFT']
    expect(applyHistoryGate(obs, s, now)).toMatchObject({ state: 'watch', metrics: { historyGate: 'unavailable' } })
  })
})
