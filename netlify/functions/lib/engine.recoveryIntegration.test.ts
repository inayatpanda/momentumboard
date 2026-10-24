import { describe, expect, it, vi } from 'vitest'
import { emptyBusinessHealth, type BusinessHealthSnapshot } from '../../../shared/businessHealth'
import { REPORT_TREND_METRICS, type FinancialReportPoint } from '../../../shared/reportTrends'
import { LAB_EXECUTION_VERSION, QUALITY_DIP_MODEL_VERSION, type EngineLabSnapshot, type StrategyLabRecord } from '../../../shared/engine/strategyLab'
import type { ResearchLearningSnapshot, ResearchReportSnapshot } from '../../../shared/engine/researchLearning'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { buildBoard, type EngineDeps } from './engine'
import { memoryStore } from './store'

const DAY = 86_400
const NOW = Date.parse('2026-10-19T06:00:00Z') / 1000
const dates: number[] = []
for (let day = Date.parse('2026-10-16T13:30:00Z') / 1000; dates.length < 220; day -= DAY) {
  const weekday = new Date(day * 1000).getUTCDay()
  if (weekday !== 0 && weekday !== 6) dates.unshift(day)
}
const tape = (values: number[]): Candle[] => values.map((c, i) => ({ t: dates[i], o: c, h: c * 1.01, l: c * 0.99, c, v: 2_000_000 }))
const flat = tape(Array(220).fill(100))
const dip = tape([...Array(214).fill(100), 94, 90, 87, 85, 85.5, 88])
dip[dip.length - 1].v = 3_200_000
const recovery = tape([...Array(200).fill(160), 149, 138, 128, 120, 115, 110, 106, 102, 100, 98, 99, 100, 102, 104, 105, 106, 107, 108, 109, 110])

function health(sym: string): BusinessHealthSnapshot {
  const value: BusinessHealthSnapshot = {
    ...emptyBusinessHealth(sym, NOW, ''), status: 'available', availableAt: NOW - 30 * DAY,
    annualPeriodEnd: '2025-12-31', balancePeriodEnd: '2026-06-30', periodEnd: '2026-06-30', currency: 'USD', gaps: [],
  }
  Object.assign(value.metrics, { revenue: 1000, netIncome: 100, operatingCashFlow: 140, capitalExpenditure: 50, freeCashFlow: 90,
    currentRatio: 2, cash: 100, totalDebt: 180, currentLiabilities: 200, totalEquity: 600, debtToEquity: 0.3, revenueGrowthPct: 10, shareCountChangePct: 0,
    recentNetIncome: 20, recentOperatingCashFlow: 40, recentRevenueGrowthPct: 5, recentShareCountChangePct: 0 })
  for (const [name, n] of Object.entries(value.metrics)) {
    if (n == null) continue
    value.evidence[name as keyof typeof value.metrics] = { value: n, periodStart: name.startsWith('recent') ? '2026-04-01' : '2025-01-01',
      periodEnd: (name.startsWith('recent') || ['cash','totalDebt','currentLiabilities','totalEquity','currentRatio','debtToEquity'].includes(name)) ? '2026-06-30' : '2025-12-31', filed: '2026-08-01', availableAt: NOW - 30 * DAY, unit: 'USD', tags: [], accessions: [] }
  }
  value.reportHistory = ['2025-12-31', '2026-03-31', '2026-06-30'].map((periodEnd, i): FinancialReportPoint => ({
    periodStart: null, periodEnd, periodKind: 'quarter', durationDays: 90, cashFlowPeriodStart: null,
    cashFlowPeriodKind: 'quarter', filed: '2026-08-01', availableAt: NOW - (120 - 30 * i) * DAY,
    accession: `report-${i}`, financialHealth: 'healthy', healthAssessment: { status: 'healthy', reasons: [], risks: [], gaps: [] },
    annualPeriodEnd: '2025-12-31', balancePeriodEnd: periodEnd, coverageStatus: 'available', gaps: [], evidence: {},
    metrics: { ...Object.fromEntries(REPORT_TREND_METRICS.map(key => [key, null])), revenueGrowthPct: 10,
      netMarginChangePp: 2, operatingCashFlowMarginChangePp: 2, shareCountChangePct: 0, operatingCashFlow: 40 } as FinancialReportPoint['metrics'],
  }))
  return value
}

