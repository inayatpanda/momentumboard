import { describe, expect, it } from 'vitest'
import { buildBoard, gradeOutstanding, traceOpenIdeas, type EngineDeps } from './engine'
import type { OpenTraceEntry } from '../../../shared/engine/openTrace'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState } from '../../../shared/engine/calibration'
import type { RiskState } from '../../../shared/engine/riskLadder'
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
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
  social: async () => [],
  insiderCoverage: async () => new Map(),
  smartMoney: async () => [],
  mediaTitles: async () => ['[Bloomberg] NVDA plunges as demand warns mount'],
  newsCatalysts: async () => [], // no LLM catalysts by default
  recentIpos: async () => [], // no fresh listings by default
  earningsSyms: async () => new Set<string>(),
  earningsCalendar: async () => [], // no earnings prints ahead by default

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
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
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
    expect(call.watchOnly).toBeUndefined() // A + contract passed → a trade, not an observation
    expect(call.setup).toBe('continuation') // shorting confirmed weakness = downtrend continuation
    expect(call.evidence.contract).toBe(true)
    expect(call.evidence.famAgree).toBeGreaterThanOrEqual(2)
    expect(Math.abs(call.evidence.contextPts)).toBeLessThanOrEqual(12) // channels/news colour is capped
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
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    // both bands covered so the 1.1 short nudge can shift NVDA's band without ungrading it
    await store.write('engine-calibration', { buckets: { 'short:amber:55-70': { n: 20, hits: 14 }, 'short:amber:70+': { n: 20, hits: 14 } }, brier: [], defVersion: CALIB_DEF_VERSION })
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
    await store.write('engine-calibration', calWith('short:amber:55-70'))
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
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    // calibration that would otherwise grade this an A live call
    await store.write('engine-calibration', calWith('short:amber:55-70'))
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

  it('a SHORT with no inverse-ETP route is forced to SHADOW — off the board, still graded', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} }) // no route for NVDA
    await store.write('engine-calibration', calWith('short:amber:55-70')) // would otherwise grade an A live short
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    // NVDA priced as a small-cap ($800M < $2B): an ISA can't route a short on it
    const smallCapScreen = async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 800, changePct: null, name: null }, source: 'screener:gainers' }]
    const { board } = await buildBoard(store, deps({ screens: smallCapScreen }), NOW)
    expect(board.find(b => b.sym === 'NVDA')).toBeUndefined() // never on the reader-facing board
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    const shadow = ledger.find(p => p.sym === 'NVDA')!
    expect(shadow.shadow).toBe(true) // still logged so the small-cap cohort learns
    expect(shadow.side).toBe('short')
    expect(shadow.riskPct).toBe(0)
    const publicBoard = (await store.read<{ board: Prediction[] }>('engine-board'))!
    expect(publicBoard.board.find(p => p.sym === 'NVDA')).toBeUndefined()
  })

  it('one outstanding shadow per sym+side: a repeat shadow is skipped while the first is still ungraded', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    // a prior-date NVDA:short shadow still ungraded (no outcome10) → it holds the one slot
    const priorDate = '2026-05-01'
    await store.write('predictions-index', [priorDate])
    await store.write(`predictions:${priorDate}`, [{ id: `${priorDate}:NVDA:short`, sym: 'NVDA', side: 'short', shadow: true }])

    // an earnings print forces shadow — the dedup path under test
    const { board } = await buildBoard(store, deps({ earningsSyms: async () => new Set(['NVDA']) }), NOW)
    expect(board.find(b => b.sym === 'NVDA')).toBeUndefined()
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.find(p => p.sym === 'NVDA')).toBeUndefined() // correlated repeat teaches nothing — skipped
  })

  it('...but once the first shadow has matured (graded), a fresh same-name shadow is allowed back in', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const priorDate = '2026-05-01'
    await store.write('predictions-index', [priorDate])
    await store.write(`predictions:${priorDate}`, [
      { id: `${priorDate}:NVDA:short`, sym: 'NVDA', side: 'short', shadow: true, outcome5: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true }, outcome10: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true } },
    ])

    await buildBoard(store, deps({ earningsSyms: async () => new Set(['NVDA']) }), NOW)
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.find(p => p.sym === 'NVDA' && p.shadow)).toBeDefined() // prior slot freed → fresh shadow allowed
  })

  it('below-base but fully-evidenced calls surface as TRACKED watch rows — seen, unsized, still graded', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    // this band has PROVEN it loses → grade null. The old behaviour buried the
    // call as an invisible shadow; the reader then watched "big names move with
    // an empty board" (live complaint 2026-07-15). Fully-evidenced null-grades
    // now publish as watch with the belowBase flag — no size, honest copy.
    await store.write('engine-calibration', { buckets: { 'short:amber:55-70': { n: 30, hits: 9 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps(), NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined() // ON the public board now
    expect(call.watchOnly).toBe(true)
    expect(call.belowBase).toBe(true)
    expect(call.shadow).toBeUndefined()
    expect(call.riskPct).toBe(0)
    expect(call.instrument).toBeNull()
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.find(p => p.sym === 'NVDA')).toBeDefined() // the learning loop still eats it
    const publicBoard = (await store.read<{ board: Prediction[] }>('engine-board'))!
    expect(publicBoard.board.find(p => p.sym === 'NVDA')?.belowBase).toBe(true)
  })

  it('grade C publishes as WATCH-ONLY: on the board with riskPct 0, no instrument — an observation, not a trade', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'SNVD' } } })
    // bucket edges past the base rate but under B: laplace (11+2)/(20+4)=0.54 → C
    await store.write('engine-calibration', { buckets: { 'short:amber:55-70': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('risk-state', { rung: 1, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps(), NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined() // still published — the day is never blank just because nothing qualified
    expect(call.grade).toBe('C')
    expect(call.watchOnly).toBe(true)
    expect(call.riskPct).toBe(0) // no size for a watch idea
    expect(call.instrument).toBeNull() // even though rung+levMap would have unlocked SNVD
    expect(call.shadow).toBeUndefined() // visible and graded, unlike a shadow
    const publicBoard = (await store.read<{ board: Prediction[] }>('engine-board'))!
    expect(publicBoard.board.find(p => p.sym === 'NVDA')?.watchOnly).toBe(true)
  })

  it('an AI nomination joins the roster as a scored candidate (source ai-nomination); an expired one is ignored', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
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

  it('a high-credibility off-roster channel stance NOMINATES a symbol as a candidate (source channel:consensus); a lone low-cred stance does not', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    // PUND: one bear from 'Stocks with Josh' — the default favourite → credibilityOf
    //   prior 0.6 ≥ 0.55, so a single call qualifies it as a candidate on its own.
    // LOWC: one bear from a single non-favourite (cred 0.5 < 0.55) and no agreement →
    //   below the gate → never sourced, never a candidate (even with qualifying candles).
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'PUND', stance: 'bear', levels: [] }], themes: [] },
      { url: 'yt/2', channel: 'Nobody', at: NOW - 2 * 86_400, tickers: [{ sym: 'LOWC', stance: 'bear', levels: [] }], themes: [] },
    ])
    const d = deps({
      screens: async () => [], // the channel stance is PUND's ONLY candidate source
      social: async () => [],
      newsCatalysts: async () => [],
      candles: async sym => (sym === 'PUND' || sym === 'LOWC' ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      mediaTitles: async () => ['[Bloomberg] PUND plunges as demand warnings mount'],
    })
    const { board } = await buildBoard(store, d, NOW)

    const roster = (await store.read<{ sym: string; source: string }[]>('engine-roster'))!
    const pund = roster.find(r => r.sym === 'PUND')
    expect(pund).toBeDefined()
    expect(pund!.source).toBe('channel:consensus') // credible single voice nominated it; attribution rides the entry
    expect(board.find(b => b.sym === 'PUND')).toBeDefined() // gated + priced like any other candidate

    expect(roster.find(r => r.sym === 'LOWC')).toBeUndefined() // below the credibility gate → never a candidate
    expect(await d.candles('LOWC')).toBe(shorty) // LOWC HAD qualifying candles — excluded by the SOURCE gate, not by data
  })

  it('two lesser-known channels agreeing on a side also NOMINATE a candidate (the ≥2-agree branch)', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    // neither 'Guy A' nor 'Guy B' is a favourite → each cred 0.5 < 0.55, so no single
    // voice clears the credibility gate; their agreement on a bear side is what nominates.
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Guy A', at: NOW - 2 * 86_400, tickers: [{ sym: 'DUO', stance: 'bear', levels: [] }], themes: [] },
      { url: 'yt/2', channel: 'Guy B', at: NOW - 2 * 86_400, tickers: [{ sym: 'DUO', stance: 'bear', levels: [] }], themes: [] },
    ])
    const d = deps({
      screens: async () => [], // the channel agreement is DUO's ONLY candidate source
      social: async () => [],
      newsCatalysts: async () => [],
      candles: async sym => (sym === 'DUO' ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      mediaTitles: async () => ['[Bloomberg] DUO plunges as demand warnings mount'],
    })
    const { board } = await buildBoard(store, d, NOW)

    const roster = (await store.read<{ sym: string; source: string }[]>('engine-roster'))!
    const duo = roster.find(r => r.sym === 'DUO')
    expect(duo).toBeDefined()
    expect(duo!.source).toBe('channel:consensus')
    expect(board.find(b => b.sym === 'DUO')).toBeDefined() // gated + priced like any other candidate
  })

  it('a recently-listed name joins the candidate pool as a fresh-listing source (catalyst:ipo, side null → no free vote)', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    // FRESH just priced 40-odd days ago (enough candles to read); the IPO calendar
    // is its ONLY candidate source — no screener, no social, no headline mentions it.
    const d = deps({
      screens: async () => [],
      social: async () => [],
      newsCatalysts: async () => [],
      candles: async sym => (sym === 'FRESH' ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      mediaTitles: async () => [], // no theme/news source may claim FRESH
      recentIpos: async () => [{ sym: 'FRESH', date: '2026-05-20' }],
    })
    const { board } = await buildBoard(store, d, NOW)

    const roster = (await store.read<{ sym: string; source: string }[]>('engine-roster'))!
    const fresh = roster.find(r => r.sym === 'FRESH')
    expect(fresh).toBeDefined()
    expect(fresh!.source).toBe('catalyst:ipo') // the IPO calendar nominated it; attribution rides the roster entry

    const call = board.find(b => b.sym === 'FRESH')!
    expect(call).toBeDefined() // gated + priced like any other candidate
    expect(call.catalyst).toEqual({ kind: 'ipo', reason: 'listed 2026-05-20' })
    expect(call.factors.catalyst.score).toBeNull() // side null → the ipo tag casts NO directional vote
  })

  it('Fix A: a non-watchlist roster name with a cached cluster-buy gets a non-null insiders factor', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } }) // NVDA is roster-only, never on the watchlist
    await store.write('engine-calibration', calWith('short:amber:55-70'))
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
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
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
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    const { holdingsCount } = await buildBoard(store, deps({ holdings: async () => null }), NOW)
    expect(holdingsCount).toBe(0)
    expect(await store.read('holdings')).toBeNull()
    expect(await store.read('holdings-reads')).toBeNull()
  })

  it('Fix B: a smartMoney 13F match surfaces in the prediction factor breakdown', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
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

  it('per-cohort rung: a large-cap call trades at the LARGE sleeve’s rung, not the combined top-level', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'SNVD' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    // combined/top-level parked at R0, but the LARGE sleeve already earned R1.
    // NVDA's screener cap is 50_000 → large cohort, so it must trade at R1.
    await store.write('risk-state', {
      rung: 0,
      sinceDate: '2026-01-01',
      gradedAtRung: 0,
      history: [],
      cohorts: {
        large: { rung: 1, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] },
        small: { rung: 0, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] },
      },
    })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps(), NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call.riskRung).toBe(1) // the large sleeve's rung — NOT the top-level R0
    expect(call.riskPct).toBe(1.25) // RUNG_RISK_PCT[1]
    expect(call.instrument).toEqual({ ticker: 'SNVD', leverage: 2 }) // R1 unlocks 2x for an A short
    expect(call.paperOnly).toBe(false)
  })

  it('always evaluates holdings/watchlist ahead of a saturated discovery budget', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [{ symbol: 'NVDA' }], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    const noisyScreens = Array.from({ length: 110 }, (_, i) => ({
      row: { sym: `ZZ${String(i).padStart(3, '0')}`, price: 10, capUsdM: 5_000, changePct: 1, name: null },
      source: 'screener:gainers',
    }))
    const { board } = await buildBoard(store, deps({ screens: async () => noisyScreens }), NOW)
    expect(board.some(p => p.sym === 'NVDA')).toBe(true)
  })

  it('event radar: an earnings-calendar name on the roster lands in the event-radar blob with daysToPrint and its shape', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const printDate = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10)
    // NVDA is the default screener candidate (has candles); OFFPOOL has no candles →
    // it reports too, but the engine never heard of it, so the radar must skip it.
    const d = deps({ earningsCalendar: async () => [{ sym: 'NVDA', date: printDate, hour: 'amc' }, { sym: 'OFFPOOL', date: printDate }] })
    await buildBoard(store, d, NOW)

    const radar = (await store.read<{ date: string; entries: { sym: string; date: string; daysToPrint: number; stage: string | null; rs21: number | null; hour?: string }[] }>('event-radar'))!
    expect(radar).toBeDefined()
    expect(radar.date).toBe(today)
    const nvda = radar.entries.find(e => e.sym === 'NVDA')!
    expect(nvda).toBeDefined()
    expect(nvda.daysToPrint).toBe(3) // print is three days out
    expect(nvda.date).toBe(printDate)
    expect(nvda.hour).toBe('amc')
    expect(nvda.stage).not.toBeNull() // real candle history → a real technical stage going in
    expect(radar.entries.find(e => e.sym === 'OFFPOOL')).toBeUndefined() // not a candidate → not on the radar
  })
})

