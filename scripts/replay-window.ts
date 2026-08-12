// WINDOW REPLAY — drives the REAL `buildBoard` day by day over a date window,
// with strict point-in-time discipline: on replayed date D the engine may only
// see candle bars that closed STRICTLY BEFORE D (the live 05:20 run sees the
// same thing — D's bar does not exist yet).
//
// This is NOT scripts/engine-replay.ts. That one drives `composeCall` over a
// fixed 50-name universe on 5 Mondays and cannot see the sleeve, the dip lane,
// the roster, the near-miss rows or the sizing tiers — i.e. it cannot measure
// Stage 1 at all. This script runs the whole daily brain: gradeOutstanding →
// buildBoard, against an in-memory AppStore whose blobs CARRY across days, so
// the roster, calibration, risk ladder and prediction ledger all evolve exactly
// as they would over a real month.
//
// PRICE-ONLY. Every non-price dependency is empty (see `makeDeps`): no LLM, no
// social, no news, no insiders, no 13F, no earnings calendar, no broker book.
// That is the same honesty rule the deep seed follows (spec §4.4) — a replay
// must never invent evidence it cannot reconstruct. The approximations are
// listed in docs/superpowers/plans/2026-08-11-stage1-replay-results.md and they
// apply IDENTICALLY to both runs, which is what makes the comparison fair.
//
// Baseline: this script is COPIED into a `git worktree` checkout of the
// pre-Stage-1 commit and run there with --baseline (no LEGACY_BOARD branch is
// ever added to production engine code). --baseline also withholds the
// `day_losers` screen, because that screen is a Stage-1 addition that lives in
// defaultDeps rather than in buildBoard, so the harness must withhold it itself.
//
// Run:
//   npx vite-node scripts/replay-window.ts -- --from 2026-07-14 --to 2026-08-11 --out /tmp/new.json
//   npx vite-node scripts/replay-window.ts -- --baseline --out /tmp/base.json
// Candles are cached in ./.replay-cache (gitignored); REPLAY_CACHE_DIR overrides
// it, which is how the baseline worktree reads the SAME bars as the new run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import type { Candle } from '../shared/types'
import type { Prediction } from '../shared/engine/types'
import type { ScreenRow } from '../netlify/functions/lib/screener'
import { fetchYahooChart } from '../netlify/functions/lib/yahoo'
import { VIX_SYMBOL, WORLD_SYMBOLS } from '../shared/engine/worldTape'
import { gradePrediction } from '../shared/engine/calibration'
import { buildBoard, gradeOutstanding } from '../netlify/functions/lib/engine'

// ---------------------------------------------------------------- universe --
// A LITERAL copy of DEFAULT_CORE_SLEEVE. It is copied, not imported, because
// this same file has to run inside the pre-Stage-1 worktree where
// shared/engine/coreSleeve.ts does not exist — and because both runs MUST
// synthesise their screens off the identical universe or the comparison would
// be measuring the universe, not the engine. scripts/replay-window.test.ts
// asserts the copy still covers every DEFAULT_CORE_SLEEVE name, so it cannot
// silently drift.
export const SLEEVE_MIRROR: string[] = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'INTC',
  'CRM', 'ORCL', 'ADBE', 'NFLX', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'KLAC',
  'NOW', 'UBER', 'ABNB', 'SHOP', 'SNOW', 'PANW', 'CRWD', 'ZS', 'DDOG', 'NET',
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'SOFI', 'RBLX', 'DKNG', 'RIVN', 'LCID', 'SMCI',
  'ARM', 'DELL', 'IONQ', 'RGTI', 'AAOI', 'APP', 'CVNA', 'AFRM', 'UPST', 'RKLB',
  'JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'V', 'MA', 'AXP', 'BLK',
  'UNH', 'LLY', 'JNJ', 'PFE', 'MRK', 'ABBV', 'TMO', 'AMGN', 'GILD', 'CVS',
  'CAT', 'DE', 'BA', 'GE', 'HON', 'LMT', 'RTX', 'NOC', 'UPS', 'FDX',
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'FCX', 'NEM', 'GLW', 'MMM', 'DOW',
  'WMT', 'COST', 'TGT', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'DIS', 'CMCSA',
  'PG', 'KO', 'PEP', 'PM', 'T', 'VZ', 'TMUS', 'CSCO', 'IBM', 'PYPL',
  'RR.L', 'BP.L', 'SHEL.L', 'AZN.L', 'GSK.L', 'HSBA.L', 'BARC.L', 'LLOY.L', 'VOD.L', 'BT-A.L',
  'GLEN.L', 'RIO.L', 'AAL.L', 'TSCO.L', 'MKS.L', 'IAG.L', 'RMV.L', 'BA.L', 'STAN.L', 'PRU.L',
]

