import { describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import { REPORT_TREND_METRICS, type FinancialReportPoint } from '../reportTrends'
import { emptyBusinessHealth, type BusinessHealthSnapshot } from '../businessHealth'
import { appendSocialHistory, buildEngineLab, calibrateLabObservations, gradeStrategyObservation, qualityDipObservations, shortHorizonObservations, socialIgnitionObservations, completedLabCandles, compatibleLabRecords, LAB_EXECUTION_VERSION, type StrategyLabRecord, type StrategyObservation } from './strategyLab'

const DAY = 86_400
const T0 = Date.parse('2026-01-01T14:00:00Z') / 1000
const after = (cs: Candle[]) => cs.at(-1)!.t + DAY
const candles = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }))

describe('visible strategy lab', () => {
  it('builds a three-session analogue forecast with explicit up/down odds and range', () => {
    const trend = candles(Array.from({ length: 180 }, (_, i) => 100 * Math.pow(1.003, i)))
    const [goog] = shortHorizonObservations([{ sym: 'GOOG', candles: trend }], after(trend), ['GOOG'])
    expect(goog.sym).toBe('GOOG')
    expect(goog.forecast.definition).toBe('three-session-direction-v1')
    expect(goog.forecast.horizonSessions).toBe(3)
    expect(goog.forecast.probabilityUp).toBeGreaterThan(0.9)
    expect(goog.forecast.probabilityDown).toBeLessThan(0.1)
    expect(goog.forecast.expectedLowPct).not.toBeNull()
    expect(goog.side).toBe('long')
    expect(goog.state).toBe('setup')
  })

  it('shows no edge instead of forcing a direction when the tape is flat', () => {
    const cs = candles(Array(180).fill(100))
    const [googl] = shortHorizonObservations([{ sym: 'GOOGL', candles: cs }], after(cs), ['GOOGL'])
    expect(googl.side).toBe('neutral')
    expect(googl.state).toBe('watch')
    expect(googl.stop).toBeNull()
    expect((googl.forecast.probabilityUp ?? 0) + (googl.forecast.probabilityDown ?? 0) + (googl.forecast.probabilityFlat ?? 0)).toBeCloseTo(1, 1)
    expect(googl.risks.join(' ')).toMatch(/neither direction clears/)
  })

  it('does not infer business health from a large-cap or index-membership proxy', () => {
    const spy = candles(Array.from({ length: 90 }, (_, i) => 100 + i * 0.1))
    const series = [...Array.from({ length: 70 }, (_, i) => 100 + i * 0.3), ...Array.from({ length: 17 }, (_, i) => 121 - i * 1.1), 103, 101, 104]
    const cs = candles(series)
    const rows = qualityDipObservations([{ sym: 'GOOD', candles: cs, qualityProxy: true, capUsdM: 25_000 }], spy, after(cs))
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('watch')
    expect(rows[0].metrics.financialHealth).toBe('unknown')
    expect(rows[0].forecast.probabilityTarget).toBeNull()
    expect(rows[0].dataGaps.length).toBeGreaterThan(0)
  })

  it('requires cross-platform acceleration for a social setup and flags extreme promotion risk', () => {
    const history = [{ observedAt: 100, rows: [{ sym: 'EARLY', redditMentions: 10, sources: 1 }] }]
    const [early, risky] = socialIgnitionObservations([
      { sym: 'EARLY', redditMentions: 25, surgeMultiple: 2.5, sources: 2, stocktwits: true, channelNet: 2, capUsdM: 2_000 },
      { sym: 'RISKY', redditMentions: 100, surgeMultiple: 8, sources: 1, stocktwits: false, channelNet: 1, capUsdM: 100 },
    ], history, 200)
    expect(early.state).toBe('setup')
    expect(early.metrics.scanVelocity).toBe(2.5)
    expect(risky.state).toBe('avoid')
    expect(risky.risks.join(' ')).toMatch(/pump risk/)
  })

  it('publishes sleeve status and retains bounded timestamped pulse history', () => {
    let history = appendSocialHistory([], [{ sym: 'ABC', redditMentions: 4, surgeMultiple: 1, sources: 1, stocktwits: false, channelNet: null }], 100)
    history = appendSocialHistory(history, [{ sym: 'ABC', redditMentions: 8, surgeMultiple: 2, sources: 2, stocktwits: true, channelNet: 1 }], 200)
    expect(history.map(h => h.observedAt)).toEqual([100, 200])
    const lab = buildEngineLab({ date: '2026-08-21', nowSec: 200, quality: [], social: [], compositeEvidenceN: 78 })
    expect(lab.sleeves.find(s => s.key === 'composite-control')?.evidenceN).toBe(78)
    expect(lab.sleeves.find(s => s.key === 'macro-event')?.status).toBe('collecting')
  })

  it('grades target-before-stop from the next open and resolves an ambiguous bar stop-first', () => {
    const obs: StrategyObservation = {
      id: 'q', sleeve: 'quality-dip', sym: 'Q', side: 'long', state: 'setup', score: 80,
      entry: 100, stop: 95, target: 110, detectedAt: T0 + 12 * 3600, availableAt: T0 + 12 * 3600, reasons: [], risks: [], dataGaps: [], metrics: {},
      forecast: { definition: 'target-before-stop-v1', label: 'test', horizonSessions: 2, calibratedN: 0, provisional: true },
    }
    const cs = candles([100, 100, 100])
    cs[1] = { ...cs[1], o: 100, h: 111, l: 94 }
    expect(gradeStrategyObservation(obs, cs)?.firstBarrier).toBe('stop')

    const records = Array.from({ length: 15 }, (_, i) => ({ ...obs, id: `q${i}`, availableAt: obs.availableAt - (20 - i) * 30 * DAY, outcome: { entry: 100, exit: i < 9 ? 110 : 95, firstBarrier: i < 9 ? 'target' as const : 'stop' as const, targetHit: i < 9, stopHit: i >= 9, returnPct: i < 9 ? 10 : -5, sessions: 2, executionVersion: LAB_EXECUTION_VERSION, executionStatus: 'filled' as const } }))
    const calibrated = calibrateLabObservations([obs], records)[0]
    expect(calibrated.forecast.calibratedN).toBe(15)
    expect(calibrated.forecast.probabilityTarget).not.toBeNull()
  })

  it('grades a no-edge short-horizon forecast after three full sessions', () => {
    const obs: StrategyObservation = {
      id: 'short', sleeve: 'short-horizon', sym: 'GOOG', side: 'neutral', state: 'watch', score: 50,
      entry: 100, stop: null, target: null, detectedAt: T0 + 12 * 3600, availableAt: T0 + 12 * 3600, reasons: [], risks: [], dataGaps: [], metrics: {},
      forecast: { definition: 'three-session-direction-v1', label: 'test', horizonSessions: 3, probabilityUp: 0.55, probabilityDown: 0.45, calibratedN: 60, provisional: true },
    }
    const cs = candles([100, 101, 102, 104])
    const outcome = gradeStrategyObservation(obs, cs)
    expect(outcome?.finishedHigher).toBe(true)
    expect(outcome?.directionHit).toBe(true)
    expect(outcome?.sessions).toBe(3)
    expect(outcome?.firstBarrier).toBe('none')
  })

  it('keeps analogue evidence separate from forward accuracy and Brier calibration', () => {
    const cs = candles(Array.from({ length: 180 }, (_, i) => 100 * Math.pow(1.003, i)))
    const [obs] = shortHorizonObservations([{ sym: 'GOOG', candles: cs }], after(cs), ['GOOG'])
    const records = Array.from({ length: 10 }, (_, i) => ({
      ...obs,
      id: `short${i}`,
      availableAt: obs.availableAt - (20 - i) * 4 * DAY,
      outcome: { entry: 100, exit: 102, firstBarrier: 'none' as const, targetHit: false, stopHit: false, returnPct: 0, sessions: 3, closeReturnPct: 2, finishedHigher: true, directionHit: true },
    }))
    const calibrated = calibrateLabObservations([obs], records)[0]
    expect(calibrated.forecast.calibratedN).toBe(obs.forecast.calibratedN)
    expect(calibrated.forecast.calibratedN).toBeLessThanOrEqual(Math.ceil((180 - 23) / 3))
    expect(calibrated.forecast.liveN).toBe(10)
    expect(calibrated.forecast.directionAccuracy).not.toBeNull()
    expect(calibrated.forecast.brierScore).not.toBeNull()
  })
})