const dependencies = (symbols: string[], over: Partial<EngineDeps> = {}): EngineDeps => ({
  valuationCapitalization: async sym => ({ sym, marketCapUsdM: .002, currency: 'USD', observedAt: NOW - 60, source: 'finnhub-profile' }),
  candles: async sym => symbols.includes(sym) ? recovery : ['SPY', 'QQQ'].includes(sym) ? flat : null,
  candles5y: async () => null, capUsdM: async () => null, companyName: async () => null,
  screens: async () => [], social: async () => [], sparkCloses: async () => new Map(), insiderCoverage: async () => new Map(),
  smartMoney: async () => [], mediaTitles: async () => [], newsCatalysts: async () => [],
  dipNewsCached: async () => ({ verdict: 'transient', reason: 'Reported one-off delivery delay', via: 'heuristic' }),
  dipNews: async () => ({ verdict: 'transient', reason: 'Reported one-off delivery delay' }),
  recentIpos: async () => [], earningsSyms: async () => new Set(), earningsCalendar: async () => [],
  worldReads: async () => [], holdings: async () => null, businessHealth: async sym => health(sym), ...over,
})

async function storeFor(symbols: string[]) {
  const store = memoryStore()
  await store.write('config', { watchlist: symbols.map(symbol => ({ symbol })), rules: [], ytChannels: [], levMap: {} })
  return store
}

function recoveryRecord(sym: string, availableAt: number): StrategyLabRecord {
  return { id: `campaign:${sym}`, sym, sleeve: 'quality-dip', side: 'long', state: 'setup', score: 75,
    entry: 100, stop: 90, target: 120, availableAt, detectedAt: availableAt, reasons: [], risks: [], dataGaps: [],
    metrics: {}, forecast: { definition: 'target-before-stop-v1', modelVersion: QUALITY_DIP_MODEL_VERSION, label: 'Recovery', horizonSessions: 63, calibratedN: 0, provisional: true } }
}

