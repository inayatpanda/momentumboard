import { describe, expect, it } from 'vitest'
import { buildBoard, gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState } from '../../../shared/engine/calibration'
import type { InsiderSummary } from './insiders'
import type { FundMoves } from './edgar'

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })

// rolled-over name: ran 80→280, now bleeding −2/day. Stage 'weak', capacity ~9%.
const shorty = mk(i => (i < 200 ? 80 + i * 1.0 : 280 - (i - 200) * 2.0))
const flat = mk(() => 500)
const NOW = Math.floor(shorty[shorty.length - 1].t + 86_400) // day after the last bar

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000 }, source: 'screener:gainers' }],
  social: async () => [],
  insiderCoverage: async () => new Map(),
  smartMoney: async () => [],
  mediaTitles: async () => ['[Bloomberg] NVDA plunges as demand warns mount'],
  earningsSyms: async () => new Set<string>(),
  worldReads: async () => [], // quiet world by default → mixed tone → mult 1
  holdings: async () => null, // no T212 book by default
  ...over,
})

// every index/future red, VIX spiking → an unambiguous risk-off overnight tape
const riskOffReads = async () => [
  { sym: '^N225', name: 'Nikkei', changePct: -1.2 },
  { sym: '^HSI', name: 'Hang Seng', changePct: -1.5 },
  { sym: '^GDAXI', name: 'DAX', changePct: -1.1 },
  { sym: '^FTSE', name: 'FTSE 100', changePct: -1.0 },
  { sym: 'ES=F', name: 'S&P fut', changePct: -1.3 },
  { sym: 'NQ=F', name: 'Nasdaq fut', changePct: -1.4 },
  { sym: '^VIX', name: 'VIX', changePct: 8 },
]

// calibration where this band has proven itself — so the call grades
const calWith = (key: string): CalibrationState => ({ buckets: { [key]: { n: 20, hits: 14 } }, brier: [], defVersion: CALIB_DEF_VERSION })

