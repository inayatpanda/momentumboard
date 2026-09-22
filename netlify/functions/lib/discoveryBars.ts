// Daily OHLCV for the whole discovery universe, in one budgeted, cached pass.
//
// Why this exists (docs/superpowers/specs/2026-09-22-discovery-engine-v2-design.md §4.2):
// the scan wants ~2,000 tapes every morning. Measured 2026-09-22, a Yahoo
// `v8/finance/chart` call is ~75 ms and 123 names at concurrency 8 finished in
// 1.3 s with zero 429s — so the whole universe is ~30 s cold and near-free warm,
// provided we (a) never re-fetch a tape that already ends on the last session
// and (b) ask only for the missing tail when it does not.
//
// This module is the ONLY I/O in the bars path. Everything it returns is plain
// data for the pure layer (shared/engine/discovery) to judge.

import { CANDLE_RANGES, parseYahooChart } from './yahoo'
import { getCached, getCachedMany, setCached } from './cache'
import { fetchStooqCandles } from './stooq'
import type { Candle } from '../../../shared/types'

/** Compact per-symbol cache blob. Columns, not row objects: a 300-bar tape as
 * `[{t,o,h,l,c,v}, …]` re-spells six keys three hundred times, which is most of
 * the blob. Six arrays cost the keys once. */
export interface PackedBars {
  t: number[]
  o: number[]
  h: number[]
  l: number[]
  c: number[]
  v: number[]
  savedAt: number
}

/** One cache row: the packed tapes of every symbol that hashes to this shard.
 * `v` is the layout version — an older or unrecognised blob is read as empty
 * rather than mis-parsed, so a layout change costs one cold scan, not a crash. */
export interface DbarsShard {
  v: 1
  bars: Record<string, PackedBars>
}

/**
 * SHARDED, NOT PER SYMBOL, and the arithmetic is the whole reason.
 *
 * The cache used to hold one row per symbol (`dbars:{sym}`). From GitHub Actions
 * the store is D1 over HTTPS and scripts/lib/httpD1.ts spaces calls MIN_GAP_MS
 * (260 ms) apart, so a 1,866-name scan spent 1,866 × 260 ms ≈ 8 MINUTES writing
 * a cache that exists to save a 25-second fetch. The cure has to cut the number
 * of ROWS, not the number of bytes.
 *
 * Sizing, measured rather than assumed: a packed 300-bar tape is ~20 KB of JSON
 * (Yahoo prints float64 closes at full precision — `231.44000244140625` is 18
 * characters). The universe's ceiling is the committed seed (~1,866 names) plus
 * DYNAMIC_UNIVERSE_MAX (600) = ~2,470 names. D1's hard cap on a single string,
 * BLOB or row is 2,000,000 bytes, and lib/cache.ts wraps the value in its
 * `{ value, expires }` envelope before it gets there.
 *
 *   shards  worst-case names/shard  worst-case blob   share of D1's 2 MB row cap
 *      32            ~78                 ~1.5 MB                  77%   ← too close
 *      64            ~39                 ~0.77 MB                 38%   ← chosen
 *     128            ~20                 ~0.39 MB                 20%   (128 writes ≈ 33 s)
 *
 * 64 keeps the worst case at well under half the cap with room for the universe
 * to grow by half again before it is even worth re-reading this comment, and
 * costs at most 64 × 260 ms ≈ 17 s of writes — against ~8 minutes before, and
 * only for shards that actually changed.
 */
export const DBARS_SHARDS = 64

/** `dbars:shard:00` … `dbars:shard:63`. Zero-padded so a key listing sorts. */
export const dbarsShardKey = (i: number) => `dbars:shard:${String(i).padStart(2, '0')}`

/** FNV-1a/32, which is stable across hosts and has no dependency — the shard a
 * symbol lives in must be the same number in Node, in workerd and in a test, or
 * a cache written by one host is invisible to the other. The symbol is hashed
 * VERBATIM (no case folding) so `shardIndexFor(k)` is exactly the shard holding
 * key `k`, for every key in the blob. */