const observation = (over: Partial<StrategyObservation> = {}): StrategyObservation => ({
  id: 'forecast', sleeve: 'short-horizon', sym: 'TEST', side: 'long', state: 'setup', score: 70,
  entry: 100, stop: 95, target: 110, detectedAt: T0 + 12 * 3600, availableAt: T0 + 12 * 3600,
  reasons: [], risks: [], dataGaps: [], metrics: {},
  forecast: { definition: 'three-session-direction-v1', modelVersion: 'test-model', label: 'test',
    horizonSessions: 3, probabilityUp: 0.7, probabilityDown: 0.25, probabilityFlat: 0.05,
    baselineProbabilityUp: 0.5, calibratedN: 30, provisional: true },
  ...over,
})

const matured = (obs: StrategyObservation, n = 20): StrategyLabRecord[] => Array.from({ length: n }, (_, i) => ({
  ...obs, id: `campaign-${i}`, availableAt: obs.availableAt - (n - i) * 4 * DAY,
  outcome: { entry: 100, exit: 110, firstBarrier: 'target', targetHit: true, stopHit: false,
    returnPct: 9.8, sessions: 3, closeReturnPct: 10, finishedHigher: true, directionHit: true,
    executionVersion: LAB_EXECUTION_VERSION, executionStatus: 'filled',
    horizonEndAt: obs.availableAt - (n - i) * 4 * DAY + 3 * DAY },
}))

