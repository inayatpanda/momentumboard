import { describe, expect, it, vi } from 'vitest'
import { buildBoard, BOARD_CANDLE_BARS, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, type CalibrationState } from '../../../shared/engine/calibration'
import { funnelTraceKey, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import type { DiscoveryCandidate, DiscoveryResult, DiscoveryStats, Features, LensId } from '../../../shared/engine/discovery/types'

// THE SCAN'S WIRING, and only its wiring.
//
// What the lenses look for, how the universe is kept and how the bars are cached
// are tested where they live (shared/engine/discovery/*, discoveryBars.ts). What
// is pinned here is the seam: a name the scan found gets a door, keeps someone
// else's door when someone else found it first, is SCORED rather than trimmed,
// pays for its own budget, and — the one that matters most — that a run without
// the scan is the run this engine has always had, to the byte.

// ---- fixtures (the engine.test.ts shapes, copied rather than imported) ----

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })

const shorty = mk(i => (i < 200 ? 80 + i * 1.0 : 280 - (i - 200) * 2.0))
const flat = mk(() => 500)
/** A calm megacap bleed: −0.5%/day. Capacity 4.9% — UNDER the roster's join gate
 * (8), so the roster will not enrol it and only an append can carry it to
 * evaluation. Exactly the shape that proves the scan's append is doing the work. */
const calmSlide = mk(i => 100 * Math.pow(0.995, i))
const NOW = Math.floor(shorty[shorty.length - 1].t + 86_400)
const TODAY = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

/** GLW's dip signature: 60 calm sessions at 100, a slide to 84.5, then a
 * volume-paid reclaim to 88. classifyDip reads triggered AND holding; swing
 * capacity is 0, so the composite publishes nothing — every row this tape
 * produces came from the dip lane, which is what the quality test gates. */
const dipTape: Candle[] = (() => {
  const bars: Candle[] = []
  const push = (c: number, v = 1_000_000, o = c, h = c, l = c) => bars.push({ t: T0 + bars.length * 86_400, o, h, l, c, v })
  for (let i = 0; i < 60; i++) push(100)
  push(94)
  push(90)
  push(87)
  push(85, 1_000_000, 86, 86, 84.5)
  push(85.5)
  push(88, 1_600_000)
  return bars
})()

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
  social: async () => [],
  sparkCloses: async () => new Map<string, number[]>(),
  insiderCoverage: async () => new Map(),
  smartMoney: async () => [],
  mediaTitles: async () => [],
  newsCatalysts: async () => [],
  dipNewsCached: async () => null,
  dipNews: async () => ({ verdict: 'unclear', reason: 'stub' }),
  recentIpos: async () => [],
  earningsSyms: async () => new Set<string>(),
  earningsCalendar: async () => [],
  worldReads: async () => [],
  holdings: async () => null,
  ...over,
})

const calWith = (key: string, n = 32, hits = 22): CalibrationState => ({
  buckets: { [key]: { n, hits } },
  brier: [],
  defVersion: CALIB_DEF_VERSION,
  seedGeneration: 5,
})

// ---- the scan's own fixtures ----

/** Features the wiring never reads: it routes on `sym`, `capBand` and the first
 * lens. Everything the lenses computed stays null so a failure here can only
 * ever be about the seam. */
const featuresOf = (sym: string, close = 100): Features => ({
  sym,
  bars: 260,
  lastT: NOW,
  close,
  ret1: null,
  ret5: null,
  ret10: null,
  ret20: null,
  ret60: null,
  gapPct: null,
  atrPct14: null,
  typicalMove10: null,
  rvol: null,
  dollarVol20: null,
  ema8: null,
  ema21: null,
  ema50: null,
  ema50Slope20: null,
  distEma21Atr: null,
  rsi14: null,
  ddFrom20dHigh: null,
  ddFrom60dHigh: null,
  distTo52wHigh: null,
  upDays5: null,
  upDays10: null,
  broke20dHigh: null,
  broke60dHigh: null,
  broke20dLow: null,
  bbWidthPctl120: null,
  rsSpy20: null,
  rsSpy60: null,
  volTrend5: null,
  lowerHighs: null,
})

