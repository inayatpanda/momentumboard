import { describe, expect, it } from 'vitest'
import { buildBoard, gradeOutstanding, traceOpenIdeas, type EngineDeps } from './engine'
import type { OpenTraceEntry } from '../../../shared/engine/openTrace'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, initWeights, type CalibrationState, type WeightsState } from '../../../shared/engine/calibration'
import { RUNG_RISK_PCT, type RiskState } from '../../../shared/engine/riskLadder'
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

// The same rolled-over skeleton, each copy oscillating at its own frequency, so
// five of them are five genuinely different bets (60-day return correlation
// under 0.1) rather than one bet in five tickers. Used to overflow the 3-a-side
// trade cap WITHOUT the correlation gate doing the culling instead.
const shortyVariant = (k: number) => mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2) * (1 + 0.04 * Math.sin(i * k)))
const flat = mk(() => 500)
const NOW = Math.floor(shorty[shorty.length - 1].t + 86_400) // day after the last bar

// A CALM megacap bleed: −0.5%/day. Capacity 4.9% — under the roster's join gate
// (8) AND under the ordinary composite capacity floor (6), but over the sleeve
// floor (3). Exactly the shape the sleeve exists for: a famous name that moved
// meaningfully for itself without ever being volatile enough to be "a mover".
const calmSlide = mk(i => 100 * Math.pow(0.995, i))

// The mirror image: a calm +0.5%/day grind higher. Same ~4.9% capacity, so the
// core read is strong and the CAPACITY gate is what kills it — a candidate that
// dies at the gates with a real, nameable core composite. The never-blank
// board's long-side near miss.
const calmClimb = mk(i => 100 * Math.pow(1.005, i))

// GLW's dip tape: 60 calm sessions at 100, a slide to 85, then a volume-paid
// reclaim to 88 — dipLane's 'holding' signature (−12% off the 20-session high,
// 4.1% off the dip low on 1.6× volume). Composites as a SHORT (or as nothing —
// capacity is 0 here), which is precisely why the dip lane builds its own long.
// The same tape parametrised by its LAST close, so a test can dial the dip's
// DEPTH: dropPct = 100 − final. Holding needs final ≥ low × 1.03 (3% off the dip
// low) and triggering needs final ≤ 88 (12% under the 20-session high of 100).
// `low` moves the dip's floor, which is what lets a test build a dip DEEPER than
// the 12.96% ceiling the default 84.5 low imposes — needed to queue five names
// ahead of the −14.3% collision tape below.
const dipTapeAt = (final: number, low = 84.5): Candle[] => {
  const bars: Candle[] = []
  const push = (c: number, v = 1_000_000, o = c, h = c, l = c) => bars.push({ t: T0 + bars.length * 86_400, o, h, l, c, v })
  for (let i = 0; i < 60; i++) push(100)
  push(94)
  push(90)
  push(87)
  push(low + 0.5, 1_000_000, low + 1.5, low + 1.5, low)
  push(low + 1)
  push(final, 1_600_000)
  return bars
}
const dipTape: Candle[] = dipTapeAt(88)

// A rolled-over name whose LAST session is a volume-paid bounce off the low:
// −14.3% under the 20-session high, no new 5-session low, +6% off the dip low on
// 1.6× volume. classifyDip reads a triggered AND holding dip; the composite,
// reading the same candles, still sees a 19%-below-the-50-day 'weak' chart and
// calls a SHORT. One tape, two lanes, opposite sides — the collision.
const dipAndShortTape: Candle[] = (() => {
  const bars = mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2), 259)
  const prev = bars[bars.length - 1]
  const c = prev.c * 1.045
  bars.push({ t: prev.t + 86_400, o: prev.c, h: c, l: prev.c * 0.995, c, v: 1_600_000 })
  return bars
})()

// The same rolled-over name, but today OPENED with an −10% gap and closed the
// hole. classifyDip still reads triggered AND holding (the gap is trigger B, the
// close is 6% off the dip low on 1.6× volume, no new 5-session low) — but dipCall
// REFUSES it: the stop has to hide under today's 144 low while the half-retrace
// target sits ~14 above a 171 entry. Risking 27 to make 14 is a negative edge, so
// the dip lane publishes NOTHING. The composite, reading the same closes, still
// calls the identical live short — and that short must survive.
const dipNoRewardTape: Candle[] = (() => {
  const bars = mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2), 259)
  const prev = bars[bars.length - 1]
  const c = prev.c * 1.045
  bars.push({ t: prev.t + 86_400, o: prev.c * 0.9, h: c, l: prev.c * 0.88, c, v: 1_600_000 })
  return bars
})()