describe('point-in-time analogue evidence', () => {
  it('does not count three overlapping windows as three independent analogues', () => {
    const cs = candles(Array.from({ length: 180 }, (_, i) => 100 * Math.pow(1.003, i)))
    const [obs] = shortHorizonObservations([{ sym: 'TEST', candles: cs }], after(cs))
    expect(obs.forecast.calibratedN).toBeGreaterThanOrEqual(20)
    expect(obs.forecast.calibratedN).toBeLessThanOrEqual(Math.ceil((cs.length - 23) / 3))
    expect(obs.forecast.probabilityUpInterval![0]).toBeLessThan(obs.forecast.probabilityUp!)
    expect(obs.forecast.probabilityUpInterval![1]).toBe(1)
    expect(obs.forecast.probabilityBasis).toBe('historical-analogues')
    expect(obs.forecast.label).toContain('20th–80th')
  })

  it('does not change a forecast when future, partial or duplicate bars are supplied', () => {
    const cs = candles(Array.from({ length: 180 }, (_, i) => 100 + Math.sin(i) * 2 + i * 0.2))
    const now = after(cs)
    const [base] = shortHorizonObservations([{ sym: 'TEST', candles: cs }], now)
    const contaminated = [...cs, cs[10], { ...cs.at(-1)!, t: now, c: 1000, h: 1100 },
      { ...cs.at(-1)!, t: now + DAY, c: 2000, h: 2100 }].reverse()
    const [candidate] = shortHorizonObservations([{ sym: 'TEST', candles: contaminated }], now)
    expect(candidate.forecast).toEqual(base.forecast)
    expect(candidate.metrics).toEqual(base.metrics)
    expect(candidate.entry).toBe(base.entry)
  })

  it('abstains with a useful reason on stale or invalid required-symbol data', () => {
    const cs = candles(Array(180).fill(100))
    const [stale] = shortHorizonObservations([{ sym: 'GOOG', candles: cs }], after(cs) + 8 * DAY, ['GOOG'])
    expect(stale.state).toBe('collecting')
    expect(stale.entry).toBeNull()
    expect(stale.forecast.probabilityUp).toBeUndefined()
    expect(stale.reasons.join(' ')).toContain('seven calendar days')
    const invalid = cs.map((c, i) => i === 100 ? { ...c, h: 90 } : c)
    const [broken] = shortHorizonObservations([{ sym: 'GOOG', candles: invalid }], after(cs), ['GOOG'])
    expect(broken.state).toBe('collecting')
    expect(broken.reasons.join(' ')).toContain('invalid OHLC')
  })

  it('keeps crypto daily bars incomplete until midnight', () => {
    const cs = candles([100, 101])
    const afterEquityClose = Math.floor(cs[1].t / DAY) * DAY + 23 * 3600
    expect(completedLabCandles(cs, afterEquityClose, 'BTC-USD')).toHaveLength(1)
    expect(completedLabCandles(cs, afterEquityClose, 'GOOG')).toHaveLength(2)
  })
})