describe('gradeOutstanding', () => {
  it('migrates the bounded index into a durable pending queue so old calls cannot age out ungraded', async () => {
    const store = memoryStore()
    const date = new Date(shorty[240].t * 1000).toISOString().slice(0, 10)
    const planted = {
      id: `${date}:NVDA:short`, date, sym: 'NVDA', side: 'short', composite: -38.9,
      regime: 'amber', probability: 0.67, provisional: false, grade: 'A',
      priceAtPrediction: shorty[239].c, entry: shorty[239].c,
      stop: shorty[239].c * 1.1, target: shorty[239].c * 0.9,
      instrument: null, factors: { technical: { score: -30, detail: '', weight: 1 } },
    } as unknown as Prediction
    await store.write(`predictions:${date}`, [planted])
    const fillers = Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`)
    await store.write('predictions-index', [date, ...fillers])

    expect((await gradeOutstanding(store, deps(), NOW, null)).graded).toBe(1)
    // 5d and 10d graded; the date legitimately stays pending until the 21d
    // (month-scale) outcome can mature — the fixture has only 19 bars after entry
    expect(await store.read('predictions-pending')).toEqual([date])
    expect((await store.read<Prediction[]>(`predictions:${date}`))![0].outcome10).toBeDefined()
    expect((await store.read<Prediction[]>(`predictions:${date}`))![0].outcome21).toBeUndefined()
  })

  it('keeps temporarily unreadable predictions pending instead of silently dropping them', async () => {
    const store = memoryStore()
    const date = '2026-01-01'
    await store.write(`predictions:${date}`, [{ id: `${date}:BAD:long`, date, sym: 'BAD', side: 'long' }])
    await store.write('predictions-index', [date])

    expect((await gradeOutstanding(store, deps(), NOW, null)).graded).toBe(0)
    expect(await store.read('predictions-pending')).toEqual([date])
  })

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
    // a WATCH-ONLY companion call on the same tape: graded and calibrated like
    // any published call, but it must never feed the risk ladder's counters
    const watchPlanted: Partial<Prediction> = {
      ...planted,
      id: `${date}:XLK:short`,
      sym: 'XLK',
      grade: 'C',
      watchOnly: true,
      riskPct: 0,
      setup: 'continuation',
    }
    await store.write(`predictions:${date}`, [planted, watchPlanted])
    await store.write('predictions-index', [date])
    await store.write('engine-calibration', calWith('short:amber:25-40'))

    const { graded } = await gradeOutstanding(store, deps(), NOW, null)
    expect(graded).toBe(2) // both graded — the learning loop eats everything published

    const preds = (await store.read<Prediction[]>(`predictions:${date}`))!
    expect(preds[0].outcome5).toBeDefined()
    expect(preds[0].outcome5!.hit).toBe(true) // falling knife kept falling, stop never touched
    expect(preds[0].outcome10).toBeDefined()
    expect(preds[1].outcome5).toBeDefined() // the watch call is graded too

    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['short:amber:25-40']).toEqual({ n: 22, hits: 16 }) // both outcomes booked
    expect(cal.setupBuckets!['continuation:short:25-40']).toEqual({ n: 1, hits: 1 }) // setup stats accrue
    expect(cal.brier).toHaveLength(1)

    const risk = (await store.read<{ gradedAtRung: number }>('risk-state'))!
    expect(risk.gradedAtRung).toBe(1) // ONLY the actionable call counts toward the rung
    const scorecard = (await store.read<{ byGrade: Record<string, { n: number }>; bySetup: Record<string, { n: number }> }>('engine-scorecard'))!
    expect(scorecard.byGrade.A.n).toBe(1)
    expect(scorecard.byGrade.C.n).toBe(1)
    expect(scorecard.bySetup.continuation.n).toBe(1)
  })

  it('production migration: a legacy rung-0 risk-state + cohortless seeded calibration load and behave; a known-cap grade books into its cohort bucket', async () => {
    const store = memoryStore()
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
      capUsdM: 50_000, // LARGE cohort — the grade must book into the large bucket
      factors: { technical: { score: -30, detail: '', weight: 1 } } as never,
    }
    await store.write(`predictions:${date}`, [planted])
    await store.write('predictions-index', [date])
    // EXACTLY the shapes live in production today: a cohortless, seeded calibration
    // blob and a rung-0 risk-state with no `cohorts`.
    await store.write('engine-calibration', { buckets: { 'short:amber:25-40': { n: 20, hits: 14 } }, brier: [], seeded: true, defVersion: CALIB_DEF_VERSION })
    await store.write('risk-state', { rung: 0, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })

    const { graded } = await gradeOutstanding(store, deps(), NOW, null)
    expect(graded).toBe(1)

    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['large:short:amber:25-40']).toEqual({ n: 1, hits: 1 }) // NEW cohort bucket written
    expect(cal.buckets['short:amber:25-40']).toEqual({ n: 20, hits: 14 }) // cohortless SEED preserved, never discarded
    expect(cal.seeded).toBe(true)

    const risk = (await store.read<RiskState>('risk-state'))!
    expect(risk.cohorts).toBeDefined() // migrated in place
    expect(risk.cohorts!.large.gradedAtRung).toBe(1) // the one large grade counted to its own sleeve
    expect(risk.cohorts!.small.gradedAtRung).toBe(0) // small sleeve untouched
    expect(risk.gradedAtRung).toBe(1) // combined counter still advances (back-compat)
  })
})

describe('traceOpenIdeas', () => {
  it('traces open live calls only — shadows and graded calls excluded — and reads re-qualification off today’s board', async () => {
    const store = memoryStore()
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    // call planted 3 bars from the end of the bleed: entry 166, closes 166→164→162
    const date = new Date(shorty[257].t * 1000).toISOString().slice(0, 10)
    const base = (over: Partial<Prediction>): Partial<Prediction> => ({
      id: `${date}:NVDA:long`,
      date,
      sym: 'NVDA',
      side: 'long',
      grade: 'B',
      entry: shorty[257].c,
      stop: shorty[257].c * 0.8,
      target: shorty[257].c * 1.2,
      ...over,
    })
    await store.write(`predictions:${date}`, [
      base({}), // open live → traced
      base({ id: `${date}:NVDA:short`, side: 'short', shadow: true }), // shadow → never traced
      base({ id: `${date}:WCHY:long`, sym: 'WCHY', watchOnly: true }), // watch-only → not a position, never traced
      base({ id: `${date}:AAPL:long`, sym: 'AAPL', outcome10: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true } }), // graded (10d) → done
    ])
    await store.write('predictions-index', [date])
    await store.write('engine-board', { date: today, board: [{ sym: 'NVDA', side: 'long' }] })

    const { traced } = await traceOpenIdeas(store, deps(), NOW)
    expect(traced).toBe(1)

    const blob = (await store.read<{ date: string; entries: OpenTraceEntry[] }>('open-trace'))!
    expect(blob.date).toBe(today)
    const e = blob.entries[0]
    expect(e.sym).toBe('NVDA')
    expect(e.status).toBe('in-play') // drifting down but inside the wide stop
    expect(e.day).toBe(3)
    expect(e.movePct).toBeLessThan(0)
    expect(e.requalified).toBe(true)
    expect(e.verdict).toBe('still-on') // re-qualified beats the drift
  })
})