const pick = (sym: string, lens: LensId = 'breakout', over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  sym,
  exchange: 'US',
  capBand: null,
  sector: null,
  index: [],
  lenses: [{ lens, score: 0.8, reason: `${lens} fired on ${sym}`, side: null }],
  features: featuresOf(sym),
  priority: 0.8,
  nominators: [],
  ...over,
})

const statsOf = (over: Partial<DiscoveryStats> = {}): DiscoveryStats => ({
  universeSize: 2_000,
  seedSize: 1_900,
  dynamicSize: 100,
  barsFetched: 1_750,
  barsFromCache: 240,
  barsFailed: 10,
  barsUnread: 0,
  scanned: 1_960,
  selected: 0,
  perLens: { unusual: 0, 'rs-leader': 0, pullback: 0, breakout: 0, dip: 0, weak: 0, climax: 0 },
  rejects: {},
  partialDropped: 0,
  elapsedMs: 41_200,
  budgetHit: false,
  ...over,
})

const scanOf = (candidates: DiscoveryCandidate[], tapes: [string, Candle[]][] = []): DiscoveryResult => ({
  date: TODAY,
  candidates,
  trace: [],
  stats: statsOf({ selected: candidates.length }),
  tapes: new Map(tapes),
})

const traceOf = (store: ReturnType<typeof memoryStore>) => store.read<FunnelTrace>(funnelTraceKey(TODAY))
const boardOf = (store: ReturnType<typeof memoryStore>) => store.read<{ board: Prediction[] }>('engine-board')

describe('the scan as a candidate door', () => {
  it('a name only the scan found gets the scan’s door, its own prefetched tape, and a score', async () => {
    const store = memoryStore()
    // ZSCN is a short the ISA can route, so its day ends at a published row
    // rather than at the route guard — the gate code is then unambiguous.
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { ZSCN: { short2x: 'ZINV' } } })
    await store.write('engine-calibration', calWith('short:amber:25-40'))
    const asked: string[] = []
    await buildBoard(
      store,
      deps({
        screens: async () => [],
        candles: async sym => {
          asked.push(sym)
          return sym === 'SPY' || sym === 'QQQ' ? flat : null
        },
        // the scan hands back the bars it already paid for
        discovery: async () => scanOf([pick('ZSCN', 'rs-leader')], [['ZSCN', calmSlide]]),
      }),
      NOW,
    )

    const trace = (await traceOf(store))!
    const row = trace.rows['ZSCN:short'] ?? trace.rows.ZSCN
    expect(row).toBeDefined()
    // the door it came in through, stamped by addSource and carried into the trace
    expect(row.source).toBe('scan:rs-leader')
    // NOT the two codes that mean "we never looked": it reached composeCall and
    // died (or lived) on a verdict about the chart.
    expect(['trimmed', 'not-candidate', 'no-candles']).not.toContain(row.gate)
    expect(trace.rows['ZSCN:short']).toBeDefined() // a SIDE was argued — the composite ran
    // and the tape was never fetched twice: the scan's prefetch is the fill
    expect(asked).not.toContain('ZSCN')

    // the roster refused it (capacity 4.9 < the join gate's 8), so the scan's
    // append to evalRows is the only reason it was scored at all
    const roster = (await store.read<{ sym: string }[]>('engine-roster'))!
    expect(roster.find(r => r.sym === 'ZSCN')).toBeUndefined()
  })

  it('a name the screener offered first keeps the screener’s door', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await buildBoard(
      store,
      deps({
        screens: async () => [{ row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
        discovery: async () => scanOf([pick('NVDA', 'weak')]),
      }),
      NOW,
    )
    const trace = (await traceOf(store))!
    const row = trace.rows['NVDA:short'] ?? trace.rows.NVDA
    expect(row.source).toBe('screener:gainers') // addSource keeps the FIRST door
  })
})

