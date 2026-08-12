// WINDOW REPLAY — drives the REAL `buildBoard` day by day over a date window,
// with strict point-in-time discipline: on replayed date D the engine may only
// see candle bars that closed STRICTLY BEFORE D (the live 05:20 run sees the
// same thing — D's bar does not exist yet).
//
// (Its predecessor, scripts/engine-replay.ts — retired 2026-08-12 — drove
// `composeCall` over a fixed 50-name universe on 5 Mondays and could not see
// the sleeve, the dip lane, the roster, the near-miss rows or the sizing
// tiers — i.e. it could not measure
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
//   npx vite-node scripts/replay-window.ts -- --gainers 25 …   (Stage-1 screen depth, for a diff)
//
// SECOND MODE — `--velocity-probe`: the Stage-1b ship gate. Instead of a board a
// day, it walks SEVEN named runners (VELOCITY_RUNNERS) session by session and
// reports every velocity door firing, every constructed call, and the paper
// book's own forward exit walk for each. Evidence: results doc §13.
//   npx vite-node scripts/replay-window.ts -- --velocity-probe --out /tmp/probe.json
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
import { SECTOR_MEMBERS } from '../netlify/functions/lib/sectors'
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

/** Tapes buildBoard reads for CONTEXT rather than as candidates — the index pair,
 * the world/VIX series and the eleven sector ETFs. They land in `asked` like any
 * other symbol, so the velocity diagnostic has to exclude them or XLK's breakout
 * would be counted as a candidate row the lane wanted. */
const CONTEXT_TAPES = new Set<string>(['SPY', 'QQQ', ...WORLD_TAPE_SYMS, ...Object.keys(SECTOR_MEMBERS)].map(s => s.toUpperCase()))

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

/** Production's per-kind screen depths (netlify/functions/lib/engine.ts,
 * `defaultDeps.screens`): the gainers list is read 50 deep because the top 25 of
 * that list is mostly sub-$5 penny rockets on a given day, and the other kinds
 * stay 25 because nothing there is being crowded out. The harness has to mirror
 * the SAME asymmetry or it measures a screen production does not run. */
export const PROD_GAINERS_DEPTH = 50
export const PROD_OTHER_DEPTH = 25

export interface ScreenSynthOpts {
  /** false in --baseline: the losers screen is a Stage-1 addition to defaultDeps. */
  includeLosers: boolean
  /** Gainers depth. Defaults to production's 50; settable so a diff can reproduce
   * the 25-deep screens Stage 1 ran and attribute the displacement to the depth
   * change rather than to everything that shipped alongside it. */
  gainers?: number
  /** Losers/actives depth — 25 in production, and no reason yet to vary it. */
  others?: number
}

/** APPROXIMATION (documented in the results doc). The real engine reads Yahoo's
 * predefined day_gainers / day_losers / most_actives / small_cap_gainers over
 * the WHOLE US market, and those endpoints have no point-in-time form. Here the
 * three price-derivable screens are recomputed from the replay universe's own
 * bars: top |1-day move| gainers, losers, and top $-volume actives. small_cap
 * gainers cannot be synthesised at all (no point-in-time market caps) and is
 * simply absent from both runs. */