describe('buildBoard', () => {
  it('scores a rolled-over name as a graded short, writes every blob, paper-only at R0', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])

    const { board, regime, rosterSize } = await buildBoard(store, deps(), NOW)
    expect(regime).toBe('amber') // flat indexes → mixed → amber
    expect(rosterSize).toBeGreaterThanOrEqual(1)

    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined()
    expect(call.side).toBe('short')
    expect(call.grade).toBe('A') // p=(14+2)/(20+4)=0.667, capacity ≥8
    expect(call.probability).toBeCloseTo(0.67, 2)
    expect(call.provisional).toBe(false)
    expect(call.stop).toBeGreaterThan(call.entry)
    expect(call.target).toBeLessThan(call.entry)
    expect(call.paperOnly).toBe(true) // R0 + no levMap → not executable, still scored
    expect(call.instrument).toBeNull()
    expect(call.riskPct).toBe(1.0)
    expect(call.factors.channels.score).toBeLessThan(0) // Josh's bear stance counted
    expect(call.factors.news.score).toBeLessThan(0)

    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    expect(await store.read(`predictions:${today}`)).toHaveLength(board.length)
    expect(await store.read('predictions-index')).toEqual([today])
    expect(await store.read('engine-board')).toMatchObject({ date: today })
    const roster = (await store.read<{ sym: string }[]>('engine-roster'))!
    expect(roster.some(r => r.sym === 'NVDA')).toBe(true)
    expect(await store.read('engine-roster-log')).toHaveLength(1)
  })

  it('a risk-off world tape rides the board blob and nudges each call by side', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    // both bands covered so the 1.1 short nudge can shift NVDA's band without ungrading it
    await store.write('engine-calibration', { buckets: { 'short:amber:25-40': { n: 20, hits: 14 }, 'short:amber:40-55': { n: 20, hits: 14 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps({ worldReads: riskOffReads }), NOW)

    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined()
    expect(call.side).toBe('short')
    expect(call.worldTape).toEqual({ tone: 'risk-off', mult: 1.1 }) // short in risk-off → conviction lifted

    const blob = (await store.read<{ worldTape: { tone: string; votes: { on: number; off: number }; detail: string }; newsTone: { label: string; score: number } }>('engine-board'))!
    expect(blob.worldTape.tone).toBe('risk-off')
    expect(blob.worldTape.votes).toEqual({ on: 0, off: 7 }) // 6 red indices + VIX spike
    expect(blob.worldTape.detail).toContain('risk-off')
    expect(blob.newsTone).toBeDefined()
    expect(['sour', 'neutral', 'upbeat']).toContain(blob.newsTone.label)

    // and the news-tone history advanced, display/log only
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const hist = (await store.read<{ date: string; label: string }[]>('news-tone-history'))!
    expect(hist.at(-1)!.date).toBe(today)
  })

  it('maps an instrument once the rung and levMap allow it', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'SNVD' } } })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    await store.write('risk-state', { rung: 1, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps(), NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call.instrument).toEqual({ ticker: 'SNVD', leverage: 2 })
    expect(call.paperOnly).toBe(false)
  })

  it('dead screeners and empty stores still build (empty board is honest)', async () => {
    const store = memoryStore()
    const { board } = await buildBoard(store, deps({ screens: async () => [], mediaTitles: async () => [] }), NOW)
    expect(Array.isArray(board)).toBe(true) // seeded calibration suppresses the weak-band short
  })

  it('an earnings print inside the horizon forces SHADOW — off the public board, still logged for the print-edge ledger', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    // calibration that would otherwise grade this an A live call
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps({ earningsSyms: async () => new Set(['NVDA']) }), NOW)
    expect(board.find(b => b.sym === 'NVDA')).toBeUndefined() // a coin-flip binary never reaches the live board
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    const shadow = ledger.find(p => p.sym === 'NVDA')!
    expect(shadow.shadow).toBe(true)
    expect(shadow.earningsRisk).toBe(true) // field kept — the ledger can later answer "edge into prints?"
    expect(shadow.riskPct).toBe(0)
    expect(shadow.instrument).toBeNull()
    const publicBoard = (await store.read<{ board: Prediction[] }>('engine-board'))!
    expect(publicBoard.board.find(p => p.sym === 'NVDA')).toBeUndefined()
  })

  it('one outstanding shadow per sym+side: a repeat shadow is skipped while the first is still ungraded', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    await store.write('engine-calibration', { buckets: { 'short:amber:25-40': { n: 30, hits: 9 } }, brier: [], defVersion: CALIB_DEF_VERSION }) // suppresses → shadow
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    // a prior-date NVDA:short shadow still ungraded (no outcome5) → it holds the one slot
    const priorDate = '2026-05-01'
    await store.write('predictions-index', [priorDate])
    await store.write(`predictions:${priorDate}`, [{ id: `${priorDate}:NVDA:short`, sym: 'NVDA', side: 'short', shadow: true }])

    const { board } = await buildBoard(store, deps(), NOW)
    expect(board.find(b => b.sym === 'NVDA')).toBeUndefined()
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.find(p => p.sym === 'NVDA')).toBeUndefined() // correlated repeat teaches nothing — skipped
  })

  it('...but once the first shadow has matured (graded), a fresh same-name shadow is allowed back in', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    await store.write('engine-calibration', { buckets: { 'short:amber:25-40': { n: 30, hits: 9 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const priorDate = '2026-05-01'
    await store.write('predictions-index', [priorDate])
    await store.write(`predictions:${priorDate}`, [
      { id: `${priorDate}:NVDA:short`, sym: 'NVDA', side: 'short', shadow: true, outcome5: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true } },
    ])

    await buildBoard(store, deps(), NOW)
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.find(p => p.sym === 'NVDA' && p.shadow)).toBeDefined() // prior slot freed → fresh shadow allowed
  })

  it('suppressed calls become shadow ledger entries — the learning loop eats even when the paper does not', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    // suppressing calibration: this band has PROVEN it loses → grade null → shadow
    await store.write('engine-calibration', { buckets: { 'short:amber:25-40': { n: 30, hits: 9 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps(), NOW)
    expect(board.find(b => b.sym === 'NVDA')).toBeUndefined() // not on the public board
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    const shadow = ledger.find(p => p.sym === 'NVDA')!
    expect(shadow.shadow).toBe(true)
    expect(shadow.riskPct).toBe(0)
    expect(shadow.instrument).toBeNull()
    const publicBoard = (await store.read<{ board: Prediction[] }>('engine-board'))!
    expect(publicBoard.board.find(p => p.sym === 'NVDA')).toBeUndefined()
  })

  it('an AI nomination joins the roster as a scored candidate (source ai-nomination); an expired one is ignored', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'GNOM', stance: 'bear', levels: [] }], themes: [] },
    ])
    // GNOM nominated 2 days ago (fresh); STALE 8 days ago (expired). BOTH have
    // qualifying candles, so only the 7-day TTL separates them.
    await store.write('ai-nominations', [
      { sym: 'GNOM', reason: 'cited a real [Bloomberg] headline', date: '2026-06-30', at: NOW - 2 * 86_400 },
      { sym: 'STALE', reason: 'week-old idea', date: '2026-06-24', at: NOW - 8 * 86_400 },
    ])
    const d = deps({
      screens: async () => [], // the nomination is GNOM's ONLY candidate source
      social: async () => [],
      candles: async sym => (sym === 'GNOM' || sym === 'STALE' ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      mediaTitles: async () => ['[Bloomberg] GNOM plunges as demand warnings mount'],
    })
    const { board } = await buildBoard(store, d, NOW)

    const roster = (await store.read<{ sym: string; source: string }[]>('engine-roster'))!
    const gnom = roster.find(r => r.sym === 'GNOM')
    expect(gnom).toBeDefined()
    expect(gnom!.source).toBe('ai-nomination') // attribution rides the roster entry
    expect(roster.find(r => r.sym === 'STALE')).toBeUndefined() // expired → never sourced, never fetched
    expect(board.find(b => b.sym === 'GNOM')).toBeDefined() // gated + priced like any other candidate
  })

  it('Fix A: a non-watchlist roster name with a cached cluster-buy gets a non-null insiders factor', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] }) // NVDA is roster-only, never on the watchlist
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    const cluster: InsiderSummary = { symbol: 'NVDA', buyers: ['CEO', 'CFO'], totalBought: 9000, totalValueUsd: 900_000, isCluster: true, latest: [] }
    const coverage = new Map<string, InsiderSummary | null>([['NVDA', cluster]])
    const { board } = await buildBoard(store, deps({ insiderCoverage: async () => coverage }), NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined()
    expect(call.factors.insiders.score).toBe(45) // rotation coverage scored it despite no watchlist membership
    expect(call.factors.insiders.detail).toContain('cluster')
  })

  it('T212 holdings: writes holdings + holdings-reads blobs, a held mover earns a roster slot (source holding), an unreadable name reads null', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    const d = deps({
      screens: async () => [], // HELD's ONLY candidate source is the holdings pool
      social: async () => [],
      candles: async sym => (sym === 'HELD' ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      holdings: async () => [
        { symbol: 'HELD', rawTicker: 'HELDl_EQ', quantity: 3, averagePrice: 100, currentPrice: 130, pplPct: 30 },
        { symbol: 'GHOST', rawTicker: 'GHOST_US_EQ', quantity: 10, averagePrice: 5, currentPrice: 4, pplPct: -20 }, // no candles → unreadable
      ],
    })
    const { holdingsCount } = await buildBoard(store, d, NOW)
    expect(holdingsCount).toBe(2)

    const held = (await store.read<{ at: number; positions: { symbol: string }[] }>('holdings'))!
    expect(held.positions).toHaveLength(2)
    expect(held.at).toBe(NOW)

    const reads = (await store.read<{ sym: string; stage: string | null; entryQuality: string | null; capacityPct: number | null; pplPct: number | null; quantity: number }[]>('holdings-reads'))!
    expect(reads).toHaveLength(2)
    const heldRead = reads.find(r => r.sym === 'HELD')!
    expect(heldRead.stage).not.toBeNull() // real candle history → a real stage
    expect(heldRead.capacityPct).toBeGreaterThan(0)
    expect(heldRead.pplPct).toBe(30)
    expect(heldRead.quantity).toBe(3)
    const ghostRead = reads.find(r => r.sym === 'GHOST')!
    expect(ghostRead.stage).toBeNull() // no candles → the engine can't read it, but it's still tracked
    expect(ghostRead.capacityPct).toBeNull()
    expect(ghostRead.pplPct).toBe(-20)

    // HELD moved enough to qualify → joined the roster via the holdings pool
    const roster = (await store.read<{ sym: string; source: string }[]>('engine-roster'))!
    const heldEntry = roster.find(r => r.sym === 'HELD')
    expect(heldEntry).toBeDefined()
    expect(heldEntry!.source).toBe('holding') // attribution rides the roster entry
    expect(roster.find(r => r.sym === 'GHOST')).toBeUndefined() // unreadable → never a candidate
  })

  it('T212 holdings fail-soft: a null book leaves the holdings blobs untouched', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    const { holdingsCount } = await buildBoard(store, deps({ holdings: async () => null }), NOW)
    expect(holdingsCount).toBe(0)
    expect(await store.read('holdings')).toBeNull()
    expect(await store.read('holdings-reads')).toBeNull()
  })

  it('Fix B: a smartMoney 13F match surfaces in the prediction factor breakdown', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    const moves: FundMoves[] = [
      { fund: 'Scion Asset Management', filedAt: '2026-05-15', newPositions: [{ issuer: 'NVIDIA CORP', shares: 100, value: 100 }], increased: [], exited: [] },
    ]
    const { board } = await buildBoard(
      store,
      deps({ smartMoney: async () => moves, companyName: async s => (s === 'NVDA' ? 'NVIDIA Corp' : null) }),
      NOW,
    )
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined()
    expect(call.factors.smartMoney.score).toBe(25) // Scion newly bought NVIDIA → +25
    expect(call.factors.smartMoney.detail).toContain('Scion')
    expect(call.factors.smartMoney.detail).toContain('45d lag')
  })
})