describe('DISCOVERY off is the engine that shipped', () => {
  /** The two `trimmed` sentences, LITERAL. Comparing three runs of this same
   * build to each other proves they agree with each other and nothing more —
   * a reworded string is identical in all three. These are the strings as main
   * ships them (74ad5f7), so a rewording has to be a deliberate edit here. */
  const NEVER_SCORED_LEGACY = 'not on the roster and not in the sleeve — never scored'
  const NEVER_SCORED_WITH_SCAN = 'not on the roster, not in the sleeve, not a scan pick — never scored'

  const runWith = async (over: Partial<EngineDeps>, extraScreens: string[] = []) => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' } } })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    await buildBoard(
      store,
      deps({
        ...over,
        screens: over.screens ?? (async () => [
          { row: { sym: 'NVDA', price: 162, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' as const },
          ...extraScreens.map(sym => ({ row: { sym, price: 50, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' as const })),
        ]),
      }),
      NOW,
    )
    return { board: (await boardOf(store))!, trace: (await traceOf(store))! }
  }

  it('absent, null and throwing are the same run, board and trace alike', async () => {
    const absent = await runWith({})
    const nulled = await runWith({ discovery: async () => null })
    const threw = await runWith({
      discovery: async () => {
        throw new Error('the scan fell over')
      },
    })

    // the stage that is off decides nothing: not a row, not a gate, not a detail
    // string, not the budget the trim quotes.
    expect(nulled.board).toEqual(absent.board)
    expect(nulled.trace).toEqual(absent.trace)
    expect(threw.board).toEqual(absent.board)
    expect(threw.trace).toEqual(absent.trace)
    expect(absent.board.board.length).toBeGreaterThan(0) // …and the run was a real one
  })

  it('the never-scored sentence is main’s, word for word, when the scan did not run', async () => {
    // ZTRIM has a tape and no way onto any of the lists, so it is the trim's own
    // row — the sentence a reader meets a quarter later, and a byte-comparable
    // fixture for a DISCOVERY=off funnel trace.
    const off = await runWith({ candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'ZTRIM' ? calmSlide : sym === 'NVDA' ? shorty : null) }, ['ZTRIM'])
    const row = off.trace.rows.ZTRIM ?? off.trace.rows['ZTRIM:long'] ?? off.trace.rows['ZTRIM:short']
    expect(row?.gate).toBe('trimmed')
    expect(row?.detail).toBe(NEVER_SCORED_LEGACY)
  })

  it('…and names the scan only when the scan actually ran', async () => {
    const on = await runWith(
      {
        candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'ZTRIM' ? calmSlide : sym === 'NVDA' ? shorty : null),
        discovery: async () => scanOf([pick('ZOTHER')]),
      },
      ['ZTRIM'],
    )
    const row = on.trace.rows.ZTRIM ?? on.trace.rows['ZTRIM:long'] ?? on.trace.rows['ZTRIM:short']
    expect(row?.gate).toBe('trimmed')
    expect(row?.detail).toBe(NEVER_SCORED_WITH_SCAN)
  })
})

describe('the scan buys its own budget', () => {
  it('the candidate cut rises by the scan’s size, and the trim says the number it actually used', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    const offered = Array.from({ length: 240 }, (_, i) => `Z${String(i).padStart(3, '0')}`)
    const found = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(3, '0')}`)
    await buildBoard(
      store,
      deps({
        screens: async () => offered.map(sym => ({ row: { sym, price: 10, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' })),
        candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : null),
        discovery: async () => scanOf(found.map(sym => pick(sym))),
      }),
      NOW,
    )
    const trace = (await traceOf(store))!
    const trimmed = Object.values(trace.rows).filter(r => r.gate === 'trimmed' && r.detail?.includes('-candidate evaluation budget'))
    expect(trimmed.length).toBeGreaterThan(0)
    // 180 + 30, quoted honestly — and NOT the bare 180 the legacy run quotes
    for (const r of trimmed) expect(r.detail).toContain('past the 210-candidate evaluation budget')
    // the scan's own names are all inside it (tier 4), so none of them is trimmed
    for (const sym of found) expect(trace.rows[sym]?.gate).not.toBe('trimmed')
  })

  it('…and never past 320, however many names the scan brings', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    const offered = Array.from({ length: 200 }, (_, i) => `Z${String(i).padStart(3, '0')}`)
    const found = Array.from({ length: 200 }, (_, i) => `S${String(i).padStart(3, '0')}`)
    await buildBoard(
      store,
      deps({
        screens: async () => offered.map(sym => ({ row: { sym, price: 10, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' })),
        candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : null),
        discovery: async () => scanOf(found.map(sym => pick(sym))),
      }),
      NOW,
    )
    const trace = (await traceOf(store))!
    const trimmed = Object.values(trace.rows).filter(r => r.gate === 'trimmed' && r.detail?.includes('-candidate evaluation budget'))
    // 400 offered by the two doors (plus whatever the rotation door adds), 320
    // evaluated — and the quoted number is the CEILING, not 180 + 200.
    expect(trimmed.length).toBeGreaterThanOrEqual(80)
    for (const r of trimmed) expect(r.detail).toContain('past the 320-candidate evaluation budget')
  })
})

describe('an S&P 500 / FTSE 100 listing is evidence of size; a band alone is not', () => {
  // The dip lane admits "quality" names only — a sleeve member or > $10B. A
  // scan pick's `capBand` is INDEX MEMBERSHIP, not a measurement: 'large' is
  // conferred by sp500, ndx OR ftse100, and the smallest members of those lists
  // are $3–8B companies. So only the two BIG lists stand in for the cap, and
  // only when no cap was fetched at all.
  const dipRun = async (capBand: 'large' | 'mid', over: Partial<DiscoveryCandidate> = {}, capUsdM: number | null = null) => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', { buckets: { 'long:amber:25-40': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    await store.write('risk-state', { rung: 3, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })
    const { board } = await buildBoard(
      store,
      deps({
        screens: async () => [],
        candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : null),
        capUsdM: async () => capUsdM, // null = no cap anywhere, so the listing is the only size evidence
        discovery: async () => scanOf([pick('ZDIP', 'dip', { capBand, index: ['sp500'], ...over })], [['ZDIP', dipTape]]),
      }),
      NOW,
    )
    // the LONG side only: the composite reads this same tape as a weak chart and
    // the never-blank board may still publish that short as its near miss, which
    // is a statement about the composite and not about the dip lane's door.
    return { long: board.find(b => b.sym === 'ZDIP' && b.side === 'long') ?? null, any: board.some(b => b.sym === 'ZDIP') }
  }

  it('an S&P 500 pick with no cap anywhere clears the dip lane’s quality door', async () => {
    const { long } = await dipRun('large')
    expect(long).not.toBeNull()
    expect(long!.riskPct).toBeGreaterThan(0) // a sized dip trade, built by the lane's own constructor
  })

  it('…and a mid-band one does not — the name was looked at, the lane just never admitted it', async () => {
    const { long, any } = await dipRun('mid')
    expect(long).toBeNull()
    expect(any).toBe(true) // it was a candidate and it was scored; only the quality door differs
  })

  it('a large band from the NASDAQ-100 alone is not the >$10B claim, and does not open the door', async () => {
    // ndx confers 'large' in the seed, but the Nasdaq-100 has no size floor of
    // its own — reading `capBand === 'large'` admitted this name on a listing
    // that evidences nothing about size.
    const { long, any } = await dipRun('large', { index: ['ndx'] })
    expect(long).toBeNull()
    expect(any).toBe(true)
  })

  it('a FTSE 100 listing opens it, exactly as the S&P 500 does', async () => {
    const { long } = await dipRun('large', { index: ['ftse100', 'ndx'] })
    expect(long).not.toBeNull()
  })

  it('a fetched cap OVERRULES the listing: the number is judged, not the index', async () => {
    // $900M and in the S&P 500 (a fallen member): the cap pass actually priced
    // it, so the listing has nothing left to add and the lane says no.
    const { long, any } = await dipRun('large', {}, 900)
    expect(long).toBeNull()
    expect(any).toBe(true)
  })
})

// THE ROSTER IS EARNED. It holds 80 names, admits on JOIN_CAPACITY and trims
// the LARGEST CAPS first — and a scan pick arrives with capUsdM null, which
// sorts last in a largest-first trim. The 2026-09-22 dry run picked ~87 names a
// day: let them queue and within a week the roster is whatever the lenses liked
// that morning, permanently, with every earned member evicted.
describe('the scan never joins the roster', () => {
  it('a hundred scan-only picks leave the stored roster untouched', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    // an earned incumbent, exactly as a previous run would have stored it
    await store.write('engine-roster', [{ sym: 'INCUM', source: 'screener:gainers', capUsdM: 50_000, joined: '2026-01-02', lastSeen: '2026-09-21' }])
    const found = Array.from({ length: 100 }, (_, i) => `SCAN${String(i).padStart(3, '0')}`)
    const foundSet = new Set(found)

    await buildBoard(
      store,
      deps({
        screens: async () => [],
        // every scan name gets a TRAVELLING tape — capacity far past the roster's
        // join gate, so the roster filter is the only thing that can keep them out
        candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'INCUM' || foundSet.has(sym) ? shorty : null),
        discovery: async () => scanOf(found.map(sym => pick(sym))),
      }),
      NOW,
    )

    const roster = (await store.read<{ sym: string }[]>('engine-roster'))!
    const blob = JSON.stringify(roster)
    for (const sym of found) expect(blob).not.toContain(sym) // the BLOB, byte for byte
    expect(roster.map(r => r.sym)).toContain('INCUM') // …and the earned member is still there

    // …and they were not ignored: every one of them reached the trace.
    const trace = (await traceOf(store))!
    const seen = found.filter(sym => Object.keys(trace.rows).some(k => k === sym || k.startsWith(`${sym}:`)))
    expect(seen).toHaveLength(found.length)
  })

  it('…but a scan pick the screener ALSO offered competes for the roster normally', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await buildBoard(
      store,
      deps({
        screens: async () => [{ row: { sym: 'BOTH', price: 100, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:gainers' }],
        candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'BOTH' ? shorty : null),
        discovery: async () => scanOf([pick('BOTH')]),
      }),
      NOW,
    )
    const roster = (await store.read<{ sym: string; source: string }[]>('engine-roster'))!
    expect(roster.map(r => r.sym)).toContain('BOTH')
    expect(roster.find(r => r.sym === 'BOTH')!.source).toBe('screener:gainers')
  })

  it('a stored `scan:` source does not condemn a roster member to the back of the cap queue for ever', async () => {
    // Finding #2's trap. A name admitted through the scan door once carried
    // `scan:breakout` into the roster blob, and the roster is replayed BEFORE
    // the scan door every morning — so a source-STRING test read that name as
    // "scan-only" on every future run, whatever door found it since, and parked
    // it permanently behind the cap budget: no cap, no cohort, for ever.
    // The set is decided at the door and is empty on a run with no scan.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-roster', [{ sym: 'LEGACY', source: 'scan:breakout', capUsdM: null, joined: '2026-09-01', lastCapacity: 20, lastQualified: TODAY }])
    // 20 unpriced screener names, more than the 15-slot cap budget, so being
    // queued last is the difference between a cap lookup and none.
    const crowd = Array.from({ length: 20 }, (_, i) => `Z${String(i).padStart(3, '0')}`)
    const asked: string[] = []
    await buildBoard(
      store,
      deps({
        screens: async () => crowd.map(sym => ({ row: { sym, price: 50, capUsdM: null, changePct: null, name: null }, source: 'screener:gainers' as const })),
        candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'LEGACY' || crowd.includes(sym) ? shorty : null),
        capUsdM: async sym => {
          asked.push(sym)
          return 12_345
        },
        discovery: async () => null, // no scan today: the set is empty
      }),
      NOW,
    )
    expect(asked).toContain('LEGACY') // a roster member, priced like any other
    expect(asked.length).toBe(15) // …and the budget itself is unchanged
  })
})

// The scan holds ~1,900 tapes of 300 bars. The board's own tape is a 1y Yahoo
// read — 252 bars — and swingCapacity and patternScore both consume the WHOLE
// array, so lending an unsliced tape moves scores on names that have nothing to
// do with the scan.
describe('the scan lends its bars in the board’s own shape', () => {
  /** 300 bars whose FIRST 48 — the ones only the scan's copy holds — are a
   * different market: a violent 40/160 chop, then a calm year. swingCapacity is
   * a p80 over the whole array, so the two windows disagree about this name by
   * construction, which is exactly the drift an unsliced loan would introduce. */
  const longTape = mk(i => (i < 48 ? (i % 2 ? 40 : 160) : 100 + Math.sin(i / 7) * 5), 300)

  it('only a PICK’s tape is lent; a name the scan merely READ is fetched as always', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [{ symbol: 'OTHER' }], rules: [], ytChannels: [], levMap: {} })
    const asked: string[] = []
    await buildBoard(
      store,
      deps({
        screens: async () => [],
        candles: async sym => {
          asked.push(sym)
          return sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'OTHER' ? shorty : null
        },
        capUsdM: async () => null,
        // ZPICK is a pick; OTHER is merely a name the scan READ (most of the
        // universe is), and the two must be treated differently.
        discovery: async () => scanOf([pick('ZPICK')], [['ZPICK', longTape], ['OTHER', longTape]]),
      }),
      NOW,
    )
    expect(asked).not.toContain('ZPICK') // the prefetch was used
    expect(asked).toContain('OTHER') // …and the non-pick came through the ordinary path
  })

  it('the lent tape is the same 252 sessions the ordinary path would have read', async () => {
    // ONE door (the screener's, in both runs), one name, one tape — the only
    // difference is WHO hands the bars over. The trace carries `core`, the
    // gate-free composite, and swingCapacity and patternScore both read the
    // whole array, so an unsliced 300-bar loan moves that number and the two
    // runs stop matching.
    const run = async (viaScan: boolean) => {
      const store = memoryStore()
      // the WATCHLIST door in both runs: it carries the name into the roster
      // and so into evalRows either way, leaving the tape as the only variable.
      await store.write('config', { watchlist: [{ symbol: 'ZSAME' }], rules: [], ytChannels: [], levMap: { ZSAME: { short2x: 'ZINV' } } })
      await store.write('engine-calibration', calWith('long:amber:55-70'))
      // …and an existing roster row, so `lastCapacity` is REWRITTEN from the
      // tape this run measured rather than left null by the join gate.
      await store.write('engine-roster', [{ sym: 'ZSAME', source: 'watchlist', capUsdM: null, joined: '2026-01-02', lastCapacity: 0, lastQualified: TODAY }])
      await buildBoard(
        store,
        deps({
          screens: async () => [],
          // the board's own read is a 1y Yahoo call — 252 bars
          candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'ZSAME' ? longTape.slice(-BOARD_CANDLE_BARS) : null),
          capUsdM: async () => 50_000,
          // …and the scan, which picked the same name, holds 300 of them
          discovery: viaScan ? async () => scanOf([pick('ZSAME')], [['ZSAME', longTape]]) : undefined,
        }),
        NOW,
      )
      const trace = (await traceOf(store))!
      const roster = (await store.read<{ sym: string; lastCapacity: number | null }[]>('engine-roster'))!
      return {
        // swingCapacity over the WHOLE array, banked in the roster row: the
        // cleanest read of which tape the board actually measured.
        capacity: roster.find(r => r.sym === 'ZSAME')?.lastCapacity ?? null,
        rows: Object.entries(trace.rows)
          .filter(([k]) => k.startsWith('ZSAME'))
          .map(([k, r]) => ({ k, gate: r.gate, core: r.core, detail: r.detail })),
      }
    }
    const lent = await run(true)
    const fetched = await run(false)
    expect(lent.rows.length).toBeGreaterThan(0)
    expect(lent.capacity).not.toBeNull()
    expect(lent).toEqual(fetched)
  })
})

// The default dep's HOST GATE. The cron Worker dispatches the daily run into
// Pages Functions, where an invocation may make fifty subrequests; a ~1,866-name
// scan would burn that budget and take the rest of the run down with it. Actions
// and Netlify are Node and uncapped. Nothing below reaches the network: the gate
// is the first thing after the DISCOVERY=off lever, so the refusal is the whole
// call.
describe('the scan refuses a subrequest-capped host', () => {
  it('a Worker env bag makes the default discovery dep return null and say why', async () => {
    const { installRuntimeEnv } = await import('./runtimeEnv')
    const { defaultDeps } = await import('./engine')
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    try {
      installRuntimeEnv({}) // an installed bag IS the Worker, per runtimeHost()
      const out = await defaultDeps({}, memoryStore()).discovery!({ date: TODAY, nominations: [], spy: null, isEtp: () => false })
      expect(out).toBeNull()
      expect(lines.join('\n')).toContain('DISCOVERY: skipped — host subrequest budget')
    } finally {
      installRuntimeEnv(null)
      spy.mockRestore()
    }
  })
})
