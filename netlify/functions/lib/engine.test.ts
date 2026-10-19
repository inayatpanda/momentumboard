import { afterEach, describe, expect, it, vi } from 'vitest'
import { VELOCITY_SHADOW_FIRST, buildBoard, gradeOutstanding, traceOpenIdeas, type EngineDeps } from './engine'
import type { OpenTraceEntry } from '../../../shared/engine/openTrace'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { CALIB_DEF_VERSION, baseHitRate, initWeights, setupStat, type CalibrationState, type WeightsState } from '../../../shared/engine/calibration'
import { RUNG_RISK_PCT, type RiskState } from '../../../shared/engine/riskLadder'
import { VELOCITY_DOOR_CAP, classifyVelocity } from '../../../shared/engine/velocityLane'
import { classifyDip } from '../../../shared/engine/dipLane'
import { bannedTokensIn } from '../../../shared/engine/voice'
import { worldMult } from '../../../shared/engine/worldTape'
import type { TrendDay } from '../../../shared/engine/hypeCluster'
import type { EmptySideReason } from '../../../shared/engine/types'
import type { InsiderSummary } from './insiders'
import type { FundMoves } from './edgar'

/** THE EXPERIMENT SLOT, SWITCHED OFF (Stage 3d, shared/engine/wildcardLane.ts).
 *
 * Four fixtures below are claims about the NEAR-MISS mechanism — "an empty side
 * still names what came closest" — and the wildcard lane reads the very same
 * near-miss list to choose its one row a day. On a day the slot is spent, the
 * name it takes yields its near-miss row (they would otherwise share an id), so
 * those fixtures would be measuring the wildcard instead of the thing they are
 * named after. The lane has its own seam for exactly this, mirroring `GATES=off`
 * inside the parity walks; the adjudication it performs is pinned on its own, on
 * these same fixtures with the lane LIVE, in engine.wildcard.test.ts. */
const wildcardOff = () => vi.stubEnv('WILDCARD', 'off')
afterEach(() => vi.unstubAllEnvs())

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
// (8), so it is never enrolled and only the sleeve can carry it to evaluation.
// It TRADES: an amber core of −38.4 expects 0.384 × 4.9 = 1.9% over ten
// sessions, clear of the 1.5 eligibility floor. Exactly the shape the sleeve
// exists for — a famous name that moved meaningfully FOR ITSELF without ever
// being volatile enough to be called "a mover".
const calmSlide = mk(i => 100 * Math.pow(0.995, i))

// DEAD MONEY, in both directions: a real, nameable core read on a name that
// still cannot hand the reader a trade, because the move the call expects of it
// is under the 1.5% floor. The never-blank board's near-miss fixture — and what
// kills it is arithmetic about THIS name, not the volatility class it belongs to:
//   deadClimb  +0.40%/day → capacity 4.1, amber core +25.9 (past the 25 dead
//              zone), expects 0.259 × 4.1 = 1.1% → no trade
//   deadSlide  −0.30%/day → capacity 3.0, amber core −31.8, expects
//              0.318 × 3.0 = 1.0% → no trade
// Both cleared the dead zone and both die at the expected-move floor. calmSlide
// above has capacity just as far under the retired flat floor (6) and TRADES,
// because its conviction earns a real move out of a small traveller — which is
// the whole reason the flat floor went.
const deadClimb = mk(i => 100 * Math.pow(1.004, i))
const deadSlide = mk(i => 100 * Math.pow(0.997, i))

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

// ---- the velocity lane's tapes ----
// One helper for all of them: append tomorrow's session with the intraday range
// the move implies, so the trail's low leg is measured against a real bar.
const append = (bars: Candle[], c: number, v = 1_000_000, o = c) => {
  const prev = bars[bars.length - 1]
  bars.push({ t: prev.t + 86_400, o, h: Math.max(c, o) * 1.005, l: Math.min(c, o) * 0.995, c, v })
}

// The EARLY door as it stands on the day of bar 240: 240 flat sessions at 100,
// then a close at 105 clean through the 20-session high on 3× volume. Flat
// underneath on purpose — swing-capacity is 0, so the name never joins the roster
// and the composite never reads it at all. Everything VELO shows is the lane's.
const breakTape240 = (() => {
  const bars = mk(() => 100, 240)
  append(bars, 105, 3_000_000)
  return bars
})()
// …and the SAME tape TWENTY-TWO sessions later, the break having run +0.8%/session.
// Nineteen until CALIB_DEF_VERSION v4: the calibrated grade moved to 21 sessions,
// and the entry bar here is the first APPENDED one (the call publishes the morning
// after the break bar), so the tape needs 21 bars behind that entry before anything
// is graded at all. The board is built on the day (breakTape240); the grader comes
// back once the outcome exists, exactly as production does.
const breakTapeMatured = (() => {
  const bars = breakTape240.map(c => ({ ...c }))
  for (let i = 1; i <= 22; i++) append(bars, Math.round(105 * (1 + 0.008 * i) * 100) / 100)
  return bars
})()
const NOW_240 = Math.floor(breakTape240[breakTape240.length - 1].t + 86_400)
/** …and the morning the grader actually runs on that tape. It has to be AFTER the
 * matured tape's last bar, not `NOW` (which is pinned to `shorty`'s 260 bars and
 * now falls INSIDE the matured window) — a grading pass dated before the outcome
 * it is reading would be the fixture telling itself a comfortable lie. */
const NOW_240_MATURED = Math.floor(breakTapeMatured[breakTapeMatured.length - 1].t + 86_400)
/** SPY, long enough to reach the calibrated horizon on the matured tape above.
 * `flat` stops at 260 bars and the benchmark leg is graded on the SAME window as
 * the name — `gradePrediction` returns null the moment EITHER series runs out — so
 * a 21-session grade on an entry at bar 241 needs a benchmark that goes to 262. */
const flatLongSpy = mk(() => 500, 300)

// The early door again, on a tape that actually GOES somewhere: a ±10% swinger, so
// swing-capacity is 8.2 rather than breakTape240's flat 0. Under v2 that number was
// what let it reach grade A — `capacityPct ≥ 8` was a hard condition on the A rung.
// Nothing reads it as a gate any more, and it is worth being exact about why, since
// the obvious answer is wrong: this row is built by velocityCall, which constructs
// its own EngineCall and never goes near composeCall, so composite.ts's
// eligibility FLOOR cannot be what admits it either. The lane's gates are its own — an early
// door, an 8-EMA trail that leaves real risk distance — and `capacityPct` is merely
// stamped onto the row from swingCapacity for display and the holdings read.
// What makes this the leverage fixture is the pair of things leverage actually
// keys on: the row grades A (p 0.6346 on nEff 32, read at |composite| 38.3 — above
// the 25-40 band's 32.5 midpoint, so nothing is claimed below its evidence) and it
// carries a levMap long route. The move to 120 is what buys the 38.3.
const richBreakTape = (() => {
  const bars = mk(i => Math.round(100 * (1 + 0.1 * Math.sin(i / 11)) * 100) / 100, 240)
  append(bars, 120, 3_000_000)
  return bars
})()

// An ORDINARY composite long, and the control for every "the lane did this" claim:
// a name grinding +0.8/session with a 5% oscillation, today pulling back a touch on
// double volume. Stage 'pullback', capacity 12.7, the full evidence contract — a
// grade-A row at the FULL rung, carrying no lane tag of any kind.
const bullTape = (() => {
  const bars = mk(i => (100 + i * 0.8) * (1 + 0.05 * Math.sin(i / 3)), 240)
  append(bars, Math.round(bars[bars.length - 1].c * 0.995 * 100) / 100, 2_000_000)
  return bars
})()

// The same grind, but today is a 3×-volume break clean through the 20-session high
// instead of a quiet pullback: a name the COMPOSITE publishes an ordinary long on
// whose tape ALSO opens a velocity door. The one fixture where the lane's
// one-row-per-sym+side skip (`longRows`) can actually be observed.
const bullBreakTape = (() => {
  const bars = mk(i => (100 + i * 0.8) * (1 + 0.05 * Math.sin(i / 3)), 240)
  append(bars, Math.round(bars[bars.length - 1].c * 1.08 * 100) / 100, 3_000_000)
  return bars
})()

// The CONFIRMATION door: +16% over five sessions, PAID for by a 2.3× up-day, then
// a pause that holds the 8-EMA. Today prints 1× on a DOWN close, so the early door
// is shut on both price and volume and only the later, larger-size door is open.
const confirmTape = (() => {
  const bars = mk(() => 100, 255)
  append(bars, 104)
  append(bars, 108)
  append(bars, 112, 2_500_000)
  append(bars, 117)
  append(bars, 116)
  return bars
})()

// A name shocked three weeks ago that has since ripped to a new high: the −8%
// open gap still sits inside the dip lane's 10-session shock window, so classifyDip
// reads triggered AND holding — and dipCall REFUSES it, because a half-retrace
// target 0.5 above a 116 entry against a stop under the 92 gap risks 24 to make 0.5
// (the 1:1 gate). The velocity confirmation door is wide open on the same tape [C9].
const shockThenRunTape = (() => {
  const bars = mk(() => 100, 250)
  append(bars, 100, 1_000_000, 92) // −8% open gap, closed by the bell
  for (let i = 0; i < 4; i++) append(bars, 100)
  append(bars, 104)
  append(bars, 108)
  append(bars, 112, 2_500_000)
  append(bars, 117)
  append(bars, 116)
  return bars
})()

// THE COLLISION, velocity edition: a −3/session crash from 280 to 115, then a
// five-session +15.7% bounce. The composite reads a name 25% under its 50-day with
// deeply negative momentum and calls a live, routable, contract-passing SHORT; the
// velocity lane reads a paid run holding the 8-EMA and calls a long. One tape, two
// lanes, opposite sides. `paidVol` is the ONLY difference between the two fixtures:
// 2.5M opens the confirmation door, 1M leaves it shut, and the composite short is
// byte-identical either way — so the demotion below can only be the lane's doing.
const crashBounce = (paidVol: number): Candle[] => {
  const bars = mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 3), 255)
  append(bars, 121)
  append(bars, 126)
  append(bars, 131, paidVol)
  append(bars, 136)
  append(bars, 133)
  return bars
}

// The same idea one gate lower: a −2/session slide then a paid five-session bounce.
// The core read (−21.6) dies in the dead zone, so the composite publishes NOTHING
// and the name lands in the near-miss list as the closest thing to a short — the
// row the velocity long has to suppress [C10].
//
// THE BOUNCE WAS STEEPENED on 2026-09-22 (176/183/190/197/196 → 178/187/196/205/204)
// and the reason is worth stating, because it is a fixture keeping its MEANING
// rather than keeping its numbers. `bandwidth` joined the core and `momentum` grew
// a 60-session leg: on the shallower bounce the same chart composited −26.4, which
// is OUTSIDE the ±25 dead zone, so BNC published as a live short and there was no
// near miss left for the velocity long to suppress. A steeper bounce restores the
// dead-zone read (−21.6) this fixture exists to produce, on the same shape — a
// paid five-session recovery off a −2/session slide, 2.5M on the third bar. [F3] is
// pinned here and nowhere else, so the fixture has to keep working.
const slideBounceTape = (() => {
  const bars = mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2), 255)
  append(bars, 178)
  append(bars, 187)
  append(bars, 196, 2_500_000)
  append(bars, 205)
  append(bars, 204)
  return bars
})()