/** The live window's own picks plus the owner's trade — the names the board
 * actually named between 14 Jul and 11 Aug. Included so the replay is scored on
 * the same tickers the owner watched, not a synthetic pool. */
export const MIRROR_EXTRAS: string[] = [
  'NRGV', 'PATH', 'JACK', 'ETH-USD', 'MS', 'AVEX', 'MSTR', '3CON.L', 'SANA', 'RR.L',
  'IRWD', 'MX', 'RR', 'GS', 'GOOGL', 'XOM', 'UROY', 'TSLA', 'KTOS', 'EFOR', 'VZLA', 'GLW',
]

export const REPLAY_UNIVERSE: string[] = [...new Set([...SLEEVE_MIRROR, ...MIRROR_EXTRAS])]

/** Index/futures series the world-tape read needs — price-only, so the replay
 * can serve them honestly from the same candle cache. */
const WORLD_TAPE_SYMS = [...WORLD_SYMBOLS, VIX_SYMBOL].map(w => w.sym)

// --------------------------------------------------------------- pure bits --

/** Bars the engine may see on replayed date D: everything that closed STRICTLY
 * before D. The live 05:20 run sees exactly this — D's own bar does not exist
 * yet — and gradePrediction then bases the outcome on D's OPEN. */
export function sliceBefore(candles: Candle[], dateISO: string): Candle[] {
  const cutoff = Date.parse(`${dateISO}T00:00:00Z`) / 1000
  return candles.filter(c => c.t < cutoff)
}

/** Trading days in [from, to], derived from a real index series rather than
 * calendar guessing, so holidays are handled by the exchange itself. */
export function tradingDays(index: Candle[], fromISO: string, toISO: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of index) {
    const iso = new Date(c.t * 1000).toISOString().slice(0, 10)
    if (iso < fromISO || iso > toISO || seen.has(iso)) continue
    seen.add(iso)
    out.push(iso)
  }
  return out.sort()
}

export interface ScreenSynthOpts {
  /** false in --baseline: the losers screen is a Stage-1 addition to defaultDeps. */
  includeLosers: boolean
  /** Yahoo's predefined screeners return 25 rows (screener.ts slices to 25). */
  count?: number
}

/** APPROXIMATION (documented in the results doc). The real engine reads Yahoo's
 * predefined day_gainers / day_losers / most_actives / small_cap_gainers over
 * the WHOLE US market, and those endpoints have no point-in-time form. Here the
 * three price-derivable screens are recomputed from the replay universe's own
 * bars: top |1-day move| gainers, losers, and top $-volume actives. small_cap
 * gainers cannot be synthesised at all (no point-in-time market caps) and is
 * simply absent from both runs. */
