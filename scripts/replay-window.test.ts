import { describe, expect, it } from 'vitest'
import { DEFAULT_CORE_SLEEVE } from '../shared/engine/coreSleeve'
import { classifyVelocity, effectiveVelocityStop, MIN_RISK_FRAC } from '../shared/engine/velocityLane'
import {
  MIRROR_EXTRAS,
  PROD_GAINERS_DEPTH,
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