// ---- a hype cluster, built from tapes that really do move together ----
// Sixty sessions of correlated excess returns ending on the index's newest bar
// (r > 0.95 pairwise), then one 8% break. ZCLU prints 3× volume on it and opens
// the early door; its two partners print 1× and open nothing — so only ZCLU can
// ever publish, and the cluster's whole effect is priority and narration.
const CLUSTER_RETS = (k: number) => Array.from({ length: 58 }, (_, i) => 0.02 * Math.sin(i * 1.9) * k + 0.001 * Math.cos(i * 3.1 * k))
const clusterTape = (k: number, jumpVol: number): Candle[] => {
  const rets = CLUSTER_RETS(k)
  const bars: Candle[] = []
  let c = 100
  const startDay = 259 - rets.length - 1 // the last bar lands on T0+259, like every tape here
  for (let i = 0; i <= rets.length; i++) {
    if (i > 0) c *= 1 + rets[i - 1]
    bars.push({ t: T0 + (startDay + i) * 86_400, o: c, h: c * 1.005, l: c * 0.995, c: Math.round(c * 100) / 100, v: 1_000_000 })
  }
  append(bars, Math.round(bars[bars.length - 1].c * 1.08 * 100) / 100, jumpVol)
  return bars
}
const CLUSTER_TAPES = new Map<string, Candle[]>([
  ['ZCLU', clusterTape(1, 3_000_000)],
  ['ZCLA', clusterTape(0.95, 1_000_000)],
  ['ZCLB', clusterTape(1.05, 1_000_000)],
])
/** `days` of trending record, every day naming all three — the co-appearance leg's
 * raw material, ending the day before the tapes' last bar. */
const clusterHistory = (days: number): TrendDay[] =>
  Array.from({ length: days }, (_, i) => ({
    date: new Date((T0 + (252 + i) * 86_400) * 1000).toISOString().slice(0, 10),
    syms: ['ZCLU', 'ZCLA', 'ZCLB'],
  }))

// every index/future green, VIX bleeding → an unambiguous risk-ON overnight tape,
// which lifts a LONG's conviction and cuts a SHORT's (worldTape.ts)
const riskOnReads = async () => [
  { sym: '^N225', name: 'Nikkei', changePct: 1.2 },
  { sym: '^HSI', name: 'Hang Seng', changePct: 1.5 },
  { sym: '^GDAXI', name: 'DAX', changePct: 1.1 },
  { sym: '^FTSE', name: 'FTSE 100', changePct: 1.0 },
  { sym: 'ES=F', name: 'S&P fut', changePct: 1.3 },
  { sym: 'NQ=F', name: 'Nasdaq fut', changePct: 1.4 },
  { sym: '^VIX', name: 'VIX', changePct: -8 },
]

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

