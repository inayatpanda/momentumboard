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

// SPY: 41 flat bars (days 0-40), so every planted return has a same-DATE index
// return to subtract and excess === raw. The vs-SPY subtraction gets its own test
// at the bottom, where the index actually moves and the raw agreement is a lie.
const SPY = tape(new Array(40).fill(0))

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
    const short = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(-14))], // 15 bars → 14 dated returns
      ['BBB', tape(RB.slice(-14))],
      ['CCC', tape(RC.slice(-14))],
    ])
    // the correlations are all still there (AB .970, AC .990, BC .961) — only the
    // sample is short, and a short sample is not evidence
    expect(detectClusters(history(repeat(8, ABC)), short, SPY)).toEqual([])

    const justEnough = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(-15))], // 16 bars → 15 dated returns
      ['BBB', tape(RB.slice(-15))],
      ['CCC', tape(RC.slice(-15))],
    ])
    expect(detectClusters(history(repeat(8, ABC)), justEnough, SPY)).toEqual([['AAA', 'BBB', 'CCC']])
  })

  it('counts OVERLAPPING sessions, not positions: two tapes on different dates never pair up', () => {
    // AAA and CCC print days 0-20; BBB prints the SAME twenty returns ten days later.
    // Tail-position pairing would hand BBB twenty pairs at r .959 and call it a
    // cluster member; dated pairing finds ten shared dates and refuses the edge.
    expect(pearson(RA.slice(0, 20), RB.slice(0, 20))!).toBeGreaterThan(0.9)
    const shifted = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(0, 20))],
      ['BBB', tape(RB.slice(0, 20), 10)],
      ['CCC', tape(RC.slice(0, 20))],
    ])
    expect(detectClusters(history(repeat(8, ABC)), shifted, SPY)).toEqual([])
    // and unshifted, the very same three series are the cluster
    const aligned = new Map<string, Candle[]>([
      ['AAA', tape(RA.slice(0, 20))],
      ['BBB', tape(RB.slice(0, 20))],
      ['CCC', tape(RC.slice(0, 20))],
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