export function synthScreens(bars: Map<string, Candle[]>, opts: ScreenSynthOpts): { row: ScreenRow; source: string }[] {
  const n = opts.count ?? 25
  const rows: { sym: string; changePct: number; dollarVol: number; price: number }[] = []
  for (const [sym, cs] of bars) {
    if (cs.length < 2) continue
    const last = cs[cs.length - 1]
    const prev = cs[cs.length - 2]
    if (!prev.c) continue
    rows.push({ sym, changePct: (last.c / prev.c - 1) * 100, dollarVol: last.c * last.v, price: last.c })
  }
  const toRow = (r: (typeof rows)[number]): ScreenRow => ({
    sym: r.sym,
    price: Math.round(r.price * 100) / 100,
    capUsdM: null, // no point-in-time market caps in a price-only replay
    changePct: Math.round(r.changePct * 10) / 10,
    name: null,
  })
  const out: { row: ScreenRow; source: string }[] = []
  for (const r of rows.filter(r => r.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, n)) out.push({ row: toRow(r), source: 'screener:gainers' })
  if (opts.includeLosers)
    for (const r of rows.filter(r => r.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, n)) out.push({ row: toRow(r), source: 'screener:losers' })
  for (const r of [...rows].sort((a, b) => b.dollarVol - a.dollarVol).slice(0, n)) out.push({ row: toRow(r), source: 'screener:actives' })
  return out
}

/** The spark batch, reconstructed from the candle cache: 3 months of daily
 * closes per requested name, keyed UPPERCASE exactly like parseSpark. Names
 * with too little history are simply absent — the same fail-soft shape a
 * refused Yahoo chunk produces, which the engine already handles. */
export function sparkClosesFrom(bars: Map<string, Candle[]>, syms: string[], barsBack = 63, minBars = 30): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const raw of syms) {
    const key = raw.toUpperCase()
    const cs = bars.get(key)
    if (!cs || cs.length < minBars) continue
    out.set(key, cs.slice(-barsBack).map(c => c.c))
  }
  return out
}

export interface BoardShape {
  trades: number
  watch: number
  nearMiss: number
  /** Sides with no NAMED row at all (near misses count as named). 0..2. */
  blankSides: number
  /** Sides with no sized trade. 0..2. */
  tradelessSides: number
  /** Named something, sized nothing — "the engine has a view but no trade". */
  namedNoTrades: boolean
  /** Nothing at all on the reader's board. The failure Stage 1 exists to kill. */
  blankBoard: boolean
}

/** Which doors a name could have walked through on a given day. Answers
 * criterion 2's "was it even a candidate?" without touching engine code: the
 * screens are the ones this harness handed over, the sleeve rank is the real
 * rankSleeve, and the roster is the carried blob. */
export function doorsFor(
  sym: string,
  screens: { row: { sym: string }; source: string }[],
  sleeveTop: string[],
  rosterSyms: string[],
): string[] {
  const key = sym.toUpperCase()
  const doors = [...new Set(screens.filter(s => s.row.sym.toUpperCase() === key).map(s => s.source))]
  if (sleeveTop.some(s => s.toUpperCase() === key)) doors.push('sleeve-top40')
  if (rosterSyms.some(s => s.toUpperCase() === key)) doors.push('roster')
  return doors
}

export function summariseBoard(board: Pick<Prediction, 'side' | 'watchOnly' | 'nearMiss'>[]): BoardShape {
  const trades = board.filter(r => !r.nearMiss && !r.watchOnly)
  const watch = board.filter(r => !r.nearMiss && r.watchOnly)
  const nearMiss = board.filter(r => r.nearMiss)
  const sides = ['long', 'short'] as const
  return {
    trades: trades.length,
    watch: watch.length,
    nearMiss: nearMiss.length,
    blankSides: sides.filter(s => !board.some(r => r.side === s)).length,
    tradelessSides: sides.filter(s => !trades.some(r => r.side === s)).length,
    namedNoTrades: trades.length === 0 && board.length > 0,
    blankBoard: board.length === 0,
  }
}

// ------------------------------------------------------------ candle cache --

// Repo-relative by default (gitignored) so the harness is runnable by anyone on
// any machine — a hard-coded session scratch path made it a one-laptop script.
// Resolved from THIS FILE, not from process.cwd(): run the script from a
// subdirectory and a cwd-relative path silently starts a second, empty cache,
// which re-downloads a year of bars and — worse — compares two runs against two
// different sets of candles. In the baseline worktree the same expression
// resolves to that worktree's own root, which is exactly what it should mean.
// REPLAY_CACHE_DIR still overrides, which is how a baseline worktree shares the
// SAME candles as the new run (a comparison across two caches is not a comparison).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CACHE_DIR = join(REPO_ROOT, '.replay-cache')
const CACHE_DIR = process.env.REPLAY_CACHE_DIR ?? DEFAULT_CACHE_DIR
/** How many bars a live `cachedCandles` call returns (Yahoo range=1y). The
 * cache holds 5y so `candles5y` can serve seasonality, but `candles` is trimmed
 * to the 1y window the production engine actually reads. */
