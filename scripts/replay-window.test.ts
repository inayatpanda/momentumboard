import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFromHistory } from '../shared/engine/backtest'
import seedJson from '../shared/engine/seed.json'
import { DEFAULT_CORE_SLEEVE } from '../shared/engine/coreSleeve'
import { classifyVelocity, effectiveVelocityStop, MIN_RISK_FRAC } from '../shared/engine/velocityLane'
import {
  type Band,
  type CalibrationState,
  type WeightsState,
  CALIB_DEF_VERSION,
  ENGINE_MODEL_VERSION,
  bandFor,
  baseHitRate,
  brierPoint,
  gradeFor,
  initWeights,
  probabilityFor,
} from '../shared/engine/calibration'
import { DEFAULT_WEIGHTS } from '../shared/engine/composite'
import { exchangeFor } from '../shared/symbols'
import { SECTOR_MEMBERS } from '../netlify/functions/lib/sectors'
import { VIX_SYMBOL, WORLD_SYMBOLS } from '../shared/engine/worldTape'
import { THEMES } from '../shared/engine/themes'
import { bannedTokensIn, composeThesis } from '../shared/engine/voice'
import type { Keyed, ProbeContext, RunFile, SeedArtefact } from './replay-window'
import {
  MIRROR_EXTRAS,
  PROD_GAINERS_DEPTH,
  aReachableState,
  bornBelowCensus,
  brierOf,
  contextsIn,
  diffKeys,
  flatten,
  gradeHistogram,
  isCryptoSymbol,
  keyOf,
  main,
  meanOf,
  monotonicityViolations,
  probeGrid,
  referenceSweep,
  sdOf,
  seedArtefactFrom,
  seedLikeState,
  seedUniverse,
  sleeveKeys,
  spreadByBand,
  spreadOf,
  thinTopState,
  voiceDefects,
  welch,
  withinContextResolution,
  PROD_OTHER_DEPTH,
  REPLAY_UNIVERSE,
  SLEEVE_MIRROR,
  VELOCITY_RUNNERS,
  bestUpDayMult,
  doorsFor,
  entryPosition,
  findRun,
  median,
  simulateTrailExit,
  sliceBefore,
  sparkClosesFrom,
  summariseBoard,
  synthScreens,
  tradingDays,
  velocityRefusal,
} from './replay-window'
import type { Candle } from '../shared/types'

const day = (iso: string, c: number, v = 1_000_000): Candle => ({ t: Date.parse(`${iso}T13:30:00Z`) / 1000, o: c, h: c, l: c, c, v })
/** Sequential sessions from a start date — the probe helpers only ever read the
 * order and the dates, never the weekday, so a plain +1 day walk is honest here. */