describe('honest forecast grading', () => {
  it('charges adverse slippage on both sides of a break-even trade', () => {
    const result = gradeStrategyObservation(observation(), candles([100, 100, 100, 100]))!
    expect(result.executionStatus).toBe('filled')
    expect(result.entry).toBe(100.1)
    expect(result.exit).toBe(99.9)
    expect(result.returnPct).toBeCloseTo(-0.1998, 4)
  })

  it('fills an overnight stop at the worse open instead of the published stop', () => {
    const cs = candles([100, 100, 90, 92])
    const result = gradeStrategyObservation(observation(), cs)!
    expect(result.firstBarrier).toBe('stop')
    expect(result.exit).toBe(89.91)
    expect(result.returnPct).toBeLessThan(-10)
  })

  it('recognises an opening target gap before a later intrabar stop', () => {
    const cs = candles([100, 100, 112, 112])
    cs[2].l = 90
    const result = gradeStrategyObservation(observation(), cs)!
    expect(result.firstBarrier).toBe('target')
    expect(result.exit).toBe(109.89)
  })

  it('measures short P&L on initial capital instead of inflating a 20% fall to 25%', () => {
    const obs = observation({ side: 'short', stop: 110, target: 60 })
    const result = gradeStrategyObservation(obs, candles([100, 100, 90, 80]))!
    expect(result.firstBarrier).toBe('none')
    expect(result.returnPct).toBeCloseTo((99.9 - 80.08) / 99.9 * 100, 4)
    expect(result.returnPct).toBeLessThan(20)
  })

  it('grades flat as a third class and leaves tied probabilities uncalled', () => {
    const obs = observation({ side: 'neutral', stop: null, target: null })
    const flat = { ...obs, forecast: { ...obs.forecast, probabilityUp: 0.05, probabilityDown: 0.05, probabilityFlat: 0.9 } }
    expect(gradeStrategyObservation(flat, candles([100, 100, 100, 100]))?.directionHit).toBe(true)
    const tied = { ...obs, forecast: { ...obs.forecast, probabilityUp: 0.5, probabilityDown: 0.5, probabilityFlat: 0 } }
    expect(gradeStrategyObservation(tied, candles([100, 101, 102, 103]))?.directionHit).toBeUndefined()
  })

  it('waits for completed sessions and refuses truncated or invalid tapes', () => {
    const cs = candles([100, 101, 102, 103])
    expect(gradeStrategyObservation(observation(), cs, cs[3].t + 3600)).toBeNull()
    expect(gradeStrategyObservation(observation(), cs, after(cs))).not.toBeNull()
    expect(gradeStrategyObservation(observation(), cs.slice(1))).toBeNull()
    expect(gradeStrategyObservation(observation(), cs.map((c, i) => i === 2 ? { ...c, c: NaN } : c))).toBeNull()
  })
})

