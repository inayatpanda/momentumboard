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
import { classifyLoser } from '../shared/engine/postMortem'
import { isRouteEtp } from '../shared/engine/riskLadder'
import type { DayTrace, Keyed, MissGateStatLike, MissLedgerLike, PostMortemLike, PrecedenceSample, ProbeContext, RegretContext, Row, RunFile, SeedArtefact } from './replay-window'
import {
  WALK_ABSENT_FACTORS,
  enrichFromCalibration,
  shippedRead,
  GATE_CODE_MIRROR,
  MISS_EXCESS_MIN_MIRROR,
  MISS_LEDGER_DAYS_MAX_MIRROR,
  MISS_LEDGER_KEY_MIRROR,
  GATE_STATE_KEY_MIRROR,
  MISS_SKIP_GATE_MIRROR,
  POSTMORTEM_CLASS_MIRROR,
  expectedCalledGates,
  missAccrualViolations,
  missCandidateCount,
  missLedgerViolations,
  postMortemViolations,
  precedenceViolations,
  traceViolations,
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
  LEVMAP_MIRROR,
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

describe('LEVMAP_MIRROR — the walk can route a short', () => {
  // A REPRESENTATIVE mirror, not a copy of a source file: production's real map
  // lives in the runtime config blob and is owner-maintained, so there is nothing
  // in the repo to drift-guard it against. What CAN be guarded is every property
  // the walk's measurement actually depends on, and those are guarded here.
  it('routes only names the walk can see, inside the cap a stored config can hold', () => {
    const keys = Object.keys(LEVMAP_MIRROR)
    expect(keys.length).toBeGreaterThan(20) // a mirror of one name measures nothing
    // validateConfig keeps the FIRST 40 entries of a stored levMap (shared/config.ts):
    // a mirror production could not hold is not a mirror of production.
    expect(keys.length).toBeLessThanOrEqual(40)
    for (const sym of keys) {
      expect(REPLAY_UNIVERSE, sym).toContain(sym) // a route for a name the walk never prices is dead weight
      expect(sym).toBe(sym.toUpperCase())
      const m = LEVMAP_MIRROR[sym]
      expect(Object.values(m).length, sym).toBeGreaterThan(0)
    }
  })

  it('carries real short routes — and does NOT pretend every name has one', () => {
    const shortable = Object.entries(LEVMAP_MIRROR).filter(([, m]) => m.short2x || m.short3x)
    // the whole point of F-2: the walk must be able to SIZE a short somewhere
    expect(shortable.length).toBeGreaterThan(15)
    // …and the pre-grade shadow path must stay exercised, or the walk stops
    // measuring the dilution the partition exists to remove: the overwhelming
    // majority of the universe still has no route at all
    const routableShorts = new Set(shortable.map(([s]) => s))
    expect(REPLAY_UNIVERSE.filter(s => !routableShorts.has(s)).length).toBeGreaterThan(REPLAY_UNIVERSE.length / 2)
  })

  it('no route ticker collides with a tradeable name — isRouteEtp would eat the candidate', () => {
    const tickers = Object.values(LEVMAP_MIRROR).flatMap(m => [m.long2x, m.long3x, m.short2x, m.short3x].filter(Boolean) as string[])
    expect(tickers.length).toBe(new Set(tickers).size) // one instrument, one underlying
    for (const t of tickers) {
      expect(REPLAY_UNIVERSE, t).not.toContain(t)
      expect(isRouteEtp(t, LEVMAP_MIRROR), t).toBe(true)
    }
    // and the underlyings themselves are never mistaken for routes
    for (const sym of Object.keys(LEVMAP_MIRROR)) expect(isRouteEtp(sym, LEVMAP_MIRROR), sym).toBe(false)
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
  observation: false,
  contract: true,
  catalyst: null,
  setup: null,
  accrual: 'sized',
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
    expect(ctxs).toContainEqual({ side: 'long', regime: 'green', cohort: 'unknown', population: 'pooled', setup: null })
    expect(ctxs).toContainEqual({ side: 'long', regime: 'green', cohort: 'large', population: 'pooled', setup: null })
    // a context nothing was booked into is not probed — asserting monotonicity on
    // an empty rung would only test the base-rate constant
    expect(ctxs.some(c => c.regime === 'blue')).toBe(false)
  })

  // THE GATE MUST LOOK AT WHAT SHIPS [stage 3c task 4, binding from the Task-2
  // review]. Since the partition and the blend, one (side, regime, cohort) is no
  // longer one curve: a sized read and a pooled read are different curves over the
  // same buckets, and a blended family read is a THIRD — and the blend is a band
  // step, so it is the one most able to break monotonicity. A probe that swept only
  // the pooled, unblended ladder would assert D2 on a curve no reader is ever shown.
  it('expands each context over BOTH populations and every setup family the state carries', () => {
    const s = seedLikeState()
    s.setupBuckets = {
      'continuation:long:25-40': { n: 60, hits: 30, shadowN: 5, shadowHits: 2 },
      'velocity:short:40-55': { n: 44, hits: 12, shadowN: 0, shadowHits: 0 },
    }
    const ctxs = contextsIn(s)
    // both populations, on every context
    for (const p of ['pooled', 'sized'] as const)
      expect(ctxs).toContainEqual({ side: 'long', regime: 'green', cohort: 'unknown', population: p, setup: null })
    // the family is probed on ITS OWN side only — a `continuation:long` bucket is
    // never read by a short, so probing it there would assert on a read that cannot
    // happen and would dilute the count with unreachable contexts
    expect(ctxs).toContainEqual({ side: 'long', regime: 'green', cohort: 'unknown', population: 'sized', setup: 'continuation' })
    expect(ctxs).toContainEqual({ side: 'short', regime: 'green', cohort: 'unknown', population: 'sized', setup: 'velocity' })
    expect(ctxs.some(c => c.side === 'short' && c.setup === 'continuation')).toBe(false)
    expect(ctxs.some(c => c.side === 'long' && c.setup === 'velocity')).toBe(false)
    // …and never on a pooled read, where `blendSetup` returns the ladder untouched:
    // a probe of an inert argument measures nothing and claims coverage for it
    expect(ctxs.some(c => c.population === 'pooled' && c.setup != null)).toBe(false)
    // a state with no families is exactly the bare ladder in two populations
    expect(contextsIn(seedLikeState()).every(c => c.setup === null)).toBe(true)
  })
})

describe('monotonicityViolations — the D2 guarantee, and the probe that could catch it failing', () => {
  const ctxs: ProbeContext[] = [{ side: 'long', regime: 'green', cohort: 'unknown', population: 'pooled', setup: null }]
  it('finds every downward step of an injected read — the probe is not vacuous', () => {
    const v = monotonicityViolations(ctxs, [10, 20, 30], (_c, x) => (x === 20 ? 0.2 : 0.5))
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ context: 'unknown:long:green pooled', prevX: 10, prevP: 0.5, x: 20, p: 0.2 })
  })
  it('names the population and the family in the violation, or a failure cannot be located', () => {
    const blended: ProbeContext[] = [{ side: 'long', regime: 'green', cohort: 'large', population: 'sized', setup: 'velocity' }]
    const v = monotonicityViolations(blended, [10, 20], (_c, x) => (x === 10 ? 0.5 : 0.4))
    expect(v[0].context).toBe('large:long:green sized/velocity')
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
    expect(monotonicityViolations(contextsIn(s), probeGrid(), shippedRead(s))).toEqual([])
  })
  it('…including the thin-lucky-top state, where shrinkage alone would invert the curve', () => {
    const s = thinTopState()
    expect(monotonicityViolations(contextsIn(s), probeGrid(), shippedRead(s))).toEqual([])
  })
  it('shippedRead IS probabilityFor with the context’s own population and family — the read the reader got', () => {
    const s = thinTopState()
    s.setupBuckets = { 'continuation:long:40-55': { n: 90, hits: 81, shadowN: 0, shadowHits: 0 } }
    const read = shippedRead(s)
    const ctx: ProbeContext = { side: 'long', regime: 'green', cohort: 'unknown', population: 'sized', setup: 'continuation' }
    expect(read(ctx, 47.5)).toBe(probabilityFor(s, 'long', 'green', 47.5, 'unknown', 'sized', 'continuation').p)
    // …and the blend is doing something here, or the assertion above is a tautology
    // over an argument the read path ignored
    expect(read(ctx, 47.5)).not.toBe(probabilityFor(s, 'long', 'green', 47.5, 'unknown', 'sized').p)
  })
  it('a blend that breaks the band step IS caught — the sized/blended curve is probed, not just the ladder', () => {
    // An earned family whose record sits far ABOVE the ladder in one band and is
    // absent in the next pulls that band up and lets the curve fall back down at the
    // boundary. This is the failure mode the binding exists for: the pooled ladder
    // stays monotone throughout, and only the shipped read shows the step.
    const s = thinTopState()
    s.setupBuckets = { 'continuation:long:40-55': { n: 200, hits: 198, shadowN: 0, shadowHits: 0 } }
    const bare = contextsIn(s).filter(c => c.setup == null)
    expect(monotonicityViolations(bare, probeGrid(), shippedRead(s))).toEqual([])
    const blended = monotonicityViolations(contextsIn(s), probeGrid(), shippedRead(s))
    expect(blended.length).toBeGreaterThan(0)
    expect(blended.every(v => v.context.includes('continuation'))).toBe(true)
  })

  // …AND ON THE COMMITTED SEED IT IS NO LONGER HYPOTHETICAL [fix wave F-1].
  //
  // Pinned here as a KNOWN, MEASURED property rather than left for the next probe
  // run to discover. Waking the blend put the engine's two guarantees against each
  // other on real evidence: the ladder is isotonic by construction, but a family's
  // read is a STEP — `laplace` of the one bucket for the call's band — so wherever
  // a family prices its next band worse than its current one, the shipped curve
  // falls at the boundary while the ladder under it keeps rising.
  //
  // It is a DESIGN DECISION, deliberately not taken inside an install: the honest
  // repairs (fit the family's four bands isotonically and read the blend off a
  // curve, or refuse a blend that would break the step) both change what every
  // blended row is priced at, which is a model question with an author. The gate
  // result and the reader-visible form of it are recorded in the task report.
  it('THE COMMITTED SEED’S BLENDED READS BREAK D2 AT THE BAND BOUNDARIES — pinned, not accepted', () => {
    const s = seedJson.calibration as unknown as CalibrationState
    const ctxs = contextsIn(s)
    // the ladder itself is still clean in BOTH populations — this is the blend's
    // step and nothing else, which is what makes the finding actionable
    expect(monotonicityViolations(ctxs.filter(c => c.setup == null), probeGrid(), shippedRead(s))).toEqual([])
    const v = monotonicityViolations(ctxs, probeGrid(), shippedRead(s))
    expect(v.length).toBe(11)
    expect(v.every(x => x.context.includes('sized/'))).toBe(true)
    // every one of them sits on a BAND EDGE (40 / 55 / 70 — `bandFor`), which is
    // the mechanism stated as an assertion: the family bucket changes under the
    // read and the new bucket prices worse
    expect([...new Set(v.map(x => x.x))].sort((a, b) => a - b)).toEqual([40, 56, 70])
    // …and the damage is bounded — the worst step is under 3pp of probability
    expect(Math.max(...v.map(x => x.prevP - x.p))).toBeLessThan(0.03)
  })
})