const series = (closes: number[], startISO = '2026-01-05', vols?: number[]): Candle[] =>
  closes.map((c, i) => {
    const d = new Date(`${startISO}T13:30:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    return { t: Math.floor(d.getTime() / 1000), o: c, h: c, l: c, c, v: vols?.[i] ?? 1_000_000 }
  })

describe('SLEEVE_MIRROR', () => {
  // The mirror is a literal copy so the harness can run inside the pre-Stage-1
  // worktree where coreSleeve.ts does not exist. This guards the copy.
  it('covers every DEFAULT_CORE_SLEEVE name', () => {
    expect(DEFAULT_CORE_SLEEVE.filter(s => !SLEEVE_MIRROR.includes(s))).toEqual([])
  })
  it('folds the window tickers into the universe without duplicates', () => {
    expect(REPLAY_UNIVERSE.length).toBe(new Set(REPLAY_UNIVERSE).size)
    for (const s of MIRROR_EXTRAS) expect(REPLAY_UNIVERSE).toContain(s)
    expect(REPLAY_UNIVERSE).toContain('GLW')
  })
})

describe('sliceBefore', () => {
  const bars = [day('2026-07-13', 10), day('2026-07-14', 11), day('2026-07-15', 12)]
  it('keeps only bars that closed strictly before the replayed date', () => {
    expect(sliceBefore(bars, '2026-07-14').map(b => b.c)).toEqual([10])
    expect(sliceBefore(bars, '2026-07-15').map(b => b.c)).toEqual([10, 11])
  })
  it('is empty before the first bar', () => {
    expect(sliceBefore(bars, '2026-07-13')).toEqual([])
  })
})

describe('tradingDays', () => {
  it('takes the window from a real index series, deduped and sorted', () => {
    const index = [day('2026-07-13', 1), day('2026-07-14', 1), day('2026-07-14', 1), day('2026-07-17', 1), day('2026-08-12', 1)]
    expect(tradingDays(index, '2026-07-14', '2026-08-11')).toEqual(['2026-07-14', '2026-07-17'])
  })
})

describe('synthScreens', () => {
  const bars = new Map<string, Candle[]>([
    ['UP', [day('2026-07-13', 100, 10), day('2026-07-14', 110, 10)]], // +10%
    ['DOWN', [day('2026-07-13', 100, 10), day('2026-07-14', 85, 10)]], // -15%
    ['BIG', [day('2026-07-13', 100, 10), day('2026-07-14', 101, 1_000_000)]], // dollar-volume king
    ['SHORTHIST', [day('2026-07-14', 50, 10)]],
  ])
  it('splits gainers, losers and $-volume actives', () => {
    const rows = synthScreens(bars, { includeLosers: true })
    const bySource = (s: string) => rows.filter(r => r.source === s).map(r => r.row.sym)
    expect(bySource('screener:gainers')).toEqual(['UP', 'BIG'])
    expect(bySource('screener:losers')).toEqual(['DOWN'])
    expect(bySource('screener:actives')[0]).toBe('BIG')
  })
  it('withholds the losers screen in baseline mode (day_losers is a Stage-1 addition)', () => {
    expect(synthScreens(bars, { includeLosers: false }).some(r => r.source === 'screener:losers')).toBe(false)
  })
  it('never invents a market cap and skips names with one bar', () => {
    const rows = synthScreens(bars, { includeLosers: true })
    expect(rows.every(r => r.row.capUsdM === null)).toBe(true)
    expect(rows.some(r => r.row.sym === 'SHORTHIST')).toBe(false)
  })
  it('mirrors production per-kind depths — gainers 50, losers and actives 25', () => {
    const many = new Map<string, Candle[]>()
    for (let i = 0; i < 80; i++) many.set(`UP${i}`, [day('2026-07-13', 100), day('2026-07-14', 100 + i + 1)])
    for (let i = 0; i < 80; i++) many.set(`DN${i}`, [day('2026-07-13', 100), day('2026-07-14', 100 - i - 1)])
    const rows = synthScreens(many, { includeLosers: true })
    const n = (s: string) => rows.filter(r => r.source === s).length
    expect(PROD_GAINERS_DEPTH).toBe(50)
    expect(PROD_OTHER_DEPTH).toBe(25)
    expect(n('screener:gainers')).toBe(50)
    expect(n('screener:losers')).toBe(25)
    expect(n('screener:actives')).toBe(25)
  })
  it('lets the gainers depth be forced back to 25 so a diff can attribute the displacement', () => {
    const many = new Map<string, Candle[]>()
    for (let i = 0; i < 80; i++) many.set(`UP${i}`, [day('2026-07-13', 100), day('2026-07-14', 100 + i + 1)])
    expect(synthScreens(many, { includeLosers: true, gainers: 25 }).filter(r => r.source === 'screener:gainers').length).toBe(25)
  })
})

describe('VELOCITY_RUNNERS', () => {
  // Named BEFORE any result was seen (Task 7 / C15). The guard exists so a later
  // edit cannot quietly swap a runner that fired for one that did not.
  it('pins the seven runners and their search windows', () => {
    expect(VELOCITY_RUNNERS.map(r => r.sym)).toEqual(['AAOI', 'RKLB', 'LUNR', 'ASTS', 'IONQ', 'RGTI', 'QBTS'])
    expect(VELOCITY_RUNNERS.filter(r => r.from === '2026-01-01' && r.to === '2026-08-01').map(r => r.sym)).toEqual(['AAOI', 'RKLB', 'LUNR', 'ASTS'])
    expect(VELOCITY_RUNNERS.filter(r => r.from === '2025-01-01' && r.to === '2025-12-31').map(r => r.sym)).toEqual(['IONQ', 'RGTI', 'QBTS'])
  })
})

describe('findRun', () => {
  it('takes the LARGEST advance in the window, not the first one that clears the floor', () => {
    // 100 → 145 (+45%) early, then 50 → 120 (+140%) later. The first pair clears
    // 40% on its own; a scan that stopped there would measure the wrong move.
    const run = findRun(series([100, 145, 50, 60, 120]), '2026-01-01', '2026-12-31')
    expect(run).toMatchObject({ startIdx: 2, endIdx: 4, advancePct: 140 })
    expect(run!.startClose).toBe(50)
    expect(run!.endClose).toBe(120)
  })
  it('refuses a window whose best advance is under 40%', () => {
    expect(findRun(series([100, 120, 110, 135]), '2026-01-01', '2026-12-31')).toBeNull()
  })
  it('never pairs a high with a low that comes after it', () => {
    // Monotonically falling: every later close is lower, so there is no advance.
    expect(findRun(series([200, 150, 120, 90]), '2026-01-01', '2026-12-31')).toBeNull()
  })
  it('only looks inside the search window', () => {
    const cs = series([10, 100, 20, 25], '2026-01-05') // the 10× sits on the first two bars
    expect(findRun(cs, '2026-01-07', '2026-12-31')).toBeNull()
    expect(findRun(cs, '2026-01-05', '2026-12-31')!.advancePct).toBe(900)
  })
  it('names the run’s single highest close', () => {
    const run = findRun(series([100, 60, 90, 150, 140]), '2026-01-01', '2026-12-31')!
    expect(run.peakIdx).toBe(3)
    expect(run.peakDate).toBe(run.endDate)
  })
})

describe('entryPosition', () => {
  const run = { startIdx: 10, endIdx: 30 }
  it('is 0 at the run’s low, 1 at its high and linear in sessions between', () => {
    expect(entryPosition(10, run)).toBe(0)
    expect(entryPosition(30, run)).toBe(1)
    expect(entryPosition(20, run)).toBe(0.5)
    expect(entryPosition(25, run)).toBe(0.75)
  })
  it('degenerates to 0 rather than dividing by zero on a one-session run', () => {
    expect(entryPosition(7, { startIdx: 7, endIdx: 7 })).toBe(0)
  })
})

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('simulateTrailExit', () => {
  const flat = (level: number) => () => level
  it('takes the target when the close reaches it first', () => {
    const cs = series([100, 105, 130])
    expect(simulateTrailExit(cs, 0, 100, 90, 120, flat(90))).toMatchObject({ reason: 'target', exitPrice: 130, sessionsHeld: 2, pnlPct: 30 })
  })
  it('calls it a STOP when the level never moved off the published one', () => {
    const cs = series([100, 95, 89])
    expect(simulateTrailExit(cs, 0, 100, 90, 200, flat(90))).toMatchObject({ reason: 'stop', exitPrice: 89, pnlPct: -11 })
  })
  it('calls it a TRAIL when the level had been raised above the published stop', () => {
    const cs = series([100, 120, 108])
    expect(simulateTrailExit(cs, 0, 100, 90, 500, flat(110))).toMatchObject({ reason: 'trail', exitPrice: 108, sessionsHeld: 2 })
  })
  it('closes at the book’s 10-session horizon and reports still-open tape as open', () => {
    const long = series(Array.from({ length: 20 }, () => 100))
    expect(simulateTrailExit(long, 0, 100, 50, 500, flat(50))).toMatchObject({ reason: 'horizon', sessionsHeld: 10 })
    expect(simulateTrailExit(series([100, 101, 102]), 0, 100, 50, 500, flat(50))).toMatchObject({ reason: 'open', exitIdx: null, pnlPct: null })
  })
  it('passes the ENTRY session index through, which is what makes the trail ratchet', () => {
    // The trail is max(8-EMA, the lowest LOW of the five prior sessions), so one
    // washout WICK — a session that trades down to 120 and closes back at 157 —
    // drops the low leg for five sessions afterwards while the closes stay high.
    // Walked WITH the entry index (production's call) the level the tape already
    // drew stands and the drift into it is an exit; walked a session at a time
    // WITHOUT it — `entrySessionIdx` = the last bar, which is the defect e0fa4f9
    // fixed — the falsifier retreats behind the wick and the same drift reads as
    // still alive.
    const cs = [
      ...Array.from({ length: 12 }, () => ({ c: 100, l: 100 })), // calm base
      { c: 150, l: 148 }, { c: 152, l: 150 }, { c: 154, l: 152 }, { c: 156, l: 154 }, { c: 158, l: 156 }, // the push
      { c: 160, l: 158 }, // 17 — the entry session
      { c: 157, l: 120 }, // 18 — the washout wick, closing back near the highs
      { c: 152, l: 150 }, // 19 — today's trail sags behind the wick; the ratchet does not
      { c: 149, l: 147 }, // 20 — through the 150 the tape drew on 18, still over today's 148.2
    ].map((b, i) => {
      const d = new Date('2026-01-05T13:30:00Z')
      d.setUTCDate(d.getUTCDate() + i)
      return { t: Math.floor(d.getTime() / 1000), o: b.c, h: b.c, l: b.l, c: b.c, v: 1_000_000 }
    })
    const entryIdx = 17
    const ratcheted = simulateTrailExit(cs, entryIdx, 160, 148, 400, effectiveVelocityStop)
    const perDay = simulateTrailExit(cs, entryIdx, 160, 148, 400, (published, asOf) => effectiveVelocityStop(published, asOf, asOf.length - 1))
    expect(ratcheted).toMatchObject({ reason: 'trail', exitIdx: 20 })
    expect(perDay.exitIdx === null || perDay.exitIdx > ratcheted.exitIdx!).toBe(true)
  })
})

describe('bestUpDayMult', () => {
  it('agrees with the number the lane itself prints in its refusal', () => {
    // 25 quiet sessions, then a five-session window with three up-days, none of
    // them paid for: the confirmation door refuses and NAMES its best up-day.
    const closes = [...Array.from({ length: 25 }, () => 100), 101, 100.5, 101.5, 101, 102]
    const vols = [...Array.from({ length: 25 }, () => 1_000_000), 1_100_000, 900_000, 1_300_000, 900_000, 1_200_000]
    const cs = series(closes, '2026-01-05', vols)
    const read = classifyVelocity(cs)!
    const printed = /best up-day ([\d.]+)×/.exec(read.detail)
    expect(printed).not.toBeNull()
    expect(Math.round(bestUpDayMult(cs)! * 10) / 10).toBe(Number(printed![1]))
  })
  it('ignores down-days and returns null with no volume baseline', () => {
    const closes = [...Array.from({ length: 25 }, () => 100), 99, 98, 97, 96, 95]
    const vols = [...Array.from({ length: 25 }, () => 1_000_000), 9_000_000, 9_000_000, 9_000_000, 9_000_000, 9_000_000]
    expect(bestUpDayMult(series(closes, '2026-01-05', vols))).toBe(0) // loud, but every session is DOWN
    expect(bestUpDayMult(series([100, 101, 102]))).toBeNull() // no 20-session baseline
  })
})

describe('velocityRefusal', () => {
  it('separates the three ways an open door still produces no call', () => {
    expect(velocityRefusal(100, null, MIN_RISK_FRAC)).toMatch(/trail null/)
    expect(velocityRefusal(100, 100, MIN_RISK_FRAC)).toMatch(/≥ entry/)
    expect(velocityRefusal(100, 99.5, MIN_RISK_FRAC)).toMatch(/under the 1% floor/)
    expect(velocityRefusal(100, 90, MIN_RISK_FRAC)).toBeNull()
  })
})

describe('sparkClosesFrom', () => {
  const long = Array.from({ length: 80 }, (_, i) => day(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, i + 1))
  const bars = new Map<string, Candle[]>([['AAPL', long], ['THIN', long.slice(0, 10)]])
  it('returns the last 63 closes, uppercase-keyed, like parseSpark', () => {
    const m = sparkClosesFrom(bars, ['aapl'])
    expect(m.get('AAPL')!.length).toBe(63)
    expect(m.get('AAPL')![62]).toBe(80)
  })
  it('omits names with too little history — the same fail-soft shape a refused chunk gives', () => {
    const m = sparkClosesFrom(bars, ['AAPL', 'THIN', 'NEVERFETCHED'])
    expect([...m.keys()]).toEqual(['AAPL'])
  })
})

describe('summariseBoard', () => {
  const r = (side: 'long' | 'short', extra: { watchOnly?: boolean; nearMiss?: true } = {}) => ({ side, ...extra })
  it('separates trades, watch and near misses', () => {
    const s = summariseBoard([r('long'), r('long', { watchOnly: true }), r('short', { watchOnly: true, nearMiss: true })])
    expect(s).toMatchObject({ trades: 1, watch: 1, nearMiss: 1, blankSides: 0, tradelessSides: 1, namedNoTrades: false, blankBoard: false })
  })
  it('counts a near-miss-only day as named but tradeless, not blank', () => {
    const s = summariseBoard([r('long', { watchOnly: true, nearMiss: true }), r('short', { watchOnly: true, nearMiss: true })])
    expect(s).toMatchObject({ trades: 0, nearMiss: 2, blankSides: 0, tradelessSides: 2, namedNoTrades: true, blankBoard: false })
  })
  it('flags the genuinely blank board', () => {
    expect(summariseBoard([])).toMatchObject({ blankSides: 2, blankBoard: true, namedNoTrades: false })
  })
})

describe('doorsFor', () => {
  const screens = [
    { row: { sym: 'GLW' }, source: 'screener:losers' },
    { row: { sym: 'GLW' }, source: 'screener:actives' },
    { row: { sym: 'NVDA' }, source: 'screener:gainers' },
  ]
  it('names every door a symbol walked through', () => {
    expect(doorsFor('glw', screens, ['GLW', 'TSLA'], ['AMD'])).toEqual(['screener:losers', 'screener:actives', 'sleeve-top40'])
  })
  it('reports the roster door and no door at all', () => {
    expect(doorsFor('AMD', screens, [], ['AMD'])).toEqual(['roster'])
    expect(doorsFor('ZZZZ', screens, [], [])).toEqual([])
  })
})

// ============================ STAGE-2 AGGREGATION (§15) ==========================
// The gate's arithmetic, pinned without a replay. Every helper under test is pure,
// so these fixtures are hand-built rows rather than a JSON someone has to regenerate
// — and the two helpers that must talk to the engine (the monotonicity read, the
// banned-token sweep) take it as an argument, which is what lets the tests drive
// BOTH a healthy engine and a broken one through the same code.

const row = (over: Partial<Keyed> = {}): Keyed => ({
  date: '2026-07-14',
  sym: 'AAA',
  side: 'long',
  grade: 'B',
  riskPct: 1,
  composite: 40,
  probability: 0.45,
  entry: 10,
  stop: 9,
  target: 12,
  capacityPct: 8,
  expectedMovePct: 3.2,
  watchOnly: false,
  nearMiss: false,
  shadow: false,
  belowBase: false,
  contract: true,
  catalyst: null,
  setup: null,
  where: 'board',
  regime: 'green',
  modelVersion: 3,
  riskRung: 0,
  provisional: false,
  instrument: null,
  thesis: 'Long AAA — the trend is intact. Wrong if it closes below 9.',
  falsifier: 'Wrong if it closes below 9.',
  ...over,
})

describe('gradeHistogram', () => {
  it('counts the letters and the share that are B', () => {
    const h = gradeHistogram([row({ grade: 'A' }), row({ grade: 'B' }), row({ grade: 'B' }), row({ grade: 'C' })])
    expect(h).toMatchObject({ n: 4, A: 1, B: 2, C: 1, pctB: 0.5, pctA: 0.25 })
  })
  it('separates a real C from a NULL grade stamped as one', () => {
    // engine.ts stores `grade ?? 'C'`, so the only way back to a null grade is the
    // shadow/belowBase flag beside it (recon §10). A histogram that missed this
    // would report a board full of Cs the calibration never graded at all.
    const h = gradeHistogram([row({ grade: 'C' }), row({ grade: 'C', shadow: true }), row({ grade: 'C', belowBase: true })])
    expect(h).toMatchObject({ C: 3, suppressed: 2 })
  })
  it('returns null shares rather than 0/0 on an empty set', () => {
    expect(gradeHistogram([])).toMatchObject({ n: 0, pctB: null, pctA: null })
  })
})

describe('spreadOf / meanOf / sdOf', () => {
  it('reports distinct values, extremes and the SAMPLE deviation', () => {
    const s = spreadOf([0.4, 0.4, 0.5, 0.7])
    expect(s).toMatchObject({ n: 4, distinct: 3, min: 0.4, max: 0.7 })
    expect(s.mean).toBeCloseTo(0.5, 12)
    expect(s.sd).toBeCloseTo(Math.sqrt(((0.1 ** 2) * 2 + 0 + 0.2 ** 2) / 3), 12) // n−1
  })
  it('has no deviation to report below two observations', () => {
    expect(sdOf([0.4])).toBeNull()
    expect(meanOf([])).toBeNull()
    expect(spreadOf([])).toMatchObject({ n: 0, distinct: 0, min: null, max: null, sd: null })
  })
})

describe('spreadByBand', () => {
  it('buckets rows by the PRODUCTION bandFor on |composite|, and omits empty bands', () => {
    const rows = [row({ composite: 30, probability: 0.4 }), row({ composite: -45, probability: 0.5 }), row({ composite: 60, probability: 0.6 })]
    const by = spreadByBand(rows)
    expect(Object.keys(by).sort()).toEqual(['25-40', '40-55', '55-70'])
    expect(by['40-55']).toMatchObject({ n: 1, min: 0.5 }) // |−45| lands long-side band
    expect(by['70+']).toBeUndefined()
    for (const r of rows) expect(bandFor(Math.abs(r.composite))).toBe(Object.keys(by).find(b => by[b as Band]!.min === r.probability))
  })
})

describe('withinContextResolution', () => {
  // The measure that actually answers "is the step function dead": a staircase
  // still yields many distinct values across 21 days and six contexts, so a raw
  // distinct count cannot tell a curve from a step.
  it('scores a pair only when the convictions differ, and only within one day+side+regime', () => {
    const same = withinContextResolution([row({ composite: 30, probability: 0.4 }), row({ composite: 35, probability: 0.42 })])
    expect(same).toMatchObject({ pairs: 1, separated: 1, pct: 1 })
    const flat = withinContextResolution([row({ composite: 30, probability: 0.4 }), row({ composite: 35, probability: 0.4 })])
    expect(flat).toMatchObject({ pairs: 1, separated: 0, pct: 0 })
  })
  it('ignores equal convictions — two rows at the same |composite| SHOULD read the same', () => {
    expect(withinContextResolution([row({ composite: 30 }), row({ composite: -30 })])).toMatchObject({ pairs: 0, pct: null })
  })
  it('never pairs across days or regimes', () => {
    const rows = [row({ composite: 30, probability: 0.4 }), row({ date: '2026-07-15', composite: 35, probability: 0.4 }), row({ regime: 'red', composite: 50, probability: 0.4 })]
    expect(withinContextResolution(rows)).toMatchObject({ pairs: 0 })
  })
})

describe('brierOf', () => {
  const o = (hit: boolean) => ({ hit, excessPct: hit ? 3 : -1, stopped: false })
  it('agrees with the PRODUCTION brierPoint on the same rows', () => {
    // The harness's outcome10 is a three-field projection, not a full PredOutcome,
    // which is why brierOf exists at all — this pins the two to one definition.
    const rows = [row({ probability: 0.6, outcome10: o(true) }), row({ probability: 0.3, outcome10: o(false) }), row({ probability: 0.5, outcome10: o(true) })]
    const mine = brierOf(rows)
    const theirs = brierPoint(rows.map(r => ({ probability: r.probability, outcome10: { ...r.outcome10!, rawPct: 0, spyPct: 0 } })))
    expect(mine.n).toBe(3)
    expect(mine.mean!).toBeCloseTo(theirs!, 12)
    expect(mine.mean!).toBeCloseTo((0.4 ** 2 + 0.3 ** 2 + 0.5 ** 2) / 3, 12)
  })
  it('skips ungraded rows and reports nothing rather than zero when none are graded', () => {
    expect(brierOf([row({ probability: 0.6 }), row({ probability: 0.6, outcome10: null })])).toEqual({ n: 0, mean: null })
  })
})

describe('welch', () => {
  it('computes the t-statistic and Welch degrees of freedom', () => {
    const a = [1, 2, 3, 4, 5]
    const b = [2, 4, 6, 8, 10]
    const w = welch(a, b)
    // sd(a) = √2.5, sd(b) = √10 → vA = 0.5, vB = 2 → t = (3 − 6)/√2.5
    expect(w.t!).toBeCloseTo(-3 / Math.sqrt(2.5), 12)
    expect(w.df!).toBeCloseTo(6.25 / (0.25 / 4 + 4 / 4), 12)
  })
  it('answers "cannot be tested" with nulls rather than NaN', () => {
    expect(welch([1], [2, 3]).t).toBeNull()
    expect(welch([2, 2, 2], [2, 2, 2]).t).toBeNull() // no variance either side
  })
})

describe('diffKeys / sleeveKeys / keyOf', () => {
  it('identifies a call by date, symbol AND side', () => {
    expect(keyOf(row({ date: '2026-08-01', sym: 'NVDA', side: 'short' }))).toBe('2026-08-01:NVDA:short')
  })
  it('splits two runs into shared, admitted and suppressed', () => {
    const d = diffKeys(['d:A:long', 'd:B:long'], ['d:B:long', 'd:C:long'])
    expect(d).toEqual({ shared: ['d:B:long'], newOnly: ['d:C:long'], refOnly: ['d:A:long'] })
  })
  it('picks out the CORE SLEEVE names — the population Task 4 took a floor away from', () => {
    expect(sleeveKeys(['d:AAPL:long', 'd:ZZZZ:long', 'd:rr.l:short'])).toEqual(['d:AAPL:long', 'd:rr.l:short'])
  })
})

describe('voiceDefects', () => {
  const scan = (t: string) => (t.includes('pullback') ? ['pullback'] : [])
  it('passes a row that states a belief and the level that would break it', () => {
    expect(voiceDefects([row()], scan)).toEqual([])
  })
  it('names a missing thesis, a missing falsifier and a falsifier that is not the thesis last sentence', () => {
    expect(voiceDefects([row({ thesis: null })], scan)[0].faults).toContain('thesis')
    expect(voiceDefects([row({ falsifier: '' })], scan)[0].faults).toContain('falsifier')
    expect(voiceDefects([row({ thesis: 'Long AAA — fine. Wrong if it closes below 8.' })], scan)[0].faults).toContain('falsifier-not-in-thesis')
  })
  it('reports the engine s own banned tokens, from either sentence', () => {
    const d = voiceDefects([row({ thesis: 'Long AAA — a pullback. Wrong if it closes below 9.' })], bannedTokensIn)
    expect(d[0].banned).toContain('pullback')
    // …and the real sweep passes the real composer's output
    expect(voiceDefects([row({ ...composeThesis({ sym: 'AAA', side: 'long', stage: 'pullback', stop: 9 }) })], bannedTokensIn)).toEqual([])
  })
})

describe('probeGrid / contextsIn', () => {
  it('walks 26→78 so the grid crosses every band edge and both flat extensions', () => {
    const xs = probeGrid()
    expect(xs[0]).toBe(26)
    expect(xs[xs.length - 1]).toBe(78)
    for (const edge of [40, 56, 70]) expect(xs.some(x => x >= edge)).toBe(true)
    expect(xs.every((x, i) => i === 0 || x > xs[i - 1])).toBe(true)
  })
  it('reads every context a state carries, from legacy AND cohort-tagged keys', () => {
    const s = seedLikeState()
    s.buckets['large:long:green:40-55'] = { n: 20, hits: 12 }
    const ctxs = contextsIn(s)
    expect(ctxs).toContainEqual({ side: 'long', regime: 'green', cohort: 'unknown' })
    expect(ctxs).toContainEqual({ side: 'long', regime: 'green', cohort: 'large' })
    // a context nothing was booked into is not probed — asserting monotonicity on
    // an empty rung would only test the base-rate constant
    expect(ctxs.some(c => c.regime === 'blue')).toBe(false)
  })
})

describe('monotonicityViolations — the D2 guarantee, and the probe that could catch it failing', () => {
  const ctxs: ProbeContext[] = [{ side: 'long', regime: 'green', cohort: 'unknown' }]
  it('finds every downward step of an injected read — the probe is not vacuous', () => {
    const v = monotonicityViolations(ctxs, [10, 20, 30], (_c, x) => (x === 20 ? 0.2 : 0.5))
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ context: 'unknown:long:green', prevX: 10, prevP: 0.5, x: 20, p: 0.2 })
  })
  it('tolerates float dust but not a real inversion', () => {
    expect(monotonicityViolations(ctxs, [10, 20], (_c, x) => (x === 10 ? 0.3 : 0.3 - 1e-15))).toEqual([])
    expect(monotonicityViolations(ctxs, [10, 20], (_c, x) => (x === 10 ? 0.3 : 0.29))).toHaveLength(1)
  })
  it('the SEED SHAPE is genuinely non-monotone in its raw evidence…', () => {
    // recon §3.2: shorts read better at LOW conviction than high — the pathology
    // stage 2 exists to end. Asserted on the raw per-band Laplace so the next test
    // is measuring a repair and not an absence of damage.
    const b = seedLikeState().buckets
    const lap = (k: string) => (b[k].hits + 2) / (b[k].n + 4)
    expect(lap('short:green:40-55')).toBeLessThan(lap('short:green:25-40'))
    expect(lap('short:amber:40-55')).toBeLessThan(lap('short:amber:25-40'))
    expect(lap('short:green:55-70')).toBeGreaterThan(lap('short:green:40-55')) // …and jumps back up on n=8
  })
  it('…and the SHIPPED read path repairs it across the whole grid', () => {
    const s = seedLikeState()
    expect(monotonicityViolations(contextsIn(s), probeGrid(), (c, x) => probabilityFor(s, c.side, c.regime, x, c.cohort).p)).toEqual([])
  })
  it('…including the thin-lucky-top state, where shrinkage alone would invert the curve', () => {
    const s = thinTopState()
    expect(monotonicityViolations(contextsIn(s), probeGrid(), (c, x) => probabilityFor(s, c.side, c.regime, x, c.cohort).p)).toEqual([])
  })
})

describe('aReachableState — the planted evidence criterion 4 stands on', () => {
  const s = aReachableState()
  const base = baseHitRate(s).rate
  it('holds the base rate DOWN with a large losing population, so p − base is a real gap', () => {
    expect(base).toBeCloseTo(2042 / 4804, 6) // 0.4251
    expect(baseHitRate(s).n).toBe(4800)
  })
  it('reads a long above base + 0.10 on nEff ≥ 30, and therefore grades A', () => {
    const r = probabilityFor(s, 'long', 'green', 40, 'unknown')
    expect(r.nEff).toBeGreaterThanOrEqual(30)
    expect(r.belowEvidence).toBe(false)
    expect(r.p).toBeGreaterThanOrEqual(base + 0.1)
    expect(gradeFor(r.p, r.nEff, base, r.belowEvidence)).toBe('A')
  })
  it('still refuses an A BELOW the evidence — the born-below cap is not bypassed by a plant', () => {
    const low = probabilityFor(s, 'long', 'green', 26, 'unknown')
    expect(low.belowEvidence).toBe(true)
    expect(gradeFor(low.p, low.nEff, base, low.belowEvidence)).toBe('C')
  })
  it('suppresses the short side it deliberately poisoned', () => {
    const r = probabilityFor(s, 'short', 'green', 40, 'unknown')
    expect(gradeFor(r.p, r.nEff, base, r.belowEvidence)).toBeNull()
  })
})

describe('bornBelowCensus', () => {
  it('separates the cap from the demotion from the leverage it withheld', () => {
    const rows: Keyed[] = [
      row({ sym: 'CAP', belowEvidence: true, gradeUncapped: 'C', grade: 'C' }), // capped, nothing lost
      row({ sym: 'DEM', belowEvidence: true, gradeUncapped: 'B', grade: 'C', riskPct: 0.5 }), // a full trade became a half
      row({ sym: 'LEV', belowEvidence: true, gradeUncapped: 'A', grade: 'C', riskRung: 1, riskPct: 0.5 }), // …and at rung 1 an A may route
      row({ sym: 'FINE', belowEvidence: false, gradeUncapped: 'B', grade: 'B' }),
    ]
    const c = bornBelowCensus(rows)
    expect(c).toMatchObject({ capped: 3, demoted: 2, routedRowsInWindow: 0 })
    expect(c.demotedToHalfSize).toEqual(['2026-07-14:DEM:long', '2026-07-14:LEV:long'])
    // leverageAllowed(0,'B') is 0 — a rung-0 B was never going to route anything,
    // so only the rung-1 A counts as leverage the cap actually withheld
    expect(c.lostLeverageEligibility).toEqual(['2026-07-14:LEV:long'])
  })
  it('counts a routed instrument when one exists, so the counterfactual is never mistaken for a loss', () => {
    expect(bornBelowCensus([row({ instrument: '3LNV.L' })]).routedRowsInWindow).toBe(1)
  })
})

// ======================= STAGE-2b: THE SEED ARTEFACT (--seed-out) =======================
// Six guarantees, one test each. They are guarantees rather than behaviours because
// every one of them fails SILENTLY: a seed whose base has drifted loses its IC on the
// first production load, a seed carrying the previous generation's rows installs a
// mixture, and a seed whose two halves disagree on their generation installs one half.

describe('seedUniverse — crypto is out of the deep-seed population', () => {
  it('drops the crypto pairs (stage 1c is unbuilt: a crypto row would book into the EQUITY buckets)', () => {
    expect(REPLAY_UNIVERSE).toContain('ETH-USD') // the trap is live in the harness today
    expect(seedUniverse(REPLAY_UNIVERSE)).not.toContain('ETH-USD')
    expect(seedUniverse(['AAPL', 'BTC-USD', 'SOL-USD', 'RR.L'])).toEqual(['AAPL', 'RR.L'])
  })
  it('keeps BT-A.L — an exchange suffix outranks the dash, which exchangeFor tests FIRST', () => {
    // shared/symbols.ts:4-8 returns on `includes('-')` before it ever looks for the
    // '.', so BT Group — a SLEEVE_MIRROR name — reads as CRYPTO. A filter written as
    // the recon spelled it (`exchangeFor(s) === 'CRYPTO'`) would silently shrink the
    // seed universe by a real LSE equity.
    expect(exchangeFor('BT-A.L')).toBe('CRYPTO')
    expect(isCryptoSymbol('BT-A.L')).toBe(false)
    expect(isCryptoSymbol('ETH-USD')).toBe(true)
    expect(seedUniverse(REPLAY_UNIVERSE)).toContain('BT-A.L')
    expect(seedUniverse(REPLAY_UNIVERSE).length).toBe(REPLAY_UNIVERSE.length - 1) // ETH-USD and nothing else
  })
})

/** A calibration blob shaped like the one a walk leaves behind: rows booked live and
 * shadow, no seed provenance, and the stale stamps a cold-started blob carries. */
const walkedCalibration = (over: Partial<CalibrationState> = {}): CalibrationState => ({
  buckets: { 'long:green:25-40': { n: 40, hits: 15 }, 'long:green:70+': { n: 31, hits: 20 } },
  setupBuckets: { 'velocity:long:55-70': { n: 9, hits: 4 } },
  brier: [{ date: '2025-03-04', mean: 0.21, n: 6 }],
  seeded: false,
  defVersion: 1,
  modelVersion: 1,
  seedGeneration: 1,
  evidence: { seed: { n: 0, hits: 0 }, live: { n: 60, hits: 25 }, shadow: { n: 11, hits: 4 } },
  ...over,
})

const walkedWeights = (over: Partial<WeightsState> = {}): WeightsState => ({
  ...initWeights(),
  gradedSinceNudge: 7,
  history: [{ date: '2025-06-02', changes: { technical: { from: 1, to: 0.99, ic: -0.02 } }, evidence: '60 predictions graded since last nudge' }],
  seedGeneration: 1,
  ...over,
})

const emit = (over: Partial<Parameters<typeof seedArtefactFrom>[0]> = {}): SeedArtefact =>
  seedArtefactFrom({
    calibration: walkedCalibration(),
    weights: walkedWeights(),
    symbols: 143,
    generation: 2,
    generatedAt: '2026-08-13T00:00:00.000Z',
    reference: { rate: 0.3712345, n: 18_402 },
    ...over,
  })

describe('seedArtefactFrom — guarantee 1: the artefact describes ITSELF', () => {
  it('stamps defVersion, modelVersion and seedGeneration EXPLICITLY in the emitted JSON', () => {
    // Round-tripped through JSON on purpose: "explicit" means the reader of the file
    // sees the number, not that migrateCalibration would have backfilled one.
    const cal = (JSON.parse(JSON.stringify(emit())) as SeedArtefact).calibration
    expect(cal.defVersion).toBe(CALIB_DEF_VERSION)
    expect(cal.defVersion).toBe(3) // pinned as a literal: the hit definition does NOT move in stage 2b
    expect(cal.modelVersion).toBe(ENGINE_MODEL_VERSION)
    expect(cal.seedGeneration).toBe(2)
    expect(cal.seeded).toBe(true)
    expect(Object.keys(cal)).toEqual(expect.arrayContaining(['defVersion', 'modelVersion', 'seedGeneration', 'seeded']))
  })
  it('refuses a generation that is not a positive integer — an artefact may not guess which walk made it', () => {
    expect(() => emit({ generation: 0 })).toThrow(/seed-generation/)
    expect(() => emit({ generation: 1.5 })).toThrow(/seed-generation/)
    expect(() => emit({ generation: Number.NaN })).toThrow(/seed-generation/)
  })
  it('carries the shape the committed seed.json has, and the walk’s own symbol count', () => {
    const art = emit()
    expect(Object.keys(art)).toEqual(['generatedAt', 'symbols', 'weights', 'calibration'])
    expect(art.symbols).toBe(143)
    expect(art.generatedAt).toBe('2026-08-13T00:00:00.000Z')
  })
})

describe('seedArtefactFrom — guarantee 2: weights.base IS DEFAULT_WEIGHTS, or nothing ships', () => {
  it('emits the walked vector when its base already matches, and stamps the generation', () => {
    const w = emit().weights
    expect(w.base).toEqual(DEFAULT_WEIGHTS)
    expect(w.seedGeneration).toBe(2)
    expect(w.gradedSinceNudge).toBe(7) // the learned state travels; only the stamp is added
    expect(w.history).toHaveLength(1)
  })
  it('THROWS on a drifted base rather than emitting a seed whose IC dies on arrival', () => {
    // rebaseWeights runs on every load and zeroes the IC whenever the stored base
    // disagrees with DEFAULT_WEIGHTS. An artefact that ships a drifted base ships
    // "seeded IC stats for all four core factors" that production deletes on read.
    const drifted = walkedWeights({ base: { ...DEFAULT_WEIGHTS, technical: 0.42 } })
    expect(() => emit({ weights: drifted })).toThrow(/technical/)
    expect(() => emit({ weights: drifted })).toThrow(/rebaseWeights/)
  })
})

describe('seedArtefactFrom — guarantee 4: the walk’s live rows ARE seed evidence once serialised', () => {
  it('folds aggregate live into seed and zeroes live', () => {
    const ev = emit().calibration.evidence!
    expect(ev.seed).toEqual({ n: 60, hits: 25 })
    expect(ev.live).toEqual({ n: 0, hits: 0 })
  })
  it('adds to whatever seed evidence was already there rather than replacing it', () => {
    const ev = emit({ calibration: walkedCalibration({ evidence: { seed: { n: 5, hits: 2 }, live: { n: 60, hits: 25 }, shadow: { n: 11, hits: 4 } } }) }).calibration.evidence!
    expect(ev.seed).toEqual({ n: 65, hits: 27 })
  })
  it('leaves shadow UNTOUCHED — a velocity shadow row is a measured shadow record, not sized history', () => {
    expect(emit().calibration.evidence!.shadow).toEqual({ n: 11, hits: 4 })
  })
  it('drops the brier trail: it is a LIVE diagnostic keyed on dates production never lived', () => {
    // calibration.brier feeds `brierImproving`, which promotes the risk ladder
    // (engine.ts:476-491). A seed handing production a promotion argument built from
    // a walk's dates would size the reader's next trade on tape they never traded.
    // The committed seed ships `brier: []` for the same reason.
    expect(emit().calibration.brier).toEqual([])
  })
})

describe('seedArtefactFrom — guarantee 5: BOTH halves come out of the carrying store', () => {
  it('refuses to serialise when either blob is missing', () => {
    expect(() => emit({ calibration: null })).toThrow(/engine-calibration/)
    expect(() => emit({ weights: null })).toThrow(/engine-weights/)
  })
  it('never mutates the blobs it was handed — the store keeps the walk’s own state', () => {
    const cal = walkedCalibration()
    const w = walkedWeights()
    emit({ calibration: cal, weights: w })
    expect(cal.defVersion).toBe(1)
    expect(cal.evidence).toEqual({ seed: { n: 0, hits: 0 }, live: { n: 60, hits: 25 }, shadow: { n: 11, hits: 4 } })
    expect(cal.brier).toHaveLength(1)
    expect(w.seedGeneration).toBe(1)
  })
})

describe('seedArtefactFrom — guarantee 6: the two halves announce the SAME generation', () => {
  it('stamps one generation on both, whatever the blobs arrived carrying', () => {
    // loadState swaps the halves independently (engine.ts:335-352), keyed on each
    // blob's own generation. Mismatched halves install asymmetrically and silently:
    // one epoch's buckets beside another epoch's factor IC.
    const art = emit({ calibration: walkedCalibration({ seedGeneration: 4 }), weights: walkedWeights({ seedGeneration: 9 }), generation: 3 })
    expect(art.calibration.seedGeneration).toBe(art.weights.seedGeneration)
    expect(art.calibration.seedGeneration).toBe(3)
  })
})

describe('seedArtefactFrom — guarantee 7: the grade anchor is MEASURED, and thin or absurd is a refusal', () => {
  it('stamps the swept reference at 4dp — the number every grade threshold will be read from', () => {
    const cal = (JSON.parse(JSON.stringify(emit())) as SeedArtefact).calibration
    expect(cal.referenceBase).toBe(0.3712) // 0.3712345 rounded, and IN the file, not derived on load
    // …and the buckets are untouched: the reference anchors grades, it does not re-price
    expect(cal.buckets).toEqual(walkedCalibration().buckets)
  })

  it('REFUSES a thin sweep — a reference measured on nothing is worse than no reference at all', () => {
    // Absence falls back to the pooled base, which is a known quantity with known
    // semantics. A stored 0.31 read off 40 rows is a made-up number that every
    // grade for the life of the seed is then measured against.
    expect(() => emit({ reference: { rate: 0.37, n: 499 } })).toThrow(/reference sweep/)
    expect(() => emit({ reference: { rate: 0.37, n: 499 } })).toThrow(/499/)
    expect(() => emit({ reference: { rate: 0.37, n: 0 } })).toThrow(/reference sweep/)
    expect(emit({ reference: { rate: 0.37, n: 500 } }).calibration.referenceBase).toBe(0.37) // the edge is admissible
  })

  it('REFUSES a reference outside [0.25, 0.55], and says the number it read', () => {
    // The sanity band from the 2026-08-13 walk-results doc: the unconditional
    // gate-clearing rate has been ~0.37 across every measurement so far, and a
    // sweep reading 0.08 or 0.9 has measured something other than what it thinks —
    // a broken hit rule, a benchmark mismatch, a universe of one name.
    expect(() => emit({ reference: { rate: 0.2449, n: 5_000 } })).toThrow(/0\.2449/)
    expect(() => emit({ reference: { rate: 0.9, n: 5_000 } })).toThrow(/0\.9/)
    expect(() => emit({ reference: { rate: 0.9, n: 5_000 } })).toThrow(/0\.25.*0\.55|\[0\.25, 0\.55\]/)
    expect(emit({ reference: { rate: 0.25, n: 5_000 } }).calibration.referenceBase).toBe(0.25) // both edges admissible
    expect(emit({ reference: { rate: 0.55, n: 5_000 } }).calibration.referenceBase).toBe(0.55)
  })

  it('REFUSES a non-finite reading rather than writing NaN into the anchor', () => {
    expect(() => emit({ reference: { rate: Number.NaN, n: 5_000 } })).toThrow(/reference/)
    expect(() => emit({ reference: { rate: 0.37, n: Number.NaN } })).toThrow(/reference/)
  })

  it('the ROUNDING is applied before the range check, so the stored number is the checked one', () => {
    // 0.2500499 rounds to 0.25 and passes; nothing may be stamped that was not
    // itself validated, or a boundary read could store an out-of-band value.
    expect(emit({ reference: { rate: 0.2500499, n: 5_000 } }).calibration.referenceBase).toBe(0.25)
    expect(() => emit({ reference: { rate: 0.2494999, n: 5_000 } })).toThrow(/0\.2495/)
  })
})

// ---------------------- guarantee 3 + the whole pipe: a tiny walk ----------------------
// A REAL walk — the same main() Task 3 runs — over a two-name fixture universe with
// ETH-USD fed in beside them, driven off a temp candle cache so it touches no network.
// It is the only test that can prove the two claims no unit test reaches: that the
// artefact is what the CARRYING store held at walk end, and that a crypto name in the
// universe contributes nothing because the walk never looks at it.

/** The two protagonists: the names with enough swing amplitude to clear the
 * roster's join gate, and therefore the ones that actually publish rows. */
const WALK_LEADS = ['AAA', 'BBB']
/** …and the bulk of the sweep's population. The reference base is measured over the
 * window and the universe the walk ACTUALLY CONSIDERED (spec §9), and
 * `seedArtefactFrom` refuses a sweep under REFERENCE_MIN_N rows — so a two-name
 * fixture can no longer drive `--seed-out` end to end, and that refusal is itself
 * under test above. These carry tape shapes chosen so the pooled reference lands
 * inside the sane band rather than at one of its edges; the walk treats them like
 * any other candidate. They are not the whole sweep: the theme and rotation doors
 * hand the engine CONTEXT_SYMS names too, and those are in the swept universe
 * because the walk asked for them — the assertion on the run-log line below is what
 * pins that widening. */
const SWEEP_SHAPES: [number, number][] = [[-0.3, 4], [-0.3, 20], [-0.3, 9], [-0.3, 14]]
const SWEEP_SYMS = Array.from({ length: 60 }, (_, i) => `S${String(i).padStart(2, '0')}`)
const WALK_SYMS = [...WALK_LEADS, ...SWEEP_SYMS]
/** Every tape the real buildBoard reaches for that is NOT a walk candidate: the
 * index pair, the world panel, the eleven sector ETFs — and the names the rotation
 * and THEME doors put in front of the engine on any day at all (themes.ts: "every
 * theme scanned a little even on quiet days"). Derived from the engine's own
 * constants rather than listed, so a new theme cannot quietly turn this test into a
 * network call. */
const CONTEXT_SYMS = [
  ...new Set([
    'SPY',
    'QQQ',
    ...Object.keys(SECTOR_MEMBERS),
    ...Object.values(SECTOR_MEMBERS).flat(),
    ...THEMES.flatMap(t => t.members),
    ...WORLD_SYMBOLS.map(w => w.sym),
    VIX_SYMBOL.sym,
  ]),
]
// Long enough that the reference sweep — which samples every fifth session from
// the seeder's 80-bar warmup on, inside the walk's own window — can grade the 500
// rows a stored anchor requires.
const WALK_BARS = 600
const WALK_WINDOW = 300

/** Business-day timestamps — the walk derives its trading days from SPY's own series,
 * so weekends simply must not be in the tape. */
const busDays = (n: number, startISO = '2024-01-01'): number[] => {
  const out: number[] = []
  const d = new Date(`${startISO}T13:30:00Z`)
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(Math.floor(d.getTime() / 1000))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
/** Deterministic tape: a drift plus a two-frequency swing. No RNG — the artefact is
 * an artefact, and a test that re-rolled its own prices could not pin one. The swing
 * AMPLITUDE is what makes these names admissible at all: the roster's join gate wants
 * an 80th-percentile 10-session move of 8% (roster.ts JOIN_CAPACITY), so a smooth
 * tape walks forty days to an empty board with nothing to serialise. */
const tape = (ts: number[], start: number, driftPctPerDay: number, swingPct = 7, phase = 0): Candle[] =>
  ts.map((t, i) => {
    const swing = Math.sin(i * 0.314 + phase) * swingPct + Math.sin(i * 0.87 + phase) * (swingPct / 4)
    const c = start * (1 + (driftPctPerDay / 100) * i) * (1 + swing / 100)
    return { t, o: c * 0.997, h: c * 1.012, l: c * 0.988, c, v: 2_400_000 + 600_000 * Math.sin(i * 0.9 + phase) }
  })

describe('referenceSweep — the unconditional population, measured by the seeder itself', () => {
  const swpBySym = (ts: number[]) =>
    new Map([
      ['AAA', tape(ts, 40, 0.22, 9, 0.7)],
      ['BBB', tape(ts, 90, -0.06, 8, 2.1)],
    ])
  const swpSpy = (ts: number[]) => tape(ts, 480, 0.04, 1.2)

  it('pools every bucket the sweep filled, and reports the sweep’s own n', () => {
    const ts = busDays(400)
    const r = referenceSweep({ bySym: swpBySym(ts), spy: swpSpy(ts), fromISO: iso(ts[0]) })
    expect(r.n).toBeGreaterThan(0)
    expect(r.rate).toBeGreaterThan(0)
    expect(r.rate).toBeLessThan(1)
    // it IS the seeder's own buckets, pooled — not a reimplementation of the walk,
    // and not `baseHitRate`, whose n<50 cliff would hand a thin sweep a flat 0.5
    // that looks exactly like an ordinary measurement
    const cal = seedFromHistory(swpBySym(ts), swpSpy(ts), undefined, undefined, { fromISO: iso(ts[0]) }).calibration
    const t = Object.values(cal.buckets).reduce((a, b) => ({ n: a.n + b.n, hits: a.hits + b.hits }), { n: 0, hits: 0 })
    expect(r.n).toBe(t.n)
    expect(r.rate).toBeCloseTo((t.hits + 2) / (t.n + 4), 12)
  })

  it('honours the window: a later `fromISO` measures strictly less', () => {
    const ts = busDays(400)
    const all = referenceSweep({ bySym: swpBySym(ts), spy: swpSpy(ts), fromISO: iso(ts[0]) })
    const late = referenceSweep({ bySym: swpBySym(ts), spy: swpSpy(ts), fromISO: iso(ts[300]) })
    expect(late.n).toBeLessThan(all.n)
    expect(late.n).toBeGreaterThan(0)
  })

  it('is deterministic — the artefact carries this number for the life of the seed', () => {
    const ts = busDays(400)
    const a = referenceSweep({ bySym: swpBySym(ts), spy: swpSpy(ts), fromISO: iso(ts[0]) })
    const b = referenceSweep({ bySym: swpBySym(ts), spy: swpSpy(ts), fromISO: iso(ts[0]) })
    expect(a).toEqual(b)
  })
})

describe('--seed-out: the flags refuse to guess', () => {
  /** main() validates before it touches the disk, so these cost nothing and never
   * warm a cache. */
  const runWith = async (flags: string[]) => {
    const argv = process.argv
    process.argv = ['node', 'replay-window.ts', ...flags]
    try {
      await main()
    } finally {
      process.argv = argv
    }
  }
  it('refuses --seed-out with --plant-a or --baseline — a probe calibration is not a seed', async () => {
    await expect(runWith(['--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '3', '--plant-a'])).rejects.toThrow(/probe calibration/)
    await expect(runWith(['--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '3', '--baseline'])).rejects.toThrow(/probe calibration/)
  })
  it('refuses a generation at or below the committed seed — the walk would warm-start from it', async () => {
    // the committed seed is generation 2 now (shipped 2026-08-13); AT 2 must refuse
    await expect(runWith(['--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '1'])).rejects.toThrow(/not above the committed/)
    await expect(runWith(['--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '2'])).rejects.toThrow(/not above the committed/)
  })
  it('refuses --symbols without a list', async () => {
    await expect(runWith(['--symbols', '--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '3'])).rejects.toThrow(/--symbols needs/)
  })
  it('refuses --seed-out without a generation — the artefact may not guess which walk made it', async () => {
    await expect(runWith(['--seed-out', join(tmpdir(), 'never-written.json')])).rejects.toThrow(/--seed-generation/)
    await expect(runWith(['--seed-out', join(tmpdir(), 'never-written.json'), '--seed-generation', '0'])).rejects.toThrow(/--seed-generation/)
  })
  it('refuses a --seed-out that swallowed the next flag instead of a path', async () => {
    await expect(runWith(['--seed-out', '--seed-generation', '2'])).rejects.toThrow(/needs a path/)
  })
})

describe('--seed-out: the walk serialises what it learned', () => {
  it('emits a v3 artefact from the carrying store, and a crypto name in the universe contributes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-seed-'))
    const ts = busDays(WALK_BARS)
    const write = (sym: string, candles: Candle[]) =>
      writeFileSync(join(dir, `${sym.replace(/[^A-Za-z0-9]/g, '_')}.json`), JSON.stringify({ sym, range: '5y', at: Date.now(), candles }))
    // Every context tape buildBoard reads, so the walk touches no network. NOT
    // ETH-USD: the cache writes a file for every symbol it looks up (hit or miss), so
    // the ABSENCE of ETH_USD.json afterwards is proof the walk never looked, and it
    // holds whether or not this machine has an internet connection.
    for (const [i, sym] of CONTEXT_SYMS.entries()) write(sym, tape(ts, 24 + (i % 37) * 9, 0.01 + (i % 9) * 0.008, 6 + (i % 5), i * 0.41))
    write('AAA', tape(ts, 40, 0.22, 9, 0.7))
    write('BBB', tape(ts, 90, -0.06, 8, 2.1))
    // the sweep's population — see SWEEP_SYMS
    for (const [i, sym] of SWEEP_SYMS.entries()) {
      const [drift, swing] = SWEEP_SHAPES[i % SWEEP_SHAPES.length]
      write(sym, tape(ts, 30 + (i % 11) * 7, drift, swing, i * 0.37))
    }
    // The benchmark and the trading calendar, written AFTER the loop above so its
    // generic tape cannot overwrite them: an index is calm, and grading is excess
    // vs SPY, so a swinging SPY would be measuring the benchmark.
    write('SPY', tape(ts, 480, 0.04, 1.2))
    write('QQQ', tape(ts, 400, 0.05, 1.6))

    const seedPath = join(dir, 'seed-candidate.json')
    const outPath = join(dir, 'walk-diag.json')
    const from = iso(ts[WALK_BARS - WALK_WINDOW])
    const to = iso(ts[WALK_BARS - 1])
    const argv = process.argv
    process.argv = ['node', 'replay-window.ts', '--from', from, '--to', to, '--symbols', [...WALK_SYMS, 'ETH-USD'].join(','), '--seed-out', seedPath, '--seed-generation', '3', '--out', outPath]
    // the walk narrates every day; the suite does not need to hear it — but the
    // seed-out summary IS a deliverable, so it is captured rather than discarded
    const logged: string[] = []
    const quiet = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
    try {
      vi.resetModules() // CACHE_DIR is read at module load, so the fresh instance is what sees the temp cache
      vi.stubEnv('REPLAY_CACHE_DIR', dir)
      const fresh = (await import('./replay-window')) as typeof import('./replay-window')
      await fresh.main()
    } finally {
      quiet.mockRestore()
      vi.unstubAllEnvs()
      process.argv = argv
    }

    const art = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedArtefact
    const run = JSON.parse(readFileSync(outPath, 'utf8')) as { universe: number; days: { board: Keyed[]; ledger: Keyed[] }[]; missing: { sym: string }[]; calibrationFinal: CalibrationState }

    // guarantee 3 — ETH-USD was fed in with the two equities and skipped ENTIRELY:
    // never in the universe, never fetched, never a row, never a symbol counted.
    expect(run.universe).toBe(WALK_SYMS.length)
    expect(existsSync(join(dir, 'ETH_USD.json'))).toBe(false)
    expect(run.missing.map(m => m.sym)).not.toContain('ETH-USD')
    const contributors = new Set([...run.days.flatMap(d => [...d.board, ...d.ledger].map(r => r.sym.toUpperCase()))])
    for (const sym of contributors) expect(isCryptoSymbol(sym)).toBe(false)
    expect(art.symbols).toBe(contributors.size) // `symbols` = the names that actually produced rows
    expect(art.symbols).toBeGreaterThanOrEqual(WALK_LEADS.length)

    // guarantee 5 — the artefact IS the carrying store's two blobs at walk end
    expect(art.calibration.buckets).toEqual(run.calibrationFinal.buckets)
    expect(art.weights.base).toEqual(DEFAULT_WEIGHTS)
    // …and the IC is the WALK's, not initWeights' zeros — technical scores on
    // every graded composite, so a walk that graded rows must have moved it
    const tech = art.weights.ic.technical
    expect(tech.nAgree + tech.nDisagree).toBeGreaterThan(0)

    // THE WALK STARTED EMPTY. The proof is in the blob as it stood at walk end,
    // BEFORE serialisation folds live into seed: `emptyLearningState` zeroes
    // `evidence.seed` and nothing in the walk ever books `provenance: 'seed'`, so a
    // zero there means no prior population rode in. Had loadState cold-started from
    // the committed generation-1 seed, `evidence.seed` would have arrived holding
    // its whole 778/285 tally (seed.json carries it explicitly, and buckets merge
    // ADDITIVELY — nothing later removes them). This holds however many rows the
    // walk grades on its own, which a bound on the total does not.
    expect(seedJson.calibration.evidence.seed.n).toBeGreaterThan(0) // the pin is not vacuous
    expect(run.calibrationFinal.evidence!.seed).toEqual({ n: 0, hits: 0 })
    const total = Object.values(art.calibration.buckets).reduce((s, b) => s + b.n, 0)
    expect(art.calibration.evidence!.live).toEqual({ n: 0, hits: 0 })
    expect(art.calibration.evidence!.seed.n + art.calibration.evidence!.shadow.n).toBe(total)
    expect(art.calibration.evidence!.seed.n).toBeGreaterThan(0) // the window is long enough to grade something

    // guarantees 1, 2, 6 on the file the next task actually copies over seed.json
    expect(art.calibration.defVersion).toBe(3)
    expect(art.calibration.modelVersion).toBe(3)
    expect(art.calibration.seedGeneration).toBe(3) // 3: the committed seed is generation 2 since 2026-08-13, and the floor refuses ≤2
    expect(art.weights.seedGeneration).toBe(art.calibration.seedGeneration)

    // guarantee 7 — the grade anchor, swept over this same window and universe and
    // stamped into the file. It is measured, so the test pins its SHAPE (a number,
    // 4dp, inside the sane band) rather than a value that would move with the tape;
    // the arithmetic itself is pinned on `referenceSweep` above.
    const ref = art.calibration.referenceBase!
    expect(typeof ref).toBe('number')
    expect(Number.isFinite(ref)).toBe(true)
    expect(ref).toBeGreaterThanOrEqual(0.25)
    expect(ref).toBeLessThanOrEqual(0.55)
    expect(ref).toBe(Math.round(ref * 1e4) / 1e4)
    // it is NOT the pooled base of the walk's own buckets — the two populations are
    // different, which is the entire reason the field exists
    expect(ref).not.toBe(baseHitRate(art.calibration).rate)
    // and the run log names the sweep's n, so a reader can weigh the anchor
    expect(logged.join('\n')).toMatch(/reference base 0\.\d{4} — unconditional sweep over \d+ symbols, \d+ graded rows/)

    // THE SWEEP WALKS THE WALK'S OWN UNIVERSE [§9]: not the `--symbols` list it was
    // handed, but the union of every name buildBoard asked for. In this fixture the
    // theme and rotation doors put context names in front of the engine that the
    // handed list never mentions, so the swept universe is strictly WIDER — which is
    // exactly the population a baseUniverse sweep would have anchored grades without.
    const sweep = logged.join('\n').match(/sweep universe (\d+) symbols — the union of every name the walk ASKED for.*?\+(\d+) the handed universe would have missed/)
    expect(sweep, 'the seed-out summary must report the swept universe').not.toBeNull()
    expect(Number(sweep![1])).toBeGreaterThan(WALK_SYMS.length)
    expect(Number(sweep![2])).toBeGreaterThan(0)
    // …and it is the SAME universe the anchor was measured over — one number, printed twice
    expect(logged.join('\n')).toMatch(new RegExp(`unconditional sweep over ${sweep![1]} symbols`))
  }, 180_000)
})

describe('flatten', () => {
  it('stamps each row with the day it was published on', () => {
    const run = {
      mode: 'new',
      commit: 'abc',
      from: '2026-07-14',
      to: '2026-07-15',
      days: [{ date: '2026-07-14', board: [row()], ledger: [] }, { date: '2026-07-15', board: [], ledger: [row()] }],
    } as unknown as RunFile
    expect(flatten(run, 'board').map(keyOf)).toEqual(['2026-07-14:AAA:long'])
    expect(flatten(run, 'ledger').map(keyOf)).toEqual(['2026-07-15:AAA:long'])
  })
})
