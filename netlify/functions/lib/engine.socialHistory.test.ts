import { describe, expect, it } from 'vitest'
import { buildBoard, type EngineDeps } from './engine'
import { memoryStore, type AppStore } from './store'
import { CALIB_DEF_VERSION } from '../../../shared/engine/calibration'
import { TREND_DAY_SYMS, TREND_HISTORY_DAYS, type TrendDay } from '../../../shared/engine/hypeCluster'
import type { SocialPulseRow } from './social'
import type { Candle } from '../../../shared/types'

// The trending record the hype-cluster lane learns from. buildBoard writes ONE
// TrendDay per date; detectClusters (a later task) reads the blob back. This file
// pins the writer: what it records, that a second run of the same day adds nothing,
// that the window is bounded, and that a blob fault costs the board nothing.

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })
const rolledOver = mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2))
const flat = mk(() => 500)
const NOW = Math.floor(rolledOver[rolledOver.length - 1].t + 86_400)
const TODAY = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

// six flat fillers so the candidate pool clears breadthAbove50's 10-series minimum
const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']

const row = (sym: string, rank: number): SocialPulseRow => ({
  sym,
  redditRank: rank,
  redditMentions: 1000 - rank,
  surging: false,
  surgeMultiple: null,
  stocktwits: false,
  channelNet: null,
  sources: 1,
  onWatchlist: false,
})
// twenty trending names, ranked, arriving lowercase from the feed
const trending = Array.from({ length: 20 }, (_, i) => row(`s${i}`, i + 1))

const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  candles: async sym => (sym === 'NVDA' ? rolledOver : fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
  candles5y: async () => null,
  capUsdM: async () => 50_000,
  companyName: async () => null,
  screens: async () =>
    ['NVDA', ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' as const })),
  social: async () => trending,
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

const seeded = async (): Promise<AppStore> => {
  const store = memoryStore()
  await store.write('config', { watchlist: [], rules: [], ytChannels: [], levMap: { NVDA: { short2x: 'INVD' } } })
  await store.write('engine-calibration', { buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 5 })
  return store
}
const historyOf = (store: AppStore) => store.read<TrendDay[]>('social-history')

describe('the social-history blob', () => {
  it("records today's trending fifteen, normalised, ranked as the feed ranked them", async () => {
    const store = await seeded()
    await buildBoard(store, deps(), NOW)
    expect(await historyOf(store)).toEqual([{ date: TODAY, syms: Array.from({ length: TREND_DAY_SYMS }, (_, i) => `S${i}`) }])
  })

  it('records NAMES, not feed rows — two spellings of one name are one name', async () => {
    const store = await seeded()
    await buildBoard(store, deps({ social: async () => [row('nvda', 1), row('NVDA', 2), row(' amd ', 3)] }), NOW)
    expect((await historyOf(store))![0].syms).toEqual(['NVDA', 'AMD'])
  })

  it('appends once per date — a second run the same day adds nothing and rewrites nothing', async () => {
    const store = await seeded()
    await buildBoard(store, deps(), NOW)
    // the feed has moved on by the afternoon run; the day was already recorded
    await buildBoard(store, deps({ social: async () => [row('zzz', 1)] }), NOW)
    const hist = (await historyOf(store))!
    expect(hist).toHaveLength(1)
    expect(hist[0].date).toBe(TODAY)
    expect(hist[0].syms).toContain('S0')
    expect(hist[0].syms).not.toContain('ZZZ')
  })

  it('keeps the record and bounds it at three weeks', async () => {
    const store = await seeded()
    const old: TrendDay[] = Array.from({ length: TREND_HISTORY_DAYS }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      syms: ['OLD'],
    }))
    await store.write('social-history', old)
    await buildBoard(store, deps(), NOW)
    const hist = (await historyOf(store))!
    expect(hist).toHaveLength(TREND_HISTORY_DAYS)
    expect(hist[hist.length - 1].date).toBe(TODAY) // today appended
    expect(hist[0].date).toBe(old[1].date) // the oldest day fell off the back
  })

  it('heals a blob of the wrong SHAPE — a record that is not a list is no record, not a permanent fault', async () => {
    const store = await seeded()
    // what a hand-edit or a half-restored snapshot leaves behind: an object, not a
    // list. Read blindly it throws on .filter into the fail-soft catch — on this run
    // and on every run after it, so the record never starts again and the cluster
    // warm-up never ends.
    await store.write('social-history', { [TODAY]: ['OLD'] } as unknown as TrendDay[])
    await buildBoard(store, deps(), NOW)
    expect(await historyOf(store)).toEqual([{ date: TODAY, syms: Array.from({ length: TREND_DAY_SYMS }, (_, i) => `S${i}`) }])
  })

  it('records nothing on a day the social feed said nothing — an empty day is not a day', async () => {
    const store = await seeded()
    await buildBoard(store, deps({ social: async () => [] }), NOW)
    expect(await historyOf(store)).toBeNull()
  })

  it('a blob fault costs the record, never the board', async () => {
    const control = await seeded()
    const { board: expected } = await buildBoard(control, deps(), NOW)
    expect(expected.length).toBeGreaterThan(0)

    const inner = await seeded()
    const faulty: AppStore = {
      read: inner.read,
      write: async (key, value) => {
        if (key === 'social-history') throw new Error('blobs are down')
        return inner.write(key, value)
      },
    }
    const { board } = await buildBoard(faulty, deps(), NOW)
    expect(board).toEqual(expected)
    expect(await historyOf(inner)).toBeNull()
  })
})
