// The discovery run: the only impure thing in the scan.
//
// Pure core (shared/engine/discovery) decides WHAT is interesting; this file
// gets it the bars, gets the universe out of and back into the store, and
// merges the two halves' statistics into one honest number set. Nothing here
// scores, ranks or rejects a name — if it looks like it is about to, it belongs
// in the pure layer where a test can reach it without a fetch.
//
// See docs/superpowers/specs/2026-09-22-discovery-engine-v2-design.md.

import { fetchUniverseBars, type BarsCache } from './discoveryBars'
import type { AppStore } from './store'
import { buildUniverse, type UniverseNomination } from '../../../shared/engine/discovery/universe'
import { discoverPure } from '../../../shared/engine/discovery/index'
import type { UniverseSeedRow } from '../../../shared/engine/discovery/universeSeedBuild'
import { DYNAMIC_UNIVERSE_KEY, DISCOVERY_TRACE_KEY, type DiscoveryResult, type DynamicUniverseState } from '../../../shared/engine/discovery/types'
import type { Candle } from '../../../shared/types'

/** Production wall-clock budget for the whole bars pass. Generous on purpose:
 * the measured full-universe cold scan is ~30 s, so 150 s is four times the
 * worst honest case and still well inside a scheduled run. */
export const DISCOVERY_BUDGET_MS = 150_000
/**
 * Hard request ceiling for one run — the backstop for a cache that has gone
 * missing and a universe that has grown.
 *
 * 3,500, and the arithmetic matters: the ceiling on the universe is the
 * committed seed (1,866 names today) plus DYNAMIC_UNIVERSE_MAX (600) = 2,466,
 * every one of which costs a request on a fully cold run. 2,500 left 34 names
 * of headroom — less than a single bad morning — so the FIRST cold run after a
 * cache wipe would have cut the tail of the universe and called it a budget.
 * 3,500 is ~40% headroom over the worst honest case and still a real backstop.
 *
 * A retry does NOT count against it (discoveryBars charges the budget once per
 * DISTINCT SYMBOL attempted): a 429 is the network's bad temper, and letting it
 * consume the ceiling shrank the scan exactly when Yahoo was throttling. */
export const DISCOVERY_MAX_REQUESTS = 3_500

/** The kill switch. `DISCOVERY=off` takes the whole stage out and leaves the
 * legacy screens/sleeve path exactly as it was. */
export function discoveryDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.DISCOVERY ?? '').trim().toLowerCase() === 'off'
}

/**
 * MAY THIS HOST RUN THE SCAN AT ALL?
 *
 * A Cloudflare Worker or Pages Function gets FIFTY subrequests per invocation.
 * The scan's cold pass is ~1,866 fetches; even the warm pass is 64 cache reads
 * plus whatever the tail needs. Run inside a Pages Function it would not merely
 * fail — it would exhaust the invocation's budget and take the REST of the run
 * (quotes, news, the board write) down with it, at the one place the failure
 * reads as "the morning paper is broken" rather than "the scan is off".
 *
 * Node has no such cap, so Actions and Netlify Functions — where the daily run
 * actually happens — are the hosts that may scan. `DISCOVERY=on` is the explicit
 * override for anyone who knows better (a Worker with a tiny universe, a test).
 *
 * Deliberately NOT a sniff inside this function: the caller passes the host,
 * which it gets from runtimeEnv's `runtimeHost()` — the one place in the repo
 * that knows where we are — so this stays pure and testable.
 */
export function discoveryAllowedOnHost(env: Record<string, string | undefined> = process.env, hostIsNode: boolean): boolean {
  if (String(env.DISCOVERY ?? '').trim().toLowerCase() === 'on') return true
  return hostIsNode
}

/** `DISCOVERY_BUDGET_MS` env override, falling back to the production default.
 * Anything unparseable or ≤ 0 is ignored rather than obeyed — a typo must not
 * silently reduce the scan to nothing. */
export function discoveryBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.DISCOVERY_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DISCOVERY_BUDGET_MS
}

/** The universe layer's nomination shape verbatim — aliased rather than
 * redeclared so the two cannot drift. */
export type DiscoveryNomination = UniverseNomination

export interface RunDiscoveryInput {
  date: string
  store: AppStore
  seed: UniverseSeedRow[]
  nominations: DiscoveryNomination[]
  /** SPY's own tape, for the relative-strength features. Null = RS goes null. */
  spy: Candle[] | null
  isEtp: (sym: string) => boolean
  fetchFn?: typeof fetch
  budgetMs?: number
  maxRequests?: number
  concurrency?: number
  log?: (line: string) => void
  /** `false` = no bars cache at all (the dry run's `--no-cache`). */
  cache?: BarsCache | false
}

/**
 * FETCH ORDER, which is also the budget's priority order:
 *
 *   1. today's nominations — a name the screens/social/news just flagged is the
 *      freshest signal in the run, and a budget cut at the tail must never be
 *      the reason it went unseen;
 *   2. seed members — the committed index universe, the scan's backbone;
 *   3. surviving dynamic members — yesterday's nominees, the most expendable.
 *
 * Within each group the order is the caller's, so two runs over the same inputs
 * read the same names in the same sequence.
 */
