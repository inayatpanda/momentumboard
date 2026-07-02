import { describe, expect, it } from 'vitest'
import { buildBoard, gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import type { CalibrationState } from '../../../shared/engine/calibration'

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
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000 }, source: 'screener:gainers' }],
  social: async () => [],
  insiders: async () => [],
  mediaTitles: async () => ['[Bloomberg] NVDA plunges as demand warns mount'],
  earningsSyms: async () => new Set<string>(),
  ...over,
})

// calibration where this band has proven itself — so the call grades
const calWith = (key: string): CalibrationState => ({ buckets: { [key]: { n: 20, hits: 14 } }, brier: [] })

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
