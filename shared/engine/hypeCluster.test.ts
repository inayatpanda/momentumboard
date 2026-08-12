import { describe, expect, it } from 'vitest'
import { clusterCandidates, detectClusters, type TrendDay } from './hypeCluster'
import { pearson } from './types'
import type { Candle } from '../types'

const DAY = 86_400
const T0 = Date.parse('2026-07-01T00:00:00Z') / 1000
const dayKey = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)

// A tape built from the returns we want to correlate. Bar 0 sits on day `from`,
// and `rets[k]` is the return INTO bar k+1 — so a return is stamped with the date
// of its LATER bar, which is exactly how detectClusters keys them. Every planted
// correlation below is therefore a correlation over real, dated observations.
const tape = (rets: number[], from = 0, start = 100): Candle[] => {
  const bars: Candle[] = []
  let c = start
  for (let i = 0; i <= rets.length; i++) {
    if (i > 0) c *= 1 + rets[i - 1]
    bars.push({ t: T0 + (from + i) * DAY, o: c, h: c, l: c, c, v: 1_000_000 })
  }
  return bars
}

// SPY: 25 flat bars (days 0-24), so every planted return has a same-DATE index
// return to subtract and excess === raw. The vs-SPY subtraction gets its own test
// at the bottom, where the index actually moves and the raw agreement is a lie.
// The index tape is also the CLOCK: its newest session (day 24 — the last day the
// tapes below print) is "now", and every co-move sample has to reach it.
const SPY = tape(new Array(24).fill(0))

// The same tape on a real market calendar: bars on successive weekdays with one
// Monday holiday dropped, so the series carries three-day Friday→Monday gaps and
// one four-day Friday→Tuesday gap — the routine breaks the gap guard must NOT read
// as missing bars. T0 is a Wednesday, so offset 5 is the following Monday.
const HOLIDAY_OFFSET = 5
const sessionOffsets = (n: number): number[] => {
  const out: number[] = []
  for (let i = 0; out.length < n; i++) {
    const w = new Date((T0 + i * DAY) * 1000).getUTCDay()
    if (w >= 1 && w <= 5 && i !== HOLIDAY_OFFSET) out.push(i)
  }
  return out
}
const sessionTape = (rets: number[], start = 100): Candle[] => {
  let c = start
  return sessionOffsets(rets.length + 1).map((off, i) => {
    if (i > 0) c *= 1 + rets[i - 1]
    return { t: T0 + off * DAY, o: c, h: c, l: c, c, v: 1_000_000 }
  })
}
const dayIndexOf = (c: Candle) => Math.round((c.t - T0) / DAY)

const N = 24
const ix = Array.from({ length: N }, (_, i) => i)
const base = ix.map(i => 0.02 * Math.sin(i * 0.7))
// Three names that genuinely move together (r over the last 20: AB .966, AC .990,
// BC .953) and one that does not (D vs each of them ≈ −0.04).
const RA = base
const RB = ix.map(i => 0.9 * base[i] + 0.004 * Math.cos(i * 3.1))
const RC = ix.map(i => 1.1 * base[i] - 0.003 * Math.sin(i * 2.3 + 1))
const RD = ix.map(i => 0.02 * Math.cos(i * 1.9))

const trio = (): Map<string, Candle[]> =>
  new Map([
    ['AAA', tape(RA)],
    ['BBB', tape(RB)],
    ['CCC', tape(RC)],
  ])
const quartet = (): Map<string, Candle[]> => trio().set('DDD', tape(RD))

// `days` runs oldest→newest and ENDS on day 24 — the last session the tapes above
// print, so the trending record and the tape live in the same fortnight.
const history = (days: string[][]): TrendDay[] => days.map((syms, i) => ({ date: dayKey(24 - days.length + 1 + i), syms }))
const repeat = (n: number, syms: string[]) => Array.from({ length: n }, () => syms)
const ABC = ['AAA', 'BBB', 'CCC']