describe('forward evidence cannot manufacture confidence', () => {
  it('excludes duplicate and overlapping campaigns, incompatible versions and outcomes still in the future', () => {
    const obs = observation({ availableAt: T0 + 100 * DAY })
    const records = matured(obs, 12)
    const duplicate = { ...records[0], id: 'another-publication' }
    const overlap = { ...records[0], id: 'overlapping', availableAt: records[0].availableAt + DAY, side: 'short' as const }
    const oldVersion = { ...records[0], sym: 'OLD', id: 'legacy', forecast: { ...records[0].forecast, modelVersion: 'prior-model' } }
    const future = { ...records[0], sym: 'FUTURE', id: 'future', outcome: { ...records[0].outcome!, horizonEndAt: obs.availableAt + DAY } }
    expect(compatibleLabRecords(obs, [...records, records[0], duplicate, overlap, oldVersion, future])).toHaveLength(12)
    const calibrated = calibrateLabObservations([obs], [...records, duplicate, overlap, oldVersion, future])[0]
    expect(calibrated.forecast.liveN).toBe(12)
  })

  it('keeps cancelled gaps and legacy execution outcomes out of barrier probabilities', () => {
    const obs = observation({ availableAt: T0 + 100 * DAY })
    const records = matured(obs, 20)
    records[0].outcome = { ...records[0].outcome!, sessions: 0, executionStatus: 'cancelled-gap', targetHit: false }
    records[1].outcome = { ...records[1].outcome!, executionVersion: undefined }
    records[2].side = 'short'
    const calibrated = calibrateLabObservations([obs], records)[0]
    expect(calibrated.forecast.liveN).toBe(20)
    expect(calibrated.forecast.barrierN).toBe(17)
    expect(calibrated.forecast.probabilityTarget).toBeCloseTo(18 / 20)
  })

  it('retains the direction outcome when a next-open order is cancelled', () => {
    const result = gradeStrategyObservation(observation(), candles([100, 112, 113, 114]))!
    expect(result.executionStatus).toBe('cancelled-gap')
    expect(result.sessions).toBe(0)
    expect(result.finishedHigher).toBe(true)
    expect(result.directionHit).toBe(true)
  })

  it('compares live probabilities to the baseline saved before the outcome', () => {
    const obs = observation({ availableAt: T0 + 100 * DAY })
    const records = matured(obs, 10).map(r => ({ ...r, forecast: { ...r.forecast, probabilityUp: 0.9, baselineProbabilityUp: 0.5 },
      outcome: { ...r.outcome!, finishedHigher: false, directionHit: false } }))
    const result = calibrateLabObservations([obs], records)[0].forecast
    expect(result.brierScore).toBe(0.81)
    expect(result.baselineBrierScore).toBe(0.25)
    expect(result.brierSkillScore).toBe(-2.24)
    expect(result.directionAccuracy).toBe(0)
  })

  it('never promotes research solely because 40 observations have matured', () => {
    const obs = observation({ availableAt: T0 + 300 * DAY })
    expect(calibrateLabObservations([obs], matured(obs, 40))[0].forecast.provisional).toBe(true)
  })
})