const ONE_YEAR_BARS = 252

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cacheFile = (sym: string) => join(CACHE_DIR, `${sym.replace(/[^A-Za-z0-9]/g, '_')}.json`)

let active = 0
const waiters: (() => void)[] = []
/** ~2 concurrent Yahoo requests, small gap between starts. Yahoo throttles hard
 * and a 429 storm would poison the whole run's cache. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>(r => waiters.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    const next = waiters.shift()
    if (next) setTimeout(next, 120)
  }
}

const missing: { sym: string; error: string }[] = []
const memo = new Map<string, Promise<Candle[] | null>>()

async function fetchWithRetry(sym: string): Promise<{ candles: Candle[] | null; error?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 5y once: `candles` is trimmed to a 1y tail, `candles5y` gets the lot —
      // one fetch per symbol instead of two.
      const { candles } = await withSlot(() => fetchYahooChart(sym, '5y'))
      return { candles }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (attempt === 0 && /429|yahoo-http-5\d\d|fetch failed|ETIMEDOUT|ECONNRESET/i.test(msg)) {
        console.log(`  ${sym}: ${msg} — backing off 30s and retrying once`)
        await sleep(msg.includes('429') ? 30_000 : 3_000)
        continue
      }
      return { candles: null, error: msg }
    }
  }
  return { candles: null, error: 'retries-exhausted' }
}

/** Full (untruncated) history for a symbol: disk cache → Yahoo. A symbol Yahoo
 * will not serve is recorded as MISSING and stays null forever — a replay never
 * synthesises a price it could not fetch. */
function fullHistory(sym: string): Promise<Candle[] | null> {
  const key = sym.toUpperCase()
  const hit = memo.get(key)
  if (hit) return hit
  const p = (async (): Promise<Candle[] | null> => {
    const file = cacheFile(key)
    if (existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as { candles?: Candle[]; missing?: boolean; error?: string }
        if (j.missing) {
          missing.push({ sym: key, error: j.error ?? 'unknown' })
          return null
        }
        if (Array.isArray(j.candles)) return j.candles
      } catch {
        /* corrupt cache entry — refetch */
      }
    }
    const { candles, error } = await fetchWithRetry(key)
    if (!candles || !candles.length) {
      missing.push({ sym: key, error: error ?? 'empty' })
      writeFileSync(file, JSON.stringify({ sym: key, missing: true, error: error ?? 'empty' }))
      return null
    }
    writeFileSync(file, JSON.stringify({ sym: key, range: '5y', at: Date.now(), candles }))
    return candles
  })()
  memo.set(key, p)
  return p
}

// ------------------------------------------------------------------- store --

/** In-memory AppStore. JSON round-trips on write AND read, so the engine cannot
 * mutate stored state through a retained reference — Netlify Blobs serialises,
 * and a replay that let objects alias would quietly diverge from production. */
function makeStore() {
  const m = new Map<string, string>()
  return {
    store: {
      async read<T>(key: string): Promise<T | null> {
        const v = m.get(key)
        return v === undefined ? null : (JSON.parse(v) as T)
      },
      async write(key: string, value: unknown): Promise<void> {
        m.set(key, JSON.stringify(value ?? null))
      },
    },
    raw: m,
  }
}

// -------------------------------------------------------------------- deps --

interface DipModule {
  classifyDip: (candles: Candle[]) => { triggered: boolean; holding: boolean; dropPct: number; detail: string } | null
  dipCall: (sym: string, candles: Candle[], read: unknown, capUsdM: number | null) => unknown
}

