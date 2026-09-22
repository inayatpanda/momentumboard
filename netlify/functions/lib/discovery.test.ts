import { describe, it, expect } from 'vitest'
import { runDiscovery, orderUniverseForFetch, discoveryAllowedOnHost, discoveryDisabled, discoveryBudgetMs, DISCOVERY_BUDGET_MS, DISCOVERY_MAX_REQUESTS } from './discovery'
import { memoryStore, type AppStore } from './store'
import { dbarsShardKey, expectedLastSession, shardIndexFor, type BarsCache, type DbarsShard } from './discoveryBars'
import { DYNAMIC_UNIVERSE_KEY, DISCOVERY_TRACE_KEY, DYNAMIC_UNIVERSE_MAX, type DynamicUniverseState, type UniverseMember } from '../../../shared/engine/discovery/types'
import { loadUniverseSeedFile } from '../../../shared/engine/discovery/universeSeed'
import type { UniverseSeedRow } from '../../../shared/engine/discovery/universeSeedBuild'
import type { Candle } from '../../../shared/types'

const DAY = 86_400
/** The session the bars layer expects to be the newest one, whatever day the
 * suite runs — so "warm cache" means the same thing here as in production. */
const LAST_SESSION = expectedLastSession(Math.floor(Date.now() / 1000))

/** A tape with a controllable last day. `shape` moves the close; volume is kept
 * large enough that the $5M 20-day dollar-volume floor is never the reason a
 * name is missing from a test's expectations. */
function tape(n: number, shape: (i: number) => number, lastVolMult = 1): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const c = shape(i)
    const v = 4_000_000 * (i === n - 1 ? lastVolMult : 1)
    out.push({ t: LAST_SESSION - (n - 1 - i) * DAY + 13.5 * 3600, o: c * 0.995, h: c * 1.01, l: c * 0.985, c, v })
  }
  return out
}

/** Quiet 250-session drift, then one violent high-volume bar. `jump` is in
 * price points and is what separates the two shock names: percentiles average
 * ties, so two identical tapes would share the top slot at 0.83 and neither
 * would clear the `unusual` lens's top-decile gate. */
const shockTape = (jump: number) => tape(250, i => (i < 249 ? 50 + Math.sin(i / 9) * 1.5 + i * 0.05 : 50 + 249 * 0.05 + jump), 6)

const sleepyTape = (base: number) => tape(250, i => base + Math.sin(i / 11) * 0.8)

const flatSpy = () => tape(250, i => 500 + i * 0.1)

function yahooBody(candles: Candle[], meta: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: candles[candles.length - 1].c, currency: 'USD', regularMarketVolume: candles[candles.length - 1].v, ...meta },
          timestamp: candles.map(b => b.t),
          indicators: { quote: [{ open: candles.map(b => b.o), high: candles.map(b => b.h), low: candles.map(b => b.l), close: candles.map(b => b.c), volume: candles.map(b => b.v) }] },
        },
      ],
    },
  }
}

function mockFetch(tapes: Record<string, Candle[]>, meta: Record<string, unknown> = {}) {
  const order: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const sym = decodeURIComponent(url.match(/chart\/([^?]+)/)?.[1] ?? '')
    order.push(sym)
    const t = tapes[sym]
    return t ? new Response(JSON.stringify(yahooBody(t, meta)), { status: 200 }) : new Response('no', { status: 404 })
  }) as unknown as typeof fetch
  return { fn, order }
}

function memCache(): BarsCache {
  const m = new Map<string, unknown>()
  return {
    async get<T>(k: string) {
      return (m.get(k) as T | undefined) ?? null
    },
    async getMany<T>(keys: string[]) {
      const out = new Map<string, T>()
      for (const k of keys) if (m.has(k)) out.set(k, m.get(k) as T)
      return out
    },
    async set(k, v) {
      m.set(k, v)
    },
  }
}

const seedRow = (sym: string, sector: string): UniverseSeedRow => ({ sym, name: sym, exchange: 'US', index: ['sp500'], sector, capBand: 'large' })

const SEED: UniverseSeedRow[] = [
  seedRow('AAA', 'Technology'),
  seedRow('BBB', 'Healthcare'),
  seedRow('CCC', 'Energy'),
  seedRow('DDD', 'Financials'),
  seedRow('EEE', 'Industrials'),
]

const DATE = '2026-09-21'

const runWith = (store: AppStore, extra: Partial<Parameters<typeof runDiscovery>[0]> = {}, meta: Record<string, unknown> = {}) => {
  const tapes: Record<string, Candle[]> = {
    AAA: shockTape(4),
    BBB: sleepyTape(30),
    CCC: sleepyTape(70),
    DDD: sleepyTape(120),
    EEE: sleepyTape(45),
    NOMX: shockTape(9),
  }
  const { fn, order } = mockFetch(tapes, meta)
  return {
    order,
    result: runDiscovery({
      date: DATE,
      store,
      seed: SEED,
      nominations: [{ sym: 'NOMX', origin: 'screener:gainers', sector: 'Technology' }],
      spy: flatSpy(),
      isEtp: () => false,
      fetchFn: fn,
      cache: memCache(),
      concurrency: 1,
      log: () => {},
      ...extra,
    }),
  }
}