const recoveryTape = () => candles([...Array(200).fill(160), 149, 138, 128, 120, 115, 110, 106, 102, 100, 98, 99, 100, 102, 104, 105, 106, 107, 108, 109, 110])
const healthyBusiness = (now: number): BusinessHealthSnapshot => {
  const snapshot: BusinessHealthSnapshot = {
  ...emptyBusinessHealth('GOOD', now, ''), status: 'available', availableAt: now - 20 * DAY,
  annualPeriodEnd: '2025-12-31', balancePeriodEnd: '2026-06-30', periodEnd: '2026-06-30', currency: 'USD', gaps: [],
  metrics: { ...emptyBusinessHealth('GOOD', now, '').metrics, revenue: 1000, netIncome: 200, operatingCashFlow: 250, capitalExpenditure: 100, freeCashFlow: 150,
    totalDebt: 100, cash: 150, currentAssets: 400, currentLiabilities: 200, totalEquity: 500,
    currentRatio: 2, debtToEquity: 0.2, revenueGrowthPct: 10, shareCountChangePct: 0.5, netMarginPct: 20, recentNetIncome: 50, recentOperatingCashFlow: 60, recentRevenueGrowthPct: 5, recentShareCountChangePct: 0 },
  }
  for (const [key, value] of Object.entries(snapshot.metrics)) {
    if (value != null) snapshot.evidence[key as keyof typeof snapshot.metrics] = { value, periodStart: key.startsWith('recent') ? '2026-04-01' : '2025-01-01', periodEnd: key.startsWith('recent') ? '2026-06-30' : '2025-12-31', filed: '2026-07-15', availableAt: now - 20 * DAY, unit: 'USD', tags: [], accessions: [] }
  }
  snapshot.reportHistory = [
    ['2025-01-01', '2025-12-31', '2026-02-15'],
    ['2026-01-01', '2026-03-31', '2026-05-15'],
    ['2026-04-01', '2026-06-30', '2026-07-15'],
  ].map(([periodStart, periodEnd, filed], i): FinancialReportPoint => ({
    periodStart, periodEnd, periodKind: i === 0 ? 'annual' : 'quarter',
    durationDays: (Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000,
    cashFlowPeriodStart: periodStart, cashFlowPeriodKind: i === 0 ? 'annual' : 'quarter',
    filed, availableAt: Date.parse(filed) / 1000 + 1.5 * DAY, accession: `report-${i}`,
    financialHealth: 'healthy', healthAssessment: { status: 'healthy', reasons: [], risks: [], gaps: [] },
    annualPeriodEnd: '2025-12-31', balancePeriodEnd: periodEnd, coverageStatus: 'available',
    metrics: { ...Object.fromEntries(REPORT_TREND_METRICS.map(key => [key, null])) as FinancialReportPoint['metrics'],
      revenueGrowthPct: 10, netMarginChangePp: 2, operatingCashFlowMarginChangePp: 2, operatingCashFlow: 100, shareCountChangePct: 0 },
    evidence: {}, gaps: [],
  }))
  return snapshot
}

describe('fundamentals-backed recovery research', () => {
  it('requires business health, a higher low and average reclaim before a 63-session setup', () => {
    const cs = recoveryTape()
    const now = after(cs)
    const [row] = qualityDipObservations([{ sym: 'GOOD', candles: cs, capUsdM: 10_000, businessHealth: healthyBusiness(now) }], candles(Array(cs.length).fill(100)), now)
    expect(row.state).toBe('setup')
    expect(row.metrics.financialHealth).toBe('healthy')
    expect(row.metrics.stabilising).toBe(true)
    expect(row.metrics.sma200).not.toBeNull()
    expect(row.metrics.atrPct).toBeGreaterThan(0)
    expect(row.metrics.scenarioRewardRisk).toBeGreaterThanOrEqual(1.5)
    expect(row.forecast.horizonSessions).toBe(63)
    expect(row.forecast.probabilityTarget).toBeNull()
    expect(row.forecast.label).toContain('not a valuation target')
    expect(row.risks.join(' ')).toContain('backward-looking')
  })

  it('rejects a cash-burning recovery and waits when fundamentals are missing or unavailable at prediction time', () => {
    const cs = recoveryTape()
    const now = after(cs)
    const healthy = healthyBusiness(now)
    const base = { sym: 'GOOD', candles: cs, capUsdM: 100_000 }
    const [unfunded] = qualityDipObservations([{ ...base, businessHealth: { ...healthy, metrics: { ...healthy.metrics, operatingCashFlow: -100, freeCashFlow: -150 } } }], cs, now)
    expect(unfunded.state).toBe('avoid')
    expect(unfunded.metrics.financialHealth).toBe('deteriorating')
    const [missing] = qualityDipObservations([base], cs, now)
    expect(missing.state).toBe('watch')
    expect(missing.metrics.financialHealth).toBe('unknown')
    const [future] = qualityDipObservations([{ ...base, businessHealth: { ...healthy, availableAt: now + DAY } }], cs, now)
    expect(future.state).toBe('watch')
    expect(future.metrics.financialHealth).toBe('unknown')
  })

  it('keeps a healthy, chart-confirmed business on watch without report history', () => {
    const cs = recoveryTape()
    const now = after(cs)
    const businessHealth = healthyBusiness(now)
    const base = { sym: 'GOOD', candles: cs, capUsdM: 10_000, businessHealth }
    const [established] = qualityDipObservations([base], cs, now)
    expect(established.state).toBe('setup')

    for (const reportHistory of [undefined, []]) {
      const [row] = qualityDipObservations([{ ...base, businessHealth: { ...businessHealth, reportHistory } }], cs, now)
      expect(row.state).toBe('watch')
      expect(row.metrics).toMatchObject({ financialHealth: 'healthy', stabilising: true,
        reportTrend: 'insufficient', reportObservations: 0, reportComparisonN: 0 })
      expect(row.entry).toBe(established.entry)
      expect(row.stop).toBe(established.stop)
      expect(row.target).toBe(established.target)
      expect(row.dataGaps.join(' ')).toContain('sustained business trajectory is not established')
    }
  })

  it('lets repeated report deterioration override the latest healthy standalone screen', () => {
    const cs = recoveryTape()
    const now = after(cs)
    const businessHealth = healthyBusiness(now)
    const base = { sym: 'GOOD', candles: cs, capUsdM: 10_000, businessHealth }
    const [established] = qualityDipObservations([base], cs, now)
    const reportHistory = businessHealth.reportHistory!.map(point => ({ ...point,
      metrics: { ...point.metrics, revenueGrowthPct: -10, netMarginChangePp: -3 } }))
    const [row] = qualityDipObservations([{ ...base, businessHealth: { ...businessHealth, reportHistory } }], cs, now)

    expect(established.state).toBe('setup')
    expect(row.state).toBe('avoid')
    expect(row.metrics).toMatchObject({ financialHealth: 'healthy', stabilising: true,
      reportTrend: 'deteriorating', reportObservations: 3, reportComparisonN: 3 })
    expect(row.score).toBeLessThan(established.score)
    expect(row.risks.join(' ')).toContain('repeated weakening report comparisons override')
    expect(row.forecast.provisional).toBe(true)
    expect(row.forecast.probabilityTarget).toBeNull()
  })

  it('does not use a future filing to supply the third report required for a setup', () => {
    const cs = recoveryTape()
    const now = after(cs)
    const businessHealth = healthyBusiness(now)
    const base = { sym: 'GOOD', candles: cs, capUsdM: 10_000, businessHealth }
    const [established] = qualityDipObservations([base], cs, now)
    // The reporting period has already ended, but its filing is not available
    // yet. Positive future comparisons must not complete the history gate.
    const knownReports = businessHealth.reportHistory!.slice(0, 2)
    const futureReport = { ...businessHealth.reportHistory!.at(-1)!, availableAt: now + DAY }
    const [future] = qualityDipObservations([{ ...base, businessHealth: {
      ...businessHealth, reportHistory: [...knownReports, futureReport],
    } }], cs, now)
    const [knownOnly] = qualityDipObservations([{ ...base, businessHealth: {
      ...businessHealth, reportHistory: knownReports,
    } }], cs, now)

    expect(established.state).toBe('setup')
    expect(future).toEqual(knownOnly)
    expect(future.state).toBe('watch')
    expect(future.metrics).toMatchObject({ financialHealth: 'healthy', stabilising: true,
      reportTrend: 'insufficient', reportObservations: 2, reportComparisonN: 2,
      reportLatestAvailableAt: knownReports.at(-1)!.availableAt })
  })

  it('keeps a healthy business on watch around earnings or without a chart recovery', () => {
    const cs = recoveryTape()
    const now = after(cs)
    const [event] = qualityDipObservations([{ sym: 'GOOD', candles: cs, capUsdM: 10_000, businessHealth: healthyBusiness(now), earningsRisk: true }], cs, now)
    expect(event.state).toBe('watch')
    expect(event.risks.join(' ')).toContain('earnings')
    const declining = candles([...Array(200).fill(160), ...Array.from({ length: 20 }, (_, i) => 130 - i)])
    const [noReversal] = qualityDipObservations([{ sym: 'GOOD', candles: declining, capUsdM: 10_000, businessHealth: healthyBusiness(now) }], declining, now)
    expect(noReversal.metrics.financialHealth).toBe('healthy')
    expect(noReversal.metrics.stabilising).toBe(false)
    expect(noReversal.state).toBe('watch')
  })
})

describe('daily provider timestamps do not change a forecast horizon', () => {
  const sec = (iso: string) => Date.parse(iso) / 1000
  const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12']
  const tapeAt = (hour: string): Candle[] => days.map((day, i) => ({ t: sec(`${day}T${hour}:00Z`), o: 100 + i,
    h: 101 + i, l: 99 + i, c: 100 + i, v: 1_000_000 }))
  const issued = (publication: string, signal = '2026-01-05T14:30:00Z', over: Partial<StrategyObservation> = {}) => observation({
    availableAt: sec(publication), detectedAt: sec(publication), stop: 90, target: 120,
    metrics: { signalSessionAt: sec(signal) }, ...over,
  })
  const gradedAt = sec('2026-01-13T08:00:00Z')

  it('grades a pre-open forecast identically with midnight and exchange-open bars', () => {
    const obs = issued('2026-01-06T08:00:00Z')
    const yahoo = gradeStrategyObservation(obs, tapeAt('14:30'), gradedAt)!
    const stooq = gradeStrategyObservation(obs, tapeAt('00:00'), gradedAt)!
    expect(yahoo).toEqual(stooq)
    expect(yahoo.closeReturnPct).toBe(3)
    expect(yahoo.horizonEndAt).toBe(sec('2026-01-08T21:00:00Z'))
    expect(yahoo.executionStartAt).toBe(sec('2026-01-06T14:30:00Z'))
    expect(yahoo.sessions).toBe(3)
  })

  it('keeps the declared third close for intraday publication and enters only at the next future open', () => {
    const obs = issued('2026-01-06T17:00:00Z')
    const yahoo = tapeAt('14:30')
    const stooq = tapeAt('00:00')
    // This barrier traded before the next executable open and is not ours.
    yahoo[1].h = stooq[1].h = 150
    const a = gradeStrategyObservation(obs, yahoo, gradedAt)!
    const b = gradeStrategyObservation(obs, stooq, gradedAt)!
    expect(a).toEqual(b)
    expect(a.firstBarrier).toBe('none')
    expect(a.closeReturnPct).toBe(3)
    expect(a.executionStartAt).toBe(sec('2026-01-07T14:30:00Z'))
    expect(a.horizonEndAt).toBe(sec('2026-01-08T21:00:00Z'))
    expect(a.sessions).toBe(2)
  })

  it('uses a newly closed source session after market close', () => {
    const obs = issued('2026-01-06T22:00:00Z', '2026-01-06T00:00:00Z', { entry: 101 })
    const a = gradeStrategyObservation(obs, tapeAt('14:30'), gradedAt)!
    const b = gradeStrategyObservation(obs, tapeAt('00:00'), gradedAt)!
    expect(a).toEqual(b)
    expect(a.closeReturnPct).toBeCloseTo((104 / 101 - 1) * 100, 4)
    expect(a.horizonEndAt).toBe(sec('2026-01-09T21:00:00Z'))
    expect(a.executionStartAt).toBe(sec('2026-01-07T14:30:00Z'))
  })

  it('cannot use a partial horizon close, a future source close or a missing source session', () => {
    for (const hour of ['00:00', '14:30']) {
      const tape = tapeAt(hour)
      expect(gradeStrategyObservation(issued('2026-01-06T08:00:00Z'), tape, sec('2026-01-08T15:00:00Z'))).toBeNull()
      expect(gradeStrategyObservation(issued('2026-01-06T08:00:00Z', '2026-01-06T00:00:00Z'), tape, gradedAt)).toBeNull()
      expect(gradeStrategyObservation(issued('2026-01-06T08:00:00Z'), tape.slice(1), gradedAt)).toBeNull()
    }
  })

  it('never invents a next-open trade after the declared horizon has elapsed', () => {
    const obs = issued('2026-01-09T22:00:00Z')
    const result = gradeStrategyObservation(obs, tapeAt('00:00'), gradedAt)!
    expect(result.executionStatus).toBe('not-applicable')
    expect(result.executionStartAt).toBeUndefined()
    expect(result.sessions).toBe(0)
    expect(result.closeReturnPct).toBe(3)
    expect(result.horizonEndAt).toBe(sec('2026-01-08T21:00:00Z'))
    const later = { ...obs, availableAt: gradedAt }
    expect(compatibleLabRecords(later, [{ ...obs, outcome: result }])).toHaveLength(0)
  })

  it('infers the last completed source date for legacy rows without treating midnight as an open', () => {
    const obs = issued('2026-01-06T08:00:00Z', undefined, { metrics: {} })
    expect(gradeStrategyObservation(obs, tapeAt('00:00'), gradedAt)).toEqual(gradeStrategyObservation(obs, tapeAt('14:30'), gradedAt))
    expect(gradeStrategyObservation(obs, tapeAt('00:00'), gradedAt)?.closeReturnPct).toBe(3)
  })

  it('uses the venue and date-specific open for summer US and London sessions', () => {
    const summerDays = ['2026-07-01', '2026-07-02', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']
    const summer = (hour: string) => tapeAt(hour).map((c, i) => ({ ...c, t: sec(`${summerDays[i]}T${hour}:00Z`) }))
    const us = issued('2026-07-06T13:00:00Z', '2026-07-02T00:00:00Z', { entry: 101 })
    const usResult = gradeStrategyObservation(us, summer('00:00'), sec('2026-07-13T08:00:00Z'))!
    expect(usResult.executionStartAt).toBe(sec('2026-07-06T13:30:00Z'))
    const london = { ...us, sym: 'GOOD.L', availableAt: sec('2026-07-06T06:30:00Z') }
    const lseResult = gradeStrategyObservation(london, summer('00:00'), sec('2026-07-13T08:00:00Z'))!
    expect(lseResult.executionStartAt).toBe(sec('2026-07-06T07:00:00Z'))
    expect(lseResult.horizonEndAt).toBe(sec('2026-07-08T15:30:00Z'))
  })
})