interface DayCtx {
  date: string
  bars: Map<string, Candle[]>
  screens: { row: ScreenRow; source: string }[]
  /** Exact record of every symbol buildBoard asked for candles on today —
   * the honest instrument for "was this name a candidate?", and it needs no
   * change to engine code. Includes SPY/QQQ/^VIX and the 11 sector ETFs. */
  asked: Set<string>
}

function makeDeps(ctx: { current: DayCtx }) {
  const sliced = async (sym: string): Promise<Candle[] | null> => {
    const full = await fullHistory(sym)
    if (!full) return null
    const s = sliceBefore(full, ctx.current.date)
    return s.length ? s : null
  }
  return {
    candles: async (sym: string) => {
      ctx.current.asked.add(sym.toUpperCase())
      const s = await sliced(sym)
      return s ? s.slice(-ONE_YEAR_BARS) : null
    },
    candles5y: sliced,
    // No point-in-time market-cap source exists for free. Every name therefore
    // runs cap-unknown: cohortless calibration buckets, no small-cap stop
    // widening, and the dip lane's >$10B quality door is shut (sleeve
    // membership is the only way in). Identical in both runs.
    capUsdM: async () => null,
    companyName: async () => null,
    screens: async () => ctx.current.screens,
    sparkCloses: async (syms: string[]) => sparkClosesFrom(ctx.current.bars, syms),
    social: async () => [],
    insiderCoverage: async () => new Map(),
    smartMoney: async () => [],
    mediaTitles: async () => [],
    newsCatalysts: async () => [],
    dipNewsCached: async () => null,
    dipNews: async () => ({ verdict: 'unclear' as const, reason: 'replay — news not replayable' }),
    recentIpos: async () => [],
    earningsSyms: async () => new Set<string>(),
    earningsCalendar: async () => [],
    // Price-only and therefore honestly replayable — but one session stale
    // relative to production (the 05:20 run sees Asia's CURRENT session; the
    // replay only has bars that closed before D).
    worldReads: async () =>
      Promise.all(
        [...WORLD_SYMBOLS, VIX_SYMBOL].map(async ({ sym, name }) => {
          const c = await sliced(sym)
          const changePct = c && c.length >= 2 && c[c.length - 2].c ? ((c[c.length - 1].c - c[c.length - 2].c) / c[c.length - 2].c) * 100 : null
          return { sym, name, changePct: changePct == null ? null : Math.round(changePct * 100) / 100 }
        }),
      ),
    holdings: async () => null,
  }
}

// -------------------------------------------------------------------- main --

interface Row {
  sym: string
  side: 'long' | 'short'
  grade: string
  riskPct: number
  composite: number
  probability: number
  entry: number
  stop: number
  target: number
  watchOnly: boolean
  nearMiss: boolean
  shadow: boolean
  belowBase: boolean
  contract: boolean
  catalyst: string | null
  setup: string | null
  where: 'board' | 'ledger'
  outcome5?: { hit: boolean; excessPct: number; stopped: boolean } | null
  outcome10?: { hit: boolean; excessPct: number; stopped: boolean } | null
}

interface DayOut {
  date: string
  regime: string
  rosterSize: number
  ms: number
  shape: BoardShape
  board: Row[]
  ledger: Row[]
  dips: { sym: string; triggered: boolean; holding: boolean; dropPct: number; constructed: boolean }[]
  /** per-name candidacy trace for the --watch list (criterion 2) */
  watched: { sym: string; doors: string[]; evaluated: boolean }[]
  candidatesAsked: number
}