describe('discoveryDisabled / discoveryBudgetMs', () => {
  it('is off only for DISCOVERY=off, case and whitespace insensitive', () => {
    expect(discoveryDisabled({ DISCOVERY: 'off' })).toBe(true)
    expect(discoveryDisabled({ DISCOVERY: ' OFF ' })).toBe(true)
    expect(discoveryDisabled({ DISCOVERY: 'on' })).toBe(false)
    expect(discoveryDisabled({})).toBe(false)
  })

  it('takes a positive DISCOVERY_BUDGET_MS and ignores nonsense', () => {
    expect(discoveryBudgetMs({ DISCOVERY_BUDGET_MS: '30000' })).toBe(30_000)
    expect(discoveryBudgetMs({ DISCOVERY_BUDGET_MS: 'soon' })).toBe(DISCOVERY_BUDGET_MS)
    expect(discoveryBudgetMs({ DISCOVERY_BUDGET_MS: '-1' })).toBe(DISCOVERY_BUDGET_MS)
    expect(discoveryBudgetMs({})).toBe(DISCOVERY_BUDGET_MS)
  })
})

describe('discoveryAllowedOnHost', () => {
  it('lets Node scan and refuses a subrequest-capped host', () => {
    expect(discoveryAllowedOnHost({}, true)).toBe(true)
    expect(discoveryAllowedOnHost({}, false)).toBe(false)
  })

  it('DISCOVERY=on is the explicit override, and only that value', () => {
    expect(discoveryAllowedOnHost({ DISCOVERY: 'on' }, false)).toBe(true)
    expect(discoveryAllowedOnHost({ DISCOVERY: ' ON ' }, false)).toBe(true)
    expect(discoveryAllowedOnHost({ DISCOVERY: 'yes' }, false)).toBe(false)
    expect(discoveryAllowedOnHost({ DISCOVERY: '' }, false)).toBe(false)
  })
})

describe('orderUniverseForFetch', () => {
  it('puts today’s nominations first, then seed, then dynamic', () => {
    const member = (sym: string, origins: string[]): [string, UniverseMember] => [sym, { sym, exchange: 'US', capBand: null, sector: null, origins, lastSeen: DATE }]
    const members = new Map<string, UniverseMember>([
      member('SEED1', ['seed:sp500']),
      member('OLDNOM', ['nom:social']),
      member('FRESH', ['nom:screener:gainers']),
      member('SEED2', ['seed:ftse100']),
    ])
    expect(orderUniverseForFetch(members, [{ sym: 'FRESH', origin: 'screener:gainers' }])).toEqual(['FRESH', 'SEED1', 'SEED2', 'OLDNOM'])
  })
})

