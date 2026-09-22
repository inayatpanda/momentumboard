import { describe, it, expect } from 'vitest'
import {
  fetchUniverseBars,
  expectedLastSession,
  packBars,
  unpackBars,
  spliceBars,
  dropPartialBar,
  isPartialLastBar,
  dbarsShardKey,
  shardIndexFor,
  DBARS_MAX,
  DBARS_SHARDS,
} from './discoveryBars'
import type { BarsCache, DbarsShard, PackedBars } from './discoveryBars'
import type { Candle } from '../../../shared/types'

const DAY = 86_400
/** 2026-09-21 is a Monday; sessions below hang off that so the weekday maths is
 * explicit rather than "whatever today happens to be". */
const MON_2026_09_21 = Date.UTC(2026, 8, 21) / 1000

/** n daily bars ending at `lastDay` (UTC midnight), stamped at 13:30Z like a
 * real Yahoo US session bar so the day-keyed splice is actually exercised. */
function bars(lastDay: number, n: number, firstClose = 100): Candle[] {
  const out: Candle[] = []
  for (let i = n - 1; i >= 0; i--) {
    const c = firstClose + (n - 1 - i)
    out.push({ t: lastDay - i * DAY + 13.5 * 3600, o: c - 1, h: c + 1, l: c - 2, c, v: 1_000 + i })
  }
  return out
}

/** The US regular session of `day`: 13:30Z → 20:00Z, as Yahoo's chart meta
 * spells it in `currentTradingPeriod`. */
const regular = (day: number) => ({ start: day + 13.5 * 3600, end: day + 20 * 3600 })

function yahooBody(candles: Candle[], meta: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: candles[candles.length - 1].c, currency: 'USD', regularMarketVolume: 1_000, ...meta },
          timestamp: candles.map(b => b.t),
          indicators: { quote: [{ open: candles.map(b => b.o), high: candles.map(b => b.h), low: candles.map(b => b.l), close: candles.map(b => b.c), volume: candles.map(b => b.v) }] },
        },
      ],
    },
  }
}

const ok = (candles: Candle[], meta: Record<string, unknown> = {}) =>
  new Response(JSON.stringify(yahooBody(candles, meta)), { status: 200, headers: { 'content-type': 'application/json' } })

/** A cache seed in the SHARD layout: `{sym: tape}` in, `dbars:shard:NN` blobs
 * out, each name in the shard its own hash puts it in. */
function shardSeed(tapes: Record<string, Candle[]>, savedAt: number, shards = DBARS_SHARDS): Record<string, DbarsShard> {
  const out: Record<string, DbarsShard> = {}
  for (const [sym, tape] of Object.entries(tapes)) {
    const key = dbarsShardKey(shardIndexFor(sym, shards))
    out[key] ??= { v: 1, bars: {} }
    out[key].bars[sym] = packBars(tape, savedAt)
  }
  return out
}

const heldBars = (m: Map<string, unknown>, sym: string, shards = DBARS_SHARDS): PackedBars | undefined =>
  (m.get(dbarsShardKey(shardIndexFor(sym, shards))) as DbarsShard | undefined)?.bars?.[sym]

/** In-memory BarsCache with a call log. `failOn` refuses those keys on write. */
function memCache(seed: Record<string, unknown> = {}, failOn: string[] = []) {
  const m = new Map<string, unknown>(Object.entries(seed))
  const writes: string[] = []
  const getManyCalls: string[][] = []
  const cache: BarsCache = {
    async get<T>(k: string) {
      return (m.get(k) as T | undefined) ?? null
    },
    async getMany<T>(keys: string[]) {
      getManyCalls.push(keys)
      const out = new Map<string, T>()
      for (const k of keys) if (m.has(k)) out.set(k, m.get(k) as T)
      return out
    },
    async set(k, v) {
      if (failOn.includes(k)) throw new Error('d1 refused')
      writes.push(k)
      m.set(k, v)
    },
  }
  return { cache, m, writes, getManyCalls }
}

