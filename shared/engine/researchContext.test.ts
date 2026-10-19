import { describe, expect, it } from 'vitest'
import { withRecoveryContext, type RecoveryContext } from './researchContext'
import type { StrategyObservation } from './strategyLab'

const obs: StrategyObservation = {
  id: 'one', sleeve: 'quality-dip', sym: 'TEST', side: 'long', state: 'setup', score: 70,
  entry: 90, stop: 80, target: 110, detectedAt: 1, availableAt: 1,
  reasons: ['profitable business with stabilising price'], risks: [], dataGaps: [], metrics: {},
  forecast: { definition: 'target-before-stop-v1', label: 'recovery', horizonSessions: 63, calibratedN: 0, provisional: true },
}
const context: RecoveryContext = { worldTone: 'mixed', earningsRisk: false }

describe('recovery context', () => {
  it('waits for a selloff assessment even when the business and chart qualify', () => {
    expect(withRecoveryContext(obs, context).state).toBe('watch')
    expect(withRecoveryContext(obs, { ...context, news: { verdict: 'unclear', reason: 'no explanation' } }).state).toBe('watch')
    expect(withRecoveryContext(obs, { ...context, news: { verdict: 'transient', reason: 'broad sector selling' } }).state).toBe('setup')
  })
  it('stands aside on a structural news warning without rewriting probabilities', () => {
    const result = withRecoveryContext(obs, { ...context, news: { verdict: 'structural', reason: 'guidance withdrawn', via: 'llm' } })
    expect(result.state).toBe('avoid')
    expect(result.risks[0]).toContain('verify the original')
    expect(result.forecast).toEqual(obs.forecast)
    expect(result.score).toBe(obs.score)
  })
  it('does not promote unknown business health because markets are rising', () => {
    const result = withRecoveryContext({ ...obs, state: 'watch' }, { ...context, worldTone: 'risk-on', sector: { name: 'Technology', rs5: 3, rs21: 5, trend: 'in' } })
    expect(result.state).toBe('watch')
    expect(result.dataGaps).toContain('the cause of the selloff is not independently established')
  })
  it('flags conflicting sector and international tape, and upcoming earnings', () => {
    const result = withRecoveryContext(obs, { ...context, worldTone: 'risk-off', earningsRisk: true, sector: { name: 'Industrials', rs5: -2, rs21: -4, trend: 'out' } })
    expect(result.state).toBe('watch')
    expect(result.risks.join(' ')).toMatch(/earnings.*Industrials.*international/)
    expect(result.metrics.sectorRelative21Pct).toBe(-4)
  })
})