// Calibration where this band has PROVEN itself — so the call grades. 32 and 22,
// not the old 20 and 14, because v3 redefined what "proven" means: grade A now
// needs nEff ≥ 30 observations straddling the read as well as p ≥ base+0.10, and
// grade B needs nEff ≥ 15.
//
// One band of evidence makes a one-point curve, flat at every |composite|, and it
// reads 0.63 rather than the raw (22+2)/(32+4) = 0.6667: a rung's shrinkage target
// is the rung BELOW it, not itself, and here that is rung 4 (the same 32
// observations pooled across regimes) and then the cold base rate 0.5 (n=32 < 50).
// With w = 32/(32+25) = 0.5614035 at each step:
//   rung 4 = 0.5614035×0.6666667 + 0.4385965×0.5        = 0.5935673
//   rung 3 = 0.5614035×0.6666667 + 0.4385965×0.5935673  = 0.6346055
// Still ≥ base+0.10 on nEff 32, so a call reading it AT OR ABOVE the band's
// midpoint grades A. A call BELOW that midpoint reads the same 0.63 but caps at C
// — the number was handed down from a conviction the engine HAS graded to one it
// has not. Which of the two a fixture gets is decided by its |composite|, and each
// such case below carries the comparison in a comment.
// seedGeneration: 5 everywhere a test writes a blob — the committed seed is
// generation 5 (the 21-session walk on the large-cap universe, 2026-09-22), and
// Task 1's install swap
// REPLACES any stored state announcing a lower generation. A test fixture without
// the stamp is not "today's stored state"; it is an install target. This number
// moves with every committed generation, by design: the fixtures claim to BE the
// current epoch, so a stale stamp is a fixture quietly replaced mid-test.
const calWith = (key: string): CalibrationState => ({ buckets: { [key]: { n: 32, hits: 22 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })

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
    // |composite| 64.8 sits ABOVE the 55-70 band's 62.5 midpoint, so this is a read
    // on evidence at-or-below the conviction: 0.6346055 ≥ 0.5+0.10, nEff 32 ≥ 30 → A.
    expect(call.grade).toBe('A')
    expect(call.probability).toBeCloseTo(0.63, 2)
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
    await store.write('engine-calibration', { buckets: { 'short:amber:55-70': { n: 20, hits: 14 }, 'short:amber:70+': { n: 20, hits: 14 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
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

  // THE PROVENANCE PARTITION, at the only place a reader ever sees it [stage 3c].
  // Same tape, same composite, same 32/22 bucket totals as the A above — but 17 of
  // those 32 observations came from rows nobody could take. The two tests below are
  // one fixture read two ways, which is the whole claim: what changes is not the
  // evidence but whose evidence it is.
  //   pooled 32/22 → laplace 0.6667, shrunk twice → 0.6346, nEff 32 → A
  //   sized  15/10 → laplace 0.6316, shrunk twice → 0.5802, nEff 15 → B
  // (the grade anchor is the pooled base either way — 32 < 50, so the cold 0.5 —
  // because `referenceBase` is an unconditional sweep with no sized slice to take.)
  const partitionedCal = (key: string): CalibrationState => ({
    buckets: { [key]: { n: 32, hits: 22, shadowN: 17, shadowHits: 12 } },
    brier: [],
    defVersion: CALIB_DEF_VERSION,
    seedGeneration: 5,
  })

  it('a SIZED row grades against SIZED history — the seventeen shadow observations no longer buy it an A', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', partitionedCal('short:amber:55-70'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps(), NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call).toBeDefined()
    expect(call.riskPct).toBeGreaterThan(0) // a row the reader can act on — which is WHY it reads sized
    expect(call.accrual).toBe('sized') // …and what it will TEACH is the same population it was graded on
    expect(call.grade).toBe('B') // 'A' on the same totals before the partition
    expect(call.probability).toBeCloseTo(0.58, 2)
    // and the row still trades: this is a demotion in what the engine CLAIMS, not
    // a suppression — B with the contract is still the full rung
    expect(call.watchOnly).toBeUndefined()
  })

  it('…while a row the reader could never place is PRICED against the pool — a shadow’s probability is not reader money', async () => {
    // Identical fixture, one difference: an earnings print inside the horizon, so
    // this row cannot be sized whatever the grade says. It is booked into the
    // shadow population, so the shadow population is the honest one to price it
    // against — and it reads the pooled 0.63 the sized row above was denied.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    await store.write('engine-calibration', partitionedCal('short:amber:55-70'))
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps({ earningsSyms: async () => new Set(['NVDA']) }), NOW)
    expect(board.find(b => b.sym === 'NVDA')).toBeUndefined() // never on the reader-facing board
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const shadow = (await store.read<Prediction[]>(`predictions:${today}`))!.find(p => p.sym === 'NVDA')!
    expect(shadow.shadow).toBe(true)
    expect(shadow.riskPct).toBe(0)
    expect(shadow.accrual).toBe('shadow') // an earnings print is one of the three PRE-GRADE causes
    expect(shadow.probability).toBeCloseTo(0.63, 2)
    expect(shadow.grade).toBe('A')
  })

  // THE ACCRUAL STAMP [stage 3c, re-ratified after the Task-1 review]. The row
  // records at publication WHICH POPULATION IT WILL TEACH, and it records it from
  // the same three pre-grade causes that chose the population it was PRICED on —
  // so the two can never disagree. The point of the re-ratification is what is NOT
  // on the shadow side of that line: a grade-null demotion is the band's own
  // record of what happened to it, and sealing it made a band that dipped under
  // the anchor unable to earn its way back up (engine.ts says in its own words
  // that it must be able to).
  it('a BELOW-BASE watch row accrues SIZED — the demotion is the band’s recovery record, not dilution', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' }, GNOM: { short2x: 'INV' }, PUND: { short2x: 'INV' }, DUO: { short2x: 'INV' }, FRESH: { short2x: 'INV' } } })
    // the same fixture as the below-base watch test above: this band has proven it
    // loses, so the grade comes back null and the row publishes at zero size.
    await store.write('engine-calibration', { buckets: { 'short:amber:55-70': { n: 30, hits: 9 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    const { board } = await buildBoard(store, deps(), NOW)
    const call = board.find(b => b.sym === 'NVDA')!
    expect(call.belowBase).toBe(true)
    expect(call.riskPct).toBe(0) // no money on it…
    expect(call.accrual).toBe('sized') // …and it still teaches the sized population
    expect(call.shadow).toBeUndefined()
  })

  it('…and so does the FOURTH shadow condition — a null grade on a failed contract is priced sized AND accrues sized', async () => {
    // `!grade && !contract` is decided BY the read, so it cannot choose the
    // population without circularity — it is priced 'sized' like any other
    // candidate. Under the ratified stamp it now ACCRUES sized as well, so the
    // asymmetry the Task-1 review flagged (priced sized, booked shadow) is gone.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'SNVD' } } })
    // partitioned totals + an unreachable anchor: the sized read is 0.58 and the
    // pooled one 0.63, and 0.8 is above both, so the grade is null either way —
    // which makes the PRICE the only thing that can tell us which population it
    // was read from.
    await store.write('engine-calibration', {
      buckets: { 'short:unknown:55-70': { n: 32, hits: 22, shadowN: 17, shadowHits: 12 } },
      brier: [],
      referenceBase: 0.8,
      defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
    })
    await store.write('video-extracts', [
      { url: 'yt/1', channel: 'Stocks with Josh', at: NOW - 2 * 86_400, tickers: [{ sym: 'NVDA', stance: 'bear', levels: [] }], themes: [] },
    ])
    // no QQQ candles → regime 'unknown' → the evidence contract fails on the regime leg
    const noQqq = deps({ candles: async sym => (sym === 'NVDA' ? shorty : sym === 'SPY' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null) })
    const { board, regime } = await buildBoard(store, noQqq, NOW)
    expect(regime).toBe('unknown')
    expect(board.find(b => b.sym === 'NVDA')).toBeUndefined() // a null grade with no contract is a shadow row
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const row = (await store.read<Prediction[]>(`predictions:${today}`))!.find(p => p.sym === 'NVDA')!
    expect(row.shadow).toBe(true)
    expect(row.evidence.contract).toBe(false)
    expect(row.riskPct).toBe(0)
    expect(row.probability).toBeCloseTo(0.58, 2) // the SIZED read — 0.63 is what the pooled one says
    expect(row.accrual).toBe('sized') // …and the stamp now agrees with the price
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
    expect(shadow.accrual).toBe('shadow') // an unroutable short is a pre-grade cause: it dilutes, it does not recover
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
      // GRADED means the CALIBRATED grade (outcome21 since v4) — a row carrying only
      // the 5 and 10 lenses has not fed the learning loop, so it still holds its slot.
      { id: `${priorDate}:NVDA:short`, sym: 'NVDA', side: 'short', shadow: true, outcome5: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true }, outcome10: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true }, outcome21: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true } },
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
    await store.write('engine-calibration', { buckets: { 'short:amber:55-70': { n: 30, hits: 9 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
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
    await store.write('engine-calibration', { buckets: { 'short:unknown:55-70': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
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
    await store.write('engine-calibration', { buckets: { 'long:amber:25-40': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
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

  it('…and a 1x field on an EQUITY entry does not mint one there: the fractional-size mint is the crypto lane’s alone', async () => {
    // Stage 1c-R gave LevMap `long1x`/`short1x` for the crypto route, and the
    // engine mints them BELOW full size for a crypto row only. The same-shaped
    // entry on an equity name must leave this half-size row exactly as the test
    // above found it — no instrument, no paper-only flip, nothing.
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { long1x: 'GLW1' } } })
    await store.write('engine-calibration', { buckets: { 'long:amber:25-40': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    await store.write('risk-state', { rung: 3, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })
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
    expect(call.riskPct).toBe(RUNG_RISK_PCT[call.riskRung] / 2) // still the half-size row
    expect(call.instrument).toBeNull()
    expect(call.paperOnly).toBe(false)
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
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
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
    wildcardOff() // the near-miss mechanism, on its own — see the note on the helper
    const store = memoryStore()
    await store.write('config', {
      watchlist: [{ symbol: 'CALM' }, { symbol: 'RISE' }, { symbol: 'DROP' }],
      rules: [],
      ytChannels: [],
      levMap: { CALM: { short2x: 'ICLM' } }, // DROP deliberately has no short route
    })
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 }) // base rate 0.5
    const d = deps({
      screens: async () => [],
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'CALM' || sym === 'DROP' ? deadSlide : sym === 'RISE' ? deadClimb : sym === 'SPY' || sym === 'QQQ' ? flat : null,
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
    await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    const d = deps({
      screens: async () => [],
      mediaTitles: async () => [],
      // every candidate bleeds → every core read is negative → no long side at all
      candles: async sym => (sym === 'CALM' || sym === 'DROP' ? deadSlide : sym === 'SPY' || sym === 'QQQ' ? flat : null),
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
    wildcardOff()
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
        sym === 'NVDA' ? shorty : sym === 'RISE' ? deadClimb : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null,
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
        sym === 'NVDA' ? shorty : sym === 'RISE' ? deadClimb : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null,
    })
    const { board } = await buildBoard(store, d, NOW)

    const nvda = board.find(b => b.sym === 'NVDA')!
    expect(nvda).toBeDefined()
    expect(nvda.side).toBe('short')
    expect(nvda.nearMiss).toBeUndefined() // it cleared the gates — it is not a near miss
    expect(nvda.observation).toBe(true) // …and it is stamped, so every surface can contain it without parsing prose
    expect(nvda.evidence.contract).toBe(true)
    // The short/amber rung holds ONE band — 55-70, 32/22 — so its curve is a single
    // point at midpoint 62.5, read flat at every conviction: p 0.6346055, nEff 32.
    // On p and evidence DEPTH alone that is an A (base 0.5 cold). But this call's
    // |composite| is 52.8: the engine has never graded a 52.8-conviction short in
    // amber, and the only reason there is a number at all is that the 62.5 reading
    // was extended DOWNWARD to meet it. No grade is born below its evidence, so it
    // caps at C. Everything else about the row is unchanged — which is the point:
    // the cap moves the grade, not the row's status.
    expect(nvda.grade).toBe('C')
    expect(nvda.probability).toBeCloseTo(0.63, 2) // …the read itself is untouched by the cap
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
      // DROP dies at the expected-move floor → a real short near miss for the fallback
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
        sym === 'NVDA' ? shorty : sym === 'RISE' ? deadClimb : sym === 'DROP' ? deadSlide : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null,
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
        // …and GRADED is the calibrated lens (outcome21 since v4), not the 10 one
        outcome10: { excessPct: -3, rawPct: -3, spyPct: 0, stopped: false, hit: true },
        outcome21: { excessPct: -3, rawPct: -3, spyPct: 0, stopped: false, hit: true },
      })
      await buildBoard(store, dedupDeps, NOW)
      expect((await ledgerOf(store))!.some(p => p.sym === 'NVDA')).toBe(true)
    })

    it('…but once it has GRADED, the slot is free again', async () => {
      const graded21 = { excessPct: -3, rawPct: -3, spyPct: 0, stopped: false, hit: true }
      const store = await dedupStore({ observation: true, watchOnly: true, outcome10: graded21, outcome21: graded21 })
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
      seedGeneration: 5,
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
      seedGeneration: 5,
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
    await store.write('engine-calibration', { buckets: { 'short:unknown:55-70': { n: 20, hits: 11 } }, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
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

  it('favourite subscriptions cannot nominate a stock through an unearned accuracy prior', async () => {
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
    expect(pund).toBeUndefined()
    expect(board.find(b => b.sym === 'PUND')).toBeUndefined()

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
  /** The same ledger read on a board built at some OTHER instant — the velocity
   * fixtures below run at NOW_240. The ledger, not the board, is where a SHADOW
   * row lives: `engine-board` carries live calls only. */
  const ledgerAt = (store: ReturnType<typeof memoryStore>, nowSec: number) =>
    store.read<Prediction[]>(`predictions:${new Date(nowSec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })}`)

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
    // capacity 4.9%, under the roster's join gate (8), so NEITHER is enrolled and
    // the sleeve's append to evalRows is the only thing that can carry a name of
    // this shape to scoring at all. fetchSparkCloses fails soft per 20-name chunk,
    // and here GLW's chunk died: the batch came back with MMM and without GLW.
    // That append, the dip-lane quality grant and priority 4 are all privileges
    // paid for by having the data — so GLW must be read exactly as it was
    // pre-sleeve, while MMM, whose closes really did arrive, keeps every one.
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
    expect(ledger.find(p => p.sym === 'GLW')).toBeUndefined() // no closes behind it → never appended to evalRows

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
    // p = (22+2)/(32+4) = 0.6667 ≥ base 0.5 + 0.10, nEff 32 ≥ 30 → A. Under v2 this
    // was capped at B by `capacityPct ≥ 8`, which has left gradeFor entirely: a
    // name's typical move is a SIZING question and it is answered in composite.ts.
    expect(call.grade).toBe('A') // graded on the ordinary calibration path like any call
  })

  // ---- reference-anchored grading (spec §9, ratified 2026-08-13) ----
  //
  // The wiring, end to end on the board: `gradeFor` reads `gradeBaseRate`, not the
  // pooled base. One store, two runs, identical in every respect except a single
  // stored `referenceBase` — so the grade step below is attributable to that field
  // and to nothing else. The buckets are a deep-seed shape in miniature: 200 rows
  // pooling to exactly 0.5, which is where a board-driven population lands and why
  // its own rows can no longer clear it.
  const dipRefDeps = () =>
    deps({
      screens: async () => [],
      social: async () => [],
      mediaTitles: async () => [],
      candles: async sym => (sym === 'GLW' ? dipTape : sym === 'SPY' || sym === 'QQQ' ? flat : null),
      capUsdM: async sym => (sym === 'GLW' ? 35_000 : null),
      sparkCloses: sparkOf(dipTape),
    })
  const dipRefStore = async (referenceBase?: number) => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', {
      buckets: { 'long:amber:25-40': { n: 200, hits: 100 } }, // pooled (100+2)/(200+4) = 0.5
      brier: [],
      defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
      ...(referenceBase == null ? {} : { referenceBase }),
    })
    return store
  }

  it('a row that ties its own selected population grades C — the all-C finding, reproduced on the board', async () => {
    const { board } = await buildBoard(await dipRefStore(), dipRefDeps(), NOW)
    const call = board.find(b => b.sym === 'GLW')!
    expect(call).toBeDefined()
    expect(call.probability).toBeCloseTo(0.5, 2) // reads its band exactly
    expect(call.grade).toBe('C') // p = base, so it clears neither +0.05 nor +0.10
  })

  it('…and the SAME row grades A once a swept referenceBase says what ordinary odds are', async () => {
    const { board } = await buildBoard(await dipRefStore(0.37), dipRefDeps(), NOW)
    const call = board.find(b => b.sym === 'GLW')!
    expect(call).toBeDefined()
    // PROBABILITY IS UNMOVED — the reference is a grading anchor, never a price.
    expect(call.probability).toBeCloseTo(0.5, 2)
    expect(call.grade).toBe('A') // 0.5 ≥ 0.37 + 0.10, nEff 200 ≥ 30
    expect(call.riskPct).toBeGreaterThan(0) // …and it is sized, which is the point of the change
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

  // The collision harness: one tape both lanes read, opposite sides, GLW routable
  // so 'unshortable' can never be what shadows the short. The two bands are sized
  // to the v3 grade gates and to each other:
  //   short 40-55  32/22 → (22+2)/(32+4) = 0.6667, nEff 32 → p ≥ .60 AND nEff ≥ 30 → A
  //   long  25-40  16/11 → (11+2)/(16+4) = 0.65,   nEff 16 → p ≥ .55 AND nEff ≥ 15 → B
  // and 32 + 16 = 48 observations, still under the 50 baseHitRate needs, so the
  // base rate is the cold 0.5 those thresholds assume. The short is a genuine live
  // A before anything demotes it; the long is a genuine sized B.
  const collisionStore = async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { GLW: { short2x: 'INV' } } })
    // Pin the weights blob rather than cold-starting from the seed: the composite
    // this narrative depends on (−41.5 vs the 47.5 midpoint) must not move under
    // the seed's own IC, which is deep enough to nudge inside a single run.
    // (Generation 2 made this load-bearing — its `current` carried the walk's
    // nudges. Generation 3's is DEFAULT_WEIGHTS, so the pin now guards the nudge
    // loop rather than the vector; it stays, because the guard is the point.)
    await store.write('engine-weights', { ...initWeights(), seedGeneration: 5 })
    await store.write('engine-calibration', {
      buckets: { 'short:amber:40-55': { n: 32, hits: 22 }, 'long:amber:25-40': { n: 16, hits: 11 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
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
    // …and nothing ELSE could have shadowed it: it graded on a passing contract,
    // no earnings print, and a routable inverse ETP. Only the dip read did this.
    // The grade is C, not A: this rung's only band is 40-55 (32/22, midpoint 47.5)
    // and GLW's short composite is −41.5, so the 0.63 read was handed DOWN to a
    // conviction the engine has never graded. p and nEff would both have carried an
    // A; the missing evidence at-or-below 41.5 is what caps it.
    expect(short.grade).toBe('C')
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
    expect(shown[0].riskPct).toBeGreaterThan(0) // live and sized, not a survivor of a demotion
    // C, capped by the born-below-evidence rule (composite −41.5 under a 47.5
    // midpoint — see the transient case above), and C WITH the contract is the HALF
    // tier: the row is sized at half the rung it would have carried as an A.
    expect(shown[0].grade).toBe('C')
    expect(shown[0].riskPct).toBe(0.5) // R0 rung risk 1.0, halved

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
    // engine had a perfectly good, routable, sized short on.
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
    expect(shown[0].grade).toBe('C') // capped below its evidence (composite −41.5, midpoint 47.5)
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
      seedGeneration: 5,
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
    // Pin the weights blob — the seed's own IC is deep enough to nudge inside one
    // run and move both dips' composites off the band boundaries this narrates.
    await store.write('engine-weights', { ...initWeights(), seedGeneration: 5 })
    await store.write('engine-calibration', {
      // OXY's deeper dip composites at 41.4 (the 40-55 band), GLW's at 39.3 — both
      // bands proven, so BOTH dip longs are genuinely sized before the cut speaks.
      // Under v3 that costs three different depths, because the grade now prices
      // the evidence and the base rate still has to stay cold:
      //   short 40-55 32/22 → 0.6667, nEff 32 → A, the live sized row this test is about
      //   long  25-40  8/6  ┐ two bands, both (6+2)/(8+4) = 0.6667; pooled parent
      //   long  40-55  8/6  ┘ (12+2)/(16+4) = 0.7, each shrunk w = 8/33 → 0.6919,
      //                       nEff 8 → C — and C WITH the lane's contract is a
      //                       half-size trade, so both longs still publish sized.
      // 32 + 8 + 8 = 48 observations, under the 50 baseHitRate needs → base 0.5.
      buckets: {
        'short:amber:40-55': { n: 32, hits: 22 },
        'long:amber:25-40': { n: 8, hits: 6 },
        'long:amber:40-55': { n: 8, hits: 6 },
      },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
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
    expect(short.grade).toBe('C') // capped below its evidence (composite −41.5, midpoint 47.5)
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
    // (22+2)/(32+4) = 0.6667, nEff 32, base 0.5 → A. Was B under v2's capacity gate.
    expect(row.grade).toBe('A') // nothing ELSE shadowed it: it graded, on a passing contract
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

  // THE VOICE (voice.ts). dipLane.ts is pure and cannot ask the news question, so
  // it writes the thesis without a clause; buildBoard — the only place the verdict
  // exists — re-composes it with the SAME builder, so the falsifier can never
  // drift from the stop the row published.
  it("the dip's thesis carries the news read the lane itself could not ask", async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    const d = dipDeps({ dipNews: async () => ({ verdict: 'transient', reason: 'sector sympathy, guidance intact' }) })
    const { board } = await buildBoard(store, d, NOW)

    const call = board.find(b => b.sym === 'GLW')!
    expect(call.thesis).toContain('Long GLW — hit ')
    expect(call.thesis).toContain('and holding, and the story behind the fall reads like an overreaction')
    expect(call.falsifier).toBe(`Wrong if it closes below ${call.stop}.`)
    expect(call.thesis!.endsWith(call.falsifier!)).toBe(true)
    expect(bannedTokensIn(call.thesis!)).toEqual([]) // …and no field name reaches the reader
    // the machine-voiced line survives beneath it, unchanged
    expect(call.note).toBe(call.evidence.detail)
    expect(call.note).toContain('holding')
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

  // ---- the velocity lane ----
  //
  // SHADOW-FIRST (owner decision, 2026-08-12). The lane ships GRADED BUT UNSIZED:
  // `VELOCITY_SHADOW_FIRST` makes every velocity call publish as a shadow, so it
  // feeds calibration and its own setup family while carrying no reader money. The
  // tests below therefore specify BOTH modes and branch on the flag — the sized
  // branch is not commented-out history, it is the behaviour the day the owner
  // flips the flag to false, and it must not rot while the lane earns its size.
  //
  // Two rules run through every branch:
  //   · a shadow lives in the LEDGER, never on the reader's board (`engine-board`
  //     carries live calls only) — so a shadow-mode assertion reads `ledgerAt`.
  //   · an UNSIZED row must never cost the reader a SIZED one. A shadow velocity
  //     long does not demote the opposing composite short and does not suppress a
  //     short near miss; both of those cures exist to stop the board contradicting
  //     itself over a row the reader can take, and a shadow is not such a row [F3].

  const velocityStore = async (buckets: Record<string, { n: number; hits: number }>) => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' } } })
    // Total n stays under 50 so baseHitRate remains the cold 0.5 and the grades
    // below are the ones the v3 thresholds describe: A at p ≥ 0.60 with nEff ≥ 30,
    // B at p ≥ 0.55 with nEff ≥ 15. A single planted band is a one-point curve —
    // flat at every |composite|, shrunk toward a parent that IS itself — so each
    // caller picks its grade purely by how deep it makes the bucket. (The collision
    // harness above does the same.)
    await store.write('engine-calibration', { buckets, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
    await store.write('engine-weights', { ...initWeights(), seedGeneration: 5 })
    return store
  }

  // The board as it stood on the day of the break: VELO's paid breakout beside TWO
  // untagged controls that keep the world-tape rule honest in both directions — an
  // ordinary composite SHORT carrying a NEWS catalyst, and an ordinary composite
  // LONG carrying no catalyst at all, on the same risk-ON tape.
  const breakoutBoard = async (store: ReturnType<typeof memoryStore>) =>
    buildBoard(
      store,
      deps({
        candles: async s =>
          s === 'VELO' ? breakTape240
          : s === 'NVDA' ? shorty.slice(0, 241)
          : s === 'BULL' ? bullTape
          : s === 'SPY' || s === 'QQQ' ? flat.slice(0, 241)
          : null,
        screens: async () => [
          { row: { sym: 'VELO', price: 105, capUsdM: 5_000, changePct: 5, name: null }, source: 'screener:gainers' },
          { row: { sym: 'NVDA', price: 200, capUsdM: 50_000, changePct: -3, name: null }, source: 'screener:losers' },
          { row: { sym: 'BULL', price: 290, capUsdM: 50_000, changePct: 1, name: null }, source: 'screener:gainers' },
        ],
        newsCatalysts: async () => [{ sym: 'NVDA', side: 'short' as const, reason: 'guidance cut', strength: 80 }],
        worldReads: riskOnReads,
      }),
      NOW_240,
    )

  it('a paid break of the 20-session high publishes a velocity long — shadowed while it earns its size, quarter-size once it has', async () => {
    const store = await velocityStore({ 'long:amber:25-40': { n: 20, hits: 14 }, 'short:amber:25-40': { n: 20, hits: 14 } })
    const { board } = await breakoutBoard(store)

    // Read from the LEDGER, which holds the row in both modes: a sized velocity
    // long is a live call (and therefore also on the board, asserted below), a
    // shadowed one is in the ledger only.
    const call = (await ledgerAt(store, NOW_240))!.find(p => p.sym === 'VELO')!
    expect(call).toBeDefined()
    expect(call.side).toBe('long')
    expect(call.setup).toBe('velocity') // its own calibration family, never pooled with continuations
    expect(call.stop).toBeLessThan(call.entry)
    expect(call.target).toBeGreaterThan(call.entry)
    expect(call.composite).toBe(30) // 25 + the five-session move, inside the calibrated bands
    expect(call.evidence.contract).toBe(true) // the lane's own gates ARE its contract
    // Graded on the ordinary calibration path like any call — shadows grade too.
    // The read is 0.6152263 (20/14 → 16/24 = 0.6667 at w = 20/45, shrunk toward rung
    // 4's 0.5740741, itself shrunk toward the cold 0.5 base) on nEff 20: a B on both
    // p and depth. It caps at C because composite 30 sits BELOW the 25-40 band's
    // 32.5 midpoint — the lane's fresh break is a conviction this rung has never
    // graded, and the number was extended down to reach it.
    expect(call.grade).toBe('C')
    expect(call.watchOnly).toBeUndefined() // never a watch row: shadow and watch are exclusive, and this cleared its gates

    if (VELOCITY_SHADOW_FIRST) {
      // SHADOW-FIRST: the whole read is published and graded, and none of it is
      // offered to the reader. Zero size, no route, off the board.
      expect(call.shadow).toBe(true)
      expect(call.riskPct).toBe(0)
      expect(call.instrument).toBeNull()
      expect(board.some(b => b.sym === 'VELO')).toBe(false)
    } else {
      // …and the day the flag flips, this is the row again: a real, takeable trade
      // at a QUARTER of the rung. C on a passing contract is the HALF tier and the
      // early door caps at a quarter, and sizedFraction is the MIN of the two — so
      // the door is still what sets the size, exactly as when this graded B.
      expect(call.shadow).toBeUndefined()
      expect(call.riskPct).toBe(RUNG_RISK_PCT[call.riskRung] * VELOCITY_DOOR_CAP.early)
      expect(call.riskPct).toBe(0.25)
      expect(board.find(b => b.sym === 'VELO')).toEqual(call)
    }

    // the producer-side triad [T2-review]. (1) the tag the whole lane family is
    // keyed off — a typo here silently trains the technical factor on lane P&L:
    expect(call.catalyst).toEqual({ kind: 'velocity', reason: expect.stringContaining('early door') })
    // …and the marker that makes the trail enforceable downstream (Task 6). It is
    // stamped at THIS site, not derived later: the open book and the £10k book both
    // read it off the row, and the paper book copies it onto the position it opens.
    expect(call.trail).toBe('velocity')
    // (2) a structural composite never saw the world-tape nudge, so the row records
    // the multiplier it truly ran at — on a tape where the nudge is unmistakably ON:
    expect(call.worldTape).toEqual({ tone: 'risk-on', mult: 1 })

    // …and the same rule read from the other side: an ordinary row carrying a NEWS
    // catalyst is NOT a lane row, and it keeps the real nudge for its side. Without
    // this the "lane rows print 1" rule could be a blanket "catalyst rows print 1".
    const ordinary = board.find(b => b.sym === 'NVDA')!
    expect(ordinary).toBeDefined()
    expect(ordinary.catalyst!.kind).toBe('news')
    expect(ordinary.worldTape).toEqual({ tone: 'risk-on', mult: worldMult('risk-on', ordinary.side) })
    expect(ordinary.worldTape!.mult).not.toBe(1) // the comparison has real content in it
    // …and once more with the SIDE held constant, because NVDA is a short and the
    // pair above is therefore also satisfied by "print 1 for longs" — a rule keyed on
    // the side rather than the lane. BULL is an untagged LONG on this same risk-on
    // board: it must take the 1.1 nudge the velocity long above does not.
    const sameSide = board.find(b => b.sym === 'BULL')!
    expect(sameSide).toBeDefined()
    expect(sameSide.side).toBe('long')
    expect(sameSide.catalyst).toBeUndefined()
    expect(sameSide.worldTape).toEqual({ tone: 'risk-on', mult: 1.1 })
    // …and neither control carries the trail marker: it belongs to the lane whose
    // stop IS a trail, and one byte of it on an ordinary row moves that row's exit.
    expect(ordinary.trail).toBeUndefined()
    expect(sameSide.trail).toBeUndefined()
  })

  it('(3) …and a calibrated horizon on, the graded break teaches calibration and its own setup family — never the technical factor, and never the ladder while it is shadowed', async () => {
    const store = await velocityStore({ 'long:amber:25-40': { n: 20, hits: 14 }, 'short:amber:25-40': { n: 20, hits: 14 } })
    await breakoutBoard(store)
    const date = new Date(NOW_240 * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    expect((await store.read<Prediction[]>(`predictions:${date}`))!.some(p => p.sym === 'VELO')).toBe(true)

    // The grader returns with the matured tape. NVDA is deliberately unreadable
    // here, so the ONLY thing graded this run is the velocity row — "ic.technical
    // at zero" then means exactly that, with no control row to hide behind.
    const graded = await gradeOutstanding(
      store,
      deps({ candles: async s => (s === 'VELO' ? breakTapeMatured : s === 'SPY' ? flatLongSpy : null) }),
      NOW_240_MATURED,
      null,
    )
    expect(graded.graded).toBe(1)

    // the quarantine, end to end: the lane's constant technical +40 placeholder
    // never becomes a factor observation, and the nudge counter never advances
    const w = (await store.read<WeightsState>('engine-weights'))!
    expect(w.ic.technical).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
    expect(w.gradedSinceNudge).toBe(0)

    // …while everything a graded long IS evidence about accrues as normal, and
    // THIS IS THE POINT OF SHADOW-FIRST: the learning loop eats the row whether or
    // not the reader was offered it. The shared cohort/side/regime/band bucket (a
    // long in this band is evidence about longs in this band, whatever lane found
    // it), the family's own setup bucket and the Brier trail all move — identically
    // in both modes.
    // …and the PROVENANCE PARTITION rides along [stage 3c]: the row is booked into
    // the shared bucket AND recorded as shadow evidence inside it, so a future
    // SIZED read of this band gets its observation count back to zero while the
    // pooled read still sees the shadow's outcome. A lane stand-down is one of the
    // three PRE-GRADE causes, so the row was stamped `accrual: 'shadow'` at
    // publication — the dilution the walk named stays out of the sized read, and
    // the shape of the assertion is itself the pin: shadow-first books the
    // sub-counts, a sized velocity row would not.
    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    const velo = (await store.read<Prediction[]>(`predictions:${date}`))!.find(p => p.sym === 'VELO')!
    expect(velo.accrual).toBe(VELOCITY_SHADOW_FIRST ? 'shadow' : 'sized')
    // the OTHER branch is the explicit zero, not an absence [fix wave]: a sized
    // velocity row is still a partition-aware accrual and still stamps.
    const shadowSub = VELOCITY_SHADOW_FIRST ? { shadowN: 1, shadowHits: 1 } : { shadowN: 0, shadowHits: 0 }
    expect(cal.buckets['large:long:amber:25-40']).toEqual({ n: 1, hits: 1, ...shadowSub })
    expect(cal.buckets['long:amber:25-40']).toEqual({ n: 20, hits: 14 }) // the seeded bucket is untouched
    expect(cal.setupBuckets!['velocity:long:25-40']).toEqual({ n: 1, hits: 1, ...shadowSub })
    expect(cal.brier.at(-1)).toMatchObject({ n: 1 })

    // The RISK LADDER is the one learner that must NOT move on a shadow: the rung
    // is earned on calls the reader could actually take, and a shadow was never on
    // offer. Same for the evidence provenance split, which is how the scorecard
    // keeps "what the engine risked" apart from "what it was auditioning".
    const risk = (await store.read<RiskState>('risk-state'))!
    // velocityStore seeds two 20/14 buckets on a blob with no `seeded` flag, so the
    // provenance migration books them as prior LIVE evidence. That is the baseline
    // both branches move from — the question is WHICH counter takes today's grade.
    const seededAsLive = { n: 40, hits: 28 }
    if (VELOCITY_SHADOW_FIRST) {
      expect(risk.gradedAtRung).toBe(0)
      expect(risk.cohorts!.large.gradedAtRung).toBe(0)
      expect(cal.evidence!.shadow).toEqual({ n: 1, hits: 1 })
      expect(cal.evidence!.live).toEqual(seededAsLive) // untouched: nothing was risked
    } else {
      // flip the flag and the ladder counts it, exactly like any other sized call
      expect(risk.gradedAtRung).toBe(1)
      expect(risk.cohorts!.large.gradedAtRung).toBe(1)
      expect(cal.evidence!.live).toEqual({ n: seededAsLive.n + 1, hits: seededAsLive.hits + 1 })
      expect(cal.evidence!.shadow).toEqual({ n: 0, hits: 0 })
    }
  })

  it('the confirmation door carries twice the size — and a HALF-graded row is capped at the door, never discounted twice', async () => {
    // p = (10+2)/(20+4) = 0.5 exactly: grade C, non-provisional, contract passing →
    // the HALF tier. Tier 0.5 and door cap 0.5 must resolve to a half-size row; the
    // product rule would publish a quarter and call the same evidence short twice.
    const store = await velocityStore({ 'long:amber:40-55': { n: 20, hits: 10 } })
    const { board } = await buildBoard(
      store,
      deps({
        candles: async s => (s === 'CONF' ? confirmTape : s === 'SPY' || s === 'QQQ' ? flat : null),
        screens: async () => [{ row: { sym: 'CONF', price: 116, capUsdM: 5_000, changePct: 4, name: null }, source: 'screener:gainers' }],
      }),
      NOW,
    )

    const call = (await ledgerOf(store))!.find(p => p.sym === 'CONF')!
    expect(call).toBeDefined()
    expect(call.catalyst).toEqual({ kind: 'velocity', reason: expect.stringContaining('confirmation door') })
    expect(call.grade).toBe('C')
    expect(call.provisional).toBe(false)
    expect(call.evidence.contract).toBe(true) // C WITH the contract = the half tier
    if (VELOCITY_SHADOW_FIRST) {
      // The tier arithmetic is still computed and still correct — it simply has
      // nothing to size. What this branch pins is that a HALF-tier row shadows the
      // same as a full one: no size, no route, off the board, still graded C.
      expect(call.shadow).toBe(true)
      expect(call.riskPct).toBe(0)
      expect(call.instrument).toBeNull()
      expect(board.some(b => b.sym === 'CONF')).toBe(false)
    } else {
      // flip the flag and the door's own ceiling is the only haircut: tier 0.5 and
      // door cap 0.5 resolve to a HALF-size row, never a quartered one
      expect(call.riskPct).toBe(RUNG_RISK_PCT[call.riskRung] * VELOCITY_DOOR_CAP.confirmation)
      expect(call.riskPct).toBe(0.5) // the CAP, not 0.25 — one haircut, the smaller one
    }
  })

  // THE CAP FLOOR UNDER SHADOW-FIRST. The Stage-1 window replay (§13) found the lane
  // firing on nothing at all: `capUsdM` is null for every name in a point-in-time
  // replay, `VELOCITY_MIN_CAP_USD_M` refused an unknown cap outright, and 85 name-days
  // of open doors produced 77 would-be calls that never entered the record. A shadow
  // carries no money, so while the lane is shadowed an unknown cap is admitted and the
  // learning record fills; the moment the lane is sized, unknown-never-passes returns.
  it('an UNKNOWN cap passes the liquidity floor only while the lane is shadowed — a KNOWN small cap never passes at all', async () => {
    const store = await velocityStore({ 'long:amber:25-40': { n: 20, hits: 14 } })
    const { board } = await buildBoard(
      store,
      deps({
        // ONE tape, two names: the cap is the only difference between them
        candles: async s => (s === 'NOCAP' || s === 'TINY' ? breakTape240 : s === 'SPY' || s === 'QQQ' ? flat.slice(0, 241) : null),
        screens: async () => [
          { row: { sym: 'NOCAP', price: 105, capUsdM: null, changePct: 5, name: null }, source: 'screener:gainers' },
          { row: { sym: 'TINY', price: 105, capUsdM: 10, changePct: 5, name: null }, source: 'screener:gainers' },
        ],
        capUsdM: async () => null, // …and no enrichment pass rescues NOCAP's cap either
      }),
      NOW_240,
    )
    const ledger = (await ledgerAt(store, NOW_240))!

    // $10M is a KNOWN cap under the floor, and it is refused in BOTH modes. The
    // admission is about an UNKNOWN cap; it never loosened the floor itself.
    expect(ledger.some(p => p.sym === 'TINY')).toBe(false)
    expect(board.some(b => b.sym === 'TINY')).toBe(false)

    const nocap = ledger.find(p => p.sym === 'NOCAP')
    if (VELOCITY_SHADOW_FIRST) {
      expect(nocap).toBeDefined() // one of the replay's 77 blocked calls, now on the record
      expect(nocap!.catalyst!.kind).toBe('velocity')
      expect(nocap!.capUsdM).toBeNull() // recorded as unknown, never guessed into a cohort
      expect(nocap!.shadow).toBe(true)
      expect(nocap!.riskPct).toBe(0)
      expect(board.some(b => b.sym === 'NOCAP')).toBe(false)
    } else {
      // sized, an unknown cap is unknown liquidity — the floor cannot be checked, so
      // the call is not made, and the replay's blocked-call gap comes back with it
      expect(nocap).toBeUndefined()
    }
  })

  // The door cap and the ETP route were asking two different questions about the same
  // row. `fullTrade` (grade + contract) unlocked leverage while `sizedFraction` (the
  // smaller of tier and door cap) set the size — so a grade-A early-door probe with a
  // long route published at a QUARTER of the rung and a 2× ETP on top of it, which is
  // half the rung's exposure with daily-rebalance decay attached, on the youngest and
  // most slippage-prone entry the engine makes. Leverage now reads the size the row
  // actually carries. [R14]
  it('a velocity row is never leveraged: shadowed it has no route at all, sized the door cap withholds the ETP an A would otherwise get', async () => {
    // 32/22 → (22+2)/(32+4) = 0.6667, nEff 32: the ONLY velocity fixture deep enough
    // to earn an A, which is what makes the leverage question live at all.
    const store = await velocityStore({ 'long:amber:25-40': { n: 32, hits: 22 } })
    // both names carry a LONG route, and the rung is high enough to unlock 2× for an
    // A — so the ONLY thing that can withhold an instrument here is the door cap
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { RICH: { long2x: 'RICH2' }, BULL: { long2x: 'BULL2' } } })
    await store.write('risk-state', { rung: 1, sinceDate: '2026-01-01', gradedAtRung: 0, history: [] })
    const { board } = await buildBoard(
      store,
      deps({
        candles: async s =>
          s === 'RICH' ? richBreakTape : s === 'BULL' ? bullTape : s === 'SPY' || s === 'QQQ' ? flat.slice(0, 241) : null,
        screens: async () => [
          { row: { sym: 'RICH', price: 120, capUsdM: 5_000, changePct: 5, name: null }, source: 'screener:gainers' },
          { row: { sym: 'BULL', price: 290, capUsdM: 50_000, changePct: 1, name: null }, source: 'screener:gainers' },
        ],
        mediaTitles: async () => [],
        worldReads: riskOnReads,
      }),
      NOW_240,
    )

    const probe = (await ledgerAt(store, NOW_240))!.find(p => p.sym === 'RICH')!
    expect(probe).toBeDefined()
    expect(probe.catalyst).toEqual({ kind: 'velocity', reason: expect.stringContaining('early door') })
    expect(probe.grade).toBe('A') // the FULL tier — nothing about its evidence is short
    expect(probe.evidence.contract).toBe(true)
    // Capacity is recorded, not required: it left gradeFor entirely in v3 [R6] and
    // the lane never consulted composite.ts's floor. What lets this A exist is p
    // 0.6346 ≥ 0.5+0.10 on nEff 32 ≥ 30, read at |composite| 38.3 — above the 25-40
    // band's 32.5 midpoint, so the grade is not born below its evidence.
    expect(probe.capacityPct).toBeGreaterThanOrEqual(8) // still true, and still only a sizing input
    expect(probe.composite).toBeGreaterThanOrEqual(32.5)
    expect(probe.probability).toBeCloseTo(0.63, 2)
    expect(probe.instrument).toBeNull() // no ETP, however good the grade
    if (VELOCITY_SHADOW_FIRST) {
      // An unsized row cannot be leveraged either — but that is the shadow doing it,
      // not the door cap, so the door-cap claim itself is pinned in the branch below
      // and revives with the flag. What this branch adds: grade A buys a shadow
      // nothing, and the ETP the control below still gets proves leverage is alive.
      expect(probe.shadow).toBe(true)
      expect(probe.riskPct).toBe(0)
      expect(board.some(b => b.sym === 'RICH' && b.side === 'long')).toBe(false)
      // …and [F3] from the other end of the board: an unsized row takes nothing
      // away from the reader. That USED to be observable on this very chart — the
      // composite read RICH as a marginal SHORT and published it as the day's near
      // miss — and it no longer is, because the composite moved. This tape is a
      // pure oscillator whose 120-session Bollinger width sits at its own median
      // (p50) under a rising 50-EMA, so `bandwidth` scores +25.2 and tips a core
      // of −4.7 to +0.5: RICH now argues a dead-zone LONG, there is no short near
      // miss to suppress, and the board says nothing about RICH on either side.
      // A knife-edge fixture is the wrong place to pin a claim anyway — [F3] is
      // pinned whole, in BOTH branches, on a chart with a real short read: see
      // 'a SIZED velocity long suppresses the same-sym short NEAR MISS' below.
      expect(board.some(b => b.sym === 'RICH')).toBe(false)
    } else {
      expect(probe.riskPct).toBe(RUNG_RISK_PCT[probe.riskRung] * VELOCITY_DOOR_CAP.early)
      expect(probe.riskPct).toBe(0.3125) // rung 1, quartered by the early door
      expect(probe.paperOnly).toBe(false) // a quarter-size long is a plain, placeable share buy
    }

    // THE CONTROL, and it is the whole test: an ordinary grade-A long at the FULL rung,
    // same board, same rung, same kind of levMap route — it still gets its instrument.
    // Without this, "instrument null" could just be leverage broken for longs.
    const full = board.find(b => b.sym === 'BULL')!
    expect(full).toBeDefined()
    expect(full.grade).toBe('A')
    expect(full.evidence.contract).toBe(true)
    expect(full.catalyst).toBeUndefined() // no lane, no cap
    expect(full.riskPct).toBe(RUNG_RISK_PCT[full.riskRung])
    expect(full.instrument).toEqual({ ticker: 'BULL2', leverage: 2 })
  })

  it('a dip READ the dip lane refused to trade never blocks the velocity lane [C9]', async () => {
    // The tape carries both reads at once, and they disagree about what to do:
    const dip = classifyDip(shockThenRunTape)!
    expect(dip.triggered && dip.holding).toBe(true) // a real dip read — the old blocker
    expect(classifyVelocity(shockThenRunTape)!.door).toBe('confirmation')

    const store = await velocityStore({ 'long:amber:40-55': { n: 20, hits: 14 } })
    const { board } = await buildBoard(
      store,
      deps({
        candles: async s => (s === 'SHOK' ? shockThenRunTape : s === 'SPY' || s === 'QQQ' ? flat : null),
        // > $10B, so the dip lane's quality door is open and the read really is taken
        screens: async () => [{ row: { sym: 'SHOK', price: 116, capUsdM: 35_000, changePct: 4, name: null }, source: 'screener:gainers' }],
      }),
      NOW,
    )

    const rows = (await ledgerOf(store))!.filter(p => p.sym === 'SHOK')
    expect(rows).toHaveLength(1) // one long, not two — and the dip's is the one missing
    expect(rows[0].catalyst!.kind).toBe('velocity')
    // keying the skip on dipReads instead of the CONSTRUCTED call would leave the
    // record nothing at all on a name both lanes could see moving
    expect(rows.some(p => p.catalyst?.kind === 'dip')).toBe(false)
    if (VELOCITY_SHADOW_FIRST) {
      // the call the refused dip would have blocked still exists — as the shadow
      // the whole lane currently publishes, in the ledger where it can be learned from
      expect(rows[0].shadow).toBe(true)
      expect(rows[0].riskPct).toBe(0)
      expect(board.some(b => b.sym === 'SHOK' && b.side === 'long')).toBe(false)
    } else {
      expect(board.find(b => b.sym === 'SHOK' && b.riskPct > 0)).toBeDefined()
    }
  })

  // The OTHER skip, and the one shadow-first could most easily have broken: the
  // ledger holds ONE ROW PER SYM+SIDE, and `longRows` is read off every published
  // long — shadows included. It would have been easy to reason "a shadow costs the
  // reader nothing, so let it publish beside the composite's long"; that would put
  // two long rows for one chart into `predictions:${date}`, double-count the name in
  // every calibration bucket it lands in, and hand the open book two positions.
  it('a name that already carries a long gets no velocity row beside it — one row per sym+side, shadows included', async () => {
    // the fixture is not vacuous in either direction: the door really is open…
    expect(classifyVelocity(bullBreakTape)!.door).toBe('early')

    const store = await velocityStore({ 'long:amber:25-40': { n: 20, hits: 14 }, 'long:amber:40-55': { n: 20, hits: 14 } })
    const { board } = await buildBoard(
      store,
      deps({
        candles: async s => (s === 'BOTH' ? bullBreakTape : s === 'SPY' || s === 'QQQ' ? flat.slice(0, 241) : null),
        screens: async () => [{ row: { sym: 'BOTH', price: 300, capUsdM: 50_000, changePct: 3, name: null }, source: 'screener:gainers' }],
      }),
      NOW_240,
    )

    const longs = (await ledgerAt(store, NOW_240))!.filter(p => p.sym === 'BOTH' && p.side === 'long')
    expect(longs).toHaveLength(1)
    // …and the row that survived is the COMPOSITE's, which got there first — no lane
    // tag, no trail marker, and therefore no velocity shadow hiding behind it
    expect(longs[0].catalyst).toBeUndefined()
    expect(longs[0].trail).toBeUndefined()
    expect(longs[0].shadow).toBeUndefined()
    expect(longs[0].riskPct).toBeGreaterThan(0) // …a live, sized composite long, untouched by any of this
    expect(board.filter(b => b.sym === 'BOTH' && b.side === 'long')).toHaveLength(1)
  })

  it('a SIZED velocity long demotes the opposing composite short and the empty side names the lane — a shadowed one leaves that short alone [F3]', async () => {
    const collide = async (paidVol: number) => {
      const store = memoryStore()
      await store.write('config', { watchlist: [{ symbol: 'NVDA' }], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INV' } } })
      await store.write('engine-calibration', {
        buckets: { 'short:amber:25-40': { n: 20, hits: 14 }, 'long:amber:25-40': { n: 20, hits: 14 } },
        brier: [],
        defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
      })
      const { board } = await buildBoard(
        store,
        deps({
          candles: async s =>
            s === 'NVDA' ? crashBounce(paidVol) : s === 'XLK' ? shorty : s === 'SPY' || s === 'QQQ' || s === 'XLU' ? flat : null,
          capUsdM: async () => 5_000,
        }),
        NOW,
      )
      const blob = (await store.read<{ emptySides?: { short?: EmptySideReason } }>('engine-board'))!
      return { board, ledger: (await ledgerOf(store))!, emptySides: blob.emptySides }
    }

    // CONTROL first: one volume print quieter, the confirmation door stays shut and
    // the composite short is the day's live, sized row.
    const quiet = await collide(1_000_000)
    expect(classifyVelocity(crashBounce(1_000_000))!.door).toBeNull()
    const liveShort = quiet.board.find(b => b.sym === 'NVDA')!
    expect(liveShort.side).toBe('short')
    expect(liveShort.riskPct).toBeGreaterThan(0)
    expect(liveShort.evidence.contract).toBe(true)
    expect(liveShort.shadow).toBeUndefined()

    // Now the up-day is PAID for. Same chart, same composite, and the velocity lane
    // reads a long on it — but whether that long may take the reader's row away from
    // the short depends entirely on whether the lane is SIZED.
    const paid = await collide(2_500_000)
    const velo = paid.ledger.find(p => p.sym === 'NVDA' && p.side === 'long')!
    expect(velo).toBeDefined()
    expect(velo.catalyst!.kind).toBe('velocity') // the lane fired either way — the branch is about consequences
    const short = paid.ledger.find(p => p.sym === 'NVDA' && p.side === 'short')!
    expect(short).toBeDefined() // the short is in the ledger in both modes — demotion is never deletion
    expect(short.composite).toBe(liveShort.composite) // …and nothing about the short's own read ever changed

    if (VELOCITY_SHADOW_FIRST) {
      // [F3] An UNSIZED row must not cost the reader a SIZED one. The clash the
      // demotion cures is "the board tells me to buy the break AND sell the chart on
      // one morning" — a shadow tells the reader nothing at all, so there is no clash
      // to cure, and taking the short away would hand back an empty side for free.
      expect(velo.shadow).toBe(true)
      expect(velo.riskPct).toBe(0)
      expect(paid.board.filter(b => b.sym === 'NVDA')).toHaveLength(1)
      const stillShown = paid.board.find(b => b.sym === 'NVDA')!
      expect(stillShown.side).toBe('short')
      expect(stillShown.riskPct).toBeGreaterThan(0) // the same live, sized row the control published
      expect(short.shadow).toBeUndefined()
      expect(short.riskPct).toBe(liveShort.riskPct)
      expect(short.instrument).toEqual(liveShort.instrument)
      // …and with a live short on the side, no empty-side copy is owed at all
      expect(paid.emptySides?.short).toBeUndefined()
    } else {
      // Sized, the lane owns the chart: the reader gets one row, on the lane's side.
      const shown = paid.board.filter(b => b.sym === 'NVDA')
      expect(shown).toHaveLength(1)
      expect(shown[0].side).toBe('long')
      expect(shown[0].catalyst!.kind).toBe('velocity')
      expect(shown[0].riskPct).toBeGreaterThan(0)
      expect(short.shadow).toBe(true)
      expect(short.riskPct).toBe(0)
      expect(short.instrument).toBeNull()
      expect(short.watchOnly).toBeUndefined() // shadow and watch stay mutually exclusive
      // the copy must not blame the gates, nor blame the DIP lane for a breakout
      expect(paid.emptySides!.short).toBe('velocity-lane')
    }
  })

  it('a SIZED velocity long suppresses the same-sym short NEAR MISS — a shadowed one leaves it standing [C10, F3]', async () => {
    wildcardOff()
    // A watchlist name is evaluated whatever it looks like, so the composite really
    // does read this chart: its −21.6 core dies in the dead zone and the name lands
    // in the near-miss list as the closest thing to a short.
    const run = async (capUsdM: number) => {
      const store = memoryStore()
      await store.write('config', { watchlist: [{ symbol: 'BNC' }], rules: [], ytChannels: [], levMap: { BNC: { short2x: 'INV' } } })
      await store.write('engine-calibration', {
        buckets: { 'short:amber:25-40': { n: 20, hits: 14 }, 'long:amber:25-40': { n: 20, hits: 14 } },
        brier: [],
        defVersion: CALIB_DEF_VERSION,
      seedGeneration: 5,
      })
      const { board } = await buildBoard(
        store,
        deps({
          candles: async s => (s === 'BNC' ? slideBounceTape : s === 'SPY' || s === 'QQQ' ? flat : null),
          capUsdM: async () => capUsdM,
        }),
        NOW,
      )
      return { board, ledger: (await ledgerOf(store))! }
    }

    // CONTROL: $10M is a KNOWN cap under the lane's liquidity floor, so no velocity
    // call exists in either mode — and the near-miss short is published exactly as it
    // always was. (Shadow-first admits an UNKNOWN cap, never a small one.)
    const tiny = await run(10)
    const miss = tiny.board.find(b => b.sym === 'BNC')!
    expect(miss).toBeDefined()
    expect(miss.side).toBe('short')
    expect(miss.nearMiss).toBe(true)
    expect(tiny.ledger.some(p => p.sym === 'BNC')).toBe(false)

    const over = await run(5_000)
    const velo = over.ledger.find(p => p.sym === 'BNC' && p.side === 'long')!
    expect(velo).toBeDefined()
    expect(velo.catalyst!.kind).toBe('velocity') // over the floor the lane publishes in both modes

    if (VELOCITY_SHADOW_FIRST) {
      // [F3] The near miss survives. It is the only thing the reader is shown on this
      // chart, and a shadow contradicts nothing — suppressing the observation would
      // blank the name for a row the reader was never offered.
      expect(velo.shadow).toBe(true)
      expect(velo.riskPct).toBe(0)
      const shown = over.board.filter(b => b.sym === 'BNC')
      expect(shown).toHaveLength(1)
      expect(shown[0].side).toBe('short')
      expect(shown[0].nearMiss).toBe(true)
    } else {
      // Sized, the short observation on the same chart goes away: a sized long beside
      // "the closest thing to a short" is the board contradicting itself over a row
      // that cleared no gate at all.
      const rows = over.board.filter(b => b.sym === 'BNC')
      expect(rows).toHaveLength(1)
      expect(rows[0].side).toBe('long')
      expect(rows[0].catalyst!.kind).toBe('velocity')
      expect(rows[0].riskPct).toBeGreaterThan(0)
      expect(over.board.some(b => b.nearMiss)).toBe(false)
    }
  })

  it('a hype-cluster member survives the 180-candidate cut it would otherwise lose, and its row names the crowd', async () => {
    // 200 discovery names sort ahead of ZCLU alphabetically at the same tier, so the
    // budget cuts it — unless the crowd's own record elevates it to the sleeve's tier.
    const fillers = Array.from({ length: 200 }, (_, i) => `F${String(i).padStart(3, '0')}`)
    const run = async (history: TrendDay[] | null) => {
      const store = memoryStore()
      await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
      await store.write('engine-calibration', calWith('long:amber:25-40'))
      if (history) await store.write('social-history', history)
      const asked: string[] = []
      const { board } = await buildBoard(
        store,
        deps({
          candles: async s => {
            asked.push(s)
            return CLUSTER_TAPES.get(s) ?? (s === 'SPY' || s === 'QQQ' || fillers.includes(s) ? flat : null)
          },
          screens: async () =>
            [...fillers, ...CLUSTER_TAPES.keys()].map(sym => ({
              row: { sym, price: 100, capUsdM: 5_000, changePct: 1, name: null },
              source: 'screener:gainers' as const,
            })),
        }),
        NOW,
      )
      // the LEDGER, not the board: under shadow-first the elevated row is a shadow,
      // and "it survived the cut" has to be readable in both modes
      return { board, ledger: (await ledgerOf(store))!, askedFor: (sym: string) => asked.filter(s => s === sym).length }
    }

    const cut = await run(null)
    expect(cut.ledger.some(p => p.sym === 'ZCLU')).toBe(false) // never even evaluated
    expect(cut.board.find(b => b.sym === 'ZCLU')).toBeUndefined()
    expect(cut.askedFor('ZCLU')).toBe(0) // …and with no record, not one candle was fetched for it

    const elevated = await run(clusterHistory(8))
    const call = elevated.ledger.find(p => p.sym === 'ZCLU')!
    expect(call).toBeDefined()
    // the cluster is narration, stamped where the paper can read it
    expect(call.catalyst!.reason).toContain('hype cluster with ZCLA, ZCLB')
    if (VELOCITY_SHADOW_FIRST) {
      expect(call.shadow).toBe(true) // elevated into the RECORD, not onto the board
      expect(call.riskPct).toBe(0)
      expect(elevated.board.some(b => b.sym === 'ZCLU')).toBe(false)
    } else {
      expect(call.riskPct).toBe(0.25) // an ordinary quarter-size early-door probe
      expect(elevated.board.some(b => b.sym === 'ZCLU')).toBe(true)
    }
    // …and elevation is never eligibility: the partners were in the pool too and
    // published nothing, because neither of them opened a door
    expect(elevated.ledger.some(p => p.sym === 'ZCLA' || p.sym === 'ZCLB')).toBe(false)
    expect(elevated.board.some(b => b.sym === 'ZCLA' || b.sym === 'ZCLB')).toBe(false)
    expect(elevated.askedFor('ZCLA')).toBeGreaterThan(0)
  })

  it('a young, missing or broken cluster record costs elevation and nothing else — the lane is byte-identical', async () => {
    // Same world in every run: ZCLU is inside the candidate budget on its own, so
    // the cluster can only ever add priority it does not need, and one clause of prose.
    const run = async (history: unknown) => {
      const store = memoryStore()
      await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
      await store.write('engine-calibration', calWith('long:amber:25-40'))
      if (history !== undefined) await store.write('social-history', history)
      const asked: string[] = []
      await buildBoard(
        store,
        deps({
          candles: async s => {
            asked.push(s)
            return CLUSTER_TAPES.get(s) ?? (s === 'SPY' || s === 'QQQ' ? flat : null)
          },
          screens: async () =>
            [...CLUSTER_TAPES.keys()].map(sym => ({
              row: { sym, price: 100, capUsdM: 5_000, changePct: 1, name: null },
              source: 'screener:gainers' as const,
            })),
        }),
        NOW,
      )
      return { ledger: (await ledgerOf(store))!, fetches: asked.filter(s => s === 'ZCLU').length }
    }

    const none = await run(undefined) // no record at all
    const young = await run(clusterHistory(6)) // inside the seven-day warm-up
    // a blob of the wrong shape. The throw comes from clusterCandidates, which runs
    // FIRST and hands the non-array straight to normaliseHistory's for…of —
    // detectClusters is never even reached, so the fail-soft this pins is the try's,
    // not that function's.
    const junk = await run({ nope: true })
    expect(none.ledger.some(p => p.sym === 'ZCLU' && p.catalyst?.kind === 'velocity')).toBe(true) // not a vacuous comparison
    expect(young.ledger).toEqual(none.ledger) // every row, size, grade and flag identical
    expect(junk.ledger).toEqual(none.ledger)
    // …and a record too young to say anything costs no CALLS either: the fetch is
    // gated on clusterCandidates, which is empty under the warm-up
    expect(none.fetches).toBe(1) // the candidate fetch, and only that
    expect(young.fetches).toBe(1)
    expect(junk.fetches).toBe(1)

    // The comparison is not vacuous in the other direction: a record that DOES
    // support a cluster changes the run — by exactly one clause of narration.
    const full = await run(clusterHistory(8))
    // ONE fetch: the bounded cluster prefetch is kept and reused by the candle
    // fill — a second read here would mean the reuse broke (and with it the
    // fail-soft guarantee the reuse exists for; codex salvage, 2026-08-12)
    expect(full.fetches).toBe(1)
    const stamped = full.ledger.find(p => p.sym === 'ZCLU')!
    expect(stamped.catalyst!.reason).toContain('hype cluster')
    expect({ ...stamped, catalyst: undefined }).toEqual({ ...none.ledger.find(p => p.sym === 'ZCLU')!, catalyst: undefined })
  })

  // Tier 4 lifted cluster members past the 180-CANDIDATE cut (ratified). It was never
  // a claim on the 15-slot CAP budget, and the deprioritisation there only knew about
  // the sleeve — so one wide cluster of unpriced names took every slot and the day's
  // discovery names went unpriced: no cap cohort, no >$10B dip-lane quality read, no
  // small-cap stop widening. Elevation queues behind discovery here too. [R17]
  it('a wide hype cluster never spends the cap budget the discovery names need', async () => {
    // twenty peers whose ONLY door is the crowd's record: named together every day and
    // moving on one shared tape, so they form a single 20-name cluster
    const peers = Array.from({ length: 20 }, (_, i) => `ZP${String(i).padStart(2, '0')}`)
    const peerTape = clusterTape(1, 1_000_000)
    const history: TrendDay[] = Array.from({ length: 8 }, (_, i) => ({
      date: new Date((T0 + (252 + i) * 86_400) * 1000).toISOString().slice(0, 10),
      syms: peers,
    }))
    // …and three discovery names the screener found with NO cap of their own: exactly
    // the rows this budget exists to price
    const discovery = ['DIS1', 'DIS2', 'DIS3']

    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('long:amber:25-40'))
    await store.write('social-history', history)
    const priced: string[] = []
    await buildBoard(
      store,
      deps({
        candles: async s => (peers.includes(s) ? peerTape : discovery.includes(s) || s === 'SPY' || s === 'QQQ' ? flat : null),
        screens: async () =>
          discovery.map(sym => ({ row: { sym, price: 100, capUsdM: null, changePct: 1, name: null }, source: 'screener:gainers' as const })),
        mediaTitles: async () => [],
        capUsdM: async sym => {
          priced.push(sym)
          return 50_000
        },
      }),
      NOW,
    )

    for (const sym of discovery) expect(priced).toContain(sym)
    // the budget itself is untouched — 15 slots, and the cluster takes the remainder
    expect(priced).toHaveLength(15)
    expect(priced.filter(s => peers.includes(s))).toHaveLength(12)
  })
})

/** THE PLANTED ENTRY BAR for the grading fixtures below, and it MOVED 240 → 230
 * with CALIB_DEF_VERSION v4. The calibrated grade now lands at 21 sessions, and a
 * row planted at bar 240 of a 260-bar tape has only 19 bars behind it: it fills
 * outcome5 and outcome10 and then teaches nothing at all. Ten bars earlier is the
 * smallest honest change that lets the calibrated lens actually land (230 + 21 =
 * 251 < 260) on the same falling-knife shape, at the same stop distances, so every
 * assertion below is still about what it was about. The one fixture deliberately
 * left at bar 240 is the pending-queue test, whose whole point is a row that has
 * NOT reached its calibrated grade. */
const PLANT = 230

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

    // ZERO graded, and that is the v4 statement this fixture now makes twice over.
    // The bounded index WAS migrated — the row was visited and its 5d and 10d
    // lenses filled, which could not have happened if the date had aged out — but
    // `graded` counts a row at its CALIBRATED lens, which since v4 is 21 sessions,
    // and this fixture has only 19 bars after entry. So: the ledger lenses fill,
    // nothing is claimed as graded, and the date stays durably pending.
    expect((await gradeOutstanding(store, deps(), NOW, null)).graded).toBe(0)
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
    // prediction planted at bar PLANT; enough history follows for the 21-session
    // calibrated grade to land (see PLANT)
    const date = new Date(shorty[PLANT].t * 1000).toISOString().slice(0, 10)
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
      priceAtPrediction: shorty[PLANT - 1].c,
      entry: shorty[PLANT - 1].c,
      stop: shorty[PLANT - 1].c * 1.1,
      target: shorty[PLANT - 1].c * 0.9,
      instrument: null,
      riskPct: 1, // a SIZED call — the reader had money on this one [stage 3c]
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
    expect(preds[0].accrual).toBeUndefined() // the fixture's own premise: neither row carries the stamp,
    expect(preds[1].accrual).toBeUndefined() // so the booking below really is the legacy path and not the new one

    // BOTH outcomes are booked (32/22 + 2 hits) — the learning loop eats every
    // published row — and the PROVENANCE PARTITION says which of them the reader
    // could have taken. THESE TWO ROWS ARE THE LEGACY FALLBACK, deliberately:
    // hand-planted, they carry no `accrual` stamp, exactly like every row already
    // sitting in the ledger when the stamp shipped. An unstamped row books by
    // `riskPct > 0`, which is the rule that shipped — so the watch row accrues into
    // the totals AND into the shadow sub-count, and a later SIZED read of this band
    // sees 33/23 while the pooled read still sees 34/24. A row PUBLISHED today
    // would carry `accrual: 'sized'` and book differently (see the stamp tests
    // above); an already-stored one must keep booking as it always would have.
    // [stage 3c]
    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['short:amber:25-40']).toEqual({ n: 34, hits: 24, shadowN: 1, shadowHits: 1 })
    expect(baseHitRate(cal, 'sized')).toEqual({ rate: 0.5, n: 33 }) // 33 < 50 → the cold-start cliff, applied to the SIZED n
    expect(baseHitRate(cal).n).toBe(34)
    // the watch row's own family bucket is partitioned the same way — the blend
    // that will read these (task 2) must not be handed an unsized row as evidence
    expect(cal.setupBuckets!['continuation:short:25-40']).toEqual({ n: 1, hits: 1, shadowN: 1, shadowHits: 1 })
    expect(setupStat(cal, 'continuation', 'short', '25-40', 'sized')).toEqual({ n: 0, hits: 0 })
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
    const date = new Date(shorty[PLANT].t * 1000).toISOString().slice(0, 10)
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
      priceAtPrediction: shorty[PLANT - 1].c,
      entry: shorty[PLANT - 1].c,
      stop: shorty[PLANT - 1].c * 1.1,
      target: shorty[PLANT - 1].c * 0.9,
      instrument: null,
      factors: { technical: { score: -30, detail: '', weight: 1 } } as never,
    }
    await store.write(`predictions:${date}`, [watchRow])
    await store.write('predictions-index', [date])
    await store.write('engine-calibration', calWith('short:amber:25-40'))

    const { graded } = await gradeOutstanding(store, deps(), NOW, null)
    expect(graded).toBe(1) // it IS graded — the learning loop eats everything published

    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['short:amber:25-40']!.n).toBe(33) // …and it DID teach calibration (32 + 1)

    const risk = (await store.read<RiskState>('risk-state'))!
    expect(risk.gradedAtRung).toBe(0) // …but the ladder never counted it
    expect(risk.rung).toBe(0) // …and never climbed on it
    expect(risk.cohorts!.large.gradedAtRung).toBe(0)
    expect(risk.cohorts!.small.gradedAtRung).toBe(0)
  })

  it('a graded DIP call never touches factor IC — the lane must not train the technical factor', async () => {
    const store = memoryStore()
    const date = new Date(shorty[PLANT].t * 1000).toISOString().slice(0, 10)
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
      priceAtPrediction: shorty[PLANT - 1].c,
      entry: shorty[PLANT - 1].c,
      stop: shorty[PLANT - 1].c * 0.5, // wide enough that the bleed never stops it out
      target: shorty[PLANT - 1].c * 1.2,
      instrument: null,
      factors: { technical: { score: 40, detail: 'dip lane', weight: 0 } } as never,
      ...over,
    })
    await store.write(`predictions:${date}`, [
      planted({ id: `${date}:GLW:long`, sym: 'GLW', catalyst: { kind: 'dip', reason: 'dip −12% · holding' } }),
      planted({ id: `${date}:NVDA:long`, sym: 'NVDA' }), // an ordinary call — the control
    ])
    await store.write('predictions-index', [date])
    await store.write('engine-weights', { ...initWeights(), seedGeneration: 5 })
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

  // The SAME quarantine, one rung more general. A velocity call's composite is
  // built by velocityLane.ts, not measured by the factor stack, so booking its
  // outcome would train the technical factor's IC on a vote it never cast —
  // exactly the dip's problem. The guard therefore keys on the lane FAMILY
  // (LANE_CATALYST_KINDS), not on the dip literal, and the 'velocity' setup
  // family books its own bucket with ZERO changes to calibration.ts.
  it('a graded VELOCITY call never touches factor IC either — the quarantine is the lane family, not a dip special case', async () => {
    const store = memoryStore()
    const date = new Date(shorty[PLANT].t * 1000).toISOString().slice(0, 10)
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
      priceAtPrediction: shorty[PLANT - 1].c,
      entry: shorty[PLANT - 1].c,
      stop: shorty[PLANT - 1].c * 0.5, // wide enough that the bleed never stops it out
      target: shorty[PLANT - 1].c * 1.2,
      instrument: null,
      factors: { technical: { score: 40, detail: 'velocity lane', weight: 0 } } as never,
      ...over,
    })
    await store.write(`predictions:${date}`, [
      planted({ id: `${date}:GLW:long`, sym: 'GLW', setup: 'velocity', catalyst: { kind: 'velocity', reason: 'breakout +18% · 3.1× volume' } }),
      planted({ id: `${date}:NVDA:long`, sym: 'NVDA' }), // an ordinary call — the control
    ])
    await store.write('predictions-index', [date])
    await store.write('engine-weights', { ...initWeights(), seedGeneration: 5 })
    await store.write('engine-calibration', calWith('long:amber:25-40')) // known start: no setup buckets yet
    const d = deps({ candles: async sym => (sym === 'GLW' || sym === 'NVDA' ? shorty : sym === 'SPY' ? flat : null) })

    expect((await gradeOutstanding(store, d, NOW, null)).graded).toBe(2) // BOTH graded

    const w = (await store.read<WeightsState>('engine-weights'))!
    const ic = w.ic.technical
    expect(ic.nAgree + ic.nDisagree).toBe(1) // only the ordinary call booked an observation
    expect(w.gradedSinceNudge).toBe(1)

    // …and the velocity call's outcome still teaches calibration and its OWN
    // setup bucket — the key template `${setup}:${side}:${band}` is family-agnostic,
    // so a brand-new family accrues without a single production change.
    const cal = (await store.read<CalibrationState>('engine-calibration'))!
    expect(cal.buckets['large:long:amber:25-40']).toEqual({ n: 2, hits: 0 })
    expect(cal.setupBuckets!['velocity:long:25-40']).toEqual({ n: 1, hits: 0 })
    expect(cal.setupBuckets!['reversal:long:25-40']).toEqual({ n: 1, hits: 0 }) // the control's family, untouched by the newcomer
  })

  it('production migration: a legacy rung-0 risk-state + cohortless seeded calibration load and behave; a known-cap grade books into its cohort bucket', async () => {
    const store = memoryStore()
    const date = new Date(shorty[PLANT].t * 1000).toISOString().slice(0, 10)
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
      priceAtPrediction: shorty[PLANT - 1].c,
      entry: shorty[PLANT - 1].c,
      stop: shorty[PLANT - 1].c * 1.1,
      target: shorty[PLANT - 1].c * 0.9,
      instrument: null,
      capUsdM: 50_000, // LARGE cohort — the grade must book into the large bucket
      factors: { technical: { score: -30, detail: '', weight: 1 } } as never,
    }
    await store.write(`predictions:${date}`, [planted])
    await store.write('predictions-index', [date])
    // The legacy SHAPES (cohortless seeded calibration, rung-0 risk-state with no
    // `cohorts`) — stamped at the committed generation so the install swap stays out of the way:
    // what this test guards is the migrate path, not the install.
    await store.write('engine-calibration', { buckets: { 'short:amber:25-40': { n: 20, hits: 14 } }, brier: [], seeded: true, defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
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

  // THE MIGRATION, end to end. Re-ordering DEFAULT_WEIGHTS is cosmetic on its
  // own: the stored blob is preferred over the seed on every load and only the
  // nudge loop ever writes it, so without this the live engine would keep
  // scoring the retired vector while every test in the repo showed the new one.
  describe('the weights re-base reaches production', () => {
    const v2Blob = (): WeightsState => ({
      base: { technical: 1, momentum: 0.8, sector: 0.6, social: 0.5, channels: 0.6, insiders: 0.4, news: 0.4, seasonality: 0.3, smartMoney: 0.3, catalyst: 0.5 } as WeightsState['base'],
      current: { technical: 0.99312, momentum: 0.79587, sector: 0.6, social: 0.5, channels: 0.6, insiders: 0.4, news: 0.4, seasonality: 0.3, smartMoney: 0.3, catalyst: 0.5 } as WeightsState['current'],
      ic: { ...initWeights().ic, technical: { nAgree: 778, sumAgree: 240, nDisagree: 0, sumDisagree: 0 } },
      gradedSinceNudge: 7,
      history: [],
      seedGeneration: 5, // gen-4 seed: without the stamp the install swap replaces this blob before the re-base can be observed
    })
    const zero = { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }

    // …on a store already on the CURRENT outcome definition. Without the
    // calibration blob the cold start clones the committed v3 seed, the v4
    // definition swap fires and `retireIcEvidence` zeroes the very IC these two
    // fixtures are about — a different mechanism answering for this one. The
    // definition swap is pinned on its own (engine.calibratedHorizon.test.ts).
    const currentEpoch = (): CalibrationState => ({ buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })

    it('re-bases a v2-shaped blob on load and persists it — exactly once, however many runs', async () => {
      const store = memoryStore()
      await store.write('engine-calibration', currentEpoch())
      await store.write('engine-weights', v2Blob())
      const d = deps({ candles: async sym => (sym === 'SPY' ? flat : null) })

      await gradeOutstanding(store, d, NOW, null) // nothing outstanding — the LOAD is the point
      const w = (await store.read<WeightsState>('engine-weights'))!
      expect(w.base.momentum).toBe(0.9)
      expect(w.base.sector).toBe(0.3)
      expect(w.current.momentum).toBe(0.9) // …and what SCORES moved, not just the base
      expect(w.current.technical).toBe(1) // the 0.99312 drift belonged to the retired model
      expect(w.ic.technical).toEqual(zero) // 778 old-vector observations, correctly dropped
      expect(w.history).toHaveLength(1)
      expect(w.history[0].evidence).toBe('stage-2 re-base to the owner-ordered vector')
      expect(w.history[0].date).toBe(new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }))
      expect(w.history[0].changes.sector).toEqual({ from: 0.6, to: 0.3, ic: 0 })

      // a second and third run must be no-ops: real evidence gathered under the
      // NEW vector survives, and no second history entry is written
      w.ic.technical = { nAgree: 4, sumAgree: 9, nDisagree: 1, sumDisagree: -2 }
      await store.write('engine-weights', w)
      await gradeOutstanding(store, d, NOW, null)
      await gradeOutstanding(store, d, NOW, null)
      const after = (await store.read<WeightsState>('engine-weights'))!
      expect(after.ic.technical).toEqual({ nAgree: 4, sumAgree: 9, nDisagree: 1, sumDisagree: -2 })
      expect(after.history).toHaveLength(1)
    })

    it('leaves a blob already on the current vector completely alone', async () => {
      const store = memoryStore()
      await store.write('engine-calibration', currentEpoch())
      const fresh = { ...initWeights(), seedGeneration: 5 } // gen-4: stamped, or the install swap eats the learned drift
      fresh.current.technical = 1.07 // a learned drift under the CURRENT vector
      fresh.ic.momentum = { nAgree: 30, sumAgree: 60, nDisagree: 5, sumDisagree: -8 }
      await store.write('engine-weights', fresh)

      await gradeOutstanding(store, deps({ candles: async sym => (sym === 'SPY' ? flat : null) }), NOW, null)
      const w = (await store.read<WeightsState>('engine-weights'))!
      expect(w.current.technical).toBe(1.07) // learning is never collateral damage
      expect(w.ic.momentum.nAgree).toBe(30)
      expect(w.history).toHaveLength(0)
    })
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
      // GRADED means the CALIBRATED grade landed (outcome21 since v4), not the
      // 10-session display lens — see the 12-session fixture below.
      base({ id: `${date}:AAPL:long`, sym: 'AAPL', outcome21: { excessPct: 1, rawPct: 1, spyPct: 0, stopped: false, hit: true } }), // graded → done
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

  // THE OPEN BOOK QUIT AT TEN WHILE THE GRADE WAS AT 21. Two hard-coded tens did
  // it — a `.slice(-10)` on the predictions index and `!p.outcome10` as the test
  // for "still open" — so a call published a fortnight ago was dropped from the
  // reader's open positions eleven sessions before the engine graded it. The row
  // was neither open nor graded anywhere the reader could see it.
  it('a call 12 sessions old with no CALIBRATED grade is still open, and counts down to 21', async () => {
    const store = memoryStore()
    const today = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
    const entryIdx = shorty.length - 12 // 12 sessions of closes, entry session included
    const date = new Date(shorty[entryIdx].t * 1000).toISOString().slice(0, 10)
    await store.write(`predictions:${date}`, [
      {
        id: `${date}:NVDA:long`,
        date,
        sym: 'NVDA',
        side: 'long',
        grade: 'B',
        entry: shorty[entryIdx].c,
        stop: shorty[entryIdx].c * 0.8,
        target: shorty[entryIdx].c * 1.2,
        // the 10-session DISPLAY lens has landed; the calibrated one has not.
        // Under the old code this single field erased the row from the open book.
        outcome10: { excessPct: -3, rawPct: -3, spyPct: 0, stopped: false, hit: false },
      } as Partial<Prediction>,
    ])
    // …and the index window has to outlive the horizon too: eleven dates of
    // padding in front, which a `.slice(-10)` would have cut the call off behind.
    const padding = Array.from({ length: 11 }, (_, i) => new Date((shorty[entryIdx].t - (11 - i) * 86_400) * 1000).toISOString().slice(0, 10))
    await store.write('predictions-index', [...padding, date])
    await store.write('engine-board', { date: today, board: [] })

    const { traced } = await traceOpenIdeas(store, deps(), NOW)
    expect(traced).toBe(1)
    const e = (await store.read<{ entries: OpenTraceEntry[] }>('open-trace'))!.entries[0]
    expect(e.sym).toBe('NVDA')
    expect(e.day).toBe(12)
    expect(e.status).toBe('in-play')
    expect(e.gradesInSessions).toBe(10) // 21 + 1 − 12: still a fortnight of clock to run
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

// THE VOICE, at the two construction sites that BYPASS the ordinary producers
// (recon §6.5). Both were where fields have gone missing before, and they want
// opposite answers — which is exactly why they are asserted together.
describe('thesis + falsifier — who gets a voice and who does not', () => {
  // the same tape both rows come off: NVDA is a gate-clearing unroutable short
  // (→ an observation) and RISE is the long side's nearest miss
  const bothKinds = () =>
    deps({
      mediaTitles: async () => [],
      candles: async sym =>
        sym === 'NVDA' ? shorty : sym === 'RISE' ? deadClimb : sym === 'SPY' || sym === 'QQQ' || sym === 'XLU' ? flat : sym === 'XLK' ? shorty : null,
    })

  it('a NEAR MISS carries neither: it cleared no gate, so there is no belief to state', async () => {
    wildcardOff() // …and the wildcard, which DOES carry both, is pinned in engine.wildcard.test.ts
    const store = memoryStore()
    await store.write('config', { watchlist: [{ symbol: 'RISE' }], rules: [], ytChannels: [], levMap: {} })
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    const { board } = await buildBoard(store, bothKinds(), NOW)
    const misses = board.filter(b => b.nearMiss)
    expect(misses.length).toBeGreaterThan(0)
    for (const m of misses) {
      expect(m.thesis).toBeUndefined()
      expect(m.falsifier).toBeUndefined()
      expect(m.note).toContain('nearest miss') // …its own honest sentence is untouched
    }
  })

  it('a promoted OBSERVATION keeps the thesis it published with — it is a real call nobody can place', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [{ symbol: 'RISE' }], rules: [], ytChannels: [], levMap: {} }) // NVDA has NO inverse ETP
    await store.write('engine-calibration', calWith('short:amber:55-70'))
    const { board } = await buildBoard(store, bothKinds(), NOW)

    const nvda = board.find(b => b.sym === 'NVDA')!
    expect(nvda.observation).toBe(true)
    // The row cleared EVERY gate; the only thing wrong with it is that an ISA
    // cannot place it. Its belief is still the engine's belief and its stop is
    // still the level that would end it, so both sentences stand…
    expect(nvda.thesis).toContain('Short NVDA — ')
    expect(nvda.falsifier).toBe(`Wrong if it closes above ${nvda.stop}.`)
    expect(bannedTokensIn(nvda.thesis!)).toEqual([])
    // …and what it must never carry is an OFFER, which the row's own flags and the
    // label appended to `note` (not to the thesis) go on making impossible.
    expect(nvda.riskPct).toBe(0)
    expect(nvda.instrument).toBeNull()
    expect(nvda.watchOnly).toBe(true)
    expect(nvda.note).toContain('no ISA route — observation only')
    expect(nvda.thesis).not.toContain('no ISA route')
  })
})