describe('detectClusters — warm-up', () => {
  it('says nothing at all under seven recorded days, and the seventh is all that was missing', () => {
    expect(detectClusters(history(repeat(6, ABC)), trio(), SPY)).toEqual([])
    expect(detectClusters(history(repeat(7, ABC)), trio(), SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })
})

describe('detectClusters — the two legs', () => {
  it('finds a genuine three-name cluster: co-appearing days AND correlated excess tapes', () => {
    expect(detectClusters(history(repeat(8, ABC)), trio(), SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('drops the name that only co-appears — an uncorrelated tape is not a cluster member', () => {
    const hist = history(repeat(8, [...ABC, 'DDD'])) // DDD trends every single day with them
    expect(detectClusters(hist, quartet(), SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('needs fifteen truly overlapping observations — fourteen correlated sessions buy nothing', () => {
    // Both fixtures END on day 24, the index's newest session, so the ONLY thing
    // separating them is the length of the sample (the freshness bound has its own
    // tests below and must not be what decides these two).
    const short = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(-14), 10)], // 15 bars, days 10-24 → 14 dated returns
      ['BBB', tape(RB.slice(-14), 10)],
      ['CCC', tape(RC.slice(-14), 10)],
    ])
    // the correlations are all still there (AB .970, AC .990, BC .961) — only the
    // sample is short, and a short sample is not evidence
    expect(detectClusters(history(repeat(8, ABC)), short, SPY)).toEqual([])

    const justEnough = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(-15), 9)], // 16 bars, days 9-24 → 15 dated returns
      ['BBB', tape(RB.slice(-15), 9)],
      ['CCC', tape(RC.slice(-15), 9)],
    ])
    expect(detectClusters(history(repeat(8, ABC)), justEnough, SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('counts OVERLAPPING sessions, not positions: two tapes on different dates never pair up', () => {
    // AAA and CCC print days 4-24; BBB prints the SAME twenty returns ten days later.
    // Tail-position pairing would hand BBB twenty pairs at r .959 and call it a
    // cluster member; dated pairing finds ten shared dates and refuses the edge.
    // (AAA and CCC still reach day 24, so freshness is not what refuses it.)
    expect(pearson(RA.slice(0, 20), RB.slice(0, 20))!).toBeGreaterThan(0.9)
    const shifted = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(0, 20), 4)],
      ['BBB', tape(RB.slice(0, 20), 14)],
      ['CCC', tape(RC.slice(0, 20), 4)],
    ])
    expect(detectClusters(history(repeat(8, ABC)), shifted, SPY)).toEqual([])
    // and unshifted, the very same three series are the cluster
    const aligned = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(0, 20), 4)],
      ['BBB', tape(RB.slice(0, 20), 4)],
      ['CCC', tape(RC.slice(0, 20), 4)],
    ])
    expect(detectClusters(history(repeat(8, ABC)), aligned, SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('correlates EXCESS returns: three names that only agreed because the index moved are not a cluster', () => {
    const RS = ix.map(i => 0.03 * Math.sin(i * 0.5)) // the index does the moving
    const nA = ix.map(i => 0.01 * Math.cos(i * 2.7)) // and each name's own move is
    const nB = ix.map(i => 0.01 * Math.sin(i * 3.3 + 0.5)) // unrelated to the others
    const nC = ix.map(i => 0.01 * Math.cos(i * 1.3 + 2))
    const raw = (n: number[]) => ix.map(i => RS[i] + n[i])
    const rawA = raw(nA)
    const rawB = raw(nB)
    const tapes = new Map<string, Candle[]>([
      ['AAA', tape(rawA)],
      ['BBB', tape(rawB)],
      ['CCC', tape(raw(nC))],
    ])
    // raw returns agree strongly — this fixture is NOT vacuous
    expect(pearson(rawA.slice(-20), rawB.slice(-20))!).toBeGreaterThan(0.85)
    const hist = history(repeat(8, ABC))
    expect(detectClusters(hist, tapes, tape(RS))).toEqual([])
    // the proof: hand the SAME three tapes a flat index and the raw agreement,
    // now unexplained by beta, is the cluster
    expect(detectClusters(hist, tapes, SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('a name with no tape can never form an edge, and no index means no verdict', () => {
    const noC = new Map<string, Candle[]>([
      ['AAA', tape(RA)],
      ['BBB', tape(RB)],
    ])
    expect(detectClusters(history(repeat(8, ABC)), noC, SPY)).toEqual([])
    expect(detectClusters(history(repeat(8, ABC)), trio(), [])).toEqual([])
  })
})

describe('detectClusters — the sample has to be FRESH', () => {
  // The index tape spans May to today (day 24), so an OLD session still has an index
  // return to subtract — the stale samples below are refused for being stale, not for
  // being unpriced.
  const LONG_SPY = tape(new Array(79).fill(0), -55) // 80 flat bars, days -55 to 24
  const endingOn = (lastDay: number): Map<string, Candle[]> =>
    new Map([
      ['AAA', tape(RA, lastDay - N)],
      ['BBB', tape(RB, lastDay - N)],
      ['CCC', tape(RC, lastDay - N)],
    ])

  it('refuses a cluster whose tapes stopped printing two months before the trending week', () => {
    // Twenty overlapping sessions, r .966 — and every one of them from June. The
    // crowd is naming these three names THIS week; a correlation measured in a
    // different market is not the tape agreeing with the crowd, it is two unrelated
    // facts stapled together.
    expect(detectClusters(history(repeat(8, ABC)), endingOn(-16), LONG_SPY)).toEqual([])
    // the same fixture flipped: the identical returns, moved onto the current
    // fortnight, ARE the cluster — so staleness is the only thing that refused it
    expect(detectClusters(history(repeat(8, ABC)), endingOn(24), LONG_SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('allows five sessions of lag and not a sixth — a name can be quiet, not absent', () => {
    // day 19: sessions 20, 21, 22, 23, 24 have printed since — five, the bound
    expect(detectClusters(history(repeat(8, ABC)), endingOn(19), LONG_SPY)).toEqual([['AAA', 'BBB', 'CCC']])
    // day 18: six sessions behind the index, and no longer this week's tape
    expect(detectClusters(history(repeat(8, ABC)), endingOn(18), LONG_SPY)).toEqual([])
  })
})

describe('detectClusters — one honest return per session', () => {
  it('drops the compounded return a name emits after going dark, and the edge goes with it', () => {
    // AAA prints from day 5, goes dark for days 10-13, and prints again on day 14.
    // That day-14 bar carries FIVE calendar days of move; keyed to one date it gets
    // weighed against SPY's ONE-day return, and it counts toward the fifteen.
    const gappy = new Map<string, Candle[]>([
      ['AAA', tape(RA).filter(c => dayIndexOf(c) >= 5 && (dayIndexOf(c) < 10 || dayIndexOf(c) > 13))],
      ['BBB', tape(RB)],
      ['CCC', tape(RC)],
    ])
    // counted, the bogus session is AAA's FIFTEENTH observation and the correlations
    // still clear the bar (AB .710, AC .792) — this fixture was a cluster until the
    // guard dropped that one observation and left fourteen
    expect(detectClusters(history(repeat(8, ABC)), gappy, SPY)).toEqual([])
    // and the honest fourteen are not short by accident: hand AAA the four missing
    // bars back and the very same three tapes are the cluster
    const whole = new Map(gappy).set('AAA', tape(RA).filter(c => dayIndexOf(c) >= 5))
    expect(detectClusters(history(repeat(8, ABC)), whole, SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('keeps the weekend and the holiday: a Friday-to-Tuesday return is a session, not a gap', () => {
    // A real market calendar — weekdays only, one Monday holiday — so these fifteen
    // observations include two Friday→Monday returns (three calendar days) and one
    // Friday→Tuesday (four). A guard tight enough to call those "missing bars" would
    // drop them from all three names and the sample would fall under fifteen.
    const calSpy = sessionTape(new Array(15).fill(0))
    const gaps = calSpy.slice(1).map((c, i) => dayIndexOf(c) - dayIndexOf(calSpy[i]))
    expect(Math.max(...gaps)).toBe(4) // the fixture really does carry a holiday break
    expect(gaps.filter(g => g === 3)).toHaveLength(2) // and two ordinary weekends
    const cal = new Map<string, Candle[]>([
      ['AAA', sessionTape(RA.slice(-15))],
      ['BBB', sessionTape(RB.slice(-15))],
      ['CCC', sessionTape(RC.slice(-15))],
    ])
    expect(detectClusters(history(repeat(8, ABC)), cal, calSpy)).toEqual([['AAA', 'BBB', 'CCC']])
  })
})

describe('detectClusters — the shape of a cluster', () => {
  it('rejects an A–B–C chain: every member needs two links, not one bridge', () => {
    // last five days: AAA+BBB three times, BBB+CCC three times, AAA+CCC once
    const chain = history([
      ['ZZZ'],
      ['ZZZ'],
      ['ZZZ'],
      ['AAA', 'BBB'],
      ['AAA', 'BBB'],
      ['AAA', 'BBB', 'CCC'],
      ['BBB', 'CCC'],
      ['BBB', 'CCC'],
    ])
    expect(detectClusters(chain, trio(), SPY)).toEqual([])
    // the tapes are identical and all three pairs correlate — the ONLY thing
    // missing was AAA–CCC co-appearance, and restoring it makes the cluster
    expect(detectClusters(history(repeat(8, ABC)), trio(), SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('keeps the triangle and sheds the pendant hanging off it', () => {
    // DDD's tape is a COPY of AAA's, so its co-move leg passes against all three —
    // but it only co-appears with AAA (3 days), meeting BBB and CCC once each. One
    // link is one link: DDD goes, and the triangle it was hanging off survives.
    const tapes = trio().set('DDD', tape(RA))
    const hist = history([
      ['ZZZ'],
      ['ZZZ'],
      ['ZZZ'],
      ABC,
      ABC,
      [...ABC, 'DDD'],
      ['AAA', 'DDD'],
      ['AAA', 'DDD'],
    ])
    expect(detectClusters(hist, tapes, SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })
})

describe('detectClusters — the record itself', () => {
  it('reads the trending record case- and whitespace-blind', () => {
    const hist = history(repeat(8, [' aaa ', 'bbb', 'Ccc']))
    expect(detectClusters(hist, trio(), SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('reads the tape MAP KEYS the same way — a caller keying off a raw feed loses no tape', () => {
    // the record is already normalised above; this pins the OTHER side of the join,
    // the candle map's own keys, which a caller may hand over exactly as fetched
    const rawKeys = new Map<string, Candle[]>([
      [' aaa ', tape(RA)],
      ['bbb', tape(RB)],
      ['Ccc', tape(RC)],
    ])
    expect(detectClusters(history(repeat(8, ABC)), rawKeys, SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('does not care what order the days were stored in', () => {
    const hist = [...history(repeat(8, ABC))].reverse()
    expect(detectClusters(hist, trio(), SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('a duplicated date is one day, not two — a stutter in the blob cannot fake co-appearance', () => {
    const dup: TrendDay[] = [
      { date: dayKey(14), syms: ['ZZZ'] },
      { date: dayKey(15), syms: ['ZZZ'] },
      { date: dayKey(16), syms: ['ZZZ'] },
      { date: dayKey(17), syms: ['ZZZ'] },
      { date: dayKey(18), syms: ['ZZZ'] },
      { date: dayKey(19), syms: ['ZZZ'] },
      { date: dayKey(20), syms: ABC },
      { date: dayKey(21), syms: ABC },
      { date: dayKey(21), syms: ABC }, // the stutter: a third co-appearance that never happened
      { date: dayKey(22), syms: ['ZZZ'] },
    ]
    expect(detectClusters(dup, trio(), SPY)).toEqual([])
    // three REAL days is the cluster, so the refusal above is the dedupe and
    // nothing else: give the stuttered day a genuine successor and it appears
    const real = dup.map((d, i) => (i === 9 ? { date: dayKey(22), syms: ABC } : d))
    expect(detectClusters(real, trio(), SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('survives a malformed blob without a verdict or a throw', () => {
    const junk = [null, { date: 5, syms: ABC }, { date: dayKey(20) }, { date: dayKey(21), syms: [null, 7] }] as unknown as TrendDay[]
    expect(detectClusters(junk, trio(), SPY)).toEqual([])
  })
})

describe('clusterCandidates — the bounded fetch list', () => {
  it('names only the symbols that are already in a co-appearing pair', () => {
    const hist = history([
      ['ZZZ'],
      ['ZZZ'],
      ['ZZZ'],
      ['AAA', 'BBB', 'LONE'],
      ['AAA', 'BBB'],
      ['AAA', 'BBB'],
      ['CCC'],
      ['CCC'],
    ])
    // AAA+BBB pair on three days; LONE trended once; CCC twice with nobody
    expect(clusterCandidates(hist)).toEqual(['AAA', 'BBB'])
  })

  it('is empty during the warm-up, so no fetch is ever spent on nothing', () => {
    expect(clusterCandidates(history(repeat(6, ABC)))).toEqual([])
    expect(clusterCandidates(history(repeat(7, ABC)))).toEqual(['AAA', 'BBB', 'CCC'])
  })
})

describe('crypto sits out until Stage 1c', () => {
  it('a quote-currency pair never enters candidacy or clusters — its Monday spans one session, SPY\'s spans three', () => {
    // ETH-USD co-trends with two equities on every recorded day. Without the
    // exclusion it would be a candidate (and, given correlated tapes, a member).
    const days = history([
      ['AAA', 'BBB', 'ETH-USD'], ['AAA', 'BBB', 'ETH-USD'], ['AAA', 'BBB', 'ETH-USD'],
      ['AAA', 'BBB', 'ETH-USD'], ['AAA', 'BBB', 'ETH-USD'], ['AAA'], ['BBB'],
    ])
    expect(clusterCandidates(days)).toEqual(['AAA', 'BBB'])
  })
  it('a share-class dash is NOT crypto — BRK-B stays clusterable', () => {
    const days = history([
      ['AAA', 'BBB', 'BRK-B'], ['AAA', 'BBB', 'BRK-B'], ['AAA', 'BBB', 'BRK-B'],
      ['AAA', 'BBB', 'BRK-B'], ['AAA', 'BBB', 'BRK-B'], ['AAA'], ['BBB'],
    ])
    expect(clusterCandidates(days)).toContain('BRK-B')
  })
})
