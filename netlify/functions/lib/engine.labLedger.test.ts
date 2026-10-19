import { describe, expect, it } from 'vitest'
import { buildBoard, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import {
  qualityDipObservations,
  shortHorizonObservations,
  socialIgnitionObservations,
  type SocialLabRow,
  type StrategyLabRecord,
} from '../../../shared/engine/strategyLab'

// THE ENGINE LAB'S LEDGER, under a discovery-sized candidate pool.
//
// Two invariants the strategy-lab wave leans on, both of which discovery v2's
// wider pool (180 → up to 320 names) puts under pressure:
//
//  1. the grading budget must reach the records that can actually grade, and
//  2. one run can only ever append a bounded number of observations, whatever
//     the pool size — which is what makes `engine-lab-ledger`'s `slice(-500)`
//     worth weeks of weekday runs rather than a couple of them.

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })

const flat = mk(() => 500)
const climb = mk(i => 100 + i * 0.4)
const NOW = Math.floor(flat[flat.length - 1].t + 86_400)

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : null),
  candles5y: async () => null,
  capUsdM: async () => null,
  companyName: async () => null,
  screens: async () => [],
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

/** An open three-session forecast. `availableAt` decides whether it can grade:
 * a record stamped before the tape ends has its three sessions; one stamped at
 * `NOW` has no bar after it at all, so `gradeStrategyObservation` answers null. */
const openRecord = (sym: string, availableAt: number): StrategyLabRecord => ({
  id: `${availableAt}:short-horizon:${sym}`,
  sleeve: 'short-horizon',
  sym,
  side: 'neutral',
  state: 'watch',
  score: 50,
  entry: 100,
  stop: null,
  target: null,
  detectedAt: availableAt,
  availableAt,
  reasons: [],
  risks: [],
  dataGaps: [],
  metrics: {},
  forecast: {
    definition: 'three-session-direction-v1',
    label: 'Close after 3 sessions versus today’s close',
    horizonSessions: 3,
    probabilityUp: 0.55,
    probabilityDown: 0.45,
    calibratedN: 40,
    provisional: true,
  },
})

describe('the engine lab ledger under a discovery-sized pool', () => {
  it('spends its grading budget on the OLDEST open records, so a mature one is not stranded behind immature ones', async () => {
    const store = memoryStore()
    await store.write('config', { watchlist: [], rules: [], ytChannels: [] })
    // MATURE, and first in the ledger: stamped near the start of the tape, so
    // three sessions have long since closed on it.
    const mature = openRecord('OLDY', T0 + 5 * 86_400)
    // …and 60 records appended after it whose horizon has not elapsed. Sixty is
    // the grading budget exactly, so under a newest-first read the mature row is
    // the one row the budget never reaches.
    const immature = Array.from({ length: 60 }, (_, i) => openRecord(`NEW${i}`, NOW))
    await store.write('engine-lab-ledger', [mature, ...immature])

    await buildBoard(
      store,
      deps({ candles: async sym => (sym === 'SPY' || sym === 'QQQ' ? flat : sym === 'OLDY' ? climb : null) }),
      NOW,
    )

    const ledger = (await store.read<StrategyLabRecord[]>('engine-lab-ledger'))!
    const graded = ledger.find(r => r.sym === 'OLDY')!
    expect(graded.outcome).toBeDefined()
    expect(graded.outcome!.sessions).toBe(3)
    // the immature batch is untouched — the budget did not grade what it cannot
    expect(ledger.filter(r => r.sym.startsWith('NEW') && r.outcome)).toHaveLength(0)
  })

  it('caps one run’s observations at 16 + 8 + 10 however many candidates discovery puts in the pool', () => {
    // 300 names: a full discovery pool (180 + scan, ceiling 320) rather than the
    // 180 the sleeves were written against.
    const tapes = Array.from({ length: 300 }, (_, i) => ({
      sym: `S${i}`,
      candles: mk(j => 100 + Math.sin((j + i) / 7) * 12 - j * 0.08, 200),
    }))

    const scanAt = tapes[0].candles.at(-1)!.t + 86_400
    const short = shortHorizonObservations(tapes, scanAt, ['GOOG', 'GOOGL'])
    expect(short.length).toBeGreaterThan(0)
    expect(short.length).toBeLessThanOrEqual(16)

    const quality = qualityDipObservations(
      tapes.map(t => ({ sym: t.sym, candles: t.candles, qualityProxy: true, capUsdM: 50_000 })),
      flat,
      NOW,
    )
    expect(quality.length).toBeLessThanOrEqual(8)

    const socialRows: SocialLabRow[] = tapes.map(t => ({
      sym: t.sym,
      redditMentions: 400,
      surgeMultiple: 3,
      sources: 3,
      stocktwits: true,
      channelNet: 2,
      capUsdM: 50_000,
      last: t.candles.at(-1)!.c,
    }))
    const social = socialIgnitionObservations(socialRows, [], NOW)
    expect(social.length).toBeGreaterThan(0)
    expect(social.length).toBeLessThanOrEqual(10)

    // …so the worst a single run can append is 34 rows, and `slice(-500)` keeps
    // at least a fortnight of weekday runs even at that ceiling.
    expect(short.length + quality.length + social.length).toBeLessThanOrEqual(34)
    expect(Math.floor(500 / 34)).toBeGreaterThanOrEqual(10)
  })
})