const rowOf = (p: Prediction, where: 'board' | 'ledger'): Row => ({
  sym: p.sym,
  side: p.side,
  grade: p.grade,
  riskPct: p.riskPct,
  composite: p.composite,
  probability: p.probability,
  entry: p.entry,
  stop: p.stop,
  target: p.target,
  watchOnly: !!p.watchOnly,
  nearMiss: !!p.nearMiss,
  shadow: !!p.shadow,
  belowBase: !!(p as { belowBase?: boolean }).belowBase,
  contract: !!p.evidence?.contract,
  catalyst: p.catalyst?.kind ?? null,
  setup: p.setup ?? null,
  where,
})

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const baseline = process.argv.includes('--baseline')
  const from = arg('from', '2026-07-14')
  const to = arg('to', '2026-08-11')
  const appetite = arg('appetite', 'aggressive') as 'moderate' | 'aggressive'
  const limitDays = Number(arg('days', '0')) || 0
  const watchList = arg('watch', 'GLW').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  const outPath = arg('out', join(CACHE_DIR, `replay-${baseline ? 'baseline' : 'new'}.json`))
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    /* not a repo — fine */
  }

  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`replay-window: mode=${baseline ? 'BASELINE' : 'NEW'} commit=${commit} window=${from}..${to} appetite=${appetite}`)
  console.log(`cache: ${CACHE_DIR}`)

  // ---- warm the cache: the replay universe + the index/world series ----
  const warm = [...new Set([...REPLAY_UNIVERSE, 'SPY', 'QQQ', ...WORLD_TAPE_SYMS])]
  console.log(`warming ${warm.length} symbols…`)
  let done = 0
  await Promise.all(
    warm.map(async sym => {
      await fullHistory(sym)
      if (++done % 25 === 0) console.log(`  …${done}/${warm.length}`)
    }),
  )
  if (missing.length) console.log(`MISSING (never synthesised): ${missing.map(m => `${m.sym}(${m.error})`).join(' ')}`)

  const spyFull = await fullHistory('SPY')
  if (!spyFull) throw new Error('BLOCKED: Yahoo would not serve SPY — cannot replay')
  let days = tradingDays(spyFull, from, to)
  if (limitDays) days = days.slice(0, limitDays)
  console.log(`${days.length} trading days: ${days[0]} … ${days[days.length - 1]}`)

  // The dip lane is a Stage-1 module: in the pre-Stage-1 worktree the file does
  // not exist, and that absence IS the baseline. Existence is checked on disk
  // first so the literal import below is only ever reached when it can resolve
  // (a bare try/catch is not enough — the loader resolves literal specifiers
  // eagerly, and a `@vite-ignore`d runtime path skips the TS transform and
  // silently yields nothing, which is how an earlier run reported zero dips).
  let dip: DipModule | null = null
  if (existsSync(new URL('../shared/engine/dipLane.ts', import.meta.url))) {
    dip = (await import('../shared/engine/dipLane')) as unknown as DipModule
    console.log('dip lane: present — dip diagnostics enabled')
  } else {
    console.log('dip lane: absent (pre-Stage-1 tree) — no dip diagnostics')
  }
  // Same guard for the sleeve: the door trace uses the REAL rankSleeve when it
  // exists, and reports no sleeve door at all when it does not.
  let rankSleeve: ((closes: Map<string, number[]>, topN: number) => { sym: string }[]) | null = null
  if (existsSync(new URL('../shared/engine/coreSleeve.ts', import.meta.url)))
    rankSleeve = (await import('../shared/engine/coreSleeve')).rankSleeve

  const { store } = makeStore()
  await store.write('config', {
    watchlist: [],
    rules: [],
    ytChannels: [],
    capital: 5000,
    levMap: {}, // empty ON PURPOSE — see the results doc: shorts are unroutable in BOTH runs
    coreSleeve: [],
    riskAppetite: appetite,
  })
  const cfg = (await store.read('config')) as Parameters<typeof gradeOutstanding>[3]

  const ctx = { current: { date: days[0], bars: new Map<string, Candle[]>(), screens: [], asked: new Set<string>() } as DayCtx }
  const deps = makeDeps(ctx)
  const out: DayOut[] = []

  for (const date of days) {
    const t0 = Date.now()
    // Screen universe = sleeve ∪ the window's tickers ∪ whatever the roster has
    // earned so far. Rebuilt daily because the roster carries.
    const rosterSyms = ((await store.read<{ sym: string }[]>('engine-roster')) ?? []).map(e => e.sym)
    const universe = [...new Set([...REPLAY_UNIVERSE, ...rosterSyms.map(s => s.toUpperCase())])]
    const bars = new Map<string, Candle[]>()
    for (const sym of universe) {
      const full = await fullHistory(sym)
      if (!full) continue
      const s = sliceBefore(full, date)
      if (s.length >= 2) bars.set(sym.toUpperCase(), s.slice(-ONE_YEAR_BARS))
    }
    const screens = synthScreens(bars, { includeLosers: !baseline })
    ctx.current = { date, bars, screens, asked: new Set<string>() }
    const sleeveTop = rankSleeve ? rankSleeve(sparkClosesFrom(bars, SLEEVE_MIRROR), 40).map(r => r.sym) : []

    // dip diagnostics, computed independently of buildBoard from the SAME bars,
    // so criterion 2 can say "classified" vs "constructed" vs "reached a board"
    const dips: DayOut['dips'] = []
    if (dip) {
      for (const [sym, cs] of bars) {
        const read = dip.classifyDip(cs)
        if (!read) continue
        const interesting = read.triggered || sym === 'GLW'
        if (!interesting) continue
        const constructed = read.triggered && read.holding ? dip.dipCall(sym, cs, read, null) != null : false
        dips.push({ sym, triggered: read.triggered, holding: read.holding, dropPct: read.dropPct, constructed })
      }
    }

    const nowSec = Date.parse(`${date}T05:20:00Z`) / 1000
    await gradeOutstanding(store, deps as never, nowSec, cfg)
    const built = await buildBoard(store, deps as never, nowSec)
    const ledger = ((await store.read<Prediction[]>(`predictions:${date}`)) ?? []).map(p => rowOf(p, 'ledger'))
    const board = built.board.map(p => rowOf(p, 'board'))
    const shape = summariseBoard(built.board)
    const watched = watchList.map(sym => ({
      sym,
      doors: doorsFor(sym, screens, sleeveTop, rosterSyms),
      evaluated: ctx.current.asked.has(sym),
    }))
    out.push({
      date,
      regime: built.regime,
      rosterSize: built.rosterSize,
      ms: Date.now() - t0,
      shape,
      board,
      ledger,
      dips,
      watched,
      candidatesAsked: ctx.current.asked.size,
    })
    console.log(
      `${date} regime=${String(built.regime).padEnd(7)} roster=${String(built.rosterSize).padStart(3)} ` +
        `trades=${shape.trades} watch=${shape.watch} nearMiss=${shape.nearMiss} blankSides=${shape.blankSides} ` +
        `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    )
  }

  // ---- outcomes, graded against the FULL untruncated history ----
  const spyGrade = spyFull
  for (const day of out) {
    for (const r of [...day.board, ...day.ledger]) {
      const cs = await fullHistory(r.sym)
      if (!cs) continue
      const pred = { date: day.date, side: r.side, priceAtPrediction: r.entry, stop: r.stop }
      const o5 = gradePrediction(pred, cs, spyGrade, 5)
      const o10 = gradePrediction(pred, cs, spyGrade, 10)
      r.outcome5 = o5 ? { hit: o5.hit, excessPct: o5.excessPct, stopped: o5.stopped } : null
      r.outcome10 = o10 ? { hit: o10.hit, excessPct: o10.excessPct, stopped: o10.stopped } : null
    }
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      { mode: baseline ? 'baseline' : 'new', commit, from, to, appetite, universe: REPLAY_UNIVERSE.length, missing, days: out },
      null,
      1,
    ),
  )
  console.log(`\nwrote ${outPath}`)

  const blank = out.filter(d => d.shape.blankBoard).length
  const noTrades = out.filter(d => d.shape.trades === 0).length
  console.log(`blank boards: ${blank}/${out.length} · zero-trade days: ${noTrades}/${out.length}`)
  if (missing.length) console.log(`missing symbols (never synthesised): ${missing.map(m => m.sym).join(' ')}`)
}

// Importable for the unit test (vitest sets VITEST); executed as a script otherwise.
if (!process.env.VITEST) await main()