export function shardIndexFor(sym: string, shards: number = DBARS_SHARDS): number {
  let h = 0x811c9dc5
  for (let i = 0; i < sym.length; i++) {
    h ^= sym.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % Math.max(1, Math.floor(shards))
}

/** Bars kept per symbol. 300 sessions ≈ 14 months — enough for the 250-session
 * 52-week-high feature with room for the splice to overshoot. */
export const DBARS_MAX = 300
/** Garbage bound only. The incremental refresh below keeps a live name's blob
 * current every run; this TTL just stops a delisted symbol living for ever. It
 * is now enforced TWICE: as the row's own TTL, and as a per-entry prune when a
 * shard is rewritten — a shard's TTL is refreshed on every write, so without
 * the prune a name that left the universe would ride inside it for ever. */
export const DBARS_TTL_SEC = 7 * 86_400
/** How stale a cached tape may be and still be repaired by a `1mo` request.
 * A `1mo` daily series is ~22 sessions; splice a 30-day-old tape onto it and
 * the result is a tape with a HOLE in it, which is worse than no tape at all
 * because every EMA and ATR downstream reads clean. Past this, refetch `1y`. */
export const STALE_SPLICE_MAX_DAYS = 25
/** Default request ceiling for one pass, mirroring discovery.ts's
 * DISCOVERY_MAX_REQUESTS. It counts DISTINCT SYMBOLS ATTEMPTED, never HTTP
 * calls: a retry after a 429 or a 5xx is the same name being read once, and
 * charging the budget for the network's bad temper made the ceiling shrink
 * exactly when the market was busiest. */
export const DEFAULT_MAX_REQUESTS = 3_500

/** A run may not ask Stooq more than this many times (it is a courtesy source
 * and it rate-limits hard — 2026-09-22 it answered a probe with an HTML page). */
export const STOOQ_CALLS_MAX = 50

const YAHOO_UA = 'Mozilla/5.0 (StreetSignal)'
const RETRY_BACKOFF_MS = 500
/** After a 429 the offending worker idles this long before its next request, so
 * the pool's pace halves itself instead of the whole run dying on a wall. */
const RATE_LIMIT_PAUSE_MS = 1_000

export function packBars(candles: readonly Candle[], savedAt: number): PackedBars {
  const kept = candles.slice(-DBARS_MAX)
  return {
    t: kept.map(b => b.t),
    o: kept.map(b => b.o),
    h: kept.map(b => b.h),
    l: kept.map(b => b.l),
    c: kept.map(b => b.c),
    v: kept.map(b => b.v),
    savedAt,
  }
}

export function unpackBars(p: PackedBars | null | undefined): Candle[] {
  if (!p || !Array.isArray(p.t) || !Array.isArray(p.c)) return []
  const out: Candle[] = []
  for (let i = 0; i < p.t.length; i++) {
    const c = p.c[i]
    if (!Number.isFinite(p.t[i]) || !Number.isFinite(c)) continue
    out.push({ t: p.t[i], o: p.o?.[i] ?? c, h: p.h?.[i] ?? c, l: p.l?.[i] ?? c, c, v: p.v?.[i] ?? 0 })
  }
  return out
}

const DAY_SEC = 86_400
const utcDay = (sec: number) => Math.floor(sec / DAY_SEC) * DAY_SEC

/* ─────────────────────── the in-progress session bar ─────────────────────── */

/** The chart meta fields that say whether the tape's last bar is finished.
 * Declared here, not in yahoo.ts: `parseYahooChart` deliberately returns only
 * candles and a quote, and widening its contract for one caller would put a
 * Yahoo implementation detail in front of every other consumer of it. */
export interface YahooChartMeta {
  currentTradingPeriod?: { regular?: { start?: number; end?: number } | null } | null
  regularMarketTime?: number | null
}

/** Seconds past UTC midnight after which every exchange the universe holds has
 * closed: NYSE/Nasdaq 20:00 UTC (EDT) or 21:00 UTC (EST), LSE 15:30/16:30 UTC.
 * Only the no-meta fallback uses it. */
export const ALL_MARKETS_CLOSED_UTC_SEC = 21.5 * 3600

/**
 * Is the tape's last bar TODAY'S UNFINISHED SESSION?
 *
 * WHY THIS IS NOT COSMETIC. Yahoo's daily series grows a bar for the live
 * session the moment it opens, and that bar is a lie in every column the scan
 * reads: its volume is however much has traded so far (RVOL 0.1–0.7× at 10:57
 * ET, so `breakout` — which gates on RVOL ≥ 2 — fired ZERO times in the
 * 2026-09-22 dry run), its close is a quote, and its high/low are partial. The
 * production run is pre-open so it normally never sees one; a throttled cron, a
 * retry, or a human running the scan at lunchtime does, and must not silently
 * scan garbage.
 *
 * The rule, from the chart meta: the bar belongs to the period Yahoo calls
 * current AND that period has not reached its `end`.
 *
 * FALLBACK when the meta is absent or malformed: the bar is dropped when its UTC
 * date is today's and the clock is before {@link ALL_MARKETS_CLOSED_UTC_SEC}.
 * That is an APPROXIMATION and it is wrong in one direction only — between
 * 21:00 and 21:30 UTC in northern winter a finished US bar is thrown away, so
 * the tape reads one session stale and is refetched tomorrow. Discarding a real
 * bar costs a session of freshness; keeping a partial one corrupts every
 * feature in the run.
 */
export function isPartialLastBar(lastT: number, meta: YahooChartMeta | null | undefined, nowSec: number): boolean {
  if (!Number.isFinite(lastT)) return false
  const reg = meta?.currentTradingPeriod?.regular
  const start = typeof reg?.start === 'number' && Number.isFinite(reg.start) ? reg.start : null
  const end = typeof reg?.end === 'number' && Number.isFinite(reg.end) ? reg.end : null
  if (start != null && end != null && end > start) {
    // Outside the current period — a Friday bar read on a Sunday, say — the bar
    // is finished whatever the clock says.
    if (lastT < start || lastT >= end) return false
    // `regularMarketTime` is the exchange's own clock. Taking the LATER of it
    // and ours means a slow local clock cannot make a closed session look live;
    // a stale quote can never make a live session look closed, because a larger
    // `nowSec` always wins.
    const rmt = typeof meta?.regularMarketTime === 'number' && Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime : 0
    return Math.max(nowSec, rmt) < end
  }
  return utcDay(lastT) === utcDay(nowSec) && nowSec - utcDay(nowSec) < ALL_MARKETS_CLOSED_UTC_SEC
}

/** {@link isPartialLastBar} applied: the tape without its live bar, and whether
 * one was taken. Exported for the test and for any future caller that parses a
 * chart itself. */
export function dropPartialBar(
  candles: readonly Candle[],
  meta: YahooChartMeta | null | undefined,
  nowSec: number,
): { candles: Candle[]; dropped: boolean } {
  const last = candles[candles.length - 1]
  if (!last || !isPartialLastBar(last.t, meta, nowSec)) return { candles: [...candles], dropped: false }
  return { candles: candles.slice(0, -1), dropped: true }
}

/** UTC midnight of the most recent session we expect a daily bar for: the
 * PREVIOUS weekday. The engine's daily run is pre-open (05:20 UK), so "the last
 * close that exists" is yesterday's, or Friday's over a weekend.
 *
 * LIMITATION, deliberately: no holiday calendar. On the morning after a market
 * holiday every tape looks one session stale, so the run spends a `1mo` request
 * per name, splices nothing, and moves on — a wasted scan, never a wrong one.
 * The mirror case is a run started AFTER a close: today's bar already exists
 * upstream but this function still points at yesterday, so a warm cache is
 * served and today's bar waits for tomorrow. Callers that need the live session
 * pass a `now` one day ahead. */
export function expectedLastSession(nowSec: number): number {
  let day = utcDay(nowSec) - DAY_SEC
  // 0 = Sunday, 6 = Saturday (epoch day 0 was a Thursday).
  for (let i = 0; i < 7; i++) {
    const dow = new Date(day * 1000).getUTCDay()
    if (dow !== 0 && dow !== 6) return day
    day -= DAY_SEC
  }
  return day
}

/** Merge a freshly fetched tail into a cached tape: newest wins per session,
 * ascending by time, capped at {@link DBARS_MAX}. Keyed by UTC DAY rather than
 * the raw stamp so a source that dates its bars at midnight (Stooq) can never
 * duplicate a session the exchange-open-stamped Yahoo bars already hold. */
export function spliceBars(oldBars: readonly Candle[], newBars: readonly Candle[], max = DBARS_MAX): Candle[] {
  const byDay = new Map<number, Candle>()
  for (const b of oldBars) if (Number.isFinite(b?.t)) byDay.set(utcDay(b.t), b)
  for (const b of newBars) if (Number.isFinite(b?.t)) byDay.set(utcDay(b.t), b)
  return [...byDay.values()].sort((a, b) => a.t - b.t).slice(-max)
}

export interface BarsCache {
  get<T>(k: string): Promise<T | null>
  getMany?<T>(keys: string[]): Promise<Map<string, T>>
  set(k: string, v: unknown, ttlSec: number): Promise<void>
}

export interface FetchUniverseBarsOpts {
  fetchFn?: typeof fetch
  concurrency?: number
  budgetMs?: number
  maxRequests?: number
  now?: () => number
  log?: (line: string) => void
  /** `false` = run with no cache at all: nothing is read, nothing is written.
   * The dry run's `--no-cache`. */
  cache?: BarsCache | false
  /** Test seam. Production always uses {@link DBARS_SHARDS}. */
  shards?: number
}

export interface UniverseBarsStats {
  fetched: number
  fromCache: number
  failed: number
  /** tapes whose last bar was the session still in progress and was discarded */
  partialDropped: number
  /** cache rows written this run — at most one per changed shard */
  shardsWritten: number
  elapsedMs: number
  budgetHit: boolean
}

export interface UniverseBarsResult {
  tapes: Map<string, Candle[]>
  /** Names the budget never let us attempt, in input order. */
  unread: string[]
  /** Names attempted and unreadable — no cache, no fallback. */
  failed: string[]
  stats: UniverseBarsStats
}

const defaultCache: BarsCache = {
  get: getCached,
  getMany: getCachedMany,
  set: setCached,
}

type Plan = 'warm' | 'stale' | 'miss'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function httpStatus(e: unknown): number | null {
  const s = (e as { status?: unknown })?.status
  return typeof s === 'number' ? s : null
}

/** 429 = pace, 5xx and network faults = weather. A 404 is a dead symbol: one
 * attempt, no retry. */
function retryable(e: unknown): boolean {
  const s = httpStatus(e)
  if (s == null) return true // network/parse fault
  return s === 429 || s >= 500
}

async function yahooBars(sym: string, range: '1y' | '1mo', fetchFn: typeof fetch, nowSec: number): Promise<{ candles: Candle[]; partial: boolean }> {
  const { interval } = CANDLE_RANGES[range]
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`
  const res = await fetchFn(url, { headers: { 'User-Agent': YAHOO_UA } })
  if (!res.ok) throw Object.assign(new Error(`yahoo-http-${res.status}`), { status: res.status })
  const json = (await res.json()) as unknown
  // parseYahooChart, not a local parser: it already drops Yahoo's zero-volume
  // pre/post-market placeholder bar, and that bar corrupts RVOL and prev-close.
  // It does NOT surface the meta, and the in-progress-session rule needs it — so
  // the meta is read off the same parsed body here rather than by widening
  // yahoo.ts's contract for one caller.
  const candles = parseYahooChart(json, sym, interval).candles
  const meta = (json as { chart?: { result?: { meta?: YahooChartMeta }[] } })?.chart?.result?.[0]?.meta ?? null
  const cut = dropPartialBar(candles, meta, nowSec)
  return { candles: cut.candles, partial: cut.dropped }
}

/**
 * Daily bars for every symbol given, cheapest route first.
 *
 * Warm cache (last bar ≥ the last expected session) costs no request at all;
 * a stale cache costs one `1mo` request that is spliced onto what we hold; a
 * miss costs one `1y` request. Symbols are consumed in INPUT ORDER by a fixed
 * worker pool, so a caller that puts the names it cares about first keeps them
 * even when the budget cuts the tail (they land in `unread`, not `failed`).
 *
 * The cache is SHARDED (see {@link DBARS_SHARDS}): one `getMany` over the shard
 * keys at the start, and one write per CHANGED shard at the end. Per-symbol
 * planning — warm / stale / miss — is unchanged; only the storage layout is.
 */
export async function fetchUniverseBars(syms: string[], opts: FetchUniverseBarsOpts = {}): Promise<UniverseBarsResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const concurrency = Math.max(1, opts.concurrency ?? 8)
  const budgetMs = opts.budgetMs ?? 120_000
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const shardCount = Math.max(1, Math.floor(opts.shards ?? DBARS_SHARDS))
  const cache: BarsCache | null = opts.cache === false ? null : (opts.cache ?? defaultCache)

  const started = now()
  const wanted = [...new Set(syms.filter(s => typeof s === 'string' && s.length > 0))]
  const tapes = new Map<string, Candle[]>()
  const failed: string[] = []
  const stats: UniverseBarsStats = { fetched: 0, fromCache: 0, failed: 0, partialDropped: 0, shardsWritten: 0, elapsedMs: 0, budgetHit: false }
  if (!wanted.length) return { tapes, unread: [], failed, stats }

  // ONE round trip for the whole universe where the backend can do it (D1's
  // readMany); on Blobs it is 64 parallel gets instead of 1,866.
  const shardOf = new Map<string, number>()
  for (const sym of wanted) shardOf.set(sym, shardIndexFor(sym, shardCount))
  const wantedShards = [...new Set(shardOf.values())].sort((a, b) => a - b)
  const shardBars = new Map<number, Record<string, PackedBars>>()
  // A cache that THREW on the read is not a cache that was empty: writing the
  // shards back would replace tapes we could not see with only the names this
  // run happened to fetch. A read fault therefore disables writing too — the run
  // is cold, and stays cold, rather than destroying what it could not read.
  let cacheUsable = cache != null
  if (cache) {
    try {
      const keys = wantedShards.map(dbarsShardKey)
      const blobs = cache.getMany
        ? await cache.getMany<DbarsShard>(keys)
        : new Map((await Promise.all(keys.map(async k => [k, await cache.get<DbarsShard>(k)] as const))).filter((e): e is [string, DbarsShard] => !!e[1]))
      for (const i of wantedShards) {
        const blob = blobs.get(dbarsShardKey(i))
        shardBars.set(i, blob?.v === 1 && blob.bars && typeof blob.bars === 'object' ? { ...blob.bars } : {})
      }
    } catch (e) {
      cacheUsable = false
      shardBars.clear()
      log(`dbars: shard cache read failed, treating every name as cold and writing nothing — ${String((e as Error)?.message ?? e).slice(0, 120)}`)
    }
  }

  const freshFrom = expectedLastSession(Math.floor(started / 1000))
  const queue: { sym: string; plan: Exclude<Plan, 'warm'>; held: Candle[] }[] = []
  for (const sym of wanted) {
    const held = unpackBars(shardBars.get(shardOf.get(sym)!)?.[sym])
    const last = held.length ? held[held.length - 1] : null
    if (last && utcDay(last.t) >= freshFrom) {
      tapes.set(sym, held)
      stats.fromCache++
      continue
    }
    const gapDays = last ? (started / 1000 - last.t) / DAY_SEC : Infinity
    queue.push({ sym, plan: gapDays <= STALE_SPLICE_MAX_DAYS ? 'stale' : 'miss', held })
  }

  let requests = 0
  let stooqCalls = 0
  let cursor = 0
  const attempted = new Set<string>()
  const dirty = new Set<number>()
  const budgetSpent = () => now() - started >= budgetMs || requests >= maxRequests

  /** Hold a freshly merged tape for the end-of-run shard write. Never called
   * for Stooq bars: a Stooq blob would read as warm next run and keep Yahoo —
   * the better source — untried for a week. */
  const remember = (sym: string, merged: Candle[]) => {
    if (!cacheUsable) return
    const i = shardOf.get(sym)!
    let bucket = shardBars.get(i)
    if (!bucket) shardBars.set(i, (bucket = {}))
    bucket[sym] = packBars(merged, Math.floor(now() / 1000))
    dirty.add(i)
  }

  const worker = async () => {
    // Worker-local, not pool-global: one symbol's rate limit should slow the
    // hand that hit it, not stall seven healthy workers.
    let pauseNext = false
    for (;;) {
      // Claim first, THEN check the budget: a run that read every name and
      // happened to finish a millisecond past `budgetMs` did not hit a budget,
      // and a stat that says it did would send someone hunting a phantom.
      const i = cursor++
      if (i >= queue.length) return
      const job = queue[i]
      if (budgetSpent()) {
        stats.budgetHit = true
        // BARS WE ALREADY HOLD COST NOTHING — no request, no second of the
        // clock. A budget caps what the run may SPEND; it is not a reason to
        // throw away a tape that is already in hand. Serving it here is what
        // makes `unread` mean "we have nothing for this name" rather than "we
        // did not fetch it", and it keeps the stats columns a partition.
        if (job.held.length) {
          tapes.set(job.sym, job.held)
          stats.fromCache++
        }
        // …and the loop CONTINUES rather than returning, so the rest of the cut
        // tail is served from cache too. `attempted` is untouched throughout, so
        // a name with nothing held still lands in `unread`.
        continue
      }
      attempted.add(job.sym)

      let bars: Candle[] | null = null
      let spent = false
      for (let attempt = 0; attempt < 2 && bars === null; attempt++) {
        if (pauseNext) {
          pauseNext = false
          await sleep(RATE_LIMIT_PAUSE_MS)
        }
        // THE BUDGET COUNTS NAMES, NOT CALLS. Charged once, at the first attempt
        // on a symbol; the retry a 429 or a 500 forces is the SAME name being
        // read, and counting it made a flaky morning quietly cut the tail of the
        // universe — the run would read fewer names precisely when Yahoo was
        // rate-limiting, which is when the retry exists.
        if (attempt === 0) {
          if (requests >= maxRequests) {
            stats.budgetHit = true
            spent = true
            attempted.delete(job.sym) // never asked → it belongs in `unread`
            break
          }
          requests++
        }
        try {
          const got = await yahooBars(job.sym, job.plan === 'stale' ? '1mo' : '1y', fetchFn, Math.floor(now() / 1000))
          bars = got.candles
          if (got.partial) stats.partialDropped++
        } catch (e) {
          if (httpStatus(e) === 429) pauseNext = true
          if (attempt === 0 && retryable(e)) {
            await sleep(RETRY_BACKOFF_MS)
            continue
          }
          log(`dbars ${job.sym}: ${String((e as Error)?.message ?? e).slice(0, 80)}`)
          break
        }
      }

      if (bars && bars.length) {
        const merged = job.plan === 'stale' ? spliceBars(job.held, bars) : bars.slice(-DBARS_MAX)
        tapes.set(job.sym, merged)
        stats.fetched++
        remember(job.sym, merged)
        continue
      }

      // Yahoo refused (or the request budget ran out mid-retry, or every bar it
      // sent was the live one). Stale bars beat no bars: the pure layer's
      // staleness rule decides whether they are usable, which is not this
      // module's call.
      if (job.held.length) {
        tapes.set(job.sym, job.held)
        stats.fromCache++
        continue
      }
      if (spent) {
        if (attempted.has(job.sym)) {
          failed.push(job.sym)
          stats.failed++
        }
        // the claim loop above now drains what is left from cache; nothing more
        // will be fetched, because `budgetSpent()` is true from here on
        continue
      }
      if (stooqCalls < STOOQ_CALLS_MAX) {
        stooqCalls++
        const stooq = await fetchStooqCandles(job.sym, fetchFn).catch(() => null)
        if (stooq?.length) {
          tapes.set(job.sym, stooq.slice(-DBARS_MAX))
          stats.fetched++
          continue
        }
      }
      failed.push(job.sym)
      stats.failed++
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))

  // ONE WRITE PER CHANGED SHARD, at the end. A shard nothing new landed in is
  // not rewritten at all, so a fully warm run costs zero writes as well as zero
  // requests.
  if (cache && cacheUsable && dirty.size) {
    const cutoff = Math.floor(now() / 1000) - DBARS_TTL_SEC
    const lost: string[] = []
    let lastErr = ''
    for (const i of [...dirty].sort((a, b) => a - b)) {
      const bucket = shardBars.get(i) ?? {}
      // Prune on the way out: the row's TTL is refreshed by this very write, so
      // a name that left the universe would otherwise ride inside its shard for
      // ever and the blob would only ever grow.
      const bars: Record<string, PackedBars> = {}
      for (const [k, v] of Object.entries(bucket)) if (v && (!Number.isFinite(v.savedAt) || v.savedAt >= cutoff)) bars[k] = v
      try {
        await cache.set(dbarsShardKey(i), { v: 1, bars } as DbarsShard, DBARS_TTL_SEC)
        stats.shardsWritten++
      } catch (e) {
        lost.push(dbarsShardKey(i))
        lastErr = String((e as Error)?.message ?? e).slice(0, 80)
      }
    }
    // ONCE, not once per shard and certainly not once per symbol: a failed shard
    // costs the run nothing but next run's warm start for the ~39 names in it.
    if (lost.length) log(`dbars: ${lost.length}/${dirty.size} shard cache writes failed (${lost.join(', ')}) — ${lastErr}`)
  }

  // Workers finish out of order; both lists are re-sorted to input order so the
  // run is reproducible whatever the network did.
  const rank = new Map(wanted.map((s, i) => [s, i]))
  failed.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  // UNREAD IS "WE HAVE NOTHING FOR IT", not "we did not fetch it". A name the
  // request budget cut can still have been served its cached tape a few lines
  // above; it is `fromCache` and it faces the lenses like any other. Listing it
  // here as well double-counted it (fromCache AND failed, via runDiscovery's
  // sum) and made the pure layer reject a name whose bars it was holding.
  // With this, the four columns partition the universe exactly:
  //   fetched + fromCache + failed + unread === symbols asked for.
  const unread = queue.filter(j => !attempted.has(j.sym) && !tapes.has(j.sym)).map(j => j.sym)
  if (unread.length) stats.budgetHit = true
  stats.elapsedMs = now() - started
  log(
    `dbars: ${stats.fetched} fetched, ${stats.fromCache} cached, ${stats.failed} failed, ${unread.length} unread, ` +
      `${stats.partialDropped} partial bars dropped in ${(stats.elapsedMs / 1000).toFixed(1)}s (${requests} requests, ${stats.shardsWritten} shard writes)`,
  )
  return { tapes, unread, failed, stats }
}