/** A fetch mock that records every URL and answers from a per-symbol script. */
function mockFetch(handler: (sym: string, range: string, url: string) => Response | Promise<Response>) {
  const calls: { sym: string; range: string; url: string }[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const sym = decodeURIComponent(url.match(/chart\/([^?]+)/)?.[1] ?? url.match(/[?&]s=([^&]+)/)?.[1] ?? '')
    const range = url.match(/range=([^&]+)/)?.[1] ?? 'stooq'
    calls.push({ sym, range, url })
    return await handler(sym, range, url)
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('expectedLastSession', () => {
  const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

  it('on a Monday points at the previous Friday', () => {
    expect(day(expectedLastSession(MON_2026_09_21 + 6 * 3600))).toBe('2026-09-18')
  })

  it('on a Saturday and a Sunday both point at the Friday', () => {
    expect(day(expectedLastSession(MON_2026_09_21 - 2 * DAY + 3600))).toBe('2026-09-18') // Sat 19th
    expect(day(expectedLastSession(MON_2026_09_21 - DAY + 3600))).toBe('2026-09-18') // Sun 20th
  })

  it('mid-week points at yesterday', () => {
    expect(day(expectedLastSession(MON_2026_09_21 + 2 * DAY + 3600))).toBe('2026-09-22') // Wed → Tue
  })
})

describe('packBars / unpackBars / spliceBars', () => {
  it('round-trips a tape and caps it at 300 bars', () => {
    const tape = bars(MON_2026_09_21, 320)
    const packed = packBars(tape, 1)
    expect(packed.t).toHaveLength(DBARS_MAX)
    expect(unpackBars(packed)).toEqual(tape.slice(-DBARS_MAX))
  })

  it('dedupes overlapping sessions, keeps order and caps', () => {
    const held = bars(MON_2026_09_21 - 3 * DAY, 300)
    const tail = bars(MON_2026_09_21, 20, 500) // overlaps the last 17 held sessions
    const merged = spliceBars(held, tail)
    expect(merged).toHaveLength(DBARS_MAX)
    expect(merged.map(b => b.t)).toEqual([...merged].sort((a, b) => a.t - b.t).map(b => b.t))
    expect(new Set(merged.map(b => Math.floor(b.t / DAY))).size).toBe(merged.length)
    expect(merged[merged.length - 1].c).toBe(tail[tail.length - 1].c) // the new bar wins
  })
})

describe('shardIndexFor', () => {
  it('is stable, in range, and spreads a real universe evenly enough', () => {
    expect(shardIndexFor('AAPL')).toBe(shardIndexFor('AAPL'))
    const syms = Array.from({ length: 2_000 }, (_, i) => `SYM${i}`)
    const counts = new Map<number, number>()
    for (const s of syms) {
      const i = shardIndexFor(s)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(DBARS_SHARDS)
      counts.set(i, (counts.get(i) ?? 0) + 1)
    }
    expect(counts.size).toBe(DBARS_SHARDS)
    // Sizing claim in the module header: no shard may run away with the universe.
    expect(Math.max(...counts.values())).toBeLessThan((2_000 / DBARS_SHARDS) * 2)
  })
})

describe('the in-progress session bar', () => {
  const mondayOpen = regular(MON_2026_09_21)
  const lastT = MON_2026_09_21 + 13.5 * 3600 // today's bar

  it('drops the live bar mid-session, on the meta', () => {
    const meta = { currentTradingPeriod: { regular: mondayOpen }, regularMarketTime: MON_2026_09_21 + 17 * 3600 }
    expect(isPartialLastBar(lastT, meta, MON_2026_09_21 + 17 * 3600)).toBe(true)
  })

  it('keeps it once the period has closed', () => {
    const meta = { currentTradingPeriod: { regular: mondayOpen }, regularMarketTime: MON_2026_09_21 + 20 * 3600 }
    expect(isPartialLastBar(lastT, meta, MON_2026_09_21 + 21 * 3600)).toBe(false)
  })

  it('a slow local clock cannot resurrect a live bar — regularMarketTime wins', () => {
    const meta = { currentTradingPeriod: { regular: mondayOpen }, regularMarketTime: MON_2026_09_21 + 17 * 3600 }
    expect(isPartialLastBar(lastT, meta, MON_2026_09_21 + 12 * 3600)).toBe(true)
  })

  it('a bar outside the current period is finished whatever the clock says', () => {
    const friday = MON_2026_09_21 - 3 * DAY + 13.5 * 3600
    const meta = { currentTradingPeriod: { regular: mondayOpen } }
    expect(isPartialLastBar(friday, meta, MON_2026_09_21 + 17 * 3600)).toBe(false)
  })

  it('without meta falls back to today-UTC-before-21:30Z', () => {
    expect(isPartialLastBar(lastT, null, MON_2026_09_21 + 17 * 3600)).toBe(true)
    expect(isPartialLastBar(lastT, {}, MON_2026_09_21 + 21.75 * 3600)).toBe(false) // past 21:30Z
    expect(isPartialLastBar(lastT - DAY, null, MON_2026_09_21 + 17 * 3600)).toBe(false) // yesterday's bar
  })

  it('dropPartialBar removes exactly one bar and says so', () => {
    const tape = bars(MON_2026_09_21, 5)
    const cut = dropPartialBar(tape, { currentTradingPeriod: { regular: mondayOpen } }, MON_2026_09_21 + 17 * 3600)
    expect(cut.dropped).toBe(true)
    expect(cut.candles).toEqual(tape.slice(0, -1))
    expect(dropPartialBar(tape, null, MON_2026_09_21 + 21.75 * 3600)).toEqual({ candles: tape, dropped: false })
  })
})

describe('fetchUniverseBars', () => {
  const now = () => MON_2026_09_21 * 1000 + 6 * 3_600_000 // Monday 06:00 UTC, pre-open
  const savedNow = Math.floor(now() / 1000)

  it('serves a warm cache without a single request or write', async () => {
    const tape = bars(MON_2026_09_21 - 3 * DAY, 120) // last bar = Friday
    const { cache, writes } = memCache(shardSeed({ AAPL: tape }, savedNow))
    const { fn, calls } = mockFetch(() => ok(bars(MON_2026_09_21, 5)))

    const res = await fetchUniverseBars(['AAPL'], { fetchFn: fn, cache, now })

    expect(calls).toHaveLength(0)
    expect(writes).toHaveLength(0)
    expect(res.tapes.get('AAPL')).toEqual(tape)
    expect(res.stats).toMatchObject({ fetched: 0, fromCache: 1, failed: 0, shardsWritten: 0 })
  })

  it('splices a 1mo tail onto a stale cache', async () => {
    const held = bars(MON_2026_09_21 - 10 * DAY, 300) // 10 sessions behind
    const tail = bars(MON_2026_09_21 - 3 * DAY, 22, 900)
    const { cache, m } = memCache(shardSeed({ MSFT: held }, savedNow))
    const { fn, calls } = mockFetch(() => ok(tail))

    const res = await fetchUniverseBars(['MSFT'], { fetchFn: fn, cache, now })

    expect(calls.map(c => c.range)).toEqual(['1mo'])
    const out = res.tapes.get('MSFT')!
    expect(out).toHaveLength(DBARS_MAX)
    expect(out[out.length - 1]).toEqual(tail[tail.length - 1])
    expect(new Set(out.map(b => Math.floor(b.t / DAY))).size).toBe(out.length)
    expect(unpackBars(heldBars(m, 'MSFT'))).toEqual(out)
    expect(res.stats).toMatchObject({ fetched: 1, fromCache: 0, failed: 0, shardsWritten: 1 })
  })

  it('refetches a whole year when the cache is too old to splice without a hole', async () => {
    const held = bars(MON_2026_09_21 - 60 * DAY, 200) // two months behind: a 1mo tail would not reach it
    const { cache } = memCache(shardSeed({ STALE: held }, savedNow))
    const year = bars(MON_2026_09_21 - 3 * DAY, 252)
    const { fn, calls } = mockFetch(() => ok(year))

    const res = await fetchUniverseBars(['STALE'], { fetchFn: fn, cache, now })

    expect(calls.map(c => c.range)).toEqual(['1y'])
    expect(res.tapes.get('STALE')).toEqual(year)
  })

  it('asks for 1y on a cache miss and caches the result in its shard', async () => {
    const { cache, m, writes } = memCache()
    const tape = bars(MON_2026_09_21 - 3 * DAY, 252)
    const { fn, calls } = mockFetch(() => ok(tape))

    const res = await fetchUniverseBars(['NVDA'], { fetchFn: fn, cache, now })

    expect(calls.map(c => c.range)).toEqual(['1y'])
    expect(res.tapes.get('NVDA')).toEqual(tape)
    expect(writes).toEqual([dbarsShardKey(shardIndexFor('NVDA'))])
    expect(unpackBars(heldBars(m, 'NVDA'))).toEqual(tape.slice(-DBARS_MAX))
  })

  it('retries once after a 429 and succeeds', async () => {
    const { cache } = memCache()
    const tape = bars(MON_2026_09_21 - 3 * DAY, 80)
    let n = 0
    const { fn, calls } = mockFetch(() => (n++ === 0 ? new Response('slow down', { status: 429 }) : ok(tape)))

    const res = await fetchUniverseBars(['TSLA'], { fetchFn: fn, cache, now })

    expect(calls).toHaveLength(2)
    expect(res.tapes.get('TSLA')).toEqual(tape)
    expect(res.stats.fetched).toBe(1)
  }, 10_000)

  it('stops on the request budget and reports the untouched tail as unread, in input order', async () => {
    const { cache } = memCache()
    const tape = bars(MON_2026_09_21 - 3 * DAY, 80)
    const { fn, calls } = mockFetch(() => ok(tape))

    const res = await fetchUniverseBars(['A', 'B', 'C', 'D', 'E'], { fetchFn: fn, cache, now, concurrency: 1, maxRequests: 2 })

    expect(calls.map(c => c.sym)).toEqual(['A', 'B'])
    expect(res.unread).toEqual(['C', 'D', 'E'])
    expect(res.stats.budgetHit).toBe(true)
  })

  // A name the budget cut can still be SERVED from cache a few lines later. It
  // was read; listing it as unread as well double-counted it (fromCache AND,
  // through runDiscovery's sum, failed) and made the pure layer reject a name
  // whose bars it was holding.
  it('a budget-cut name served from cache is cached, not unread', async () => {
    const stale = bars(MON_2026_09_21 - 12 * DAY, 80) // old enough to want a refresh
    const { cache } = memCache(shardSeed({ C: stale, D: stale }, now() / 1000))
    const tape = bars(MON_2026_09_21 - 3 * DAY, 80)
    const { fn, calls } = mockFetch(() => ok(tape))

    const res = await fetchUniverseBars(['A', 'B', 'C', 'D'], { fetchFn: fn, cache, now, concurrency: 1, maxRequests: 2 })

    expect(calls.map(c => c.sym)).toEqual(['A', 'B'])
    // C and D never got a request, but their cached tapes are right here.
    expect(res.tapes.get('C')).toEqual(stale)
    expect(res.unread).toEqual([])
    expect(res.failed).toEqual([])
    expect(res.stats.budgetHit).toBe(true)
    // …and the four columns still partition the four names asked for.
    expect(res.stats.fetched + res.stats.fromCache + res.stats.failed + res.unread.length).toBe(4)
  })

  // The ceiling exists to bound a cold scan of ~2,470 names. Charging it for a
  // retry made it shrink exactly when Yahoo was throttling — the one morning the
  // retry is there for.
  it('a retry costs no budget: the ceiling counts distinct symbols', async () => {
    const { cache } = memCache()
    const tape = bars(MON_2026_09_21 - 3 * DAY, 80)
    const seen = new Set<string>()
    // every symbol 429s once, then answers
    const { fn, calls } = mockFetch(sym => {
      if (!seen.has(sym)) {
        seen.add(sym)
        return new Response('slow down', { status: 429 })
      }
      return ok(tape)
    })

    const res = await fetchUniverseBars(['A', 'B'], { fetchFn: fn, cache, now, concurrency: 1, maxRequests: 2 })

    expect(calls).toHaveLength(4) // two names, two HTTP calls each
    expect(res.stats.fetched).toBe(2) // …and BOTH were read under a 2-request ceiling
    expect(res.unread).toEqual([])
    expect(res.stats.budgetHit).toBe(false)
  }, 15_000)

  it('stops on the wall-clock budget', async () => {
    const { cache } = memCache()
    const tape = bars(MON_2026_09_21 - 3 * DAY, 80)
    let clock = now()
    const { fn } = mockFetch(() => {
      clock += 5_000 // every call burns five seconds of the budget
      return ok(tape)
    })

    const res = await fetchUniverseBars(['A', 'B', 'C', 'D'], { fetchFn: fn, cache, now: () => clock, concurrency: 1, budgetMs: 8_000 })

    expect(res.unread).toEqual(['C', 'D'])
    expect(res.stats.budgetHit).toBe(true)
    expect(res.stats.elapsedMs).toBeGreaterThanOrEqual(8_000)
  })

  it('serves stale cached bars when the fetch fails outright', async () => {
    const held = bars(MON_2026_09_21 - 10 * DAY, 90)
    const { cache } = memCache(shardSeed({ 'BP.L': held }, savedNow))
    const { fn, calls } = mockFetch(() => new Response('nope', { status: 500 }))

    const res = await fetchUniverseBars(['BP.L'], { fetchFn: fn, cache, now })

    expect(calls).toHaveLength(2) // one attempt + one retry
    expect(res.tapes.get('BP.L')).toEqual(held)
    expect(res.failed).toEqual([])
    expect(res.stats).toMatchObject({ fetched: 0, fromCache: 1, failed: 0, shardsWritten: 0 })
  }, 10_000)

  it('falls back to Stooq exactly once when there is no cache at all', async () => {
    const { cache, writes } = memCache()
    const csv = ['Date,Open,High,Low,Close,Volume', ...Array.from({ length: 40 }, (_, i) => `2026-0${i < 9 ? 7 : 8}-${String((i % 28) + 1).padStart(2, '0')},10,11,9,10.5,1000`)].join('\n')
    const { fn, calls } = mockFetch((_sym, range) => (range === 'stooq' ? new Response(csv, { status: 200 }) : new Response('gone', { status: 404 })))

    const res = await fetchUniverseBars(['ZZZZ'], { fetchFn: fn, cache, now })

    expect(calls.filter(c => c.range !== 'stooq')).toHaveLength(1) // 404 is not retryable
    expect(calls.filter(c => c.url.includes('stooq.com'))).toHaveLength(1)
    expect(res.tapes.get('ZZZZ')?.length).toBe(40)
    expect(res.failed).toEqual([])
    expect(writes).toHaveLength(0) // a Stooq blob would read as warm and hide Yahoo
  })

  it('reports a name as failed when neither Yahoo nor Stooq answers', async () => {
    const { cache } = memCache()
    const { fn } = mockFetch(() => new Response('gone', { status: 404 }))

    const res = await fetchUniverseBars(['NOPE'], { fetchFn: fn, cache, now })

    expect(res.tapes.size).toBe(0)
    expect(res.failed).toEqual(['NOPE'])
    expect(res.stats.failed).toBe(1)
  })

  it('processes a mixed universe deterministically and in input order', async () => {
    const warm = bars(MON_2026_09_21 - 3 * DAY, 100)
    const { cache } = memCache(shardSeed({ WARM: warm }, savedNow))
    const { fn, calls } = mockFetch(() => ok(bars(MON_2026_09_21 - 3 * DAY, 100)))

    const res = await fetchUniverseBars(['WARM', 'COLD1', 'COLD2'], { fetchFn: fn, cache, now, concurrency: 1 })

    expect(calls.map(c => c.sym)).toEqual(['COLD1', 'COLD2'])
    expect([...res.tapes.keys()].sort()).toEqual(['COLD1', 'COLD2', 'WARM'])
    expect(res.stats).toMatchObject({ fetched: 2, fromCache: 1, failed: 0, budgetHit: false })
  })
})

describe('fetchUniverseBars · the partial bar never reaches the tape or the cache', () => {
  const midSession = () => (MON_2026_09_21 + 17 * 3600) * 1000 // Monday 17:00 UTC
  const mondayMeta = { currentTradingPeriod: { regular: regular(MON_2026_09_21) }, regularMarketTime: MON_2026_09_21 + 17 * 3600 }

  it('drops today’s live bar on the meta, counts it, and caches only finished sessions', async () => {
    const { cache, m } = memCache()
    const tape = bars(MON_2026_09_21, 60) // ends on TODAY, mid-session
    const { fn } = mockFetch(() => ok(tape, mondayMeta))

    const res = await fetchUniverseBars(['AMD'], { fetchFn: fn, cache, now: midSession })

    expect(res.stats.partialDropped).toBe(1)
    expect(res.tapes.get('AMD')).toEqual(tape.slice(0, -1))
    expect(unpackBars(heldBars(m, 'AMD'))).toEqual(tape.slice(0, -1))
  })

  it('drops it on the no-meta fallback too', async () => {
    const { cache } = memCache()
    const tape = bars(MON_2026_09_21, 60)
    const { fn } = mockFetch(() => ok(tape, { currentTradingPeriod: null }))

    const res = await fetchUniverseBars(['AMD'], { fetchFn: fn, cache, now: midSession })

    expect(res.stats.partialDropped).toBe(1)
    expect(res.tapes.get('AMD')).toEqual(tape.slice(0, -1))
  })

  it('keeps the last bar once the session has closed', async () => {
    const { cache } = memCache()
    const tape = bars(MON_2026_09_21, 60)
    const closed = { currentTradingPeriod: { regular: regular(MON_2026_09_21) }, regularMarketTime: MON_2026_09_21 + 20 * 3600 }
    const { fn } = mockFetch(() => ok(tape, closed))

    const res = await fetchUniverseBars(['AMD'], { fetchFn: fn, cache, now: () => (MON_2026_09_21 + 21 * 3600) * 1000 })

    expect(res.stats.partialDropped).toBe(0)
    expect(res.tapes.get('AMD')).toEqual(tape)
  })

  it('never splices a live bar into a cached tape', async () => {
    const held = bars(MON_2026_09_21 - 8 * DAY, 120)
    const { cache, m } = memCache(shardSeed({ AMD: held }, MON_2026_09_21))
    const tail = bars(MON_2026_09_21, 12, 500) // the last of these is today's live bar
    const { fn, calls } = mockFetch(() => ok(tail, mondayMeta))

    const res = await fetchUniverseBars(['AMD'], { fetchFn: fn, cache, now: midSession })

    expect(calls.map(c => c.range)).toEqual(['1mo'])
    const out = res.tapes.get('AMD')!
    expect(out[out.length - 1]).toEqual(tail[tail.length - 2]) // Friday's bar, not today's
    expect(unpackBars(heldBars(m, 'AMD')).at(-1)).toEqual(tail[tail.length - 2])
    expect(res.stats.partialDropped).toBe(1)
  })
})

describe('fetchUniverseBars · the sharded cache', () => {
  const now = () => MON_2026_09_21 * 1000 + 6 * 3_600_000
  const savedNow = Math.floor(now() / 1000)
  const SHARDS = 4
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF']
  const key = (sym: string) => dbarsShardKey(shardIndexFor(sym, SHARDS))

  it('reads every shard in ONE getMany and writes only the shards that changed', async () => {
    const warmTape = bars(MON_2026_09_21 - 3 * DAY, 100)
    // Every name starts warm; then one is aged so exactly one shard changes.
    const seed = shardSeed(Object.fromEntries(syms.map(s => [s, warmTape])), savedNow, SHARDS)
    const staleShard = seed[key('CCC')] as DbarsShard
    staleShard.bars['CCC'] = packBars(bars(MON_2026_09_21 - 12 * DAY, 100), savedNow)
    const { cache, writes, getManyCalls } = memCache(seed)
    const { fn, calls } = mockFetch(() => ok(bars(MON_2026_09_21 - 3 * DAY, 25, 400)))

    const res = await fetchUniverseBars(syms, { fetchFn: fn, cache, now, shards: SHARDS })

    expect(getManyCalls).toHaveLength(1)
    expect(getManyCalls[0].sort()).toEqual([...new Set(syms.map(key))].sort())
    expect(calls.map(c => c.sym)).toEqual(['CCC'])
    expect(writes).toEqual([key('CCC')]) // and no other shard, though 5 names were served
    expect(res.stats).toMatchObject({ fetched: 1, fromCache: 5, shardsWritten: 1 })
  })

  it('a shard write failure costs that shard’s cache and nothing else, and logs ONCE', async () => {
    const a = syms.find(s => shardIndexFor(s, SHARDS) === 0)!
    const b = syms.find(s => shardIndexFor(s, SHARDS) !== shardIndexFor(a, SHARDS))!
    const { cache, m, writes } = memCache({}, [key(a)])
    const lines: string[] = []
    const { fn } = mockFetch(() => ok(bars(MON_2026_09_21 - 3 * DAY, 100)))

    const res = await fetchUniverseBars([a, b], { fetchFn: fn, cache, now, shards: SHARDS, log: l => lines.push(l) })

    expect(res.tapes.size).toBe(2) // the RUN is unharmed; only next run's warm start is
    expect(writes).toEqual([key(b)])
    expect(heldBars(m, a, SHARDS)).toBeUndefined()
    expect(heldBars(m, b, SHARDS)).toBeTruthy()
    expect(lines.filter(l => /shard cache writes? failed/.test(l))).toHaveLength(1)
    expect(res.stats.shardsWritten).toBe(1)
  })

  it('a cache read that THROWS makes the run cold and writes nothing — it never clobbers what it could not see', async () => {
    const angry: BarsCache = {
      async get() {
        throw new Error('d1 down')
      },
      async getMany() {
        throw new Error('d1 down')
      },
      async set() {
        throw new Error('should never be called')
      },
    }
    const lines: string[] = []
    const { fn, calls } = mockFetch(() => ok(bars(MON_2026_09_21 - 3 * DAY, 100)))

    const res = await fetchUniverseBars(['AAA'], { fetchFn: fn, cache: angry, now, log: l => lines.push(l) })

    expect(calls).toHaveLength(1)
    expect(res.tapes.get('AAA')).toBeTruthy()
    expect(res.stats.shardsWritten).toBe(0)
    expect(lines.join('\n')).toMatch(/shard cache read failed/)
  })

  it('prunes entries past the TTL when it rewrites a shard, so a shard cannot grow for ever', async () => {
    const ancient = savedNow - 30 * DAY
    const seed = shardSeed({ AAA: bars(MON_2026_09_21 - 40 * DAY, 100), GONE: bars(MON_2026_09_21 - 3 * DAY, 100) }, ancient, SHARDS)
    // Put the departed name in AAA's shard so AAA's refetch rewrites it.
    const merged: Record<string, unknown> = {}
    const aKey = key('AAA')
    merged[aKey] = { v: 1, bars: { ...(seed[aKey] as DbarsShard).bars, GONE: packBars(bars(MON_2026_09_21 - 3 * DAY, 100), ancient) } }
    const { cache, m } = memCache(merged)
    const { fn } = mockFetch(() => ok(bars(MON_2026_09_21 - 3 * DAY, 200)))

    await fetchUniverseBars(['AAA'], { fetchFn: fn, cache, now, shards: SHARDS })

    expect(heldBars(m, 'AAA', SHARDS)).toBeTruthy()
    expect((m.get(aKey) as DbarsShard).bars['GONE']).toBeUndefined()
  })

  it('cache: false reads nothing, writes nothing, and remembers nothing between runs', async () => {
    const tape = bars(MON_2026_09_21 - 3 * DAY, 100)
    const { fn, calls } = mockFetch(() => ok(tape))

    const one = await fetchUniverseBars(['AAA'], { fetchFn: fn, cache: false, now })
    const two = await fetchUniverseBars(['AAA'], { fetchFn: fn, cache: false, now })

    expect(calls.map(c => c.sym)).toEqual(['AAA', 'AAA'])
    expect(one.tapes.get('AAA')).toEqual(tape)
    expect(two.stats).toMatchObject({ fetched: 1, fromCache: 0, shardsWritten: 0 })
  })
})