// ---------------------------------------------------------------------------
// THE COUNTERFACTUAL IS READ IN THE POPULATION THE ROW SHIPPED IN [stage 3c task
// 4, binding from the Task-1 review]. `enrichFromCalibration` recomputes nEff,
// belowEvidence and the uncapped grade from the same blob the board was built
// against — and it recomputed them POOLED, which was byte-identical to the board
// until the partition existed. From generation 4 on it is not: a sized row's
// nEff, its born-below flag and its uncapped grade are all read off the sized
// curve, so a pooled recomputation would report the born-below census, the §3
// rounding check and the monotonicity gate against a curve no row was graded on.
// ---------------------------------------------------------------------------

describe('enrichFromCalibration — the row is re-read in its own population, with its own family', () => {
  /** Sized evidence that is genuinely better than the pool it sits in: the shadow
   * slice is the losing half, so a sized read must come back HIGHER. */
  const partitioned = (): CalibrationState => ({
    buckets: {
      'long:green:25-40': { n: 600, hits: 240, shadowN: 300, shadowHits: 60 },
      'long:green:40-55': { n: 400, hits: 190, shadowN: 200, shadowHits: 50 },
    },
    setupBuckets: { 'continuation:long:40-55': { n: 120, hits: 96, shadowN: 20, shadowHits: 4 } },
    brier: [],
    referenceBase: 0.37,
  })
  const row = (over: Partial<Row>): Row =>
    ({
      sym: 'AAA', side: 'long', grade: 'C', riskPct: 0, composite: 47.5, probability: 0.4, entry: 10, stop: 9, target: 12,
      capacityPct: 5, expectedMovePct: 3, watchOnly: false, nearMiss: false, shadow: false, belowBase: false, observation: false,
      contract: true, catalyst: null, setup: null, accrual: null, where: 'board', regime: 'green', modelVersion: 3, riskRung: 1,
      provisional: false, instrument: null, thesis: null, falsifier: null,
      ...over,
    }) as Row
  const enrich = (r: Row): Row => {
    const cal = partitioned()
    enrichFromCalibration([r], cal, 0.37)
    return r
  }
  const cal = partitioned()
  const pooled = probabilityFor(cal, 'long', 'green', 47.5, 'unknown')
  const sized = probabilityFor(cal, 'long', 'green', 47.5, 'unknown', 'sized')

  it('the fixture is not vacuous — the two populations disagree on this bucket', () => {
    expect(sized.p).not.toBe(pooled.p)
    expect(sized.nEff).not.toBe(pooled.nEff)
  })
  it('a row stamped `sized` is re-read against SIZED history, exactly as the engine priced it', () => {
    const r = enrich(row({ accrual: 'sized' }))
    expect(r.pRaw).toBe(sized.p)
    expect(r.nEff).toBe(sized.nEff)
  })
  it('a row stamped `shadow` is re-read POOLED — a shadow was priced against the pool it belongs to', () => {
    const r = enrich(row({ accrual: 'shadow', shadow: true }))
    expect(r.pRaw).toBe(pooled.p)
    expect(r.nEff).toBe(pooled.nEff)
  })
  it('an UNSTAMPED row stays pooled — a pre-partition tree reads byte-for-byte what it read before', () => {
    const r = enrich(row({ accrual: null }))
    expect(r.pRaw).toBe(pooled.p)
  })
  it('carries the row’s own setup family in, so the enrichment sees the blend the reader was shown', () => {
    const r = enrich(row({ accrual: 'sized', setup: 'continuation' }))
    expect(r.pRaw).toBe(probabilityFor(cal, 'long', 'green', 47.5, 'unknown', 'sized', 'continuation').p)
    expect(r.pRaw).not.toBe(sized.p) // the family earned its 0.3, and the enrichment shows it
    // the blend moves PRICE only — the ladder's evidence mass is untouched
    expect(r.nEff).toBe(sized.nEff)
  })
  it('…and a shadow’s family is inert, because the blend never fires on a pooled read', () => {
    const r = enrich(row({ accrual: 'shadow', setup: 'continuation' }))
    expect(r.pRaw).toBe(pooled.p)
  })
  it('the uncapped grade is struck from the SIZED read too — the census counts what the board did', () => {
    const r = enrich(row({ accrual: 'sized' }))
    expect(r.gradeUncapped).toBe(gradeFor(sized.p, sized.nEff, 0.37, false))
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
    // Stage-3a Task 3 fixed exchangeFor itself (suffix first), so the local
    // no-dot guard is belt over braces now — this pin documents that BOTH
    // layers agree BT Group is an LSE equity, not a coin.
    expect(exchangeFor('BT-A.L')).toBe('LSE')
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

describe('seedArtefactFrom — guarantee 2b: weights.current IS weights.base, or nothing ships', () => {
  // The gen-2 seed shipped `current` carrying the walk's ~450 compounding nudges:
  // technical 0.0791 against a base of 1.0, momentum pinned at the 2× cap and 73 % of
  // a weight-normalised composite (recon §0.1). `base` drift is caught above because
  // `rebaseWeights` reacts to it; `current` drift is caught by NOTHING downstream —
  // it simply becomes production's scoring vector, silently, on install.
  it('emits when the walk pinned its vector, and the emitted current IS the base', () => {
    const w = emit().weights
    expect(w.current).toEqual(w.base)
    expect(w.current).toEqual(DEFAULT_WEIGHTS)
  })
  it('THROWS on a drifted current — the walk’s compounding nudges may not ride into production', () => {
    const drifted = walkedWeights({ current: { ...DEFAULT_WEIGHTS, technical: 0.0791, momentum: 1.8 } })
    expect(() => emit({ weights: drifted })).toThrow(/technical/)
    expect(() => emit({ weights: drifted })).toThrow(/momentum/)
    expect(() => emit({ weights: drifted })).toThrow(/weights\.current/)
    // one factor is enough — the vector is the whole artefact's scorer
    expect(() => emit({ weights: walkedWeights({ current: { ...DEFAULT_WEIGHTS, seasonality: 5.75e-5 } }) })).toThrow(/seasonality/)
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

// ---------------------------------------------------------------------------
// GUARANTEE 8 — A FACTOR THE WALK NEVER FED SHIPS NO MEASUREMENT [stage 3c task
// 4, binding from the Task-2 review].
//
// The replay is PRICE-ONLY: `makeDeps` returns an empty tape for media titles,
// an empty insider map, no 13F, no YouTube stances, no catalysts. Before stage
// 3c that cost nothing, because `updateIcStats` skipped every zero. Task 2's
// `ZERO_IS_A_READING` admits news's zero deliberately — `newsFactor([])` is the
// "quiet tape" reading and the factor has no null path — and the consequence
// lands HERE: over a two-year walk the news column fills with one identical
// fabricated observation per graded row (against every long, with every short),
// crosses both twenty-observation floors, and ships an IC that production would
// nudge a real weight on. A thousand readings from a factor never shown a
// headline is an artifact, not evidence.
// ---------------------------------------------------------------------------

describe('seedArtefactFrom — guarantee 8: no IC from a factor the walk could not feed', () => {
  const phantom = (over: Partial<Record<string, unknown>> = {}) =>
    walkedWeights({
      ic: {
        ...initWeights().ic,
        technical: { nAgree: 5194, sumAgree: 7361.7, nDisagree: 49, sumDisagree: 15.9 },
        seasonality: { nAgree: 3579, sumAgree: 4255.3, nDisagree: 1547, sumDisagree: 2895.8 },
        news: { nAgree: 2100, sumAgree: -410.2, nDisagree: 4300, sumDisagree: 980.4 },
        insiders: { nAgree: 31, sumAgree: 12.5, nDisagree: 44, sumDisagree: -3.5 },
      },
      history: [
        { date: '2025-06-02', changes: { technical: { from: 1, to: 0.99, ic: -0.02 }, news: { from: 0.5, to: 0.53, ic: 0.41 } }, evidence: '15 predictions graded since last nudge' },
      ],
      ...over,
    })

  it('names the factors the walk cannot feed — every non-price dependency in makeDeps', () => {
    expect([...WALK_ABSENT_FACTORS].sort()).toEqual(['catalyst', 'channels', 'insiders', 'news', 'smartMoney', 'social'])
    // …and the complement is the price-derived four the walk DOES measure
    for (const f of ['technical', 'momentum', 'sector', 'seasonality']) expect(WALK_ABSENT_FACTORS).not.toContain(f)
  })

  it('zeroes their IC at serialisation — news above all, whose zero the loop now books', () => {
    const ic = emit({ weights: phantom() }).weights.ic
    for (const f of WALK_ABSENT_FACTORS) expect(ic[f], f).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
    // the pin that matters: news arrived with both columns past MIN_IC_SIDE_N, i.e.
    // eligible to nudge a live weight on the first pass after install
    expect(phantom().ic.news.nAgree).toBeGreaterThan(20)
    expect(phantom().ic.news.nDisagree).toBeGreaterThan(20)
  })

  it('leaves the price-derived factors exactly as the walk measured them', () => {
    const ic = emit({ weights: phantom() }).weights.ic
    expect(ic.technical).toEqual({ nAgree: 5194, sumAgree: 7361.7, nDisagree: 49, sumDisagree: 15.9 })
    expect(ic.seasonality).toEqual({ nAgree: 3579, sumAgree: 4255.3, nDisagree: 1547, sumDisagree: 2895.8 })
  })

  it('scrubs their nudges out of the history too — a panel may not report a change nobody measured', () => {
    const h = emit({ weights: phantom() }).weights.history
    expect(h[0].changes.news).toBeUndefined()
    expect(h[0].changes.technical).toEqual({ from: 1, to: 0.99, ic: -0.02 })
  })

  it('never mutates the walk’s own blob — the store keeps what it measured', () => {
    const w = phantom()
    emit({ weights: w })
    expect(w.ic.news.nAgree).toBe(2100)
    expect(w.history[0].changes.news).toBeDefined()
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
    await expect(runWith(['--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '5', '--plant-a'])).rejects.toThrow(/probe calibration/)
    await expect(runWith(['--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '5', '--baseline'])).rejects.toThrow(/probe calibration/)
  })
  it('refuses a generation at or below the committed seed — the walk would warm-start from it', async () => {
    // the committed seed is generation 4 now (the partitioned re-walk, 2026-08-13);
    // AT 4 must refuse, and so must every generation the tree has already shipped
    for (const g of ['1', '2', '3', '4'])
      await expect(runWith(['--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', g])).rejects.toThrow(/not above the committed/)
  })
  it('refuses --symbols without a list', async () => {
    await expect(runWith(['--symbols', '--seed-out', join(tmpdir(), 'nw.json'), '--seed-generation', '5'])).rejects.toThrow(/--symbols needs/)
  })
  it('refuses --seed-out without a generation — the artefact may not guess which walk made it', async () => {
    await expect(runWith(['--seed-out', join(tmpdir(), 'never-written.json')])).rejects.toThrow(/--seed-generation/)
    await expect(runWith(['--seed-out', join(tmpdir(), 'never-written.json'), '--seed-generation', '0'])).rejects.toThrow(/--seed-generation/)
  })
  it('refuses a --seed-out that swallowed the next flag instead of a path', async () => {
    await expect(runWith(['--seed-out', '--seed-generation', '5'])).rejects.toThrow(/needs a path/)
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
    process.argv = ['node', 'replay-window.ts', '--from', from, '--to', to, '--symbols', [...WALK_SYMS, 'ETH-USD'].join(','), '--seed-out', seedPath, '--seed-generation', '5', '--out', outPath]
    // the walk narrates every day; the suite does not need to hear it — but the
    // seed-out summary IS a deliverable, so it is captured rather than discarded
    const logged: string[] = []
    const quiet = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
    // seed mode PINS `GATES=off` on itself (see below); the pin is observed here and
    // the ambient value restored, so one walk cannot silence the gates for the rest
    // of the suite
    const gatesBefore = process.env.GATES
    let gatesDuringWalk: string | undefined
    try {
      vi.resetModules() // CACHE_DIR is read at module load, so the fresh instance is what sees the temp cache
      vi.stubEnv('REPLAY_CACHE_DIR', dir)
      const fresh = (await import('./replay-window')) as typeof import('./replay-window')
      await fresh.main()
      gatesDuringWalk = process.env.GATES
    } finally {
      quiet.mockRestore()
      vi.unstubAllEnvs()
      process.argv = argv
      if (gatesBefore === undefined) delete process.env.GATES
      else process.env.GATES = gatesBefore
    }

    const art = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedArtefact
    const run = JSON.parse(readFileSync(outPath, 'utf8')) as { universe: number; days: { board: Keyed[]; ledger: Keyed[] }[]; missing: { sym: string }[]; calibrationFinal: CalibrationState; gateStateFinal: unknown }

    // THE SEED WALK DOES NOT ADVANCE GATE STATE [stage 3c task 4, plan decision
    // (d)]. Gates move on LIVE evidence, on a live cadence clock. A synthetic tape
    // that armed them would re-judge every later day of its own window under a dead
    // zone the walk itself moved — the artefact would then be measured partly under
    // thresholds production has never run, with nothing in the file to say which
    // days. So seed mode pins the rollback lever on and the blob is never written.
    expect(gatesDuringWalk).toBe('off')
    expect(run.gateStateFinal).toBeNull()
    expect(logged.join('\n')).toMatch(/gates: PINNED OFF/)

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
    expect(tech.nAgree).toBeGreaterThan(0)

    // …AND NO IC AT ALL FROM A FACTOR THE WALK NEVER FED (guarantee 8). The blob in
    // the carrying store books news on every graded row — `newsFactor([])` is a
    // reading under ZERO_IS_A_READING and this walk hands it an empty tape every
    // morning — so the two halves of this pin are what make it real: the walk DID
    // fabricate a news column, and the artefact does not carry it.
    for (const f of WALK_ABSENT_FACTORS) expect(art.weights.ic[f], f).toEqual({ nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 })
    for (const h of art.weights.history) for (const f of WALK_ABSENT_FACTORS) expect(h.changes[f], f).toBeUndefined()
    // the run log names what was dropped and how much of it there was — and NEWS
    // must be in that list with a real count, or the zeroing above is passing on a
    // column that was empty anyway and this whole guarantee is untested
    const dropped = logged.join('\n').match(/phantom IC dropped: (.+)/)
    expect(dropped, 'the seed-out summary must name the IC it refused to ship').not.toBeNull()
    expect(dropped![1]).toMatch(/news \d+ obs/)
    expect(Number(dropped![1].match(/news (\d+) obs/)![1])).toBeGreaterThan(20)

    // THE SCORING VECTOR IS FROZEN, AND THE MEASUREMENT IS NOT. Seed mode pins
    // `current` back to `base` after every graded day, so the whole window was scored
    // with DEFAULT_WEIGHTS — the vector production will score with — while the factor
    // IC beside it kept accruing. Without the pin the walk's compounding nudges
    // (NUDGE_EVERY 15 over a two-year window ⇒ ~450 of them, unbounded below once
    // PRUNE_MIN_N lifts the floor) become the seed's scoring vector: generation 2
    // shipped technical at 0.0791 and momentum at the 2× cap. The nAgree assertion
    // above is the other half of the claim — a frozen vector that stopped MEASURING
    // would satisfy this one vacuously.
    expect(art.weights.current).toEqual(art.weights.base)
    expect(art.weights.current).toEqual(DEFAULT_WEIGHTS)
    // the nudge loop DID run — it is the applied vector that was pinned, not the loop
    expect(art.weights.history.length).toBeGreaterThan(0)

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
    expect(art.calibration.seedGeneration).toBe(5) // 5: the committed seed is generation 4 since 2026-08-13, and the floor refuses ≤4
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

// ==================== STAGE-3a TASK 4: THE WALK CARRIES THE TRACE ====================
// The acceptance instrument 3b and 3c are built on. Two claims, tested separately:
//   1. CONSISTENCY — per day, the funnel trace and the rows the READER gets agree.
//      Pure, so it is driven by hand-built days here and by the real walk below.
//   2. PARITY — the recorder never touches published output. Proved by walking the
//      same fixture window twice, once with the recorder stubbed to a no-op, and
//      byte-comparing the board and the ledger.

/** A day as the walk records one, with only the fields the invariant reads. */
const traceDay = (over: { board?: Keyed[]; ledger?: Keyed[]; trace?: DayTrace | undefined } = {}) => ({
  date: '2026-07-14',
  board: over.board ?? [],
  ledger: over.ledger ?? [],
  trace: 'trace' in over ? over.trace : { rows: {}, counts: { notCandidate: 0 } },
})
const traceOf = (rows: DayTrace['rows'], notCandidate = 0): DayTrace => ({ rows, counts: { notCandidate } })

describe('GATE_CODE_MIRROR', () => {
  it('carries every code the engine’s own taxonomy declares', () => {
    // The mirror exists because a static import of shared/engine/funnelTrace would
    // not resolve in the pre-Stage-1 baseline worktree this harness still has to
    // load in. A mirror that stops mirroring makes the walk fail on a legitimate
    // new code, so the drift is caught HERE, in the suite, against the source of
    // truth — the same guard SLEEVE_MIRROR carries.
    const src = readFileSync(join(process.cwd(), 'shared', 'engine', 'types.ts'), 'utf8')
    const union = src.slice(src.indexOf('export type GateCode ='))
    const declared = [...union.slice(0, union.indexOf('\n\n')).matchAll(/'([a-z-]+)'/g)].map(m => m[1])
    expect(declared.length).toBeGreaterThan(15) // the extractor found a union, not an empty string
    expect([...GATE_CODE_MIRROR].sort()).toEqual([...declared].sort())
  })
})

describe('expectedCalledGates — the size class the reader can see, read back off the row', () => {
  it('maps every published shape to the code publishCall writes for it', () => {
    expect(expectedCalledGates(row({ grade: 'A', contract: true }))).toEqual(['called-full'])
    expect(expectedCalledGates(row({ grade: 'B', contract: true }))).toEqual(['called-full'])
    // one of conviction/evidence short — a real trade taken smaller
    expect(expectedCalledGates(row({ grade: 'A', contract: false }))).toEqual(['called-half'])
    expect(expectedCalledGates(row({ grade: 'C', contract: true }))).toEqual(['called-half'])
    // the three zero-size populations the fix wave split apart, kept apart
    expect(expectedCalledGates(row({ watchOnly: true }))).toEqual(['called-watch'])
    expect(expectedCalledGates(row({ watchOnly: true, belowBase: true }))).toEqual(['called-below-base'])
    expect(expectedCalledGates(row({ watchOnly: true, observation: true }))).toEqual(['called-observation'])
    // a shadow is either an ordinary one or the one an ISA cannot place
    expect(expectedCalledGates(row({ shadow: true }))).toEqual(['called-shadow', 'route-blocked'])
  })
})

describe('traceViolations — the consistency invariant, per day', () => {
  it('passes a day whose trace and board tell the same story', () => {
    const board = [
      row({ sym: 'AAA', side: 'long', grade: 'A', contract: true }),
      row({ sym: 'BBB', side: 'short', watchOnly: true, riskPct: 0 }),
      row({ sym: 'CCC', side: 'long', nearMiss: true, watchOnly: true, riskPct: 0, grade: 'C' }),
    ]
    const ledger = [
      row({ sym: 'AAA', side: 'long', grade: 'A', contract: true, where: 'ledger' }),
      row({ sym: 'BBB', side: 'short', watchOnly: true, riskPct: 0, where: 'ledger' }),
      row({ sym: 'DDD', side: 'short', shadow: true, riskPct: 0, where: 'ledger' }),
    ]
    const trace = traceOf({
      'AAA:long': { gate: 'called-full', side: 'long' },
      'BBB:short': { gate: 'called-watch', side: 'short' },
      // the near miss carries the gate that refused it — never a called-* code
      'CCC:long': { gate: 'dead-zone-core', side: 'long' },
      'DDD:short': { gate: 'called-shadow', side: 'short' },
      // side-free gates: the name died before there was a side
      EEE: { gate: 'trimmed' },
      FFF: { gate: 'no-candles' },
      // a shadow the budget dropped: in the trace, in neither board nor ledger
      'GGG:long': { gate: 'shadow-capped', side: 'long' },
      // …and a row the slot cut took off the board entirely
      'HHH:long': { gate: 'slot-cut', side: 'long' },
    })
    expect(traceViolations(traceDay({ board, ledger, trace }))).toEqual([])
  })

  it('fails loudly when the day wrote no trace at all', () => {
    expect(traceViolations(traceDay({ trace: undefined }))).toEqual([expect.stringMatching(/no funnel trace/)])
  })

  it('catches a reader row the funnel never recorded', () => {
    const board = [row({ sym: 'AAA', side: 'long' })]
    expect(traceViolations(traceDay({ board, trace: traceOf({}) }))).toEqual([expect.stringMatching(/AAA:long.*no trace row/)])
  })

  it('catches a published row whose trace row still reads as a refusal', () => {
    const board = [row({ sym: 'AAA', side: 'long', grade: 'A', contract: true })]
    const trace = traceOf({ 'AAA:long': { gate: 'dead-zone-core', side: 'long' } })
    expect(traceViolations(traceDay({ board, trace })).join('\n')).toMatch(/AAA:long reads 'dead-zone-core', expected called-full/)
  })

  it('catches the WRONG size class — a sized trade traced as a watch row', () => {
    const board = [row({ sym: 'AAA', side: 'long', grade: 'A', contract: true })]
    const ledger = [row({ sym: 'AAA', side: 'long', grade: 'A', contract: true, where: 'ledger' })]
    const trace = traceOf({ 'AAA:long': { gate: 'called-watch', side: 'long' } })
    expect(traceViolations(traceDay({ board, ledger, trace })).length).toBe(2) // board and ledger both say so
  })

  it('catches a shadow the budget dropped that nonetheless reached the ledger', () => {
    const ledger = [row({ sym: 'AAA', side: 'long', shadow: true, riskPct: 0, where: 'ledger' })]
    const trace = traceOf({ 'AAA:long': { gate: 'shadow-capped', side: 'long' } })
    const v = traceViolations(traceDay({ ledger, trace }))
    expect(v.join('\n')).toMatch(/shadow-capped/)
    expect(v.length).toBeGreaterThan(0)
  })

  it('exempts near-miss board rows from the called-* match — ONE-DIRECTIONAL, by design', () => {
    // A near miss is on the board carrying the gate that refused it. The converse
    // of the invariant ("every board row reads called-*") is false for exactly this
    // population, and asserting it would break the board's own contract.
    const board = [row({ sym: 'CCC', side: 'short', nearMiss: true, watchOnly: true, riskPct: 0 })]
    const trace = traceOf({ 'CCC:short': { gate: 'expected-move', side: 'short' } })
    expect(traceViolations(traceDay({ board, trace }))).toEqual([])
  })

  it('still demands a near miss be traced, and never as a publication', () => {
    const board = [row({ sym: 'CCC', side: 'short', nearMiss: true, watchOnly: true, riskPct: 0 })]
    expect(traceViolations(traceDay({ board, trace: traceOf({}) })).join('\n')).toMatch(/near miss CCC:short has no trace row/)
    const published = traceOf({ 'CCC:short': { gate: 'called-shadow', side: 'short' } })
    expect(traceViolations(traceDay({ board, trace: published })).join('\n')).toMatch(/near miss CCC:short reads 'called-shadow'/)
  })

  it('catches a called-* row the reader never got', () => {
    const trace = traceOf({ 'AAA:long': { gate: 'called-half', side: 'long' } })
    expect(traceViolations(traceDay({ trace })).join('\n')).toMatch(/AAA:long reads 'called-half' and the reader got no such row/)
  })

  it('catches a malformed key, an undeclared gate and a side that disagrees with its key', () => {
    const trace = traceOf({
      'AAA:sideways': { gate: 'trimmed' },
      'BBB:long': { gate: 'nonsense' as unknown as string, side: 'long' },
      'CCC:long': { gate: 'dead-zone-core', side: 'short' },
      'ddd:long': { gate: 'dead-zone-core', side: 'long' },
    })
    const v = traceViolations(traceDay({ trace })).join('\n')
    expect(v).toMatch(/AAA:sideways: not a trace row key/)
    expect(v).toMatch(/'nonsense' is not a declared GateCode/)
    expect(v).toMatch(/CCC:long: row.side=short disagrees/)
    expect(v).toMatch(/ddd:long: symbol is not upper-cased/)
  })

  it('keeps the side-free gates side-free, in both directions', () => {
    const sided = traceOf({ 'AAA:long': { gate: 'trimmed', side: 'long' } })
    expect(traceViolations(traceDay({ trace: sided })).join('\n')).toMatch(/'trimmed' fires before a side exists/)
    const bare = traceOf({ AAA: { gate: 'dead-zone-core' } })
    expect(traceViolations(traceDay({ trace: bare })).join('\n')).toMatch(/'dead-zone-core' names a side's fate/)
  })

  it('refuses a near miss that reached the ledger — board-only is the contract', () => {
    const ledger = [row({ sym: 'CCC', side: 'long', nearMiss: true, where: 'ledger' })]
    const trace = traceOf({ 'CCC:long': { gate: 'dead-zone-core', side: 'long' } })
    expect(traceViolations(traceDay({ ledger, trace })).join('\n')).toMatch(/near miss.*reached the ledger/)
  })
})

describe('the walk carries the trace — and the board never noticed', () => {
  /** A short REAL walk, run twice over one temp candle cache: once with the funnel
   * recorder live, once with `FUNNEL_TRACE=off` stubbing it to a no-op. Same days,
   * same universe, same bars — so any difference in the published board or ledger
   * could only have come from the recorder. */
  it('surfaces every day’s trace, satisfies the invariant, and publishes byte-identical output with the recorder stubbed out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-trace-'))
    const ts = busDays(320)
    const write = (sym: string, candles: Candle[]) =>
      writeFileSync(join(dir, `${sym.replace(/[^A-Za-z0-9]/g, '_')}.json`), JSON.stringify({ sym, range: '5y', at: Date.now(), candles }))
    for (const [i, sym] of CONTEXT_SYMS.entries()) write(sym, tape(ts, 24 + (i % 37) * 9, 0.01 + (i % 9) * 0.008, 6 + (i % 5), i * 0.41))
    write('AAA', tape(ts, 40, 0.22, 9, 0.7))
    write('BBB', tape(ts, 90, -0.06, 8, 2.1))
    const walkSyms = ['AAA', 'BBB', ...SWEEP_SYMS.slice(0, 12)]
    for (const [i, sym] of SWEEP_SYMS.slice(0, 12).entries()) {
      const [drift, swing] = SWEEP_SHAPES[i % SWEEP_SHAPES.length]
      write(sym, tape(ts, 30 + (i % 11) * 7, drift, swing, i * 0.37))
    }
    write('SPY', tape(ts, 480, 0.04, 1.2))
    write('QQQ', tape(ts, 400, 0.05, 1.6))

    const from = iso(ts[320 - 25])
    const to = iso(ts[319])
    const argv = process.argv
    const logged: string[] = []
    const quiet = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
    const tracedPath = join(dir, 'traced.json')
    const stubbedPath = join(dir, 'stubbed.json')
    const runOnce = async (out: string, fresh: { main: () => Promise<void> }) => {
      process.argv = ['node', 'replay-window.ts', '--from', from, '--to', to, '--symbols', walkSyms.join(','), '--out', out]
      await fresh.main()
    }
    try {
      vi.resetModules()
      vi.stubEnv('REPLAY_CACHE_DIR', dir)
      // GATE FEEDBACK OFF IN BOTH ARMS (Stage 3c, gateState.ts). The recorder is
      // the thing under test here, and it is still a pure observer — but what it
      // records now feeds the miss ledger, and the ledger may move a threshold.
      // Over this window it DOES: the dead zone clears the eligibility bar and
      // takes a notch, which changes every later day's board. That is the whole
      // point of 3c and it has its own switch, so the parity claim is made with
      // that switch off and remains a claim about the RECORDER.
      vi.stubEnv('GATES', 'off')
      const fresh = (await import('./replay-window')) as typeof import('./replay-window')
      // 1) the recorder live — the walk asserts the invariant itself, day by day,
      //    and throws if it is ever false. Reaching the next line IS that assertion.
      await runOnce(tracedPath, fresh)
      // 2) the same walk with the recorder stubbed to a no-op
      vi.stubEnv('FUNNEL_TRACE', 'off')
      await runOnce(stubbedPath, fresh)
    } finally {
      quiet.mockRestore()
      vi.unstubAllEnvs()
      process.argv = argv
    }

    const traced = JSON.parse(readFileSync(tracedPath, 'utf8')) as RunFile
    const stubbed = JSON.parse(readFileSync(stubbedPath, 'utf8')) as RunFile

    // the invariant was ARMED in run 1 — the walk checked every day itself and
    // reaching this point means it never had cause to stop — and deliberately
    // disarmed in run 2, where the trace is empty by construction
    expect(logged).toContain('funnel trace: present — the walk enforces the consistency invariant daily')
    expect(logged).toContain('funnel trace: STUBBED (FUNNEL_TRACE=off) — parity run, invariant not checked')

    // the walk actually walked, and actually published
    expect(traced.days.length).toBeGreaterThan(10)
    expect(traced.days.some(d => d.board.length > 0)).toBe(true)
    expect(traced.days.some(d => d.ledger.length > 0)).toBe(true)

    // every day carries its trace, and every day's trace is consistent with the
    // rows the reader got — the same function the walk ran inline
    for (const d of traced.days) {
      expect(d.trace, `${d.date} carries no trace`).toBeTruthy()
      expect(Object.keys(d.trace!.rows).length, `${d.date} traced nothing`).toBeGreaterThan(0)
      expect(traceViolations(d), `${d.date}`).toEqual([])
    }

    // PARITY: board and ledger are byte-identical with the recorder stubbed out.
    const published = (r: RunFile) => JSON.stringify(r.days.map(d => ({ date: d.date, regime: d.regime, shape: d.shape, board: d.board, ledger: d.ledger })))
    expect(published(stubbed)).toBe(published(traced))

    // …and the instrument is not vacuous: with the recorder stubbed the trace is
    // empty, and the very same invariant then FAILS on a day that published rows.
    expect(stubbed.days.every(d => Object.keys(d.trace?.rows ?? {}).length === 0)).toBe(true)
    const publishedDay = stubbed.days.find(d => d.board.some(r => !r.nearMiss) || d.ledger.length > 0)!
    expect(traceViolations(publishedDay).length).toBeGreaterThan(0)
  }, 180_000)
})

// ================= STAGE-3b TASK 4: THE WALK MEASURES ITS OWN REGRET =================
// Both mechanisms already RUN in the walk — `gradeOutstanding` is the engine's own
// daily pass — so what is proved here is that the walk SEES them and that what it
// sees is coherent. Four pure instruments, each driven by hand-built violations so
// the instrument itself is never vacuous, plus the real walk at the bottom.

const missLedgerOf = (over: Partial<MissLedgerLike> = {}): MissLedgerLike => ({ gates: {}, days: {}, ...over })
const gateStat = (over: Partial<MissGateStatLike> = {}): MissGateStatLike => ({ cost: 0, costExcessSum: 0, saved: 0, savedExcessSum: 0, unchecked: 0, examples: [], ...over })
/** A one-day context: one walked date whose trace holds two refusals and one
 * sized publication, which is the smallest shape every check below needs. */
const regretCtx = (over: Partial<RegretContext> = {}): RegretContext => ({
  dates: ['2026-07-14'],
  traces: {
    '2026-07-14': traceOf({
      'AAA:long': { gate: 'dead-zone-core', side: 'long' },
      BBB: { gate: 'trimmed' },
      'CCC:long': { gate: 'called-half', side: 'long' },
    }),
  },
  sized: { '2026-07-14': new Set(['CCC:long']) },
  ...over,
})
/** A clean ledger for `regretCtx()`: the day's two candidates both priced, one of
 * them a cost booked against the gate that refused it. */
const cleanLedger = (): MissLedgerLike =>
  missLedgerOf({
    gates: { 'dead-zone-core': gateStat({ cost: 1, costExcessSum: 8.4, examples: [{ date: '2026-07-14', sym: 'AAA', side: 'long', excessPct: 8.4, gate: 'dead-zone-core' }] }) },
    days: { '2026-07-14': { checked: 2, unchecked: 0, misses: 1 } },
  })

describe('MISS_SKIP_GATE_MIRROR / POSTMORTEM_CLASS_MIRROR — the drift guards', () => {
  // Same argument as GATE_CODE_MIRROR: a static import of a Stage-3b module would
  // not resolve in the pre-Stage-1 baseline worktree, so the constants are copied
  // and the copy is checked here against the modules' own source.
  it('carries exactly the gates missLedger.ts refuses to charge, and its bar', () => {
    const src = readFileSync(join(process.cwd(), 'shared', 'engine', 'missLedger.ts'), 'utf8')
    const line = src.slice(src.indexOf('export const MISS_SKIP_GATES'))
    const declared = [...line.slice(0, line.indexOf('\n')).matchAll(/'([a-z-]+)'/g)].map(m => m[1])
    expect(declared.length).toBeGreaterThan(3)
    expect([...MISS_SKIP_GATE_MIRROR].sort()).toEqual([...declared].sort())
    expect(src).toContain(`export const MISS_EXCESS_MIN = ${MISS_EXCESS_MIN_MIRROR}`)
    expect(src).toContain(`export const MISS_LEDGER_KEY = '${MISS_LEDGER_KEY_MIRROR}'`)
    expect(src).toContain(`export const MISS_LEDGER_DAYS_MAX = ${MISS_LEDGER_DAYS_MAX_MIRROR}`)
  })
  it('carries the gate-state key the artefact reads the moved gates out of', () => {
    const src = readFileSync(join(process.cwd(), 'shared', 'engine', 'gateState.ts'), 'utf8')
    expect(src).toContain(`export const GATE_STATE_KEY = '${GATE_STATE_KEY_MIRROR}'`)
  })
  it('carries every post-mortem class the engine declares, in precedence order', () => {
    const src = readFileSync(join(process.cwd(), 'shared', 'engine', 'postMortem.ts'), 'utf8')
    const line = src.slice(src.indexOf('export const POSTMORTEM_CLASSES'))
    const declared = [...line.slice(0, line.indexOf('\n')).matchAll(/'([a-z-]+)'/g)].map(m => m[1])
    expect(declared.length).toBe(5)
    expect([...POSTMORTEM_CLASS_MIRROR]).toEqual(declared) // ORDER too — it is the precedence
  })
})

describe('missLedgerViolations — what the ledger may never say', () => {
  it('passes a ledger that priced the day it claims to have priced', () => {
    expect(missLedgerViolations(cleanLedger(), regretCtx())).toEqual([])
  })
  it('is silent before anything has matured — an empty ledger is not a violation', () => {
    expect(missLedgerViolations(null, regretCtx())).toEqual([])
    expect(missLedgerViolations(missLedgerOf(), regretCtx())).toEqual([])
  })
  it('CATCHES A SIZED PUBLICATION CHARGED AS A MISS — the invariant this task exists for', () => {
    const l = cleanLedger()
    l.gates['called-half'] = gateStat({ cost: 1, costExcessSum: 9, examples: [{ date: '2026-07-14', sym: 'CCC', side: 'long', excessPct: 9, gate: 'called-half' }] })
    expect(missLedgerViolations(l, regretCtx()).join('\n')).toMatch(/called-half/)
  })
  it('catches a miss whose (date, sym, side) the reader actually had a size on', () => {
    // the gate reads as an ordinary refusal, so only the published-row cross-check
    // can catch it: the trace and the board disagree about what the reader got
    const l = cleanLedger()
    l.gates['dead-zone-core']!.examples = [{ date: '2026-07-14', sym: 'CCC', side: 'long', excessPct: 9, gate: 'dead-zone-core' }]
    expect(missLedgerViolations(l, regretCtx()).join('\n')).toMatch(/CCC:long.*reader/i)
  })
  it('catches an example the trace never refused, or refused under another gate', () => {
    const l = cleanLedger()
    l.gates['dead-zone-core']!.examples = [{ date: '2026-07-14', sym: 'ZZZ', side: 'long', excessPct: 9, gate: 'dead-zone-core' }]
    expect(missLedgerViolations(l, regretCtx()).join('\n')).toMatch(/ZZZ:long/)
    const l2 = cleanLedger()
    l2.gates['dead-zone-core']!.examples = [{ date: '2026-07-14', sym: 'BBB', side: 'long', excessPct: 9, gate: 'dead-zone-core' }]
    expect(missLedgerViolations(l2, regretCtx()).join('\n')).toMatch(/BBB/)
  })
  it('accepts a BARE row charged both ways — one cost and one mirror save, same gate', () => {
    const l = missLedgerOf({
      gates: {
        trimmed: gateStat({
          cost: 1,
          costExcessSum: 7,
          saved: 1,
          savedExcessSum: -7,
          examples: [
            { date: '2026-07-14', sym: 'BBB', side: 'long', excessPct: 7, gate: 'trimmed', bare: true },
            { date: '2026-07-14', sym: 'BBB', side: 'short', excessPct: -7, gate: 'trimmed', bare: true },
          ],
        }),
      },
      days: { '2026-07-14': { checked: 2, unchecked: 0, misses: 1 } },
    })
    expect(missLedgerViolations(l, regretCtx())).toEqual([])
  })
  it('catches a charge inside the ±5pp bar — the miss bar is not the hit bar', () => {
    const l = cleanLedger()
    l.gates['dead-zone-core']!.examples = [{ date: '2026-07-14', sym: 'AAA', side: 'long', excessPct: 4.9, gate: 'dead-zone-core' }]
    expect(missLedgerViolations(l, regretCtx()).join('\n')).toMatch(/4\.9/)
  })
  it('catches a day the walk never walked, and a GAP in the days it did', () => {
    const ctx = regretCtx({ dates: ['2026-07-14', '2026-07-15', '2026-07-16'], traces: { ...regretCtx().traces }, sized: { ...regretCtx().sized } })
    const stray = missLedgerOf({ days: { '2026-06-01': { checked: 0, unchecked: 0, misses: 0 } } })
    expect(missLedgerViolations(stray, ctx).join('\n')).toMatch(/2026-06-01/)
    const gapped = missLedgerOf({ days: { '2026-07-14': { checked: 2, unchecked: 0, misses: 0 }, '2026-07-16': { checked: 0, unchecked: 0, misses: 0 } } })
    expect(missLedgerViolations(gapped, ctx).join('\n')).toMatch(/2026-07-15/)
  })
  it('catches a population that vanished — checked + unchecked must equal the day’s candidates', () => {
    const l = cleanLedger()
    l.days['2026-07-14'] = { checked: 1, unchecked: 0, misses: 1 } // one candidate silently dropped
    expect(missLedgerViolations(l, regretCtx()).join('\n')).toMatch(/checked 1 \+ unchecked 0/)
  })
  it('catches per-gate columns that disagree with the day totals', () => {
    const unmatched = missLedgerOf({
      gates: { 'dead-zone-core': gateStat({ unchecked: 1 }) },
      days: { '2026-07-14': { checked: 2, unchecked: 0, misses: 0 } },
    })
    expect(missLedgerViolations(unmatched, regretCtx()).join('\n')).toMatch(/unchecked/)
    const miscounted = cleanLedger()
    miscounted.days['2026-07-14'] = { checked: 2, unchecked: 0, misses: 2 }
    expect(missLedgerViolations(miscounted, regretCtx()).join('\n')).toMatch(/cost/)
  })
})

describe('missAccrualViolations — one day per pass, and never twice', () => {
  it('accepts exactly one new day', () => {
    const prev = cleanLedger()
    const next = missLedgerOf({ gates: prev.gates, days: { ...prev.days, '2026-07-15': { checked: 3, unchecked: 1, misses: 0 } } })
    expect(missAccrualViolations(prev, next)).toEqual([])
    expect(missAccrualViolations(null, cleanLedger())).toEqual([])
  })
  it('catches a day that was RE-ACCRUED — the blob is additive, so twice is double-charged', () => {
    const prev = cleanLedger()
    const next = JSON.parse(JSON.stringify(prev)) as MissLedgerLike
    next.days['2026-07-14'] = { checked: 2, unchecked: 0, misses: 2 }
    expect(missAccrualViolations(prev, next).join('\n')).toMatch(/2026-07-14/)
  })
  it('allows the 60-day PRUNE to drop the oldest, and nothing else', () => {
    // recordMissDay drops the oldest once the window is full — the prune is what
    // makes "newest matured day, one per pass" safe, so it must not read as a
    // measured day being unmeasured. Anything younger than the retained window
    // still must not vanish.
    const full = (n: number, from = 0) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-${String(1 + Math.floor((from + i) / 28)).padStart(2, '0')}-${String(((from + i) % 28) + 1).padStart(2, '0')}`, { checked: 1, unchecked: 0, misses: 0 }]))
    const prev = missLedgerOf({ days: full(MISS_LEDGER_DAYS_MAX_MIRROR) })
    const pruned = missLedgerOf({ days: { ...full(MISS_LEDGER_DAYS_MAX_MIRROR - 1, 1), '2026-12-31': { checked: 1, unchecked: 0, misses: 0 } } })
    expect(missAccrualViolations(prev, pruned)).toEqual([])
    // …but the SAME shortfall without a full window is a day that simply went missing
    const short = missLedgerOf({ days: full(10) })
    const lost = missLedgerOf({ days: full(9, 1) })
    expect(missAccrualViolations(short, lost).join('\n')).toMatch(/disappeared/)
  })
  it('catches a day that disappeared, and two days accrued in one pass', () => {
    const prev = cleanLedger()
    expect(missAccrualViolations(prev, missLedgerOf()).join('\n')).toMatch(/2026-07-14/)
    const two = missLedgerOf({ days: { ...prev.days, '2026-07-15': { checked: 1, unchecked: 0, misses: 0 }, '2026-07-16': { checked: 1, unchecked: 0, misses: 0 } } })
    expect(missAccrualViolations(prev, two).join('\n')).toMatch(/two|2 new/i)
  })
})

describe('postMortemViolations — every graded loser explains itself', () => {
  const graded = (over: Partial<Keyed> = {}, o: { hit: boolean; stopped: boolean; excessPct: number } | null = { hit: false, stopped: true, excessPct: -6 }, pm?: PostMortemLike | null) => ({
    ...row(over),
    storedOutcome10: o,
    ...(pm === undefined ? {} : { postMortem: pm }),
  })
  const pm = (over: Partial<PostMortemLike> = {}): PostMortemLike => ({ cls: 'stopped', detail: 'closed through the 9 stop', at: 1_700_000_000, ...over })
  const dayOf = (ledger: ReturnType<typeof graded>[]) => [{ date: '2026-07-14', board: [], ledger: ledger as unknown as Keyed[] }]

  it('passes a graded loser that carries a class and a winner that carries none', () => {
    expect(postMortemViolations(dayOf([graded({ sym: 'AAA' }, { hit: false, stopped: true, excessPct: -6 }, pm()), graded({ sym: 'BBB' }, { hit: true, stopped: false, excessPct: 4 }, null)]))).toEqual([])
  })
  it('CATCHES A GRADED LOSER WITH NO POST-MORTEM', () => {
    expect(postMortemViolations(dayOf([graded({ sym: 'AAA' }, { hit: false, stopped: true, excessPct: -6 }, null)])).join('\n')).toMatch(/AAA:long/)
  })
  it('catches an undeclared class and an empty detail', () => {
    expect(postMortemViolations(dayOf([graded({}, { hit: false, stopped: false, excessPct: -6 }, pm({ cls: 'vibes' }))])).join('\n')).toMatch(/vibes/)
    expect(postMortemViolations(dayOf([graded({}, { hit: false, stopped: false, excessPct: -6 }, pm({ detail: '' }))])).join('\n')).toMatch(/detail/)
    expect(postMortemViolations(dayOf([graded({}, { hit: false, stopped: false, excessPct: -6 }, pm({ at: 0 }))])).join('\n')).toMatch(/at/)
  })
  it('catches a WINNER carrying a post-mortem, and one on a row the engine never graded', () => {
    expect(postMortemViolations(dayOf([graded({}, { hit: true, stopped: false, excessPct: 9 }, pm())])).join('\n')).toMatch(/won/)
    expect(postMortemViolations(dayOf([graded({}, null, pm())])).join('\n')).toMatch(/never graded/)
  })
  it('ignores rows the walk could not read back at all (a pre-Stage-3b tree)', () => {
    expect(postMortemViolations([{ date: '2026-07-14', board: [], ledger: [row()] }])).toEqual([])
  })
})

describe('precedenceViolations — the pinned total order, re-derived from the tape', () => {
  // driven by the REAL classifier: a spot-check that used a copy of the rules
  // would only prove the copy agrees with itself.
  const tape = (closes: number[]) => series(closes, '2026-07-14')
  const sample = (over: Partial<PrecedenceSample> = {}): PrecedenceSample => ({
    key: '2026-07-14:AAA:long',
    row: { side: 'long', date: '2026-07-14', stop: 9 },
    outcome: { hit: false, stopped: true, excessPct: -8, rawPct: -10, spyPct: -2 },
    postMortem: { cls: 'stopped', detail: '', at: 1 },
    candles: tape([10, 9.5, 8.9, 9, 9, 9, 9, 9, 9, 9, 9, 9]),
    ...over,
  })
  const withReal = (s: PrecedenceSample) => {
    const truth = classifyLoser(s.row, s.outcome as never, s.candles)
    return { ...s, postMortem: { ...s.postMortem, ...truth } }
  }

  it('passes a row whose stored class and detail are exactly what the tape says', () => {
    expect(precedenceViolations([withReal(sample())], classifyLoser as never)).toEqual([])
  })
  it('catches a stored class the tape contradicts, naming both', () => {
    const s = withReal(sample())
    const v = precedenceViolations([{ ...s, postMortem: { ...s.postMortem, cls: 'market-drag' } }], classifyLoser as never)
    expect(v.join('\n')).toMatch(/market-drag/)
    expect(v.join('\n')).toMatch(/stopped/)
  })
  it('catches a detail that drifted from the class it claims', () => {
    const s = withReal(sample())
    expect(precedenceViolations([{ ...s, postMortem: { ...s.postMortem, detail: 'it went down a bit' } }], classifyLoser as never).join('\n')).toMatch(/detail/)
  })
  it('compares an LLM upgrade against the class it replaced — the ONE legal difference', () => {
    const s = withReal(sample())
    const upgraded = { ...s, postMortem: { ...s.postMortem, cls: 'news-reversal', clsBefore: s.postMortem.cls, detail: 'catalyst tone flipped · the deterministic read was …' } }
    expect(precedenceViolations([upgraded], classifyLoser as never)).toEqual([])
    const { clsBefore: _drop, ...noBefore } = upgraded.postMortem
    expect(precedenceViolations([{ ...upgraded, postMortem: noBefore }], classifyLoser as never).join('\n')).toMatch(/news-reversal/)
  })
  it('reports a classifier that throws instead of taking the walk down', () => {
    expect(
      precedenceViolations([sample()], () => {
        throw new Error('no tape')
      }).join('\n'),
    ).toMatch(/no tape/)
  })
})

describe('the walk measures regret — and the board still never noticed', () => {
  /** The 3a parity mechanism, EXTENDED. The same fixture window walked twice off
   * one temp candle cache: once with Stage 3b's two mechanisms live, once with
   * `REGRET=off`, which makes the engine behave exactly as the pre-3b tree did.
   * Same days, same universe, same bars — so any difference in what the reader
   * gets could only have come from the regret machinery.
   *
   * The comparison is over PUBLISHED FIELDS. `postMortem` is additive on a ledger
   * row and `storedOutcome10` is the harness reading the engine's grade back, so
   * both are stripped BY NAME — and the strip is not a loophole, because the test
   * separately asserts that those two are the ONLY keys the active run's rows
   * carry that the stubbed run's do not. */
  it('accrues the ledger, explains every loser, and publishes byte-identical output with the machinery off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-regret-'))
    const ts = busDays(320)
    const write = (sym: string, candles: Candle[]) =>
      writeFileSync(join(dir, `${sym.replace(/[^A-Za-z0-9]/g, '_')}.json`), JSON.stringify({ sym, range: '5y', at: Date.now(), candles }))
    for (const [i, sym] of CONTEXT_SYMS.entries()) write(sym, tape(ts, 24 + (i % 37) * 9, 0.01 + (i % 9) * 0.008, 6 + (i % 5), i * 0.41))
    write('AAA', tape(ts, 40, 0.22, 9, 0.7))
    write('BBB', tape(ts, 90, -0.06, 8, 2.1))
    const walkSyms = ['AAA', 'BBB', ...SWEEP_SYMS.slice(0, 12)]
    for (const [i, sym] of SWEEP_SYMS.slice(0, 12).entries()) {
      const [drift, swing] = SWEEP_SHAPES[i % SWEEP_SHAPES.length]
      write(sym, tape(ts, 30 + (i % 11) * 7, drift, swing, i * 0.37))
    }
    write('SPY', tape(ts, 480, 0.04, 1.2))
    write('QQQ', tape(ts, 400, 0.05, 1.6))

    const from = iso(ts[320 - 30])
    const to = iso(ts[319])
    const argv = process.argv
    const logged: string[] = []
    const quiet = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
    const livePath = join(dir, 'live.json')
    const offPath = join(dir, 'off.json')
    try {
      vi.resetModules()
      vi.stubEnv('REPLAY_CACHE_DIR', dir)
      // …and gate feedback off in BOTH arms, for the reason given in the trace
      // parity test above: 3c's gate move is a published change BY DESIGN and is
      // downstream of exactly the machinery this test switches off, so leaving it
      // armed would turn a claim about the regret machinery into a claim about
      // the gates. (`gateStateFinal` in the artefact is null under this flag.)
      vi.stubEnv('GATES', 'off')
      const fresh = (await import('./replay-window')) as typeof import('./replay-window')
      const runOnce = async (out: string) => {
        process.argv = ['node', 'replay-window.ts', '--from', from, '--to', to, '--symbols', walkSyms.join(','), '--out', out]
        await fresh.main()
      }
      // 1) the machinery live — the walk asserts its own invariants every morning
      //    and at the end, and throws if any of them is ever false. Reaching the
      //    next line IS that assertion, over every day of the window.
      await runOnce(livePath)
      // 2) the same walk with the engine's regret seam switched off
      vi.stubEnv('REGRET', 'off')
      await runOnce(offPath)
    } finally {
      quiet.mockRestore()
      vi.unstubAllEnvs()
      process.argv = argv
    }

    const live = JSON.parse(readFileSync(livePath, 'utf8')) as RunFile
    const off = JSON.parse(readFileSync(offPath, 'utf8')) as RunFile

    // ARMED in run 1, deliberately absent in run 2
    expect(logged).toContain('regret: present — the walk drives the miss ledger and the post-mortems, and enforces their invariants')
    expect(logged).toContain('regret: STUBBED (REGRET=off) — parity run, no miss ledger and no post-mortems')

    // THE LEDGER ACCRUED, one matured day per pass and never the same day twice
    const led = live.missLedgerFinal!
    expect(led, 'the window measured no regret at all').toBeTruthy()
    const measured = Object.keys(led.days).sort()
    expect(measured.length).toBeGreaterThan(0)
    expect(measured).toEqual(live.days.map(d => d.date).slice(0, measured.length))
    for (const d of measured) expect(led.days[d].checked + led.days[d].unchecked).toBe(missCandidateCount(live.days.find(x => x.date === d)!.trace))
    // the per-day surfacing walks forward with it — one accrual per pass, in order
    const accrued = live.days.map(d => d.missAccrued?.date ?? null).filter((d): d is string => !!d)
    expect(accrued).toEqual(measured)
    // …and no gate that PUBLISHED a row was ever charged
    for (const g of Object.keys(led.gates)) expect(MISS_SKIP_GATE_MIRROR.has(g), `${g} was charged`).toBe(false)

    // EVERY GRADED LOSER EXPLAINS ITSELF — total coverage, plus the re-derivation
    const census = live.postMortemCensus!
    expect(census.losers).toBeGreaterThan(0)
    expect(census.classified).toBe(census.losers)
    expect(census.sampled).toBeGreaterThan(0)
    expect(census.sentences).toBe(0) // the walk carries no LLM dep, by construction
    expect(Object.keys(census.byClass).every(c => POSTMORTEM_CLASS_MIRROR.includes(c))).toBe(true)
    expect(census.byClass['news-reversal']).toBeUndefined() // unreachable without the LLM pass
    expect(postMortemViolations(live.days)).toEqual([])
    expect(live.days.flatMap(d => d.ledger).some(r => r.postMortem)).toBe(true)

    // …and with the seam off the engine wrote NEITHER — the pre-3b tree exactly
    expect(off.missLedgerFinal ?? null).toBeNull()
    expect(off.postMortemCensus ?? null).toBeNull()
    expect(off.days.flatMap(d => [...d.board, ...d.ledger]).some(r => r.postMortem)).toBe(false)
    expect(off.days.every(d => (d.missAccrued ?? null) === null)).toBe(true)

    // PARITY: the two new fields are the ONLY things the rows gained…
    const added = new Set<string>()
    for (const [i, d] of live.days.entries())
      for (const [j, r] of [...d.board, ...d.ledger].entries()) {
        const mirror = [...off.days[i].board, ...off.days[i].ledger][j]
        for (const k of Object.keys(r)) if (!(k in mirror)) added.add(k)
      }
    expect([...added].sort()).toEqual(['postMortem', 'storedOutcome10'])
    // …and once they are stripped, every published field is byte-identical
    const strip = ({ postMortem: _p, storedOutcome10: _s, ...rest }: RunFile['days'][number]['board'][number]) => rest
    const published = (r: RunFile) =>
      JSON.stringify(r.days.map(d => ({ date: d.date, regime: d.regime, rosterSize: d.rosterSize, baseRate: d.baseRate, shape: d.shape, board: d.board.map(strip), ledger: d.ledger.map(strip) })))
    expect(published(off)).toBe(published(live))
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