describe('recovery research through the production engine', () => {
  it('preserves published market context when the board is rebuilt', async () => {
    const store = await storeFor(['MSFT'])
    const context = { version: 1, generatedAt: NOW, dataFrom: '2006-04-28', dataThrough: '2026-10-16', observations: 5000, digest: 'context-test', current: [], pairs: [], seasonal: [], similar: [] }
    await store.write('engine-market-patterns', context)
    await buildBoard(store, dependencies(['MSFT']), NOW)
    expect((await store.read<EngineLabSnapshot>('engine-lab'))!.learning?.marketPatterns).toEqual(context)
    expect((await store.read<ResearchLearningSnapshot>('engine-research-learning'))!.marketPatterns).toEqual(context)
  })

  it('publishes watchlist context and freezes the paired experiment with new forecasts', async () => {
    const store = await storeFor(['MSFT', 'ZZQ.L'])
    await store.write('engine-market-patterns', { version: 1, generatedAt: NOW - 60, dataFrom: '2006-04-28', dataThrough: '2026-10-16', observations: 5000, digest: 'context-test', current: ['SPY', 'TLT', 'USO'].map(symbol => ({ symbol, monthPct: 2, quarterPct: 3 })), pairs: [], seasonal: [], similar: [] })
    await store.write('news-desk', [{ title: 'Microsoft results', url: 'https://example.com/msft', syms: ['MSFT'], at: NOW - 60, why: 'Company report', score: 70 }])
    await buildBoard(store, dependencies(['MSFT'], { candles: async sym => sym === 'MSFT' ? recovery : flat }), NOW)
    const saved = await store.read<{ items: Record<string, import('../../../shared/engine/stockContext').StockContext> }>('engine-stock-contexts')
    expect(saved!.items.MSFT.news[0].title).toBe('Microsoft results')
    expect(saved!.items['ZZQ.L'].status).toBe('limited')
    const trials = (await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!.filter(r => r.contextTrial)
    expect(trials.length).toBeGreaterThan(0)
    expect(trials.every(r => r.contextTrial!.savedAt === r.availableAt && r.contextTrial!.baselineUp === r.forecast.probabilityUp)).toBe(true)
    const first = JSON.stringify(trials)
    await buildBoard(store, dependencies(['MSFT'], { candles: async sym => sym === 'MSFT' ? recovery : flat }), NOW + 60)
    expect(JSON.stringify((await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!.filter(r => trials.some(t => t.id === r.id)).map(r => ({ ...r, lastGradeAttemptAt: undefined })))).toBe(first)
  })

  it('checks a recovery selloff cause even when no fast dip ever warmed the news cache', async () => {
    const store = await storeFor(['MSFT'])
    const news = vi.fn(async () => ({ verdict: 'transient' as const, reason: 'Company-specific one-off delay' }))
    await buildBoard(store, dependencies(['MSFT'], { dipNewsCached: async () => null, dipNews: news }), NOW)
    expect(news).toHaveBeenCalledWith('MSFT')
    const lab = (await store.read<EngineLabSnapshot>('engine-lab'))!
    expect(lab.observations.find(row => row.sym === 'MSFT' && row.sleeve === 'quality-dip')).toMatchObject({ state: 'setup', metrics: { newsAssessment: 'transient' } })
  })

  it('keeps the original daily forecast ledger when a refreshed board changes selection', async () => {
    const store = await storeFor(['MSFT'])
    const deps = dependencies(['MSFT'], { capUsdM: async () => 20_000, candles: async sym => sym === 'MSFT' ? dip : flat })
    await buildBoard(store, deps, NOW)
    const key = 'predictions:2026-10-19'
    const first = (await store.read<Prediction[]>(key))!
    expect(first.length).toBeGreaterThan(0)
    // Freeze a real publication, then remove every candidate from the next run.
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await buildBoard(store, dependencies([]), NOW + 3600)
    const retained = (await store.read<Prediction[]>(key))!
    for (const original of first) expect(retained.find(row => row.id === original.id)).toEqual(original)
    expect(await store.read<string[]>('predictions-pending')).toContain('2026-10-19')
  })

  it('does not size legacy dip calls without matching healthy business evidence', async () => {
    const symbols = ['MSFT', 'BURN', 'MISSING', 'WRONG']
    const store = await storeFor(symbols)
    await buildBoard(store, dependencies(symbols, {
      capUsdM: async () => 20_000,
      valuationCapitalization: async sym => ({ sym, marketCapUsdM: .002, currency: 'USD', observedAt: NOW - 60, source: 'finnhub-profile' }),
  candles: async sym => symbols.includes(sym) ? dip : flat,
      businessHealth: async sym => {
        if (sym === 'MISSING') throw new Error('no fundamentals')
        const value = health(sym === 'WRONG' ? 'OTHER' : sym)
        if (sym === 'BURN') value.metrics.operatingCashFlow = -20
        return value
      },
    }), NOW)
    const ledger = (await store.read<Prediction[]>('predictions:2026-10-19'))!
    const dips = ledger.filter(row => row.catalyst?.kind === 'dip')
    expect(dips.length).toBeGreaterThan(0)
    expect(dips.map(row => row.sym)).toEqual(expect.arrayContaining(['BURN', 'MISSING', 'WRONG']))
    expect(dips.filter(row => ['BURN', 'MISSING', 'WRONG'].includes(row.sym)).every(row => row.shadow && row.riskPct === 0)).toBe(true)
  })

  it('hydrates real business evidence, applies cause-of-selloff context and records only qualified shadow setups', async () => {
    const symbols = ['MSFT', 'BURN', 'BROKEN', 'MISSING', 'UNCLEAR']
    const store = await storeFor(symbols)
    await buildBoard(store, dependencies(symbols, {
      businessHealth: async sym => {
        if (sym === 'MISSING') throw new Error('provider unavailable')
        const value = health(sym)
        if (sym === 'BURN') value.metrics.operatingCashFlow = -20
        return value
      },
      dipNewsCached: async sym => sym === 'BROKEN'
        ? { verdict: 'structural', reason: 'The main customer permanently terminated the contract', via: 'heuristic' }
        : sym === 'UNCLEAR' ? { verdict: 'unclear', reason: 'No directly related recent headlines', via: 'heuristic' }
        : { verdict: 'transient', reason: 'One-off delivery delay', via: 'heuristic' },
    }), NOW)
    const snapshot = (await store.read<EngineLabSnapshot>('engine-lab'))!
    const quality = snapshot.observations.filter(row => row.sleeve === 'quality-dip')
    const bySym = new Map(quality.map(row => [row.sym, row]))
    expect(bySym.get('MSFT')).toMatchObject({ state: 'setup', metrics: { financialHealth: 'healthy', newsAssessment: 'transient' }, forecast: { horizonSessions: 63 } })
    expect(bySym.get('BURN')).toMatchObject({ state: 'avoid', metrics: { financialHealth: 'deteriorating' } })
    expect(bySym.get('BROKEN')).toMatchObject({ state: 'avoid', metrics: { newsAssessment: 'structural' } })
    expect(bySym.get('MISSING')).toMatchObject({ state: 'watch', metrics: { financialHealth: 'unknown' } })
    expect(bySym.get('UNCLEAR')).toMatchObject({ state: 'watch', metrics: { financialHealth: 'healthy', newsAssessment: 'unclear' } })
    expect(snapshot.mode).toBe('shadow')
    const ledger = (await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!
    expect(ledger.filter(row => row.sleeve === 'quality-dip').map(row => row.sym)).toEqual(['MSFT'])
  })

  it('carries sector rotation, international selling and adverse news into recovery stand-down decisions', async () => {
    const symbols = ['AAPL', 'ADBE', 'OIL']
    const store = await storeFor(symbols)
    const fallingSector = tape([...Array(215).fill(100), 99, 97, 95, 93, 90])
    const d = dependencies(symbols)
    await buildBoard(store, { ...d,
      candles: async sym => sym === 'XLK' ? fallingSector : d.candles(sym),
      newsCatalysts: async () => [{ sym: 'OIL', side: 'short', strength: 80, reason: 'New export restrictions hurt this producer' }],
      worldReads: async () => ['^N225', '^HSI', '^GDAXI', '^FTSE'].map(sym => ({ sym, name: sym, changePct: -2 })),
    }, NOW)
    const snapshot = (await store.read<EngineLabSnapshot>('engine-lab'))!
    const bySym = new Map(snapshot.observations.filter(row => row.sleeve === 'quality-dip').map(row => [row.sym, row]))
    expect(bySym.get('AAPL')).toMatchObject({ state: 'watch', metrics: { financialHealth: 'healthy', sectorName: 'Technology', sectorRotation: 'out', worldTone: 'risk-off' } })
    expect(bySym.get('ADBE')).toMatchObject({ state: 'watch', metrics: { sectorName: 'Technology', sectorRotation: 'out' } })
    expect(bySym.get('OIL')).toMatchObject({ state: 'watch', metrics: { financialHealth: 'healthy', worldTone: 'risk-off' } })
    expect(bySym.get('OIL')?.risks).toContain('Adverse news interpretation: New export restrictions hurt this producer')
    expect((await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!.filter(row => row.sleeve === 'quality-dip')).toHaveLength(0)
  })

  it('bounds fundamental hydration at sixteen candidates and two in-flight provider calls', async () => {
    const symbols = Array.from({ length: 20 }, (_, i) => `REC${i}`)
    const store = await storeFor(symbols)
    let inFlight = 0
    let peak = 0
    const businessHealth = vi.fn(async (sym: string) => {
      peak = Math.max(peak, ++inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight--
      return health(sym)
    })
    await buildBoard(store, dependencies(symbols, { businessHealth }), NOW)
    expect(businessHealth).toHaveBeenCalledTimes(16)
    expect(peak).toBe(2)
    const snapshot = (await store.read<EngineLabSnapshot>('engine-lab'))!
    const quality = snapshot.observations.filter(row => row.sleeve === 'quality-dip')
    expect(quality.length).toBeLessThanOrEqual(8)
    expect(quality.every(row => row.metrics.financialHealth === 'healthy')).toBe(true)
    expect(quality.every(row => row.forecast.probabilityTarget == null)).toBe(true)
  })

  it('reports international coverage as missing when only the VIX feed succeeded', async () => {
    const store = await storeFor(['MSFT'])
    await buildBoard(store, dependencies(['MSFT'], {
      worldReads: async () => [{ sym: '^VIX', name: 'VIX', changePct: 2 }, { sym: '^N225', name: 'Nikkei', changePct: null }],
    }), NOW)
    const snapshot = (await store.read<EngineLabSnapshot>('engine-lab'))!
    const quality = snapshot.observations.find(row => row.sleeve === 'quality-dip')!
    expect(quality.metrics.worldTone).toBeNull()
    expect(quality.metrics.worldDetail).toBeNull()
    expect(quality.dataGaps).toContain('international market context unavailable')
  })

  it('retains an unfinished 63-session campaign while trimming a full completed history', async () => {
    const store = await storeFor([])
    const pending = recoveryRecord('PENDING', NOW - 30 * DAY)
    const closed = Array.from({ length: 600 }, (_, i) => ({ ...recoveryRecord(`DONE${i}`, NOW - (100 + i) * DAY), outcome: {
      entry: 100, exit: 101, firstBarrier: 'none' as const, targetHit: false, stopHit: false, returnPct: 1, sessions: 63,
    } }))
    await store.write('engine-lab-ledger', [pending, ...closed])
    await buildBoard(store, dependencies([]), NOW)
    const ledger = (await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!
    expect(ledger.find(row => row.id === pending.id)).toEqual(pending)
    expect(ledger.filter(row => row.outcome)).toHaveLength(500)
  })

  it('grades a mature 63-session campaign from fresh price history after its symbol leaves the candidate pool', async () => {
    const store = await storeFor([])
    const issued = dates[dates.length - 64] + 8 * 3600
    const pending = recoveryRecord('DEPARTED', issued)
    await store.write('engine-lab-ledger', [pending])
    const d = dependencies([])
    const candles = vi.fn(async (sym: string) => sym === 'DEPARTED' ? flat : d.candles(sym))
    await buildBoard(store, { ...d, candles }, NOW)
    const ledger = (await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!
    expect(candles).toHaveBeenCalledWith('DEPARTED')
    expect(ledger.find(row => row.id === pending.id)?.outcome).toMatchObject({ executionStatus: 'filled', sessions: 63, firstBarrier: 'none' })
  })

  it('remembers the published calibrated odds, learns only completed campaigns and preserves each scan report', async () => {
    const store = await storeFor(['MSFT'])
    const completed: StrategyLabRecord[] = Array.from({ length: 20 }, (_, i) => ({
      ...recoveryRecord(`PAST${i}`, NOW - (150 + i) * DAY),
      metrics: { reportTrend: 'improving', stabilising: true, worldTone: 'mixed' },
      forecast: { ...recoveryRecord(`PAST${i}`, 0).forecast, probabilityTarget: 0.4 },
      outcome: { entry: 100.1, exit: i % 2 ? 99 : 103, returnPct: i % 2 ? -1 : 3, sessions: 63,
        targetHit: i % 2 === 0, stopHit: i % 2 !== 0, firstBarrier: i % 2 ? 'stop' : 'target',
        executionStatus: 'filled', executionVersion: LAB_EXECUTION_VERSION, horizonEndAt: NOW - (40 + i) * DAY },
    }))
    await store.write('engine-lab-ledger', completed)
    await buildBoard(store, dependencies(['MSFT']), NOW)
    const lab = (await store.read<EngineLabSnapshot>('engine-lab'))!
    const shown = lab.observations.find(row => row.sleeve === 'quality-dip' && row.sym === 'MSFT')!
    const saved = (await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!.find(row => row.sleeve === 'quality-dip' && row.sym === 'MSFT')!
    expect(shown.forecast.probabilityTarget).toBeCloseTo(11 / 23, 4)
    expect(saved.forecast).toEqual(shown.forecast)
    const learning = (await store.read<ResearchLearningSnapshot>('engine-research-learning'))!
    expect(lab.learning).toEqual(learning)
    expect(learning.strategies.find(s => s.key === 'quality-dip')).toMatchObject({ status: 'observing', overall: { independentN: 20, filledN: 20, meanNetReturnPct: 1, brierN: 20 } })
    const reports = (await store.read<ResearchReportSnapshot[]>('engine-research-reports:v1'))!
    const originalReport = JSON.stringify(reports[0])
    expect(reports[0].decisions.find(row => row.sym === 'MSFT' && row.sleeve === 'quality-dip')?.campaignId).toBe(saved.id)
    await buildBoard(store, dependencies(['MSFT']), NOW + 60)
    const updatedReports = (await store.read<ResearchReportSnapshot[]>('engine-research-reports:v1'))!
    expect(updatedReports).toHaveLength(2)
    expect(JSON.stringify(updatedReports[0])).toBe(originalReport)
    expect((await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!.filter(row => row.sleeve === 'quality-dip' && row.sym === 'MSFT')).toHaveLength(1)
  })
})