describe('runDiscovery', () => {
  it('scans a small universe end to end and persists both blobs', async () => {
    const store = memoryStore()
    const { result, order } = runWith(store)
    const res = await result

    // A budget cut must never be the reason a fresh nomination went unseen.
    expect(order[0]).toBe('NOMX')
    expect(order.slice(1).sort()).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE'])

    expect(res.date).toBe(DATE)
    expect(res.stats).toMatchObject({ universeSize: 6, seedSize: 5, dynamicSize: 1, barsFetched: 6, barsFailed: 0, budgetHit: false })
    expect(res.stats.scanned).toBe(6)
    expect(res.tapes.size).toBe(6)
    expect(res.candidates.length).toBeGreaterThan(0)
    // the nominated shock name is the loudest tape in the set, so it is both a
    // candidate and carries the nominator that put it there
    const nomx = res.candidates.find(c => c.sym === 'NOMX')
    expect(nomx?.nominators).toContain('nom:screener:gainers')
    expect(nomx?.lenses.length).toBeGreaterThan(0)
    expect(res.trace.length).toBeGreaterThan(0)

    const dyn = await store.read<DynamicUniverseState>(DYNAMIC_UNIVERSE_KEY)
    expect(Object.keys(dyn?.members ?? {})).toEqual(['NOMX'])

    const trace = await store.read<{ date: string; stats: { universeSize: number }; rows: unknown[] }>(DISCOVERY_TRACE_KEY(DATE))
    expect(trace?.date).toBe(DATE)
    expect(trace?.stats.universeSize).toBe(6)
    expect(trace?.rows.length).toBe(res.trace.length)
  })

  it('reuses a warm bars cache instead of re-fetching', async () => {
    const cache = memCache()
    const store = memoryStore()
    await (await runWith(store, { cache })).result
    const second = runWith(store, { cache })
    const res = await second.result

    expect(second.order).toEqual([]) // every tape already ends on the last session
    expect(res.stats.barsFromCache).toBe(6)
    expect(res.stats.barsFetched).toBe(0)
    expect((await cache.get<DbarsShard>(dbarsShardKey(shardIndexFor('AAA'))))?.bars['AAA']).toBeTruthy()
  })

  it('survives a store that refuses every write', async () => {
    const broken: AppStore = {
      async read() {
        return null
      },
      async write() {
        throw new Error('blobs down')
      },
    }
    const lines: string[] = []
    const res = await runWith(broken, { log: (l: string) => lines.push(l) }).result
    expect(res.stats.universeSize).toBe(6)
    expect(lines.join('\n')).toMatch(/write failed/)
  })

  it('counts unread names against bars coverage when the budget bites', async () => {
    const store = memoryStore()
    const res = await runWith(store, { maxRequests: 2 }).result
    expect(res.stats.budgetHit).toBe(true)
    expect(res.stats.barsFetched).toBe(2)
    expect(res.stats.barsUnread).toBe(4) // 4 never attempted
    expect(res.stats.barsFailed).toBe(0) // …and none of them FAILED: nothing was tried
    // …and the reject counts say WHICH four, which the 400-row trace could not.
    expect(res.stats.rejects['budget-cut']).toBe(4)
  })

  // Four columns, one universe. They used to be three, with `barsFailed`
  // summing the unreadable and the never-attempted — so a name the budget cut
  // but the CACHE served was counted in `fromCache` AND in `barsFailed`, and no
  // column could be trusted to mean one thing.
  it('the bars columns partition the universe, warm cache or cold', async () => {
    const partitions = (s: { universeSize: number; barsFetched: number; barsFromCache: number; barsFailed: number; barsUnread: number }) =>
      s.barsFetched + s.barsFromCache + s.barsFailed + s.barsUnread === s.universeSize

    const cold = await runWith(memoryStore()).result
    expect(partitions(cold.stats)).toBe(true)

    const cut = await runWith(memoryStore(), { maxRequests: 2 }).result
    expect(partitions(cut.stats)).toBe(true)

    // …and a warm second run under a budget that would have cut four of the six:
    // every name is served from cache, so each is `fromCache` and nothing else —
    // not unread, not failed, and the pure layer scans all six. (The bars layer's
    // own suite pins the sharper case: a STALE cached tape served after the
    // request budget bit, which used to be counted twice.)
    const cache = memCache()
    const store = memoryStore()
    await runWith(store, { cache }).result
    const warmCut = await runWith(store, { cache, maxRequests: 1 }).result
    expect(warmCut.stats.barsUnread).toBe(0)
    expect(warmCut.stats.barsFailed).toBe(0)
    expect(warmCut.stats.barsFromCache).toBe(6)
    expect(warmCut.stats.rejects['budget-cut']).toBeUndefined()
    expect(partitions(warmCut.stats)).toBe(true)
  })

  it('the request ceiling clears the worst honest universe, and a retry does not eat it', async () => {
    // The cold-run worst case: every committed seed row plus a full dynamic
    // layer, one request each. 2,500 left 34 names of headroom.
    const worstCase = loadUniverseSeedFile().count + DYNAMIC_UNIVERSE_MAX
    expect(DISCOVERY_MAX_REQUESTS).toBe(3_500)
    expect(DISCOVERY_MAX_REQUESTS).toBeGreaterThan(worstCase * 1.2)
  })

  it('counts every reject by code — including the ones the bounded trace drops', async () => {
    const store = memoryStore()
    const res = await runWith(store).result
    const counted = Object.values(res.stats.rejects).reduce((a, b) => a + b, 0)
    expect(counted + res.stats.selected).toBe(res.stats.universeSize)
    // Nothing was scanned during a session, so nothing was thrown away.
    expect(res.stats.partialDropped).toBe(0)
  })

  it('reports the partial bars the bars layer dropped, and says so in the log line', async () => {
    const store = memoryStore()
    const lines: string[] = []
    // A trading period that CONTAINS every tape's last bar and has not ended
    // yet: exactly the shape a run during market hours sees, without mocking a
    // clock. All six names lose their last bar before a feature reads it.
    const openPeriod = {
      currentTradingPeriod: { regular: { start: LAST_SESSION + 13 * 3600, end: Math.floor(Date.now() / 1000) + 3_600 } },
    }
    const res = await runWith(store, { log: (l: string) => lines.push(l) }, openPeriod).result

    expect(res.stats.partialDropped).toBe(6)
    expect(lines.join('\n')).toMatch(/6 partial dropped/)
    expect(lines.join('\n')).toMatch(/rejects:/)
  })
})