export function orderUniverseForFetch(members: Map<string, { origins: string[] }>, nominations: readonly DiscoveryNomination[]): string[] {
  const nominatedToday = new Set(nominations.map(n => n.sym))
  const first: string[] = []
  const seedRows: string[] = []
  const dynamic: string[] = []
  for (const [sym, m] of members) {
    if (nominatedToday.has(sym)) first.push(sym)
    else if (m.origins.some(o => o.startsWith('seed:'))) seedRows.push(sym)
    else dynamic.push(sym)
  }
  return [...first, ...seedRows, ...dynamic]
}

/** Best effort, never fatal: a store that refuses a write costs the run its
 * memory, not its answer. */
async function writeSoft(store: AppStore, key: string, value: unknown, log: (line: string) => void): Promise<void> {
  try {
    await store.write(key, value)
  } catch (e) {
    log(`discovery: ${key} write failed — ${String((e as Error)?.message ?? e).slice(0, 120)}`)
  }
}

export async function runDiscovery(input: RunDiscoveryInput): Promise<DiscoveryResult> {
  const { date, store, seed, nominations, spy, isEtp } = input
  const log = input.log ?? (() => {})
  const startedMs = Date.now()

  let dynamic: DynamicUniverseState | null = null
  try {
    dynamic = await store.read<DynamicUniverseState>(DYNAMIC_UNIVERSE_KEY)
  } catch (e) {
    log(`discovery: dynamic universe read failed, starting from the seed alone — ${String((e as Error)?.message ?? e).slice(0, 120)}`)
  }

  const { members, nextDynamic, nominators } = buildUniverse(seed, dynamic, nominations, date)
  const order = orderUniverseForFetch(members, nominations)

  const bars = await fetchUniverseBars(order, {
    fetchFn: input.fetchFn,
    concurrency: input.concurrency,
    budgetMs: input.budgetMs ?? DISCOVERY_BUDGET_MS,
    maxRequests: input.maxRequests ?? DISCOVERY_MAX_REQUESTS,
    log,
    cache: input.cache,
  })

  const result = discoverPure({ date, members, nominators, tapes: bars.tapes, spy, isEtp, unread: bars.unread })

  // The pure layer cannot know what the wire cost; this is the one place the
  // two halves' numbers meet, so they are reconciled here rather than guessed
  // at either end.
  let seedSize = 0
  for (const m of members.values()) if (m.origins.some(o => o.startsWith('seed:'))) seedSize++
  const stats = {
    ...result.stats,
    universeSize: members.size,
    seedSize,
    dynamicSize: members.size - seedSize,
    // FOUR COLUMNS THAT PARTITION THE UNIVERSE:
    //   fetched + fromCache + failed + unread === universeSize.
    // They used to be three, with `barsFailed` summing the unreadable and the
    // never-attempted — so a name the budget cut but the CACHE served was
    // counted in `fromCache` and in `barsFailed` at once, coverage read low, and
    // no column could be trusted to mean one thing. The trace keeps the reasons
    // apart ('no-bars' vs 'budget-cut'); these keep the arithmetic honest.
    barsFetched: bars.stats.fetched,
    barsFromCache: bars.stats.fromCache,
    barsFailed: bars.stats.failed,
    barsUnread: bars.unread.length,
    // Bars-layer number, carried through because it is the one stat that says
    // "this run read an unfinished session and threw it away". A non-zero value
    // pre-open is a bug; a non-zero value at lunchtime is the guard working.
    partialDropped: bars.stats.partialDropped,
    budgetHit: bars.stats.budgetHit,
    elapsedMs: Date.now() - startedMs,
  }

  await writeSoft(store, DYNAMIC_UNIVERSE_KEY, nextDynamic, log)
  await writeSoft(store, DISCOVERY_TRACE_KEY(date), { date, stats, rows: result.trace }, log)

  // The reject counts go in the LINE, not just the blob: the trace is bounded at
  // 400 rows and ordered near-misses first, so a code that rejected 139 names
  // could be read by nobody, anywhere.
  const rejectSummary = Object.entries(stats.rejects)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code} ${n}`)
    .join(', ')
  log(
    `discovery ${date}: universe ${stats.universeSize} (seed ${stats.seedSize} + dynamic ${stats.dynamicSize}), ` +
      `bars ${stats.barsFetched} fetched / ${stats.barsFromCache} cached / ${stats.barsFailed} failed / ${stats.barsUnread} unread` +
      `${stats.partialDropped ? ` / ${stats.partialDropped} partial dropped` : ''}, ` +
      `scanned ${stats.scanned}, selected ${stats.selected} in ${(stats.elapsedMs / 1000).toFixed(1)}s${stats.budgetHit ? ' (BUDGET HIT)' : ''}` +
      `${rejectSummary ? ` · rejects: ${rejectSummary}` : ''}`,
  )

  // `tapes` rides along so buildBoard reuses the bars the scan already holds
  // instead of fetching a candidate's candles a second time (design §4.6).
  return { ...result, stats, tapes: bars.tapes }
}