// GLW is in DEFAULT_CORE_SLEEVE, in no SECTOR_MEMBERS list and matches no theme,
// so anything it does on the board can only have arrived through the sleeve.
const sparkOf = (tape: Candle[], sym = 'GLW') => async () => new Map([[sym, tape.map(c => c.c)]])

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
  social: async () => [],
  // no sleeve prices by default → sleeveActive false → every sleeve behaviour off,
  // so every pre-sleeve test below runs exactly the engine it was written against
  sparkCloses: async () => new Map<string, number[]>(),
  insiderCoverage: async () => new Map(),
  smartMoney: async () => [],
  mediaTitles: async () => ['[Bloomberg] NVDA plunges as demand warns mount'],
  newsCatalysts: async () => [], // no LLM catalysts by default
  // the dip-news lane checks nothing by default, so every pre-5b test runs the
  // engine it was written against: an unchecked dip still trades, honestly labelled.
  // The cache is EMPTY by default — every candidate is a miss, so the budget tests
  // below measure fresh reads and nothing else.
  dipNewsCached: async () => null,
  dipNews: async () => ({ verdict: 'unclear', reason: 'stub' }),
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
    // BIG is routable and shorts live, so the short side is NOT empty — the
    // 2026-08-12 observation rank (which only rescues a nameless side) stays out
    // of the way and the anti-clutter rule governs, exactly as it always has.
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { BIG: { short2x: 'INV' } } }) // no route for NVDA
    await store.write('engine-calibration', calWith('short:amber:55-70')) // would otherwise grade an A live short
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    // NVDA priced as a small-cap ($800M < $2B): an ISA can't route a short on it
    const smallCapScreen = async () => [
      { row: { sym: 'NVDA', price: 162, capUsdM: 800, changePct: null, name: null }, source: 'screener:gainers' as const },
      { row: { sym: 'BIG', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' as const },
    ]
    const withBig = deps({
      screens: smallCapScreen,
      candles: async sym =>
        sym === 'NVDA' || sym === 'BIG' || sym === 'XLK' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : null,
    })
    const { board } = await buildBoard(store, withBig, NOW)
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

  it('a prior LIVE call holds no shadow slot: yesterday’s ungraded trade never swallows today’s shadow', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    // Yesterday's NVDA short was a real, live, sized call and is still ungraded —
    // exactly what an open position looks like on day 2. The dedup exists to stop
    // three correlated SHADOWS crowding the shadow budget; a live call occupies
    // none of it. Counting it made today's shadow vanish from the ledger entirely,
    // which silently discarded the rows the budget exists to collect.
    const priorDate = '2026-05-01'
    await store.write('predictions-index', [priorDate])
    await store.write(`predictions:${priorDate}`, [{ id: `${priorDate}:NVDA:short`, sym: 'NVDA', side: 'short', shadow: undefined }])

    await buildBoard(store, deps({ earningsSyms: async () => new Set(['NVDA']) }), NOW)
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.find(p => p.sym === 'NVDA' && p.shadow)).toBeDefined()
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

  it('grade C on THIN evidence stays WATCH-ONLY: on the board with riskPct 0, no instrument — an observation, not a trade', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'SNVD' } } })
    // bucket edges past the base rate but under B: laplace (11+2)/(20+4)=0.54 → C.
    // No QQQ candles → the regime read is 'unknown' → the evidence contract fails.
    // C plus a failed contract is the ONE combination that still carries no size.
    await store.write('engine-calibration', { buckets: { 'short:unknown:55-70': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('risk-state', { rung: 1, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const noQqq = deps({ candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null) })
    const { board, regime } = await buildBoard(store, noQqq, NOW)
    expect(regime).toBe('unknown')
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined() // still published — the day is never blank just because nothing qualified
    expect(call.grade).toBe('C')
    expect(call.evidence.contract).toBe(false)
    expect(call.watchOnly).toBe(true)
    expect(call.riskPct).toBe(0) // no size for a watch idea
    expect(call.instrument).toBeNull() // even though rung+levMap would have unlocked SNVD
    expect(call.shadow).toBeUndefined() // visible and graded, unlike a shadow
    const publicBoard = (await store.read<{ board: Prediction[] }>('engine-board'))!
    expect(publicBoard.board.find(p => p.sym === 'NVDA')?.watchOnly).toBe(true)
  })

  it('grade C WITH the contract is a HALF-SIZE trade: sized, no instrument, not paper-only (a plain share buy)', async () => {
    const store = memoryStore()
    // the dip lane's long carries a full evidence contract by construction; this
    // calibration rates its band barely over the base rate → grade C. Until
    // 2026-08-11 that combination published unsized; now it is a trade at half
    // the rung's risk — a real setup the calibration merely rates modestly. [R12][R14]
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { long2x: 'GLW2' } } })
    await store.write('engine-calibration', { buckets: { 'long:amber:25-40': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('risk-state', { rung: 3, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] }) // the top rung: leverage is only ever withheld by the GRADE
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? dipTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      capUsdM: async sym => (sym === 'GLW' ? 35_000 : null),
      sparkCloses: sparkOf(dipTape),
    })
    const { board } = await buildBoard(store, d, NOW)
    const call = board.find(b => b.sym === 'GLW')!
    expect(call).toBeDefined()
    expect(call.grade).toBe('C')
    expect(call.evidence.contract).toBe(true)
    expect(call.watchOnly).toBeUndefined() // a trade, not an observation
    expect(call.riskPct).toBe(RUNG_RISK_PCT[call.riskRung] / 2)
    expect(call.riskPct).toBeGreaterThan(0)
    expect(call.instrument).toBeNull() // C never unlocks leverage — riskLadder untouched
    expect(call.paperOnly).toBe(false) // a long at C is a plain share buy, fully placeable
    expect(call.horizon).toBe('week') // sized rows run on the calibrated clock
  })

  it('an A/B call that fails the contract trades at HALF size and names the gap in its evidence', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'SNVD' } } })
    // no QQQ → regime 'unknown' → the contract fails on the missing regime leg,
    // while the band itself has proven itself → grade A on thin evidence.
    await store.write('engine-calibration', calWith('short:unknown:55-70'))
    await store.write('risk-state', { rung: 2, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const noQqq = deps({ candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null) })
    const { board } = await buildBoard(store, noQqq, NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined()
    expect(call.grade).toBe('A')
    expect(call.evidence.contract).toBe(false)
    expect(call.watchOnly).toBeUndefined() // it acts — at half the size
    expect(call.riskPct).toBe(RUNG_RISK_PCT[call.riskRung] / 2)
    expect(call.evidence.detail.length).toBeGreaterThan(0) // the UI can say WHAT is missing
    expect(call.instrument).toBeNull() // rung 2 + an A would route SNVD — leverage needs the FULL contract
    expect(call.paperOnly).toBe(true) // an unrouted short is honestly paper-only
  })

  it('unpicked actionable calls fall THROUGH to the watch list, not into the void', async () => {
    const store = memoryStore()
    // five uncorrelated rolled-over names, all half-size C trades (empty
    // calibration → base rate 0.5 → every band grades C; the contract passes on
    // breadth + two agreeing core families). Five actionable rows, three slots.
    const fives: [string, number][] = [['AAA', 0.7], ['BBB', 1.1], ['CCC', 1.9], ['DDD', 2.5], ['EEE', 1.5]]
    const tapes = new Map(fives.map(([sym, k]) => [sym, shortyVariant(k)]))
    const syms = fives.map(([sym]) => sym)
    await store.write('config', {
      watchlist: syms.map(symbol => ({ symbol })),
      rules: [],
      ytChannels: [],
      levMap: Object.fromEntries(syms.map(s => [s, { short2x: `I${s}` }])),
    })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION })
    // six flat fillers so the candidate pool clears breadthAbove50's 10-series
    // minimum — breadth known is the confirming leg that lets the contract pass
    const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']
    const d = deps({
      screens: async () =>
        [...syms, ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' as const })),
      mediaTitles: async () => [],
      candles: async sym => tapes.get(sym) ?? (fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
    })
    const { board } = await buildBoard(store, d, NOW)
    const shown = board.filter(b => syms.includes(b.sym))
    expect(shown).toHaveLength(5) // every one of them is NAMED — the trade cap demotes, it does not delete
    const trades = shown.filter(b => !b.watchOnly)
    expect(trades).toHaveLength(3) // at most three trades a side
    for (const t of trades) expect(t.riskPct).toBeGreaterThan(0)
    const fellThrough = shown.filter(b => b.watchOnly)
    expect(fellThrough).toHaveLength(2)
    for (const w of fellThrough) {
      expect(w.riskPct).toBe(0) // demoted rows carry no size…
      expect(w.instrument).toBeNull() // …and no route
      expect(w.paperOnly).toBe(false) // a watch row is nobody's position
      expect(w.shadow).toBeUndefined() // visible, not buried
    }
    // and they reach the LEDGER too — a demoted call is still a call the engine
    // made, so its outcome must come back and teach the buckets
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`))!
    expect(ledger.filter(p => syms.includes(p.sym))).toHaveLength(5)
  })

  it('a day where every candidate dies at the gates still NAMES the nearest misses', async () => {
    const store = memoryStore()
    await store.write('config', {
      watchlist: [{ symbol: 'CALM' }, { symbol: 'RISE' }, { symbol: 'DROP' }],
      rules: [],
      ytChannels: [],
      levMap: { CALM: { short2x: 'ICLM' } }, // DROP deliberately has no short route
    })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION }) // base rate 0.5
    const d = deps({
      screens: async () => [],
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'CALM' || sym === 'DROP' ? calmSlide : sym === 'RISE' ? calmClimb : sym === 'SPY' || sym === 'QQQ' ? flat : null,
    })
    const { board } = await buildBoard(store, d, NOW)
    expect(board.length).toBeGreaterThan(0) // NEVER blank
    const long = board.find(b => b.sym === 'RISE')!
    const short = board.find(b => b.sym === 'CALM')!
    expect(long).toBeDefined()
    expect(short).toBeDefined()
    expect(long.side).toBe('long')
    expect(short.side).toBe('short')
    for (const row of [long, short]) {
      expect(row.nearMiss).toBe(true)
      expect(row.watchOnly).toBe(true)
      expect(row.riskPct).toBe(0)
      expect(row.grade).toBe('C')
      expect(row.probability).toBe(0.5) // the engine's own base rate, not a bucket read it never earned
      expect(row.entry).toBeGreaterThan(0) // real levels off lastClose/ATR
      expect(row.note).toContain('nearest miss')
      expect(row.evidence.contract).toBe(false)
    }
    // RATIFIED: the only-placeable-shorts rule governs SIZED CALLS. A near miss is
    // an observation, so an unroutable short is shown — and says so in the open.
    const unroutable = board.find(b => b.sym === 'DROP')!
    expect(unroutable).toBeDefined()
    expect(unroutable.nearMiss).toBe(true)
    expect(unroutable.riskPct).toBe(0)
    expect(unroutable.instrument).toBeNull()
    expect(unroutable.note).toContain('no ISA route — observation only')
    expect(unroutable.evidence.detail).toContain('no ISA route — observation only')
    expect(short.note).not.toContain('no ISA route') // CALM has a route: no false label
    const blob = (await store.read<{ board: Prediction[] }>('engine-board'))!
    expect(blob.board.filter(p => p.nearMiss).length).toBeGreaterThanOrEqual(2)
    // …but the LEDGER stays clean: a row that cleared no gate must never teach the
    // calibration buckets, the IC loop or the Brier trail.
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const ledger = (await store.read<Prediction[]>(`predictions:${today}`)) ?? []
    expect(ledger.some(p => p.nearMiss)).toBe(false)
  })

  // THE FOURTH BLANK-BOARD PATH: nothing clears the gates AND every core read is
  // negative AND no name has an inverse-ETP route. Suppressing unroutable short
  // near misses used to empty the board completely on exactly that day.
  it('an all-negative day with NO short routes still fills the board — labelled, never blank', async () => {
    const store = memoryStore()
    await store.write('config', {
      watchlist: [{ symbol: 'CALM' }, { symbol: 'DROP' }],
      rules: [],
      ytChannels: [],
      levMap: {}, // not one routable short anywhere
    })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION })
    const d = deps({
      screens: async () => [],
      mediaTitles: async () => [],
      // every candidate bleeds → every core read is negative → no long side at all
      candles: async sym => (sym === 'CALM' || sym === 'DROP' ? calmSlide : sym === 'SPY' || sym === 'QQQ' ? flat : null),
    })
    const { board } = await buildBoard(store, d, NOW)

    expect(board.length).toBeGreaterThan(0) // the whole point: NEVER blank
    expect(board.every(b => b.side === 'short')).toBe(true)
    expect(board.every(b => b.nearMiss)).toBe(true)
    for (const row of board) {
      expect(row.watchOnly).toBe(true)
      expect(row.riskPct).toBe(0) // an observation is never sized
      expect(row.instrument).toBeNull()
      expect(row.note).toContain('no ISA route — observation only')
      expect(row.entry).toBeGreaterThan(0)
    }
    // …and the ledger stays clean: nothing here ever teaches the engine
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    expect(((await store.read<Prediction[]>(`predictions:${today}`)) ?? []).some(p => p.nearMiss)).toBe(false)
  })

  it('near misses only fill an EMPTY side — a side with a real row is left alone', async () => {
    const store = memoryStore()
    await store.write('config', {
      watchlist: [{ symbol: 'RISE' }],
      rules: [],
      ytChannels: [],
      levMap: { NVDA: { short2x: 'SNVD' } },
    })
    await store.write('engine-calibration', calWith('short:amber:55-70')) // NVDA shorts grade A
    const d = deps({
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'NVDA' ? shorty : sym === 'RISE' ? calmClimb : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null,
    })
    const { board } = await buildBoard(store, d, NOW)
    expect(board.find(b => b.sym === 'NVDA' && !b.watchOnly)).toBeDefined() // the short side has a real trade
    expect(board.some(b => b.side === 'short' && b.nearMiss)).toBe(false) // …so no short near miss is invented
    expect(board.find(b => b.sym === 'RISE')?.nearMiss).toBe(true) // the empty long side still gets named
  })

  // ---- the observation rank: a gate-clearing unroutable short beats a near miss ----
  // Ratified 2026-08-12. The 2026-07-24 anti-clutter rule ("only show shorts I can
  // place") governs SIZED calls, and still does: nothing below carries size, route
  // or an offer to trade. But when the side would otherwise be nameless, a graded,
  // fully-evidenced short is a far better answer than a row that cleared nothing.
  it('an unroutable short that cleared EVERY gate is shown as a labelled observation, and near misses are not used', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [{ symbol: 'RISE' }], rules: [], ytChannels: [], levMap: {} }) // NVDA has NO inverse ETP
    await store.write('engine-calibration', calWith('short:amber:55-70')) // …but it grades A
    const d = deps({
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'NVDA' ? shorty : sym === 'RISE' ? calmClimb : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null,
    })
    const { board } = await buildBoard(store, d, NOW)

    const nvda = board.find(b => b.sym === 'NVDA')!
    expect(nvda).toBeDefined()
    expect(nvda.side).toBe('short')
    expect(nvda.nearMiss).toBeUndefined() // it cleared the gates — it is not a near miss
    expect(nvda.observation).toBe(true) // …and it is stamped, so every surface can contain it without parsing prose
    expect(nvda.evidence.contract).toBe(true)
    expect(nvda.grade).toBe('C') // graded on the full contract — a half-size trade in every respect but the route
    expect(nvda.watchOnly).toBe(true) // …and still carries nothing tradeable
    expect(nvda.riskPct).toBe(0)
    expect(nvda.instrument).toBeNull()
    expect(nvda.paperOnly).toBe(false) // an observation is nobody's position
    expect(nvda.shadow).toBeUndefined()
    expect(nvda.note).toContain('no ISA route — observation only')
    expect(nvda.evidence.detail).toContain('no ISA route — observation only')
    // the near-miss machinery stands down on that side entirely
    expect(board.some(b => b.side === 'short' && b.nearMiss)).toBe(false)
    // and the board says WHY the side has nothing tradeable, in a field the copy reads
    const blob = (await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!
    expect(blob.emptySides?.short).toBe('no-route')
    // unlike a near miss, this is a real call with a real evidence read — it belongs
    // in the ledger and must go on teaching the buckets, stamp and all
    const ledgered = (await ledgerOf(store))!.find(p => p.sym === 'NVDA' && p.side === 'short')!
    expect(ledgered).toBeDefined()
    expect(ledgered.observation).toBe(true)
  })

  // ---- an observation is a ONE-OFF, not a standing entry in the ledger ----
  // The condition that hides it (no ISA route) does not expire, so nothing about
  // today's promotion stops tomorrow's: the same name would be promoted every
  // morning it emptied its side, and every copy graded as fresh live evidence —
  // several rows deep on one name, beyond the budget the shadow dedup enforces.
  // So the promotion respects that dedup: a sym:side the ledger is already
  // carrying UNGRADED — as a shadow, or as a promotion of its own — is skipped.
  describe('the observation rank never re-promotes a name the ledger has not graded yet', () => {
    const dedupStore = async (priorRow: Partial<Prediction> | null) => {
      const store = memoryStore()
      // DROP dies at the capacity gate → a real short near miss for the fallback
      await store.write('config', { watchlist: [{ symbol: 'RISE' }, { symbol: 'DROP' }], rules: [], ytChannels: [], levMap: {} })
      await store.write('engine-calibration', calWith('short:amber:55-70'))
      if (priorRow) {
        const prior = '2026-06-01'
        await store.write(`predictions:${prior}`, [{ date: prior, sym: 'NVDA', side: 'short', ...priorRow }])
        await store.write('predictions-index', [prior])
      }
      return store
    }
    const dedupDeps = deps({
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'NVDA' ? shorty : sym === 'RISE' ? calmClimb : sym === 'DROP' ? calmSlide : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null,
    })

    it('the control: with no prior row at all, NVDA is promoted exactly as before', async () => {
      const { board } = await buildBoard(await dedupStore(null), dedupDeps, NOW)
      expect(board.find(b => b.sym === 'NVDA')?.observation).toBe(true)
    })

    it('an ungraded SHADOW of the same sym:side blocks the promotion — the side falls back to near misses', async () => {
      const store = await dedupStore({ shadow: true }) // published in the dark yesterday, still ungraded
      const { board } = await buildBoard(store, dedupDeps, NOW)

      expect(board.some(b => b.sym === 'NVDA')).toBe(false) // not promoted — it stays a shadow
      const fallback = board.filter(b => b.side === 'short' && b.nearMiss)
      expect(fallback.length).toBeGreaterThan(0) // …and the side is still named
      expect(fallback.some(b => b.sym === 'DROP')).toBe(true)
      // the copy still tells the truth about WHY: the route hid it, not the gates
      expect((await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!.emptySides?.short).toBe('no-route')
      // the ledger carries ONE ungraded NVDA short — today's shadow, not a second live row
      expect((await ledgerOf(store))!.filter(p => p.sym === 'NVDA' && !p.outcome10).every(p => p.shadow === true)).toBe(true)
    })

    it('yesterday’s ungraded OBSERVATION blocks it too — a promoted row is a live ledger row, never a shadow', async () => {
      const store = await dedupStore({ observation: true, watchOnly: true }) // promoted yesterday, still ungraded
      const { board } = await buildBoard(store, dedupDeps, NOW)

      expect(board.some(b => b.sym === 'NVDA')).toBe(false)
      expect(board.some(b => b.side === 'short' && b.nearMiss)).toBe(true)
    })

    // …and blocking the promotion is only half of it. The very same row publishes
    // as a SHADOW when it is not promoted, so a rule that stopped at the promotion
    // let yesterday's ungraded observation and today's shadow of the identical
    // signal both mature into the calibration buckets — one read, counted twice.
    it('…and the SHADOW path is deduped by it too, so one signal is never graded twice', async () => {
      const store = await dedupStore({ observation: true, watchOnly: true })
      await buildBoard(store, dedupDeps, NOW)

      // nothing about NVDA enters today's ledger: not promoted, and not shadowed
      // behind yesterday's copy either
      expect((await ledgerOf(store))!.some(p => p.sym === 'NVDA')).toBe(false)
      // the control: the prior day still carries exactly one ungraded NVDA short —
      // the row the buckets are waiting on
      expect((await store.read<Prediction[]>('predictions:2026-06-01'))!.filter(p => p.sym === 'NVDA')).toHaveLength(1)
    })

    it('…and once that observation has graded, the shadow slot frees with the promotion', async () => {
      const store = await dedupStore({
        observation: true,
        watchOnly: true,
        outcome10: { excessPct: -3, rawPct: -3, spyPct: 0, stopped: false, hit: true },
      })
      await buildBoard(store, dedupDeps, NOW)
      expect((await ledgerOf(store))!.some(p => p.sym === 'NVDA')).toBe(true)
    })

    it('…but once it has GRADED, the slot is free again', async () => {
      const store = await dedupStore({ observation: true, watchOnly: true, outcome10: { excessPct: -3, rawPct: -3, spyPct: 0, stopped: false, hit: true } })
      const { board } = await buildBoard(store, dedupDeps, NOW)
      expect(board.find(b => b.sym === 'NVDA')?.observation).toBe(true)
    })
  })

  // ---- a name the dip lane is LONG cannot also host a short observation ----
  // The dip lane already publishes a sized long on GLW. Promoting the composite
  // short on the same chart would put both readings on the board at once — buy
  // this and (do not) sell it — which is not honesty, it is a contradiction. The
  // route-blocked short goes on grading in the dark, exactly as it did.
  it('the dip lane owning a name blocks the opposing short observation, even on an empty short side', async () => {
    const store = memoryStore()
    // levMap EMPTY: the composite short on GLW is route-blocked, which is the only
    // reason it shadows — precisely the row the observation rank promotes
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', {
      buckets: { 'short:amber:40-55': { n: 20, hits: 14 }, 'long:amber:25-40': { n: 20, hits: 14 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
    })
    const d = collisionDeps({ dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }) })
    const { board } = await buildBoard(store, d, NOW)

    const shown = board.filter(b => b.sym === 'GLW')
    expect(shown).toHaveLength(1) // one row on the name, not two opposing ones
    expect(shown[0].side).toBe('long')
    expect(shown[0].riskPct).toBeGreaterThan(0) // the dip long is sized and real
    expect(board.some(b => b.observation)).toBe(false) // nothing was promoted anywhere
    expect(board.some(b => b.side === 'short' && !b.nearMiss)).toBe(false)

    // the short still published and still grades — containment, not suppression
    const short = (await ledgerOf(store))!.find(p => p.sym === 'GLW' && p.side === 'short')!
    expect(short).toBeDefined()
    expect(short.shadow).toBe(true)
    expect(short.observation).toBeUndefined()
    // and the empty-side copy still refuses to blame the gates
    expect((await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!.emptySides?.short).toBe('no-route')
  })

  // ---- …but only a VISIBLE long is a contradiction ----
  // Same tape, one difference: the news reads the dip as a broken thesis, so the
  // dip long publishes as a shadow and never reaches the reader's board. Keying
  // the refusal on the dip lane's ATTEMPT then suppressed the short observation
  // too — and the reader was shown nothing whatever on a name both lanes had a
  // fully-graded read on. Nothing can contradict a row that is not on the board.
  it('a dip long the news SHADOWED no longer suppresses the short observation — the board would otherwise show nothing at all', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} }) // no inverse ETP: the short is route-blocked
    await store.write('engine-calibration', {
      buckets: { 'short:amber:40-55': { n: 20, hits: 14 }, 'long:amber:25-40': { n: 20, hits: 14 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
    })
    const d = collisionDeps({ dipNews: async () => ({ verdict: 'structural', reason: 'SEC probe into revenue recognition' }) })
    const { board } = await buildBoard(store, d, NOW)

    const shown = board.filter(b => b.sym === 'GLW' && !b.nearMiss)
    expect(shown).toHaveLength(1) // still exactly one GLW row — no contradiction was created
    expect(shown[0].side).toBe('short')
    expect(shown[0].observation).toBe(true)
    expect(shown[0].watchOnly).toBe(true)
    expect(shown[0].riskPct).toBe(0) // an observation is never sized
    expect(shown[0].instrument).toBeNull()
    expect(shown[0].note).toContain('no ISA route — observation only')
    // the vetoed dip long is nowhere near the reader's board — which is precisely
    // why the short may speak
    expect(board.some(b => b.sym === 'GLW' && b.side === 'long')).toBe(false)
    expect((await ledgerOf(store))!.find(p => p.sym === 'GLW' && p.side === 'long')!.shadow).toBe(true)
    expect((await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!.emptySides?.short).toBe('no-route')
  })

  it('…but a side WITH a live short leaves the unroutable one exactly where it was: a shadow', async () => {
    const store = memoryStore()
    await store.write('config', {
      watchlist: [{ symbol: 'SHRT' }],
      rules: [],
      ytChannels: [],
      levMap: { NVDA: { short2x: 'SNVD' } }, // NVDA routable, SHRT not
    })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    const d = deps({
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'NVDA' || sym === 'SHRT' || sym === 'XLK' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : null,
    })
    const { board } = await buildBoard(store, d, NOW)

    expect(board.some(b => b.sym === 'NVDA' && b.side === 'short' && !b.watchOnly)).toBe(true) // the side has a real trade
    expect(board.some(b => b.sym === 'SHRT')).toBe(false) // …so the unroutable one stays off the board
    const shrt = (await ledgerOf(store))!.find(p => p.sym === 'SHRT')!
    expect(shrt).toBeDefined()
    expect(shrt.shadow).toBe(true) // graded in the dark, exactly as before
    expect(shrt.note).not.toContain('no ISA route — observation only') // and never labelled as an observation
    const blob = (await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!
    expect(blob.emptySides?.short).toBeUndefined() // nothing empty about the short side
  })

  it('an unroutable short that would only have been a WATCH row still spares its side the gates line', async () => {
    // Grade C on thin evidence: with a route this row would have been shown as a
    // watch observation. It is NOT promotable — the observation rank is for rows
    // that cleared the sizing gates — but the gates are not what hid it either,
    // and "nothing cleared the gates on the short side today" is the flat
    // opposite of the truth about a row the route alone suppressed.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} }) // no inverse ETP anywhere
    // (11+2)/(20+4) = 0.54 → C; no QQQ candles → regime 'unknown' → contract fails
    await store.write('engine-calibration', { buckets: { 'short:unknown:55-70': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const noQqq = deps({ candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null) })
    const { board } = await buildBoard(store, noQqq, NOW)

    const nvda = (await ledgerOf(store))!.find(p => p.sym === 'NVDA')!
    expect(nvda.grade).toBe('C')
    expect(nvda.evidence.contract).toBe(false)
    expect(nvda.shadow).toBe(true) // the route is the only reason it is not on the board
    expect(board.some(b => b.sym === 'NVDA' && !b.nearMiss)).toBe(false) // …and it is not promoted
    const blob = (await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!
    expect(blob.emptySides?.short).toBe('no-route')
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

  // ---- the core sleeve: famous names are candidates every day ----

  const todayOf = () => new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const ledgerOf = (store: ReturnType<typeof memoryStore>) => store.read<Prediction[]>(`predictions:${todayOf()}`)

  it('a sleeve mover reaches evaluation even when no screen and no roster carry it', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    // every ordinary door is dead: no screens, no social, no headlines, no roster.
    // The spark batch is GLW's ONLY route into the run.
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: sparkOf(shorty),
    })
    await buildBoard(store, d, NOW)

    const ledger = (await ledgerOf(store))!
    expect(ledger.find(p => p.sym === 'GLW')).toBeDefined() // evaluated and published (shadow: no short route)
  })

  it('a sleeve name arriving via day_losers still reaches evaluation when it fails the roster join gate', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    // GLW's FIRST source is the losers screen, so addSource stamps 'screener:losers'
    // and the sleeve never owns the source string. Its capacity (4.9%) fails the
    // roster join gate (8) — the old engine would have scanned it and thrown it away.
    const base = {
      screens: async () => [{ row: { sym: 'GLW', price: 27, capUsdM: 35_000, changePct: -9, name: null }, source: 'screener:losers' }],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async (sym: string) => (sym === 'GLW' ? calmSlide : sym === 'SPY' || sym === 'QQQ' ? flat : null),
    }
    await buildBoard(store, deps({ ...base, sparkCloses: sparkOf(calmSlide) }), NOW)

    const ledger = (await ledgerOf(store))!
    expect(ledger.find(p => p.sym === 'GLW')).toBeDefined() // sleeve MEMBERSHIP drove the append, not the source string
    const roster = (await store.read<{ sym: string }[]>('engine-roster'))!
    expect(roster.find(r => r.sym === 'GLW')).toBeUndefined() // it genuinely failed the join gate

    // and the control: with the spark batch empty the sleeve is inert, so the same
    // screener row is scanned and dropped exactly as it was before this feature
    const store2 = memoryStore()
    await store2.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' } } })
    await store2.write('engine-calibration', calWith('short:amber:25-40'))
    await buildBoard(store2, deps(base), NOW)
    expect((await ledgerOf(store2))!.find(p => p.sym === 'GLW')).toBeUndefined()
  })

  it('sleeve names are not written into the roster', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    // GLW and NVDA ride the SAME qualifying tape (capacity ~9, liquid, priced).
    // NVDA came through the screener and joins; GLW came only through the sleeve
    // and must not — the roster is the engine's earned hunting ground, not a
    // dumping ground for 130 permanently-watched names.
    const d = deps({
      candles: async sym =>
        sym === 'GLW' || sym === 'NVDA' || sym === 'XLK' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : null,
      sparkCloses: sparkOf(shorty),
    })
    await buildBoard(store, d, NOW)

    const roster = (await store.read<{ sym: string }[]>('engine-roster'))!
    expect(roster.find(r => r.sym === 'NVDA')).toBeDefined() // same tape, ordinary door → earns its slot
    expect(roster.find(r => r.sym === 'GLW')).toBeUndefined() // sleeve-only → evaluated, never enrolled
    const rows = (await ledgerOf(store))!
    expect(rows.find(p => p.sym === 'GLW')).toBeDefined() // …and still evaluated

    // Row ids are `${date}:${sym}:${side}` and the ledger is written by id-keyed
    // merge on a rerun — a duplicate id would silently overwrite a real row and
    // hide one lane's call. The sleeve appends to evalRows, so this is exactly
    // where a double-evaluation would show up.
    expect(new Set(rows.map(p => p.id)).size).toBe(rows.length)
  })

  it('door order is not overwritten by the sleeve: a sleeve name that ALSO came through a screen keeps that source and its roster slot', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    // GLW and MMM are both sleeve members riding the SAME qualifying tape. GLW
    // additionally arrives through the losers screen — addSource stamps the FIRST
    // door, and the sleeve door is added LAST precisely so it can never overwrite
    // it. That matters twice: the roster's sleeve-only filter is an exact string
    // test on the source, and the cap-enrichment budget now orders on it too.
    const d = deps({
      screens: async () => [{ row: { sym: 'GLW', price: 164, capUsdM: 35_000, changePct: -9, name: null }, source: 'screener:losers' }],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' || sym === 'MMM' ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: async () => new Map([['GLW', shorty.map(c => c.c)], ['MMM', shorty.map(c => c.c)]]),
    })
    await buildBoard(store, d, NOW)

    const roster = (await store.read<{ sym: string; source: string }[]>('engine-roster'))!
    const glw = roster.find(r => r.sym === 'GLW')
    expect(glw).toBeDefined() // the screen door earned it a slot — the sleeve must not evict it
    expect(glw!.source).toBe('screener:losers') // ORIGINAL attribution, never restamped 'sleeve'
    expect(roster.find(r => r.sym === 'MMM')).toBeUndefined() // the genuinely sleeve-only twin stays out
  })

  it('a sleeve name whose spark CHUNK failed gets no sleeve treatment — membership is what was fetched', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' }, MMM: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    // GLW and MMM are both configured sleeve members riding the SAME calm tape:
    // capacity 4.9%, under the ordinary composite floor (6) and over the sleeve
    // floor (3). fetchSparkCloses fails soft per 20-name chunk, and here GLW's
    // chunk died: the batch came back with MMM and without GLW. The sleeve floor,
    // the dip-lane quality grant and priority 4 are all privileges paid for by
    // having the data — so GLW must be read exactly as it was pre-sleeve, while
    // MMM, whose closes really did arrive, keeps every one of them.
    const base = {
      screens: async () => [
        { row: { sym: 'GLW', price: 27, capUsdM: 35_000, changePct: -9, name: null }, source: 'screener:losers' },
        { row: { sym: 'MMM', price: 27, capUsdM: 35_000, changePct: -9, name: null }, source: 'screener:losers' },
      ],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async (sym: string) => (sym === 'GLW' || sym === 'MMM' ? calmSlide : sym === 'SPY' || sym === 'QQQ' ? flat : null),
    }
    await buildBoard(store, deps({ ...base, sparkCloses: async () => new Map([['MMM', calmSlide.map(c => c.c)]]) }), NOW)

    const ledger = (await ledgerOf(store))!
    expect(ledger.find(p => p.sym === 'MMM')).toBeDefined() // fetched → a real sleeve member
    expect(ledger.find(p => p.sym === 'GLW')).toBeUndefined() // no closes behind it → no sleeve floor

    // the control: when GLW's chunk DOES come back, the identical row publishes —
    // so the assertion above is about the missing data and nothing else
    const store2 = memoryStore()
    await store2.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' }, MMM: { short2x: 'INV' } } })
    await store2.write('engine-calibration', calWith('short:amber:25-40'))
    const bothCloses = new Map([['MMM', calmSlide.map(c => c.c)], ['GLW', calmSlide.map(c => c.c)]])
    await buildBoard(store2, deps({ ...base, sparkCloses: async () => bothCloses }), NOW)
    expect((await ledgerOf(store2))!.find(p => p.sym === 'GLW')).toBeDefined()
  })

  // ---- the dip lane ----

  it('a holding dip on a quality name publishes a LONG reversal row with a dip tag', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? dipTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      capUsdM: async sym => (sym === 'GLW' ? 35_000 : null), // cap arrives via the enrichment pass
      sparkCloses: sparkOf(dipTape),
    })
    const { board } = await buildBoard(store, d, NOW)

    const call = board.find(b => b.sym === 'GLW')!
    expect(call).toBeDefined()
    expect(call.side).toBe('long') // the ordinary composite reads this chart as weakness
    expect(call.setup).toBe('reversal')
    expect(call.catalyst).toEqual({ kind: 'dip', reason: expect.stringContaining('holding') })
    expect(call.stop).toBeLessThan(call.entry)
    expect(call.target).toBeGreaterThan(call.entry)
    expect(call.capUsdM).toBe(35_000)
    expect(call.shadow).toBeUndefined()
    expect(call.grade).toBe('B') // graded on the ordinary calibration path like any call
  })

  it('dip earnings override: a dip name inside the earnings window is shadowed like any call', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? dipTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      capUsdM: async sym => (sym === 'GLW' ? 35_000 : null),
      sparkCloses: sparkOf(dipTape),
      earningsSyms: async () => new Set(['GLW']),
    })
    const { board } = await buildBoard(store, d, NOW)
    expect(board.find(b => b.sym === 'GLW')).toBeUndefined() // a coin-flip is a coin-flip in every lane

    const row = (await ledgerOf(store))!.find(p => p.sym === 'GLW')!
    expect(row).toBeDefined()
    expect(row.earningsRisk).toBe(true) // dipCall hard-codes false — the merge reads the real calendar
    expect(row.shadow).toBe(true)
    expect(row.riskPct).toBe(0)
  })

  // the collision harness: one tape both lanes read, opposite sides, GLW routable
  // so 'unshortable' can never be what shadows the short. Both bands proven and
  // total n under 50, so baseHitRate stays 0.5 and BOTH calls grade — the short is
  // a genuine live A before anything demotes it.
  const collisionStore = async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' } } })
    await store.write('engine-calibration', {
      buckets: { 'short:amber:40-55': { n: 20, hits: 14 }, 'long:amber:25-40': { n: 20, hits: 14 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
    })
    return store
  }
  const collisionDeps = (over: Partial<EngineDeps> = {}) =>
    deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? dipAndShortTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: sparkOf(dipAndShortTape),
      ...over,
    })

  it('dip evidence demotes the opposing SHORT: the long is the live row, the short shadows on (ratified 2026-08-11)', async () => {
    const store = await collisionStore()
    // an OVERREACTION read: the news agrees with the dip lane, so the two lanes
    // genuinely disagree and the dip's long is the row the reader gets
    const d = collisionDeps({ dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }) })
    const { board } = await buildBoard(store, d, NOW)

    // the reader-facing board carries ONE GLW row, and it is the dip's long
    const shown = board.filter(b => b.sym === 'GLW')
    expect(shown).toHaveLength(1)
    expect(shown[0].side).toBe('long')
    expect(shown[0].catalyst).toEqual({ kind: 'dip', reason: expect.stringContaining('holding') })
    expect(shown[0].riskPct).toBeGreaterThan(0) // a real, sized call

    const rows = (await ledgerOf(store))!.filter(p => p.sym === 'GLW')
    expect(rows).toHaveLength(2) // both lanes still published — learning intact
    expect(new Set(rows.map(p => p.id)).size).toBe(2) // sym+side ids never collide

    const short = rows.find(p => p.side === 'short')!
    expect(short.shadow).toBe(true)
    expect(short.riskPct).toBe(0)
    expect(short.instrument).toBeNull()
    expect(short.watchOnly).toBeUndefined() // shadow and watch stay mutually exclusive
    // …and nothing ELSE could have shadowed it: it graded A on a passing contract,
    // no earnings print, and a routable inverse ETP. Only the dip read did this.
    expect(short.grade).toBe('A')
    expect(short.evidence.contract).toBe(true)
    expect(short.earningsRisk).toBe(false)
  })

  it('…but a STRUCTURAL news read frees that short: the news corroborates it, so the short is the live row', async () => {
    const store = await collisionStore()
    // The dip lane and the composite disagreed on price alone. The headlines
    // settle it: the thesis broke. The dip long stands down — and demoting the
    // short too would leave the reader nothing on a name where both lanes now
    // agree it is going lower.
    const d = collisionDeps({ dipNews: async () => ({ verdict: 'structural', reason: 'SEC probe into revenue recognition' }) })
    const { board } = await buildBoard(store, d, NOW)

    const shown = board.filter(b => b.sym === 'GLW')
    expect(shown).toHaveLength(1)
    expect(shown[0].side).toBe('short') // the opposite row from the transient case above
    expect(shown[0].shadow).toBeUndefined()
    expect(shown[0].riskPct).toBeGreaterThan(0) // fully live and sized, not a survivor of a demotion
    expect(shown[0].grade).toBe('A')

    const rows = (await ledgerOf(store))!.filter(p => p.sym === 'GLW')
    expect(rows).toHaveLength(2) // both lanes still publish and still grade
    const long = rows.find(p => p.side === 'long')!
    expect(long.shadow).toBe(true) // the vetoed dip
    expect(long.catalyst!.reason).toContain('SEC probe into revenue recognition')
  })

  it('an UNREAD dip still demotes the short — unexamined price evidence stands, silence is not a release', async () => {
    const store = await collisionStore()
    // Five deeper dips (−16%…−15.6%) take the whole news budget, so GLW's own
    // −14.3% dip is never read. 'budget' is not a verdict about GLW: the dip
    // evidence against the short is exactly as strong as it was before the news
    // lane existed, so the 5g demotion must still apply.
    const deeper = new Map<string, Candle[]>([
      ['MMM', dipTapeAt(84.0, 80)],
      ['DOW', dipTapeAt(84.1, 80)],
      ['FCX', dipTapeAt(84.2, 80)],
      ['NEM', dipTapeAt(84.3, 80)],
      ['OXY', dipTapeAt(84.4, 80)],
    ])
    const sparked = new Map<string, Candle[]>([...deeper, ['GLW', dipAndShortTape]])
    const asked: string[] = []
    const d = collisionDeps({
      candles: async sym => deeper.get(sym) ?? (sym === 'GLW' ? dipAndShortTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: async () => new Map([...sparked].map(([sym, t]) => [sym, t.map(c => c.c)])),
      dipNews: async sym => {
        asked.push(sym)
        return { verdict: 'transient', reason: 'sector sympathy' }
      },
    })
    const { board } = await buildBoard(store, d, NOW)

    expect(asked).toHaveLength(5)
    expect(asked).not.toContain('GLW') // shallower than all five — over budget

    const rows = (await ledgerOf(store))!.filter(p => p.sym === 'GLW')
    const short = rows.find(p => p.side === 'short')!
    expect(short.shadow).toBe(true)
    expect(short.riskPct).toBe(0)
    expect(board.find(b => b.sym === 'GLW' && b.side === 'short')).toBeUndefined()
    expect(rows.find(p => p.side === 'long')!.catalyst!.reason).toContain('budget')
  })

  it('a dip the lane REFUSED to trade demotes nothing: the composite short stays live', async () => {
    const store = await collisionStore()
    // The tape is triggered AND holding, so classifyDip reads a dip and the old
    // rule (keyed on dipReads) demoted the short beside it. But dipCall declined
    // the shape on the 1:1 reward-to-risk gate, so the dip long never published:
    // demoting the short left the reader with NO live call at all on a name the
    // engine had a perfectly good, routable, grade-A short on.
    const asked: string[] = []
    const d = collisionDeps({
      candles: async sym => (sym === 'GLW' ? dipNoRewardTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: sparkOf(dipNoRewardTape),
      dipNews: async sym => {
        asked.push(sym)
        return { verdict: 'transient', reason: 'sector sympathy' }
      },
    })
    const { board } = await buildBoard(store, d, NOW)

    const rows = (await ledgerOf(store))!.filter(p => p.sym === 'GLW')
    expect(rows.map(p => p.side)).toEqual(['short']) // the dip long really was never constructed
    expect(asked).toEqual([]) // …so no news read was ever spent on it either

    const shown = board.filter(b => b.sym === 'GLW')
    expect(shown).toHaveLength(1)
    expect(shown[0].side).toBe('short')
    expect(shown[0].shadow).toBeUndefined() // NOT demoted — nothing opposed it
    expect(shown[0].riskPct).toBeGreaterThan(0)
    expect(shown[0].grade).toBe('A')
    expect(shown[0].evidence.contract).toBe(true)
  })

  it('a WATCH-ONLY dip long demotes nothing: a zero-size observation never costs the reader the only sized row', async () => {
    // Ratified 2026-08-12. Same collision tape, but the LONG bucket has no history,
    // so the dip long publishes below the engine's base rate: visible, graded,
    // carrying no size. Trading it is not on offer — and demoting a live, routable,
    // fully-evidenced short in its favour would leave the reader an observation
    // where a sized call used to be. The disagreement is real; the cure was worse.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' } } })
    // the long bucket exists and is BAD: the dip long is rated below the engine's
    // own base rate, which is exactly the belowBase → watch-only path
    await store.write('engine-calibration', {
      buckets: { 'short:amber:40-55': { n: 20, hits: 14 }, 'long:amber:25-40': { n: 20, hits: 4 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
    })
    const d = collisionDeps({ dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }) })
    const { board } = await buildBoard(store, d, NOW)

    const long = board.find(b => b.sym === 'GLW' && b.side === 'long')!
    expect(long).toBeDefined()
    expect(long.catalyst?.kind).toBe('dip') // the dip really did construct and publish…
    expect(long.watchOnly).toBe(true) // …as an observation nobody can take
    expect(long.riskPct).toBe(0)

    const short = board.find(b => b.sym === 'GLW' && b.side === 'short')!
    expect(short).toBeDefined()
    expect(short.shadow).toBeUndefined() // NOT demoted
    expect(short.riskPct).toBeGreaterThan(0) // the day's only sized row survives
    expect(short.watchOnly).toBeUndefined()
  })

  it('a dip long that loses the SLOT CUT demotes nothing either: the guard reads the final sized state', async () => {
    // The F3 hole. GLW's dip long is sized when it publishes — grade B, real risk
    // — so the pre-cut read of "sized" said yes and the composite short was
    // shadowed. Then the trade cut ran: OXY's deeper dip took the long slot and
    // GLW, moving in lockstep with it, was culled by the correlation gate into a
    // zero-size watch row. The morning ended in exactly the state F3 forbids — an
    // unplaceable observation on the board and a routable, grade-A short hidden
    // behind it. The demotion now runs AFTER the cut, on the state the reader gets.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' } } })
    await store.write('engine-calibration', {
      // OXY's deeper dip composites at 41.4 (the 40-55 band), GLW's at 39.3 — both
      // bands proven, so BOTH dip longs are genuinely sized before the cut speaks.
      // Each bucket clears MIN_BUCKET_N (15) and the three together stay under the
      // 50 observations baseHitRate needs, so the base rate is still 0.5 and a
      // 0.67 bucket really is an edge over it.
      buckets: {
        'short:amber:40-55': { n: 16, hits: 11 },
        'long:amber:25-40': { n: 16, hits: 11 },
        'long:amber:40-55': { n: 16, hits: 11 },
      },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
    })
    // the same rolled-over-and-bounced shape as GLW, bouncing less: a DEEPER dip
    // (16.4% vs 14.3%) on a 60-day return path that is all but identical
    const deeperTwin: Candle[] = (() => {
      const bars = mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2), 259)
      const prev = bars[bars.length - 1]
      const c = prev.c * 1.02
      bars.push({ t: prev.t + 86_400, o: prev.c, h: c, l: prev.c * 0.995, c, v: 1_600_000 })
      return bars
    })()
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'GLW' ? dipAndShortTape : sym === 'OXY' ? deeperTwin : sym === 'SPY' || sym === 'QQQ' ? flat : null,
      sparkCloses: async () =>
        new Map([
          ['GLW', dipAndShortTape.map(c => c.c)],
          ['OXY', deeperTwin.map(c => c.c)],
        ]),
      dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }),
    })
    const { board } = await buildBoard(store, d, NOW)

    // the deeper dip took the day's long slot…
    const oxy = board.find(b => b.sym === 'OXY' && b.side === 'long')!
    expect(oxy).toBeDefined()
    expect(oxy.riskPct).toBeGreaterThan(0)

    // …and GLW's dip long, sized when it published, ended the assembly unsized
    const long = board.find(b => b.sym === 'GLW' && b.side === 'long')!
    expect(long).toBeDefined()
    expect(long.catalyst?.kind).toBe('dip')
    expect(long.watchOnly).toBe(true)
    expect(long.riskPct).toBe(0)

    // so the short it would have demoted keeps the row: live, routable, sized
    const short = board.find(b => b.sym === 'GLW' && b.side === 'short')!
    expect(short).toBeDefined()
    expect(short.shadow).toBeUndefined()
    expect(short.watchOnly).toBeUndefined()
    expect(short.riskPct).toBeGreaterThan(0)
    expect(short.grade).toBe('A')
    // …and the side is not described as empty, because it isn't
    const blob = (await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!
    expect(blob.emptySides?.short).toBeUndefined()
  })

  it('a dip long that KEEPS its slot still demotes, and the empty short side says the dip lane did it', async () => {
    // The mirror of the test above: nothing outranks GLW's dip long, so it holds
    // its slot, the demotion fires as ratified — and the short side is now empty
    // for a reason that is neither the gates nor the route. Saying "nothing
    // cleared the gates" there would be a lie about a grade-A row.
    const store = await collisionStore()
    const d = collisionDeps({ dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }) })
    const { board } = await buildBoard(store, d, NOW)

    expect(board.find(b => b.sym === 'GLW' && b.side === 'long')!.riskPct).toBeGreaterThan(0)
    expect(board.some(b => b.side === 'short')).toBe(false) // the demoted short was the only one
    const blob = (await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!
    expect(blob.emptySides?.short).toBe('dip-lane')
  })

  it('the dip lane never receives the world-tape nudge, so its row records the multiplier it actually ran at', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? dipTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      capUsdM: async sym => (sym === 'GLW' ? 35_000 : null),
      sparkCloses: sparkOf(dipTape),
      worldReads: riskOffReads, // a long in risk-off would ordinarily be nudged to 0.85
    })
    const { board } = await buildBoard(store, d, NOW)

    const call = board.find(b => b.sym === 'GLW')!
    expect(call.catalyst?.kind).toBe('dip')
    // dipCall's composite is structural (depth-derived) and is never re-scored with
    // worldMult — printing 0.85 would advertise an adjustment that never happened
    expect(call.worldTape).toEqual({ tone: 'risk-off', mult: 1 })
  })

  // ---- dip-news corroboration: a dip trades on overreaction, not on a broken thesis ----

  const dipDeps = (over: Partial<EngineDeps> = {}) =>
    deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? dipTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      capUsdM: async sym => (sym === 'GLW' ? 35_000 : null),
      sparkCloses: sparkOf(dipTape),
      ...over,
    })

  it('a dip whose news reads a BROKEN THESIS never reaches the board — it shadows, with the reason on the record', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const d = dipDeps({ dipNews: async () => ({ verdict: 'structural', reason: 'SEC probe into revenue recognition' }) })
    const { board } = await buildBoard(store, d, NOW)

    // the reader is never shown the DIP CALL. (The composite's own read on GLW is
    // bearish, so the empty short side may still name it as a nearest miss — a
    // different statement entirely: no size, no grade, and no dip thesis.)
    expect(board.find(b => b.sym === 'GLW' && b.side === 'long')).toBeUndefined()
    // …and what the reader DOES see on GLW is the near miss on the empty short
    // side: a different statement entirely — no size, no grade, no dip thesis.
    // (Asserted unconditionally on purpose: wrapped in `if (row)` this block
    // passed whether or not the row existed, which is not a test.)
    const asNearMiss = board.find(b => b.sym === 'GLW')!
    expect(asNearMiss).toBeDefined()
    expect(asNearMiss.side).toBe('short')
    expect(asNearMiss.nearMiss).toBe(true)
    expect(asNearMiss.riskPct).toBe(0)
    expect(asNearMiss.catalyst).toBeUndefined() // it carries no dip catalyst/thesis

    const row = (await ledgerOf(store))!.find(p => p.sym === 'GLW')!
    expect(row).toBeDefined() // …but it still publishes and still grades
    expect(row.shadow).toBe(true)
    expect(row.riskPct).toBe(0)
    expect(row.instrument).toBeNull()
    expect(row.watchOnly).toBeUndefined() // shadow and watch stay mutually exclusive
    expect(row.belowBase).toBeUndefined()
    expect(row.grade).toBe('B') // nothing ELSE shadowed it: it graded, on a passing contract
    expect(row.evidence.contract).toBe(true)
    expect(row.earningsRisk).toBe(false)
    expect(row.catalyst!.reason).toContain('SEC probe into revenue recognition')
    expect(row.catalyst!.reason).toContain('holding') // the price read stays on the record too
  })

  it('a dip whose news reads an OVERREACTION trades, carrying the reason', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const d = dipDeps({ dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }) })
    const { board } = await buildBoard(store, d, NOW)

    const call = board.find(b => b.sym === 'GLW')!
    expect(call).toBeDefined()
    expect(call.side).toBe('long')
    expect(call.shadow).toBeUndefined()
    expect(call.riskPct).toBeGreaterThan(0)
    expect(call.catalyst!.reason).toContain('sector sympathy, guidance intact')
    expect(call.catalyst!.reason).toContain('holding')
  })

  it('a dip-news lookup that fails never blocks the lane — the dip trades, labelled "news unchecked"', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const d = dipDeps({
      dipNews: async () => {
        throw new Error('finnhub down')
      },
    })
    const { board } = await buildBoard(store, d, NOW)

    const call = board.find(b => b.sym === 'GLW')!
    expect(call).toBeDefined()
    expect(call.shadow).toBeUndefined()
    expect(call.riskPct).toBeGreaterThan(0)
    expect(call.catalyst!.reason).toContain('news unchecked')
    // …and the card says WHICH kind of unchecked: a dead dep reads differently
    // from a quiet news window, and the reader can tell them apart
    expect(call.catalyst!.reason).toContain('lookup failed')
  })

  it('an unclear verdict trades too — the lane only stands aside on evidence of a broken thesis', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const { board } = await buildBoard(store, dipDeps(), NOW) // the default stub is unclear/'stub'

    const call = board.find(b => b.sym === 'GLW')!
    expect(call.shadow).toBeUndefined()
    expect(call.catalyst!.reason).toContain('news unchecked')
  })

  it('spends at most five news reads a run, deepest dip first, and skips the rest as "budget"', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    // Six sleeve names, six different dip depths. Deepest → shallowest:
    // OXY 12.9, NEM 12.8, FCX 12.6, DOW 12.4, MMM 12.2, GLW 12.0.
    const tapes = new Map<string, Candle[]>([
      ['GLW', dipTapeAt(88.0)],
      ['MMM', dipTapeAt(87.8)],
      ['DOW', dipTapeAt(87.6)],
      ['FCX', dipTapeAt(87.4)],
      ['NEM', dipTapeAt(87.2)],
      ['OXY', dipTapeAt(87.1)],
    ])
    const asked: string[] = []
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => tapes.get(sym) ?? (sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: async () => new Map([...tapes].map(([sym, t]) => [sym, t.map(c => c.c)])),
      dipNews: async sym => {
        asked.push(sym)
        return { verdict: 'structural', reason: `probe at ${sym}` }
      },
    })
    const { board } = await buildBoard(store, d, NOW)

    // the budget is spent on the five deepest dips, in depth order
    expect(asked).toEqual(['OXY', 'NEM', 'FCX', 'DOW', 'MMM'])
    expect(asked).not.toContain('GLW')

    const ledger = (await ledgerOf(store))!
    for (const sym of ['OXY', 'NEM', 'FCX', 'DOW', 'MMM']) {
      const row = ledger.find(p => p.sym === sym && p.side === 'long')!
      expect(row.shadow, `${sym} should shadow on a structural verdict`).toBe(true)
      expect(row.catalyst!.reason).toContain(`probe at ${sym}`)
    }
    // the sixth was never read, so it cannot be shadowed by news it never saw
    const unread = board.find(b => b.sym === 'GLW')!
    expect(unread).toBeDefined()
    expect(unread.shadow).toBeUndefined()
    expect(unread.catalyst!.reason).toContain('news unchecked')
    expect(unread.catalyst!.reason).toContain('budget')
  })

  // Six sleeve names on six dip depths, deepest → shallowest:
  // OXY 12.9, NEM 12.8, FCX 12.6, DOW 12.4, MMM 12.2, GLW 12.0.
  const sixDips = new Map<string, Candle[]>([
    ['GLW', dipTapeAt(88.0)],
    ['MMM', dipTapeAt(87.8)],
    ['DOW', dipTapeAt(87.6)],
    ['FCX', dipTapeAt(87.4)],
    ['NEM', dipTapeAt(87.2)],
    ['OXY', dipTapeAt(87.1)],
  ])
  const sixDipStore = async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    return store
  }
  const sixDipDeps = (over: Partial<EngineDeps>) =>
    deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => sixDips.get(sym) ?? (sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: async () => new Map([...sixDips].map(([sym, t]) => [sym, t.map(c => c.c)])),
      ...over,
    })

  it('a CACHED verdict protects the shallowest dip on the board, however many deeper ones there are', async () => {
    const store = await sixDipStore()
    // GLW is the sixth-deepest, so under a budget that counts cache hits it was
    // relabelled 'unclear/budget' and TRADED — while its structural veto sat in
    // the blob the whole time. A cached verdict costs nothing to read, so it must
    // never be crowded out, and it must never crowd out a fresh read either.
    const asked: string[] = []
    const d = sixDipDeps({
      dipNewsCached: async sym => (sym === 'GLW' ? { verdict: 'structural', reason: `cached probe at ${sym}`, via: 'llm' } : null),
      dipNews: async sym => {
        asked.push(sym)
        return { verdict: 'transient', reason: `sympathy at ${sym}` }
      },
    })
    const { board } = await buildBoard(store, d, NOW)

    // the five misses still get their five fresh reads — the hit cost nothing
    expect(asked).toEqual(['OXY', 'NEM', 'FCX', 'DOW', 'MMM'])
    expect(asked).not.toContain('GLW')

    const ledger = (await ledgerOf(store))!
    const glw = ledger.find(p => p.sym === 'GLW' && p.side === 'long')!
    expect(glw.shadow).toBe(true) // the cached veto stood it down
    expect(glw.riskPct).toBe(0)
    expect(glw.catalyst!.reason).toContain('cached probe at GLW')
    expect(glw.catalyst!.reason).not.toContain('budget')
    expect(board.find(b => b.sym === 'GLW')).toBeUndefined() // never reached the reader
    // …and the fresh reads were acted on: OXY (the deepest, and the one the
    // diversity gates let through for its correlated crowd) trades on its own
    // transient verdict, and no row anywhere came back 'budget'
    const oxy = board.find(b => b.sym === 'OXY')!
    expect(oxy.shadow).toBeUndefined()
    expect(oxy.catalyst!.reason).toContain('sympathy at OXY')
    expect(ledger.filter(p => p.catalyst?.reason.includes('budget'))).toEqual([])
  })

  it('cache hits do not consume the budget: five hits still leave the sixth name a fresh read', async () => {
    const store = await sixDipStore()
    // The five DEEPEST dips are all cached. Before the split, those five hits ate
    // all five slots and GLW — the only name that actually needed the network —
    // came back 'budget' without a single Finnhub call having been made.
    const cached = new Set(['OXY', 'NEM', 'FCX', 'DOW', 'MMM'])
    const asked: string[] = []
    const d = sixDipDeps({
      dipNewsCached: async sym => (cached.has(sym) ? { verdict: 'transient', reason: `cached sympathy at ${sym}`, via: 'llm' } : null),
      dipNews: async sym => {
        asked.push(sym)
        return { verdict: 'structural', reason: `fresh probe at ${sym}` }
      },
    })
    const { board } = await buildBoard(store, d, NOW)

    expect(asked).toEqual(['GLW']) // exactly one fresh read, spent on the only miss

    const ledger = (await ledgerOf(store))!
    const glw = ledger.find(p => p.sym === 'GLW' && p.side === 'long')!
    expect(glw.catalyst!.reason).toContain('fresh probe at GLW')
    expect(glw.catalyst!.reason).not.toContain('budget')
    expect(glw.shadow).toBe(true) // and the fresh verdict was acted on
    // the cached five carried their cached verdicts (OXY is the deepest, and the
    // one the diversity gates let through for its correlated crowd)
    expect(cached.has('OXY')).toBe(true)
    const oxy = board.find(b => b.sym === 'OXY')!
    expect(oxy.catalyst!.reason).toContain('cached sympathy at OXY')
    expect(oxy.shadow).toBeUndefined()
    expect(ledger.filter(p => p.catalyst?.reason.includes('budget'))).toEqual([]) // nobody was starved
  })

  it('a rejecting cache probe is a miss, not a verdict — the name still gets its fresh read', async () => {
    const store = await sixDipStore()
    const asked: string[] = []
    const d = sixDipDeps({
      dipNewsCached: async () => {
        throw new Error('blobs down')
      },
      dipNews: async sym => {
        asked.push(sym)
        return { verdict: 'transient', reason: `sympathy at ${sym}` }
      },
    })
    await buildBoard(store, d, NOW)
    expect(asked).toEqual(['OXY', 'NEM', 'FCX', 'DOW', 'MMM']) // exactly the pre-cache behaviour
  })

  it('a .L dip never spends a budget slot: the source cannot serve it, so five US names still get read', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    // RR.L is the DEEPEST dip on the board (−16% vs 12.0–12.9 for the US five),
    // so under a naive depth queue it would take the first slot and starve MMM.
    // Finnhub company-news is US-listed only: that read is guaranteed empty, and
    // spending the budget on it buys nothing while costing a checkable name.
    const tapes = new Map<string, Candle[]>([
      ['RR.L', dipTapeAt(84.0, 80)],
      ['GLW', dipTapeAt(88.0)],
      ['MMM', dipTapeAt(87.8)],
      ['DOW', dipTapeAt(87.6)],
      ['FCX', dipTapeAt(87.4)],
      ['NEM', dipTapeAt(87.2)],
    ])
    const asked: string[] = []
    const d = deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => tapes.get(sym) ?? (sym === 'SPY' || sym === 'QQQ' ? flat : null),
      sparkCloses: async () => new Map([...tapes].map(([sym, t]) => [sym, t.map(c => c.c)])),
      dipNews: async sym => {
        asked.push(sym)
        return { verdict: 'transient', reason: `sympathy at ${sym}` }
      },
    })
    const { board } = await buildBoard(store, d, NOW)

    // all five US names read, in depth order; the unservable name asked nothing
    expect(asked).toEqual(['NEM', 'FCX', 'DOW', 'MMM', 'GLW'])
    expect(asked).not.toContain('RR.L')

    // …and RR.L still publishes, trading, with the coverage gap named on the card
    const uk = board.find(b => b.sym === 'RR.L')!
    expect(uk).toBeDefined()
    expect(uk.shadow).toBeUndefined() // an unservable venue is not a veto
    expect(uk.catalyst!.reason).toContain('news unchecked')
    expect(uk.catalyst!.reason).toContain('no news source for LSE names yet')
  })

  it('the sleeve cannot starve cap enrichment: discovery names get the lookups first', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    // 20 sleeve members (none of them a theme-inflow name, so the sleeve really is
    // their only door) all sort AHEAD of discovery in candidatePriority and all
    // start capUsdM null — the spark batch carries closes, never fundamentals.
    // Three screener names arrive with a null cap too. The budget is 15: before the
    // ordering fix the sleeve took all 15 and the discovery names went unpriced.
    const sleeve20 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'INTC', 'CRM', 'ORCL', 'ADBE',
      'NFLX', 'QCOM', 'TXN', 'MU', 'NOW', 'UBER', 'ABNB', 'SHOP', 'SNOW', 'PANW']
    const discovery = ['DISCA', 'DISCB', 'DISCC']
    const priced = new Set([...sleeve20, ...discovery])
    const enriched: string[] = []
    const d = deps({
      screens: async () => discovery.map(sym => ({ row: { sym, price: 164, capUsdM: null, changePct: 5, name: null }, source: 'screener:gainers' })),
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (priced.has(sym) ? shorty : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      capUsdM: async sym => {
        enriched.push(sym)
        return 4_000
      },
      sparkCloses: async () => new Map(sleeve20.map(sym => [sym, shorty.map(c => c.c)])),
    })
    await buildBoard(store, d, NOW)

    expect(enriched).toHaveLength(15) // the budget itself is unchanged
    for (const sym of discovery) expect(enriched).toContain(sym) // …and discovery is served first
    expect(enriched.filter(s => sleeve20.includes(s))).toHaveLength(12) // the sleeve takes what is left
  })

  it('sleeve fetch failure leaves the run byte-identical to a sleeve-less run', async () => {
    // Same world in all three runs — only the spark batch differs.
    const world = {
      candles: async (sym: string) =>
        sym === 'GLW' || sym === 'NVDA' || sym === 'XLK' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : null,
    }
    const run = async (sparkCloses: EngineDeps['sparkCloses']) => {
      const store = memoryStore()
      await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' } } })
      await store.write('engine-calibration', calWith('short:amber:55-70'))
      await buildBoard(store, deps({ ...world, sparkCloses }), NOW)
      return (await ledgerOf(store))!
    }

    const failed = await run(async () => {
      throw new Error('yahoo spark refused')
    })
    const sleeveless = await run(async () => new Map())
    expect(failed.map(p => p.sym)).toContain('NVDA') // the comparison has real content in it
    expect(failed).toEqual(sleeveless) // every row, side, size, grade and flag identical

    // …and the comparison is not vacuous: a working batch really does change the run
    const active = await run(sparkOf(shorty))
    expect(active.find(p => p.sym === 'GLW')).toBeDefined()
    expect(failed.find(p => p.sym === 'GLW')).toBeUndefined()
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

  // THE RISK LADDER STAYS CLEAN. Rung progression is earned only on calls the
  // reader could actually have taken. A demoted/watch row is graded, calibrated
  // and scorecarded like everything else — but if it could move the ladder, the
  // engine could climb its way to leverage on trades it never asked anyone to
  // place. Pinned end-to-end: a run containing NOTHING BUT watch rows.
  it('a watch-only row never enters rung progression — it learns, the ladder does not move', async () => {
    const store = memoryStore()
    const date = new Date(shorty[240].t * 1000).toISOString().slice(0, 10)
    const watchRow: Partial<Prediction> = {
      id: `${date}:XLK:short`,
      date,
      sym: 'XLK',
      side: 'short',
      composite: -38.9,
      regime: 'amber',
      probability: 0.67,
      provisional: false,
      grade: 'C',
      watchOnly: true,
      riskPct: 0,
      setup: 'continuation',
      priceAtPrediction: shorty[239].c,
      entry: shorty[239].c,
      stop: shorty[239].c * 1.1,
      target: shorty[239].c * 0.9,
      instrument: null,
      factors: { technical: { score: -30, detail: '', weight: 1 } } as never,
    }
    await store.write(`predictions:${date}`, [watchRow])
    await store.write('predictions-index', [date])
    await store.write('engine-calibration', calWith('short:amber:25-40'))

    const { graded } = await gradeOutstanding(store, deps(), NOW, null)
    expect(graded).toBe(1) // it IS graded — the learning loop eats everything published

    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['short:amber:25-40']!.n).toBe(21) // …and it DID teach calibration

    const risk = (await store.read<RiskState>('risk-state'))!
    expect(risk.gradedAtRung).toBe(0) // …but the ladder never counted it
    expect(risk.rung).toBe(0) // …and never climbed on it
    expect(risk.cohorts!.large.gradedAtRung).toBe(0)
    expect(risk.cohorts!.small.gradedAtRung).toBe(0)
  })

  it('a graded DIP call never touches factor IC — the lane must not train the technical factor', async () => {
    const store = memoryStore()
    const date = new Date(shorty[240].t * 1000).toISOString().slice(0, 10)
    // Two identical long calls on the same tape, both carrying the dip lane's
    // constant technical +40 placeholder. Only one is tagged as a dip call.
    const planted = (over: Partial<Prediction>): Partial<Prediction> => ({
      date,
      side: 'long',
      composite: 37,
      regime: 'amber',
      probability: 0.6,
      provisional: false,
      grade: 'B',
      setup: 'reversal',
      capUsdM: 35_000,
      priceAtPrediction: shorty[239].c,
      entry: shorty[239].c,
      stop: shorty[239].c * 0.5, // wide enough that the bleed never stops it out
      target: shorty[239].c * 1.2,
      instrument: null,
      factors: { technical: { score: 40, detail: 'dip lane', weight: 0 } } as never,
      ...over,
    })
    await store.write(`predictions:${date}`, [
      planted({ id: `${date}:GLW:long`, sym: 'GLW', catalyst: { kind: 'dip', reason: 'dip −12% · holding' } }),
      planted({ id: `${date}:NVDA:long`, sym: 'NVDA' }), // an ordinary call — the control
    ])
    await store.write('predictions-index', [date])
    await store.write('engine-weights', initWeights())
    await store.write('engine-calibration', calWith('long:amber:25-40')) // known start: no setup buckets yet
    const d = deps({ candles: async sym => (sym === 'GLW' || sym === 'NVDA' ? shorty : sym === 'SPY' ? flat : null) })

    expect((await gradeOutstanding(store, d, NOW, null)).graded).toBe(2) // BOTH graded

    const w = (await store.read<WeightsState>('engine-weights'))!
    const ic = w.ic.technical
    expect(ic.nAgree + ic.nDisagree).toBe(1) // only the ordinary call booked an observation
    expect(w.gradedSinceNudge).toBe(1)

    // …but the dip's outcome still teaches calibration and the setup buckets
    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['large:long:amber:25-40']).toEqual({ n: 2, hits: 0 })
    expect(cal.setupBuckets!['reversal:long:25-40']).toEqual({ n: 2, hits: 0 })
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

  // "re-qualified" claims the engine WOULD TAKE THIS TRADE AGAIN today. A near
  // miss cleared no gate — counting it would tell the reader an open call was
  // re-affirmed on the very morning the engine refused to make it.
  it('a NEAR MISS on today’s board never re-qualifies a prior call', async () => {
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const date = new Date(shorty[257].t * 1000).toISOString().slice(0, 10)
    const open: Partial<Prediction> = {
      id: `${date}:NVDA:long`, date, sym: 'NVDA', side: 'long', grade: 'B',
      entry: shorty[257].c, stop: shorty[257].c * 0.8, target: shorty[257].c * 1.2,
    }
    const traceWith = async (boardRow: Record<string, unknown>) => {
      const store = memoryStore()
      await store.write(`predictions:${date}`, [open])
      await store.write('predictions-index', [date])
      await store.write('engine-board', { date: today, board: [boardRow] })
      await traceOpenIdeas(store, deps(), NOW)
      return (await store.read<{ entries: OpenTraceEntry[] }>('open-trace'))!.entries[0]
    }

    const viaNearMiss = await traceWith({ sym: 'NVDA', side: 'long', nearMiss: true })
    expect(viaNearMiss.requalified).toBe(false)
    expect(viaNearMiss.verdict).not.toBe('still-on')
    expect(viaNearMiss.note).not.toContain('re-qualified')

    // the control: the SAME row without the near-miss stamp still re-qualifies
    const viaRealRow = await traceWith({ sym: 'NVDA', side: 'long' })
    expect(viaRealRow.requalified).toBe(true)

    // …and an OBSERVATION cannot re-qualify one either. It cleared every gate and
    // is still a row an ISA cannot place: the engine would not take this trade
    // again today, so telling the holder it was re-affirmed is the same lie in
    // the other direction.
    const viaObservation = await traceWith({ sym: 'NVDA', side: 'long', observation: true })
    expect(viaObservation.requalified).toBe(false)
    expect(viaObservation.verdict).not.toBe('still-on')
    expect(viaObservation.note).not.toContain('re-qualified')
  })
})