describe('gradeOutstanding', () => {
  it('grades a matured prediction, updates calibration, risk and scorecard', async () => {
    const store = memoryStore()
    // prediction planted at bar 240 (2026-01-28); 19 bars of history follow
    const date = new Date(shorty[240].t * 1000).toISOString().slice(0, 10)
    const planted: Partial<Prediction> = {
      id: `${date}:NVDA:short`,
      date,
      sym: 'NVDA',
      side: 'short',
      composite: -38.9,
      regime: 'amber',
      probability: 0.67,
      provisional: false,
      grade: 'A',
      priceAtPrediction: shorty[239].c,
      entry: shorty[239].c,
      stop: shorty[239].c * 1.1,
      target: shorty[239].c * 0.9,
      instrument: null,
      factors: { technical: { score: -30, detail: '', weight: 1 } } as never,
    }
    await store.write(`predictions:${date}`, [planted])
    await store.write('predictions-index', [date])
    await store.write('engine-calibration', calWith('short:amber:25-40'))

    const { graded } = await gradeOutstanding(store, deps(), NOW, null)
    expect(graded).toBe(1)

    const preds = (await store.read<Prediction[]>(`predictions:${date}`))!
    expect(preds[0].outcome5).toBeDefined()
    expect(preds[0].outcome5!.hit).toBe(true) // falling knife kept falling, stop never touched
    expect(preds[0].outcome10).toBeDefined()

    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['short:amber:25-40']).toEqual({ n: 21, hits: 15 })
    expect(cal.brier).toHaveLength(1)

    const risk = (await store.read<{ gradedAtRung: number }>('risk-state'))!
    expect(risk.gradedAtRung).toBe(1)
    const scorecard = (await store.read<{ byGrade: Record<string, { n: number }> }>('engine-scorecard'))!
    expect(scorecard.byGrade.A.n).toBe(1)
  })
})