export function synthScreens(bars: Map<string, Candle[]>, opts: ScreenSynthOpts): { row: ScreenRow; source: string }[] {
  const nGainers = opts.gainers ?? PROD_GAINERS_DEPTH
  const nOthers = opts.others ?? PROD_OTHER_DEPTH
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
  for (const r of rows.filter(r => r.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, nGainers)) out.push({ row: toRow(r), source: 'screener:gainers' })
  if (opts.includeLosers)
    for (const r of rows.filter(r => r.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, nOthers)) out.push({ row: toRow(r), source: 'screener:losers' })
  for (const r of [...rows].sort((a, b) => b.dollarVol - a.dollarVol).slice(0, nOthers)) out.push({ row: toRow(r), source: 'screener:actives' })
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

// -------------------------------------------------- the velocity probe (§13) --
// The velocity lane's ship gate. SEVEN runners, named with their search windows
// BEFORE any result was seen (the plan's Task 7, C15), so the probe cannot become
// a search for tape that flatters the doors.

export interface Runner {
  sym: string
  /** Search window. The RUN is found inside it from the candles, never named. */
  from: string
  to: string
}

export const VELOCITY_RUNNERS: Runner[] = [
  // the 2026 space/optical cluster
  { sym: 'AAOI', from: '2026-01-01', to: '2026-08-01' },
  { sym: 'RKLB', from: '2026-01-01', to: '2026-08-01' },
  { sym: 'LUNR', from: '2026-01-01', to: '2026-08-01' },
  { sym: 'ASTS', from: '2026-01-01', to: '2026-08-01' },
  // the 2025 quantum trio
  { sym: 'IONQ', from: '2025-01-01', to: '2025-12-31' },
  { sym: 'RGTI', from: '2025-01-01', to: '2025-12-31' },
  { sym: 'QBTS', from: '2025-01-01', to: '2025-12-31' },
]

/** The advance a stretch of tape must make to count as a RUN for the probe. */
export const RUN_MIN_ADVANCE_PCT = 40
/** Sessions the paper book gives a position before it closes it out
 * (paperBook.ts HORIZON_SESSIONS) — mirrored so the probe's exits are the book's. */
export const PROBE_HORIZON_SESSIONS = 10

export interface FoundRun {
  startIdx: number
  endIdx: number
  startDate: string
  endDate: string
  startClose: number
  endClose: number
  advancePct: number
  /** Index of the run's single highest CLOSE — the bar no door may buy. */
  peakIdx: number
  peakDate: string
}

const isoOf = (c: Candle) => new Date(c.t * 1000).toISOString().slice(0, 10)

/** The run inside a search window: the largest low→high CLOSING advance, provided
 * it clears `minAdvancePct`. Found from the candles, so the probe never has to be
 * told where a move was — the tape says. Running-minimum scan, so the pair really
 * is the best one in the window and not merely the first ≥40% pair found.
 *
 * Ties (two pairs with the same advance) keep the FIRST, which is the earliest and
 * therefore the longer-lived read; a tie is a curiosity, not a judgement call. */
export function findRun(candles: Candle[], fromISO: string, toISO: string, minAdvancePct = RUN_MIN_ADVANCE_PCT): FoundRun | null {
  const idxs = candles.map((c, i) => [c, i] as const).filter(([c]) => {
    const d = isoOf(c)
    return d >= fromISO && d <= toISO
  })
  if (idxs.length < 2) return null
  let minIdx = idxs[0][1]
  let best: { s: number; e: number; adv: number } | null = null
  for (const [c, i] of idxs) {
    const lowC = candles[minIdx].c
    if (lowC > 0) {
      const adv = (c.c / lowC - 1) * 100
      if (adv > (best?.adv ?? -Infinity) && i > minIdx) best = { s: minIdx, e: i, adv }
    }
    if (c.c < candles[minIdx].c) minIdx = i
  }
  if (!best || best.adv < minAdvancePct) return null
  let peakIdx = best.s
  for (let i = best.s; i <= best.e; i++) if (candles[i].c > candles[peakIdx].c) peakIdx = i
  return {
    startIdx: best.s,
    endIdx: best.e,
    startDate: isoOf(candles[best.s]),
    endDate: isoOf(candles[best.e]),
    startClose: candles[best.s].c,
    endClose: candles[best.e].c,
    advancePct: Math.round(best.adv * 10) / 10,
    peakIdx,
    peakDate: isoOf(candles[peakIdx]),
  }
}

/** Where in the run an entry sits, 0 = the run's low, 1 = its high. Measured in
 * SESSIONS, not in price: the gate asks whether the doors fire early in the move's
 * life, and a price-based position would call a late entry "early" merely because
 * the move went parabolic at the end. */
export function entryPosition(entryIdx: number, run: Pick<FoundRun, 'startIdx' | 'endIdx'>): number {
  const span = run.endIdx - run.startIdx
  if (span <= 0) return 0
  return (entryIdx - run.startIdx) / span
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface TrailExit {
  reason: 'trail' | 'stop' | 'target' | 'horizon' | 'open'
  exitIdx: number | null
  exitDate: string | null
  exitPrice: number | null
  /** The level the exit session was judged against — the ratcheted trail. */
  stopAtExit: number | null
  pnlPct: number | null
  sessionsHeld: number
}

/** The paper book's own walk (paperBook.ts `manageOpenPositions`), replayed on the
 * probe's tape: from the session AFTER the entry session, each close is compared to
 * the ratcheted trail first, then the target, then the 10-session horizon.
 *
 * `effectiveStop` is injected rather than imported so this file keeps no static
 * dependency on a Stage-1b module (the harness still has to load inside the
 * pre-Stage-1 worktree). The probe passes the REAL `effectiveVelocityStop`, and it
 * passes `entryIdx` with it — walking the trail a session at a time WITHOUT the
 * entry index is the defect the ratchet fix (e0fa4f9) exists to kill: the trail
 * would then be read as of each day alone and a falsifier that rose and sagged back
 * would quietly hand the position a looser exit. */
export function simulateTrailExit(
  candles: Candle[],
  entryIdx: number,
  entry: number,
  publishedStop: number,
  target: number,
  effectiveStop: (published: number, candlesAsOfDay: Candle[], entrySessionIdx: number) => number,
  horizon = PROBE_HORIZON_SESSIONS,
): TrailExit {
  for (let i = entryIdx + 1; i < candles.length; i++) {
    const held = i - entryIdx
    const c = candles[i]
    const stopNow = effectiveStop(publishedStop, candles.slice(0, i + 1), entryIdx)
    const mk = (reason: TrailExit['reason']): TrailExit => ({
      reason,
      exitIdx: i,
      exitDate: isoOf(c),
      exitPrice: c.c,
      stopAtExit: Math.round(stopNow * 100) / 100,
      pnlPct: Math.round(((c.c - entry) / entry) * 1000) / 10,
      sessionsHeld: held,
    })
    if (c.c <= stopNow) return mk(stopNow > publishedStop ? 'trail' : 'stop')
    if (c.c >= target) return mk('target')
    if (held >= horizon) return mk('horizon')
  }
  return { reason: 'open', exitIdx: null, exitDate: null, exitPrice: null, stopAtExit: null, pnlPct: null, sessionsHeld: candles.length - 1 - entryIdx }
}

/** MIRROR of the confirmation door's volume evidence (velocityLane.ts): the largest
 * volume multiple printed on an UP-day inside the run window, against the mean
 * volume of the 20 sessions before today. Mirrored rather than imported because the
 * lane keeps it internal; `replay-window.test.ts` pins the mirror against the
 * refusal string the lane itself prints, so it cannot drift silently. null when
 * there is no volume baseline at all — an unknown is never a measurement. */
export function bestUpDayMult(candles: Candle[], runWindow = 5, volWindow = 20): number | null {
  const w = candles.slice(-(volWindow + 1), -1)
  if (w.length < volWindow) return null
  const baseVol = w.reduce((s, c) => s + c.v, 0) / w.length
  if (!(baseVol > 0)) return null
  const n = candles.length
  let best = 0
  for (let i = Math.max(1, n - runWindow); i < n; i++) {
    if (candles[i].c <= candles[i - 1].c) continue
    const m = candles[i].v / baseVol
    if (m > best) best = m
  }
  return best
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

/** A structural MIRROR of velocityLane's own `VelocityRead`. Mirrored, not
 * imported, because the lane is loaded dynamically (this harness still has to be
 * loadable inside the pre-Stage-1 worktree, where the module does not exist) — the
 * shape is only ever produced by the real classifier. */
export interface VelocityRead {
  door: 'early' | 'confirmation' | null
  earlyTriggered: boolean
  confirmationTriggered: boolean
  greenStreak: number
  detail: string
  /** The multiple the open door was actually paid at, or null. Optional here for
   * the same reason it is optional there: a replay may load a lane old enough not
   * to carry it. A MIRROR that quietly stops mirroring is worse than no mirror —
   * it typechecks while describing a different shape. */
  paidMult?: number | null
}

interface VelocityModule {
  classifyVelocity: (candles: Candle[]) => VelocityRead | null
  velocityCall: (sym: string, candles: Candle[], read: VelocityRead, capUsdM: number | null) => { entry: number; stop: number; target: number; composite: number } | null
  velocityTrail: (candles: Candle[]) => number | null
  effectiveVelocityStop: (published: number, candlesAsOfDay: Candle[], entrySessionIdx: number) => number
  MIN_RISK_FRAC: number
  MIN_CANDLES: number
}

/** Why an OPEN door still produced no call. `velocityCall` returns null for three
 * different reasons and they mean different things — a replay that reported only
 * "no call" would hide the one that is actually a calibration question (the 1%
 * floor). Recomputed from the same tape by calling `velocityTrail` alongside. */
export function velocityRefusal(entry: number, trail: number | null, minRiskFrac: number): string | null {
  if (trail == null) return 'trail null (no 8-EMA or too few sessions)'
  if (trail >= entry) return `trail ${round2(trail)} ≥ entry ${round2(entry)} (the 8-EMA shelf sits above the break)`
  if (entry - trail < minRiskFrac * entry) return `risk ${round2(entry - trail)} under the ${(minRiskFrac * 100).toFixed(0)}% floor (${((entry - trail) / entry * 100).toFixed(2)}% of entry)`
  return null
}

const round2 = (x: number) => Math.round(x * 100) / 100

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
  /** VELOCITY DIAGNOSTIC — computed outside buildBoard from the SAME bars and over
   * the names buildBoard actually evaluated, because the lane itself cannot fire in
   * this harness: `capUsdM` is null for every name (approximation #4, no
   * point-in-time cap source) and VELOCITY_MIN_CAP_USD_M refuses an unknown cap by
   * design. Without this the window would report "0 velocity rows" and say nothing
   * about why. */
  velocity: {
    sym: string
    door: string | null
    early: boolean
    confirmation: boolean
    greenStreak: number
    bestUpMult: number | null
    /** did velocityCall build one? (with the cap floor NOT applied) */
    constructed: boolean
    entry?: number
    stop?: number
    composite?: number
    riskFrac?: number
    /** why the call was refused although the door was open */
    refusal?: string
    detail: string
  }[]
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
  // Screen depth, gainers only. Defaults to production's 50; `--gainers 25` recreates
  // the Stage-1 screens so the two runs differ ONLY in the depth and the displacement
  // can be attributed to it rather than to everything else that shipped since.
  const gainersDepth = Number(arg('gainers', String(PROD_GAINERS_DEPTH))) || PROD_GAINERS_DEPTH
  const outPath = arg('out', join(CACHE_DIR, `replay-${baseline ? 'baseline' : 'new'}.json`))
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    /* not a repo — fine */
  }

  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`replay-window: mode=${baseline ? 'BASELINE' : 'NEW'} commit=${commit} window=${from}..${to} appetite=${appetite} gainers=${gainersDepth}`)
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
  // …and the same guard for the velocity lane (a Stage-1b module). The diagnostic
  // below runs the REAL classifier and the REAL constructor over the names
  // buildBoard evaluated, with the LANE's own gates and WITHOUT the engine's
  // liquidity floor — which no cap-less replay can ever pass. That difference is
  // stated in §13, not smuggled: these are would-be rows, not board rows.
  const velMod = existsSync(new URL('../shared/engine/velocityLane.ts', import.meta.url))
    ? ((await import('../shared/engine/velocityLane')) as unknown as VelocityModule)
    : null
  console.log(velMod ? 'velocity lane: present — velocity diagnostics enabled' : 'velocity lane: absent — no velocity diagnostics')
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
    const screens = synthScreens(bars, { includeLosers: !baseline, gainers: gainersDepth })
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
    // velocity diagnostics — over the names buildBoard actually evaluated (`asked`
    // minus the index/sector tapes it reads for context), from the same bars.
    const velocity: DayOut['velocity'] = []
    if (velMod) {
      for (const sym of ctx.current.asked) {
        if (CONTEXT_TAPES.has(sym)) continue
        const cs = bars.get(sym)
        if (!cs) continue
        let read: VelocityRead | null = null
        try {
          read = velMod.classifyVelocity(cs)
        } catch {
          continue // one unreadable tape costs that name its diagnostic, nothing else
        }
        if (!read || (!read.earlyTriggered && !read.confirmationTriggered)) continue
        const call = read.door ? velMod.velocityCall(sym, cs, read, null) : null
        const entry = cs[cs.length - 1].c
        velocity.push({
          sym,
          door: read.door,
          early: read.earlyTriggered,
          confirmation: read.confirmationTriggered,
          greenStreak: read.greenStreak,
          bestUpMult: bestUpDayMult(cs),
          constructed: !!call,
          ...(call
            ? { entry: call.entry, stop: call.stop, composite: call.composite, riskFrac: (call.entry - call.stop) / call.entry }
            : { refusal: velocityRefusal(entry, velMod.velocityTrail(cs), velMod.MIN_RISK_FRAC) ?? 'no door' }),
          detail: read.detail,
        })
      }
    }
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
      velocity,
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
      { mode: baseline ? 'baseline' : 'new', commit, from, to, appetite, gainersDepth, universe: REPLAY_UNIVERSE.length, missing, days: out },
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

// ------------------------------------------------------ main: the probe (§13) --

interface Firing {
  date: string
  idx: number
  inRun: boolean
  /** 0 = the run's low session, 1 = its high session. null outside the run. */
  position: number | null
  onRunPeak: boolean
  early: boolean
  confirmation: boolean
  door: 'early' | 'confirmation' | null
  greenStreak: number
  close: number
  bestUpMult: number | null
  constructed: boolean
  entry?: number
  stop?: number
  target?: number
  composite?: number
  riskFrac?: number
  /** the refusal, recomputed by calling velocityTrail alongside — an OPEN door's
   * own `detail` reads affirmatively even on a session that produced no call, so
   * both strings are printed side by side and neither is allowed to stand alone. */
  refusal?: string
  detail: string
  exit?: TrailExit
}

async function probeMain() {
  mkdirSync(CACHE_DIR, { recursive: true })
  const outPath = arg('out', join(CACHE_DIR, 'velocity-probe.json'))
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    /* not a repo — fine */
  }
  // Probe mode only ever runs at HEAD (it is measuring a Stage-1b lane), so this
  // import is dynamic purely to keep the module graph loadable in the pre-Stage-1
  // worktree the window replay still has to run inside.
  const vel = (await import('../shared/engine/velocityLane')) as unknown as VelocityModule
  console.log(`velocity-probe: commit=${commit} runners=${VELOCITY_RUNNERS.length} cache=${CACHE_DIR}`)
  console.log(`gate: >=5/7 runners fire in-run · median in-run entry position <=0.6 · <=1/3 beyond 0.8 · >=60% green exits · 0 entries on the run's highest close`)

  const results: {
    sym: string
    from: string
    to: string
    run: FoundRun | null
    sessionsWalked: number
    firings: Firing[]
    error?: string
  }[] = []

  for (const runner of VELOCITY_RUNNERS) {
    const candles = await fullHistory(runner.sym)
    if (!candles) {
      const err = missing.find(m => m.sym === runner.sym)?.error ?? 'no candles'
      console.log(`${runner.sym}: MISSING — ${err}`)
      results.push({ sym: runner.sym, from: runner.from, to: runner.to, run: null, sessionsWalked: 0, firings: [], error: err })
      continue
    }
    const run = findRun(candles, runner.from, runner.to)
    const firings: Firing[] = []
    let walked = 0
    for (let i = 0; i < candles.length; i++) {
      const d = isoOf(candles[i])
      if (d < runner.from || d > runner.to) continue
      const slice = candles.slice(0, i + 1)
      if (slice.length < vel.MIN_CANDLES) continue
      walked++
      const read = vel.classifyVelocity(slice)
      if (!read || (!read.earlyTriggered && !read.confirmationTriggered)) continue
      const inRun = !!run && i >= run.startIdx && i <= run.endIdx
      const call = read.door ? vel.velocityCall(runner.sym, slice, read, null) : null
      const entryClose = candles[i].c
      const f: Firing = {
        date: d,
        idx: i,
        inRun,
        position: inRun && run ? Math.round(entryPosition(i, run) * 1000) / 1000 : null,
        onRunPeak: !!run && i === run.peakIdx,
        early: read.earlyTriggered,
        confirmation: read.confirmationTriggered,
        door: read.door,
        greenStreak: read.greenStreak,
        close: round2(entryClose),
        bestUpMult: bestUpDayMult(slice),
        constructed: !!call,
        detail: read.detail,
      }
      if (call) {
        f.entry = call.entry
        f.stop = call.stop
        f.target = call.target
        f.composite = call.composite
        f.riskFrac = Math.round(((call.entry - call.stop) / call.entry) * 10000) / 10000
        // The forward walk uses the FULL history, so an entry near the end of the
        // search window is still followed into the sessions after it — the position
        // does not stop existing because the probe's window did.
        f.exit = simulateTrailExit(candles, i, call.entry, call.stop, call.target, vel.effectiveVelocityStop)
      } else {
        f.refusal = velocityRefusal(entryClose, vel.velocityTrail(slice), vel.MIN_RISK_FRAC) ?? 'no door chosen'
      }
      firings.push(f)
    }
    results.push({ sym: runner.sym, from: runner.from, to: runner.to, run, sessionsWalked: walked, firings })
    const inRunFirings = firings.filter(f => f.inRun)
    console.log(
      `\n${runner.sym} ${runner.from}..${runner.to} — ${
        run ? `run ${run.startDate} ${round2(run.startClose)} → ${run.endDate} ${round2(run.endClose)} (+${run.advancePct}%, peak close ${run.peakDate})` : 'NO RUN >=40% in window'
      }`,
    )
    console.log(
      `  ${walked} sessions walked · firings ${firings.length} (in-run ${inRunFirings.length}) · ` +
        `early ${firings.filter(f => f.early).length} · confirmation ${firings.filter(f => f.confirmation).length} · ` +
        `constructed ${firings.filter(f => f.constructed).length} (in-run ${inRunFirings.filter(f => f.constructed).length})`,
    )
    for (const f of firings) {
      const where = f.inRun ? `pos ${f.position!.toFixed(2)}${f.onRunPeak ? ' **RUN PEAK**' : ''}` : 'OUT-OF-RUN'
      const call = f.constructed
        ? `entry ${f.entry} stop ${f.stop} target ${f.target} risk ${(f.riskFrac! * 100).toFixed(2)}% comp ${f.composite} → ${f.exit!.reason} ${f.exit!.exitDate ?? '(still open)'} ${f.exit!.pnlPct == null ? '' : `${f.exit!.pnlPct > 0 ? '+' : ''}${f.exit!.pnlPct}%`}`
        : `NO CALL — ${f.refusal}`
      console.log(`  ${f.date} ${where} door=${f.door} early=${f.early} conf=${f.confirmation} streak=${f.greenStreak} bestUp=${f.bestUpMult == null ? 'unknown' : `${Math.round(f.bestUpMult * 10) / 10}×`}`)
      console.log(`    ${call}`)
      console.log(`    read: ${f.detail}`)
    }
  }

  // ---------------------------------------------------------------- the gate --
  const inRunEntries = results.flatMap(r => r.firings.filter(f => f.inRun && f.constructed))
  const positions = inRunEntries.map(f => f.position!)
  const runnersFiredInRun = results.filter(r => r.firings.some(f => f.inRun)).length
  const med = median(positions)
  const beyond08 = positions.filter(p => p > 0.8).length
  const exits = inRunEntries.map(f => f.exit!).filter(Boolean)
  const green = exits.filter(e => e.pnlPct != null && e.pnlPct > 0)
  const greenViaTrail = green.filter(e => e.reason === 'trail')
  const peakEntries = inRunEntries.filter(f => f.onRunPeak)
  const c1 = runnersFiredInRun >= 5
  const c2a = med != null && med <= 0.6
  const c2b = positions.length > 0 && beyond08 <= positions.length / 3
  const c3 = exits.length > 0 && green.length / exits.length >= 0.6
  const c4 = peakEntries.length === 0
  const verdict = c1 && c2a && c2b && c3 && c4

  const buckets = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2, Infinity]
  const allConstructed = results.flatMap(r => r.firings.filter(f => f.constructed))
  const histogram = buckets.map((hi, k) => {
    const lo = k === 0 ? 0 : buckets[k - 1]
    return { lo, hi, n: allConstructed.filter(f => f.riskFrac! >= lo && f.riskFrac! < hi).length }
  })

  console.log('\n================ THREE QUANTITIES (they are not the same number) ================')
  const anyFiring = results.flatMap(r => r.firings)
  console.log(`door firings — early ${anyFiring.filter(f => f.early).length}, confirmation ${anyFiring.filter(f => f.confirmation).length}, both on one session ${anyFiring.filter(f => f.early && f.confirmation).length}, sessions with any door open ${anyFiring.length}`)
  console.log(`chosen doors — early ${anyFiring.filter(f => f.door === 'early').length}, confirmation ${anyFiring.filter(f => f.door === 'confirmation').length}`)
  console.log(`constructed calls — ${allConstructed.length} (refused ${anyFiring.length - allConstructed.length})`)
  const refusals = new Map<string, number>()
  for (const f of anyFiring.filter(x => !x.constructed)) {
    const kind = f.refusal?.startsWith('trail null') ? 'trail null' : f.refusal?.startsWith('trail') ? 'trail >= entry' : f.refusal?.startsWith('risk') ? '1% risk floor' : 'other'
    refusals.set(kind, (refusals.get(kind) ?? 0) + 1)
  }
  for (const [k, n] of refusals) console.log(`  refused by ${k}: ${n}`)
  console.log('\nrisk-distance histogram ((entry − stop)/entry, across CONSTRUCTED calls):')
  for (const b of histogram) console.log(`  ${(b.lo * 100).toFixed(0)}–${b.hi === Infinity ? '∞' : (b.hi * 100).toFixed(0)}% : ${b.n}`)
  const bestUps = allConstructed.map(f => f.bestUpMult).filter((x): x is number => x != null)
  console.log(`bestUpMult across constructed calls — min ${bestUps.length ? Math.min(...bestUps).toFixed(1) : 'n/a'}× median ${bestUps.length ? median(bestUps)!.toFixed(1) : 'n/a'}× max ${bestUps.length ? Math.max(...bestUps).toFixed(1) : 'n/a'}×`)

  console.log('\n================ GATE ================')
  console.log(`1. runners firing in-run: ${runnersFiredInRun}/7 (>=5) — ${c1 ? 'PASS' : 'FAIL'}`)
  console.log(`2a. median in-run entry position: ${med == null ? 'n/a' : med.toFixed(3)} (<=0.6) — ${c2a ? 'PASS' : 'FAIL'}`)
  console.log(`2b. in-run entries beyond 0.8: ${beyond08}/${positions.length} (<=1/3) — ${c2b ? 'PASS' : 'FAIL'}`)
  console.log(`3. in-run entries exiting green: ${green.length}/${exits.length}${exits.length ? ` (${((green.length / exits.length) * 100).toFixed(0)}%)` : ''} (>=60%) — ${c3 ? 'PASS' : 'FAIL'} · of which via the TRAIL: ${greenViaTrail.length}`)
  console.log(`4. entries on a run's single highest close: ${peakEntries.length} (must be 0) — ${c4 ? 'PASS' : 'FAIL'}`)
  console.log(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}`)

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        mode: 'velocity-probe',
        commit,
        horizonSessions: PROBE_HORIZON_SESSIONS,
        runners: VELOCITY_RUNNERS,
        missing,
        results,
        gate: {
          runnersFiredInRun,
          medianPosition: med,
          beyond08,
          inRunEntries: positions.length,
          exits: exits.length,
          green: green.length,
          greenViaTrail: greenViaTrail.length,
          peakEntries: peakEntries.length,
          criteria: { c1, c2a, c2b, c3, c4 },
          verdict,
        },
        histogram,
      },
      null,
      1,
    ),
  )
  console.log(`\nwrote ${outPath}`)
  if (missing.length) console.log(`missing symbols (never synthesised): ${missing.map(m => `${m.sym}(${m.error})`).join(' ')}`)
}

// Importable for the unit test (vitest sets VITEST); executed as a script otherwise.
if (!process.env.VITEST) await (process.argv.includes('--velocity-probe') ? probeMain() : main())
