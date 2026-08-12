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
//
// THIRD MODE — `--aggregate`: the Stage-2 gate. Pure counters over the JSONs the
// window mode wrote — grade histogram, probability spread, the monotonicity probe,
// A-reachability, Brier by scoring epoch, the attributed baseline↔new diff, the
// born-below census and the banned-token sweep — printed with a PASS/FAIL per
// criterion. Evidence: results doc §15.
//   npx vite-node scripts/replay-window.ts -- --aggregate --new … --base … --mid … --aprobe …
//
// FOURTH MODE — `--plant-a`: the window mode with ONE substitution, the calibration
// blob replaced each morning by `aReachableState()`. It is a flag on `main` rather
// than a fourth loop because an A-reachability claim proved by a copy of the
// pipeline proves something about the copy.
//   npx vite-node scripts/replay-window.ts -- --plant-a --out /tmp/aprobe.json
//
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
// Every one of these exists in the pre-Stage-1 worktree too, so the static import
// is safe there — what differs is `probabilityFor`'s RETURN SHAPE (no nEff, no
// belowEvidence before stage 2) and `gradeFor`'s SIGNATURE. The enrichment below
// feature-detects the shape rather than the tree.
import {
  type Band,
  type CalibrationState,
  CALIB_DEF_VERSION,
  ENGINE_MODEL_VERSION,
  bandFor,
  baseHitRate,
  gradeFor,
  gradePrediction,
  probabilityFor,
} from '../shared/engine/calibration'
import { leverageAllowed } from '../shared/engine/riskLadder'
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

export interface Row {
  sym: string
  side: 'long' | 'short'
  grade: string
  riskPct: number
  composite: number
  probability: number
  entry: number
  stop: number
  target: number
  /** The name's own ten-session travel, and the move THIS call expects of it —
   * the two numbers Task 4's expected-move floor is computed from, carried so the
   * floor census can show its arithmetic instead of asserting it. */
  capacityPct: number
  expectedMovePct: number
  watchOnly: boolean
  nearMiss: boolean
  shadow: boolean
  belowBase: boolean
  contract: boolean
  catalyst: string | null
  setup: string | null
  where: 'board' | 'ledger'
  // ---- stage-2 additions, all read off the row the engine actually published ----
  /** The regime the row was scored in — the calibration context, per row rather
   * than per day, because a ledger row is graded against the tape it was born on. */
  regime: string
  /** The scoring-epoch stamp. Two epochs in one ledger are separable ONLY by this
   * (calibration.ts, ENGINE_MODEL_VERSION) — the Brier comparison is keyed on it. */
  modelVersion: number | null
  riskRung: number
  provisional: boolean
  /** The routed ETP, if any. Always null in this harness (levMap is empty on
   * purpose) — carried so the census can say so from the data, not from memory. */
  instrument: string | null
  /** THE VOICE (stage 2 T5). Absent on a near miss BY DESIGN — that row cleared no
   * gate, so it has no belief to state. */
  thesis: string | null
  falsifier: string | null
  // ---- recomputed post-publication from the SAME calibration blob (HEAD only) ----
  /** The UNROUNDED curve read. `probability` on the row is this quantised to 2dp
   * (engine.ts), and the two are reported side by side on purpose: the curve can
   * be perfectly continuous while the STORED number is a staircase with finer
   * steps, and only the pair says which of those is true. */
  pRaw?: number
  /** Observations straddling this read. Undefined in a pre-stage-2 tree. */
  nEff?: number
  /** The read was handed DOWN from the lowest band this rung has ever graded. */
  belowEvidence?: boolean
  /** What gradeFor would have said WITHOUT the born-below cap — the counterfactual
   * the de-leveraging census is measured against. */
  gradeUncapped?: string | null
  outcome5?: { hit: boolean; excessPct: number; stopped: boolean } | null
  outcome10?: { hit: boolean; excessPct: number; stopped: boolean } | null
}

export interface DayOut {
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
  /** The engine's own base rate on the day the board was built — every grade
   * threshold is relative to it, so a grade histogram without it is unreadable. */
  baseRate: number
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
  capacityPct: p.capacityPct,
  expectedMovePct: p.expectedMovePct,
  watchOnly: !!p.watchOnly,
  nearMiss: !!p.nearMiss,
  shadow: !!p.shadow,
  belowBase: !!(p as { belowBase?: boolean }).belowBase,
  contract: !!p.evidence?.contract,
  catalyst: p.catalyst?.kind ?? null,
  setup: p.setup ?? null,
  where,
  regime: p.regime,
  modelVersion: p.modelVersion ?? null,
  riskRung: p.riskRung,
  provisional: !!p.provisional,
  instrument: p.instrument?.ticker ?? null,
  thesis: (p as { thesis?: string }).thesis ?? null,
  falsifier: (p as { falsifier?: string }).falsifier ?? null,
})

/** Recompute, from the SAME calibration blob the day's board was built against,
 * the two numbers the published row does not carry: how many observations
 * straddled the read (`nEff`) and whether the read was handed DOWN from the
 * lowest band the rung has ever graded (`belowEvidence`) — plus the grade the row
 * would have carried had the born-below cap not applied.
 *
 * FEATURE-DETECTED, not tree-detected: in the pre-stage-2 baseline `probabilityFor`
 * returns `{p, provisional, n}` and `gradeFor` takes a different signature, so the
 * absence of `nEff` on the first read is the signal to leave every row unenriched.
 * A harness that guessed from the file system would enrich a tree whose calibration
 * module had moved on underneath it. */
function enrichFromCalibration(rows: Row[], cal: CalibrationState | null, baseRate: number): void {
  if (!cal) return
  for (const r of rows) {
    if (r.nearMiss) continue // a near miss never went through the read path at all
    // cohort 'unknown' is not a simplification here: `capUsdM` is null for every
    // name in a price-only replay (approximation #4), so publishCall's own
    // capCohortOf returned exactly this on the row being reproduced.
    const read = probabilityFor(cal, r.side, r.regime, Math.abs(r.composite), 'unknown') as unknown as {
      p: number
      nEff?: number
      belowEvidence?: boolean
    }
    if (read.nEff == null) return // pre-stage-2 read path — no curve to report on
    r.pRaw = read.p
    r.nEff = read.nEff
    r.belowEvidence = !!read.belowEvidence
    r.gradeUncapped = (gradeFor as unknown as (p: number, nEff: number, base: number, below: boolean) => string | null)(
      read.p,
      read.nEff,
      baseRate,
      false,
    )
  }
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const baseline = process.argv.includes('--baseline')
  // A-REACHABILITY PROBE (§15 criterion 4). The same window, the same board code,
  // the same everything — with ONE substitution: the calibration blob is replaced
  // by `aReachableState()` every morning, immediately before buildBoard. It is a
  // parameter of `main` rather than a second loop on purpose: an A-reachability
  // claim proved by a copy of the pipeline proves something about the copy. The
  // re-plant is per-day because gradeOutstanding legitimately books outcomes into
  // the blob as the window runs, and the probe's question is "given a calibration
  // that supports an A, does an A reach the reader's board", not "does one survive
  // twenty-one days of drift".
  const plantA = process.argv.includes('--plant-a')
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
  console.log(`replay-window: mode=${baseline ? 'BASELINE' : plantA ? 'A-PROBE' : 'NEW'} commit=${commit} window=${from}..${to} appetite=${appetite} gainers=${gainersDepth}`)
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
    if (plantA) await store.write('engine-calibration', aReachableState())
    const built = await buildBoard(store, deps as never, nowSec)
    const ledger = ((await store.read<Prediction[]>(`predictions:${date}`)) ?? []).map(p => rowOf(p, 'ledger'))
    const board = built.board.map(p => rowOf(p, 'board'))
    // gradeOutstanding writes `engine-calibration`; buildBoard only reads it. So
    // the blob standing here IS the one every grade above was struck against.
    const calNow = await store.read<CalibrationState>('engine-calibration')
    const baseRate = calNow ? baseHitRate(calNow).rate : 0.5
    enrichFromCalibration(board, calNow, baseRate)
    enrichFromCalibration(ledger, calNow, baseRate)
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
      baseRate,
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

  // The calibration blob as it stood after the last graded day — the state the
  // monotonicity probe samples, so the curve the gate asserts on is the one this
  // window actually built rather than a fixture that resembles it.
  const calibrationFinal = await store.read<CalibrationState>('engine-calibration')
  // …and the risk ladder, with its own history of promotions and the evidence
  // string each one was booked on. The rung multiplies every published riskPct
  // (engine.ts RUNG_RISK_PCT), so two runs that differ in rung differ in the size
  // the reader is told to take — a difference no grade histogram would show.
  const riskFinal = await store.read<unknown>('risk-state')
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        mode: baseline ? 'baseline' : plantA ? 'a-probe' : 'new',
        commit,
        from,
        to,
        appetite,
        gainersDepth,
        universe: REPLAY_UNIVERSE.length,
        modelVersion: ENGINE_MODEL_VERSION,
        missing,
        days: out,
        calibrationFinal,
        riskFinal,
      },
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

// ============================ STAGE-2 AGGREGATION — the gate (§15) ==============
// The window replay above WRITES the evidence; none of it READ the evidence back.
// `grade` and `probability` were captured per row and then never counted, so spec
// §5's grade-distribution criterion had no implementation at all (recon §8.2).
// Everything below is that missing half: pure counters over the same JSON, plus
// two probes that ask questions the window on its own cannot answer.
//
// PURE, AND SEPARATELY TESTED. Every helper here takes plain data and returns
// plain data — no store, no network, no engine — so `replay-window.test.ts` pins
// the arithmetic without a replay. The two functions that must touch the engine
// (the monotonicity read and the banned-token sweep) take it as an INJECTED
// argument for the same reason.
//
//   npx vite-node scripts/replay-window.ts -- --aggregate \
//     --new /tmp/replay-new.json --base /tmp/replay-baseline.json \
//     --mid /tmp/replay-mid.json --aprobe /tmp/replay-aprobe.json

/** The shape `main` writes. Declared structurally rather than imported so the
 * aggregation can read a JSON produced by an OLDER copy of this script — the
 * baseline run is exactly that, and its rows legitimately lack `nEff`. */
export interface RunFile {
  mode: string
  commit: string
  from: string
  to: string
  modelVersion?: number
  days: DayOut[]
  calibrationFinal?: CalibrationState | null
  riskFinal?: { rung?: number; history?: { date: string; from: number; to: number; evidence: string }[] } | null
}

export type Keyed = Row & { date: string }

/** date+symbol+side — the identity of a call across two runs. A row is "the same
 * row" in baseline and new only if all three match; the same name on a different
 * day is a different decision. */
export const keyOf = (r: Keyed): string => `${r.date}:${r.sym}:${r.side}`

export function flatten(run: RunFile, where: 'board' | 'ledger'): Keyed[] {
  return run.days.flatMap(d => (where === 'board' ? d.board : d.ledger).map(r => ({ ...r, date: d.date })))
}

// ---------------------------------------------------------- grade histogram --

export interface GradeHistogram {
  n: number
  A: number
  B: number
  C: number
  /** Rows whose grade was NULL and stored as 'C' (engine.ts stamps `grade ?? 'C'`).
   * Counted separately because "the calibration saw no edge" and "the calibration
   * saw a small edge" are the same letter on the row and different facts. */
  suppressed: number
  pctA: number | null
  pctB: number | null
}

/** A grade histogram over any row set. `suppressed` is inferred the only way a
 * consumer of the ledger can infer it: a null grade is stamped 'C' and is
 * recoverable ONLY through `shadow`/`belowBase` (recon §10) — so a 'C' row
 * carrying either flag had no grade at all. */
export function gradeHistogram(rows: Pick<Row, 'grade' | 'shadow' | 'belowBase'>[]): GradeHistogram {
  const count = (g: string) => rows.filter(r => r.grade === g).length
  const A = count('A')
  const B = count('B')
  const C = count('C')
  return {
    n: rows.length,
    A,
    B,
    C,
    suppressed: rows.filter(r => r.grade === 'C' && (r.shadow || r.belowBase)).length,
    pctA: rows.length ? A / rows.length : null,
    pctB: rows.length ? B / rows.length : null,
  }
}

// ------------------------------------------------------- probability spread --

export interface Spread {
  n: number
  distinct: number
  min: number | null
  max: number | null
  mean: number | null
  sd: number | null
}

export function meanOf(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
}

/** SAMPLE standard deviation (n−1). A window is a sample of the engine's
 * behaviour, not the population of it. Null below two observations, because one
 * number has no spread and reporting 0 would say it did. */
export function sdOf(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = meanOf(xs)!
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

export function spreadOf(xs: number[]): Spread {
  return {
    n: xs.length,
    distinct: new Set(xs).size,
    min: xs.length ? Math.min(...xs) : null,
    max: xs.length ? Math.max(...xs) : null,
    mean: meanOf(xs),
    sd: sdOf(xs),
  }
}

/** Spread per calibration BAND, keyed by the row's own |composite| through the
 * production `bandFor`. This is what says whether the window ever sampled the top
 * of the curve at all — a monotonicity claim over bands nothing landed in is a
 * claim about a fixture. */
export function spreadByBand(rows: Pick<Row, 'probability' | 'composite'>[]): Partial<Record<Band, Spread>> {
  const out: Partial<Record<Band, Spread>> = {}
  for (const band of ['25-40', '40-55', '55-70', '70+'] as Band[]) {
    const hits = rows.filter(r => bandFor(Math.abs(r.composite)) === band)
    if (hits.length) out[band] = spreadOf(hits.map(r => r.probability))
  }
  return out
}

/** The sharper question behind "the step function is dead", and the one a raw
 * distinct-value count cannot answer: WITHIN one day and one calibration context,
 * do two different convictions read two different probabilities? A staircase
 * still produces many distinct values across 21 days and six contexts — the
 * buckets fill, so every step moves — which is precisely why the count alone is
 * not evidence. Returns the share of same-day same-context row PAIRS that differ
 * in |composite| AND differ in probability. */
export function withinContextResolution(rows: Keyed[]): { pairs: number; separated: number; pct: number | null } {
  const groups = new Map<string, Keyed[]>()
  for (const r of rows) {
    const k = `${r.date}|${r.side}|${r.regime}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  let pairs = 0
  let separated = 0
  for (const g of groups.values())
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        if (Math.abs(g[i].composite) === Math.abs(g[j].composite)) continue
        pairs++
        if (g[i].probability !== g[j].probability) separated++
      }
  return { pairs, separated, pct: pairs ? separated / pairs : null }
}

// ------------------------------------------------------------ outcomes, Brier --

/** Mean Brier over rows carrying a 10-session outcome. Deliberately a local
 * implementation rather than a call into `brierPoint`: the harness's `outcome10`
 * is a three-field projection, not a full `PredOutcome`. `replay-window.test.ts`
 * pins this against the production `brierPoint` on a shared fixture, so the two
 * cannot drift into two different definitions of the same score. */
export function brierOf(rows: Pick<Row, 'probability' | 'outcome10'>[]): { n: number; mean: number | null } {
  const graded = rows.filter(r => r.outcome10)
  if (!graded.length) return { n: 0, mean: null }
  return { n: graded.length, mean: graded.reduce((s, r) => s + (r.probability - (r.outcome10!.hit ? 1 : 0)) ** 2, 0) / graded.length }
}

export interface Welch {
  nA: number
  nB: number
  meanA: number | null
  meanB: number | null
  t: number | null
  df: number | null
}

/** Welch's t (unequal variances) — the right test for two runs whose row counts
 * and dispersions both differ. Returns nulls rather than NaN when either arm is
 * too small or has no variance at all: "cannot be tested" is an answer and
 * `NaN` is not. */
export function welch(a: number[], b: number[]): Welch {
  const [mA, mB] = [meanOf(a), meanOf(b)]
  const [sA, sB] = [sdOf(a), sdOf(b)]
  if (mA == null || mB == null || sA == null || sB == null) return { nA: a.length, nB: b.length, meanA: mA, meanB: mB, t: null, df: null }
  const vA = sA ** 2 / a.length
  const vB = sB ** 2 / b.length
  if (vA + vB === 0) return { nA: a.length, nB: b.length, meanA: mA, meanB: mB, t: null, df: null }
  return {
    nA: a.length,
    nB: b.length,
    meanA: mA,
    meanB: mB,
    t: (mA - mB) / Math.sqrt(vA + vB),
    df: (vA + vB) ** 2 / (vA ** 2 / (a.length - 1) + vB ** 2 / (b.length - 1)),
  }
}

// ------------------------------------------------------------- the diff table --

export interface DiffSets {
  shared: string[]
  /** In the NEW run and not in the reference — names the change admitted. */
  newOnly: string[]
  /** In the reference and not in the new run — names the change suppressed. */
  refOnly: string[]
}

export function diffKeys(ref: string[], neu: string[]): DiffSets {
  const R = new Set(ref)
  const N = new Set(neu)
  return {
    shared: [...N].filter(k => R.has(k)).sort(),
    newOnly: [...N].filter(k => !R.has(k)).sort(),
    refOnly: [...R].filter(k => !N.has(k)).sort(),
  }
}

/** Which of a set of `date:sym:side` keys name a CORE SLEEVE member. The floor
 * census turns on this: the sleeve is the population that LOST a floor of its own
 * in Task 4 (SLEEVE_CAPACITY_FLOOR is gone), so a sleeve name the change
 * suppressed is the one direction of that trade the commit message cannot claim
 * away. */
export function sleeveKeys(keys: string[]): string[] {
  const sleeve = new Set(SLEEVE_MIRROR.map(s => s.toUpperCase()))
  return keys.filter(k => sleeve.has((k.split(':')[1] ?? '').toUpperCase()))
}

// ------------------------------------------------------------------ the voice --

export interface VoiceDefect {
  key: string
  /** 'thesis' | 'falsifier' | 'falsifier-not-in-thesis' */
  faults: string[]
  banned: string[]
}

/** Every board TRADE row must state what it believes and what would prove it
 * wrong, in the reader's language. `scan` is injected (the production
 * `bannedTokensIn`) so this helper stays pure and so the sweep can never quietly
 * become a different, weaker regex than the one the engine enforces. */
export function voiceDefects(rows: Keyed[], scan: (t: string) => string[]): VoiceDefect[] {
  const out: VoiceDefect[] = []
  for (const r of rows) {
    const faults: string[] = []
    if (!r.thesis?.trim()) faults.push('thesis')
    if (!r.falsifier?.trim()) faults.push('falsifier')
    // the paper reproduces the falsifier VERBATIM in the invalidation cell, so the
    // two must be one sentence and not two that agree (voice.ts)
    if (r.thesis && r.falsifier && !r.thesis.trim().endsWith(r.falsifier.trim())) faults.push('falsifier-not-in-thesis')
    const banned = [...new Set([...scan(r.thesis ?? ''), ...scan(r.falsifier ?? '')])]
    if (faults.length || banned.length) out.push({ key: keyOf(r), faults, banned })
  }
  return out
}

// --------------------------------------------------- monotonicity, on a probe --

/** The conviction axis the probe walks. 26 is just inside the aggressive dead
 * zone (20) and 78 is past the last band midpoint (77.5), so the grid crosses
 * every band edge AND both flat extensions. Step 2 rather than 1 only because 27
 * samples per context is already enough to catch a single-point inversion — the
 * curve is piecewise-linear, so a violation cannot hide between two samples of
 * the same segment. */
export function probeGrid(from = 26, to = 78, step = 2): number[] {
  const xs: number[] = []
  for (let x = from; x <= to + 1e-9; x += step) xs.push(Math.round(x * 100) / 100)
  return xs
}

export interface ProbeContext {
  side: 'long' | 'short'
  regime: string
  cohort: 'large' | 'small' | 'unknown'
}

/** Every (side, regime, cohort) a state actually carries evidence for. Parsed
 * from the bucket keys themselves — legacy cohortless keys are 3-part and read as
 * cohort 'unknown' (which is exactly how an unknown-cap call reads them back),
 * cohort-tagged keys are 4-part. A context nothing was ever booked into is not
 * probed: asserting monotonicity on an empty rung tests the base-rate constant. */
export function contextsIn(state: CalibrationState): ProbeContext[] {
  const seen = new Map<string, ProbeContext>()
  for (const key of Object.keys(state.buckets)) {
    const parts = key.split(':')
    const [cohort, side, regime] = parts.length === 4 ? parts : ['unknown', parts[0], parts[1]]
    if (side !== 'long' && side !== 'short') continue
    seen.set(`${cohort}:${side}:${regime}`, { side, regime, cohort: cohort as ProbeContext['cohort'] })
  }
  return [...seen.values()].sort((a, b) => `${a.cohort}${a.side}${a.regime}`.localeCompare(`${b.cohort}${b.side}${b.regime}`))
}

export interface MonoViolation {
  context: string
  prevX: number
  prevP: number
  x: number
  p: number
}

/** THE D2 GUARANTEE, asserted: within one context, more conviction may never read
 * a lower probability. Walks the grid and reports every step that goes DOWN.
 *
 * `read` is injected — the production `probabilityFor`, bound by the caller — so
 * the assertion is made against the shipped read path and the test can drive the
 * same walk over a hand-built curve. Tolerance is 1e-12: the curve is built from
 * divisions, and a strict `<` would flag float dust as a pathology. */
export function monotonicityViolations(
  contexts: ProbeContext[],
  xs: number[],
  read: (ctx: ProbeContext, x: number) => number,
): MonoViolation[] {
  const out: MonoViolation[] = []
  for (const ctx of contexts) {
    const label = `${ctx.cohort}:${ctx.side}:${ctx.regime}`
    let prev: { x: number; p: number } | null = null
    for (const x of xs) {
      const p = read(ctx, x)
      if (prev && p < prev.p - 1e-12) out.push({ context: label, prevX: prev.x, prevP: prev.p, x, p })
      prev = { x, p }
    }
  }
  return out
}

// ------------------------------------------------- the states the probe plants --

const state = (buckets: Record<string, { n: number; hits: number }>): CalibrationState => ({
  buckets,
  setupBuckets: {},
  brier: [],
  seeded: false,
  defVersion: CALIB_DEF_VERSION,
  modelVersion: ENGINE_MODEL_VERSION,
})

/** THE COMMITTED SEED'S OWN SHAPE, as measured in the stage-2 recon (§3.2) — the
 * documented pathology this whole stage exists to end: shorts read 0.31–0.41 in
 * 25-40 and 0.24–0.26 in 40-55 (more conviction, worse odds), and the 55-70 rows
 * jump to a flat 0.50 on two and eight observations. Planted as a probe state
 * because a monotonicity check that only ever sees well-behaved evidence proves
 * nothing about the machinery that is supposed to repair badly-behaved evidence. */
export function seedLikeState(): CalibrationState {
  return state({
    'long:green:25-40': { n: 195, hits: 74 },
    'long:amber:25-40': { n: 88, hits: 36 },
    'long:red:25-40': { n: 18, hits: 7 },
    'short:green:25-40': { n: 116, hits: 45 },
    'short:amber:25-40': { n: 108, hits: 32 },
    'short:red:25-40': { n: 147, hits: 47 },
    'long:green:40-55': { n: 46, hits: 18 },
    'short:green:40-55': { n: 50, hits: 10 },
    'short:amber:40-55': { n: 19, hits: 3 },
    'short:red:40-55': { n: 31, hits: 6 },
    'long:green:55-70': { n: 2, hits: 1 },
    'short:green:55-70': { n: 8, hits: 4 },
  })
}

/** The adversary the seed is not: a curve whose TOP band is both thin and lucky.
 * Shrinkage weight rises with n while n falls with conviction, so the thin top is
 * pulled harder toward the parent than the thick band beneath it and can land
 * BELOW it — the exact mechanism the running-max guard exists to catch. */
export function thinTopState(): CalibrationState {
  return state({
    'long:green:25-40': { n: 400, hits: 130 },
    'long:green:40-55': { n: 300, hits: 150 },
    'long:green:55-70': { n: 3, hits: 3 },
    'long:green:70+': { n: 1, hits: 1 },
    'short:green:25-40': { n: 5, hits: 5 },
    'short:green:40-55': { n: 250, hits: 60 },
  })
}

/** A CALIBRATION THAT CAN SUPPORT AN A, built rather than found (§15 criterion 4).
 *
 * Grade A needs three things at once (`gradeFor`): `p ≥ base + 0.10`, `nEff ≥ 30`,
 * and a read that was not extended DOWNWARD off the bottom of the evidence. The
 * committed seed can supply none of them — its best non-provisional read is 0.44
 * against a 0.487 bar (recon §3.2) — so an A-reachability claim has to plant the
 * evidence and then check the WHOLE pipeline honours it.
 *
 * The arithmetic, stated so it can be checked rather than trusted:
 *  · pooled n = 4,800, hits = 2,040 → base rate = 2,042/4,804 = **0.4251**
 *  · a long's own band reads laplace 152/204 = 0.7451 (25-40), 162/204 = 0.7941
 *    (40-55), 172/204 = 0.8431 (55-70) — already monotone, so PAVA is the identity
 *  · shrinkage pulls each toward the rung below, itself shrunk toward 0.4251;
 *    with n = 200 per band the weight is 200/225 = 0.889, so the read lands
 *    around **0.74–0.83** — a clear 0.30+ above base, on nEff = 200
 *  · the 1,000-observation short bucket at a 0.20 hit rate is what HOLDS the base
 *    rate down. Without it the base rate simply follows the long buckets up and
 *    `p − base` collapses to nothing: an A is a claim about a gap, and a plant
 *    that lifts both sides of the gap proves nothing.
 *
 * The shorts therefore read below base and suppress — deliberately. The probe is
 * not "make everything an A"; it is "can an A exist at all, end to end". */
export function aReachableState(): CalibrationState {
  const buckets: Record<string, { n: number; hits: number }> = {}
  for (const regime of ['green', 'amber', 'red']) {
    buckets[`long:${regime}:25-40`] = { n: 200, hits: 150 }
    buckets[`long:${regime}:40-55`] = { n: 200, hits: 160 }
    buckets[`long:${regime}:55-70`] = { n: 200, hits: 170 }
    buckets[`short:${regime}:25-40`] = { n: 1000, hits: 200 }
  }
  return state(buckets)
}

// ------------------------------------------- the born-below de-leveraging census --

export interface BornBelowCensus {
  /** Rows whose read was extended downward off the bottom of the evidence. */
  capped: number
  /** …of those, the ones the cap actually demoted (uncapped grade was A or B). */
  demoted: number
  demotedToHalfSize: string[]
  /** Rows that lost ETP eligibility: they would have been FULL-tier A/B rows, and
   * `leverageAllowed` says an A or B at their rung may route one. */
  lostLeverageEligibility: string[]
  /** Rows carrying a ROUTED instrument anywhere in the window. Zero by
   * construction — `levMap` is `{}` on purpose (shorts are unroutable in both
   * runs) — and MEASURED rather than assumed, so the census can say out loud that
   * the eligibility number above is a counterfactual and not a loss anyone took. */
  routedRowsInWindow: number
}

/** What the born-below cap cost, counted two ways that must not be conflated: the
 * grades it demoted, and the LEVERAGE those demotions withheld. In this harness
 * the second number is a counterfactual and says so — `levMap` is `{}`, so no row
 * is routed to an ETP in either run and none can lose one. What the census CAN
 * measure honestly is eligibility: a row that would have been a full-tier A/B at
 * its rung is a row an equipped levMap would have levered. */
export function bornBelowCensus(rows: Keyed[]): BornBelowCensus {
  const capped = rows.filter(r => r.belowEvidence)
  const demoted = capped.filter(r => r.gradeUncapped === 'A' || r.gradeUncapped === 'B')
  // full tier = A/B on the evidence contract (engine.ts `fullTrade`), which is the
  // only tier that can carry an instrument (`sizedFraction === 1`)
  const wouldBeFull = demoted.filter(r => r.contract && !r.shadow)
  return {
    capped: capped.length,
    demoted: demoted.length,
    demotedToHalfSize: demoted.filter(r => r.riskPct > 0).map(keyOf).sort(),
    lostLeverageEligibility: wouldBeFull
      .filter(r => leverageAllowed(r.riskRung, r.gradeUncapped as 'A' | 'B') > 0)
      .map(keyOf)
      .sort(),
    routedRowsInWindow: rows.filter(r => r.instrument).length,
  }
}

// --------------------------------------------------------------- the aggregate --

const pct = (x: number | null) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
const f3 = (x: number | null) => (x == null ? 'n/a' : x.toFixed(3))
const f4 = (x: number | null) => (x == null ? 'n/a' : x.toFixed(4))

/** Trade rows = the sized calls on the reader's board. This is the population the
 * grade criterion has always been read on (100% B baseline → 83% after stage 1b),
 * and it is named here rather than inlined so §15 and the gate cannot quietly be
 * computed on two different denominators. */
const tradesOf = (board: Keyed[]) => board.filter(r => !r.nearMiss && !r.watchOnly)
/** …and every board row that carries a REAL grade (a near miss is stamped 'C'
 * without ever visiting the read path, so it is not a graded row). */
const gradedBoard = (board: Keyed[]) => board.filter(r => !r.nearMiss)

async function aggregateMain() {
  const read = (p: string): RunFile => JSON.parse(readFileSync(p, 'utf8')) as RunFile
  const newPath = arg('new', join(CACHE_DIR, 'replay-new.json'))
  const basePath = arg('base', join(CACHE_DIR, 'replay-baseline.json'))
  const midPath = arg('mid', '')
  const aProbePath = arg('aprobe', '')
  const outPath = arg('out', join(CACHE_DIR, 'stage2-gate.json'))

  const runs: { label: string; run: RunFile }[] = [
    { label: 'baseline', run: read(basePath) },
    ...(midPath ? [{ label: 'mid', run: read(midPath) }] : []),
    { label: 'new', run: read(newPath) },
  ]
  const N = runs.find(r => r.label === 'new')!.run
  const B = runs.find(r => r.label === 'baseline')!.run

  // the banned-token sweep is the ENGINE's own (voice.ts). Guarded on disk for the
  // same reason every other stage-gated module here is: this file must still load
  // inside the pre-stage-1 worktree, where the module does not exist.
  const voice = existsSync(new URL('../shared/engine/voice.ts', import.meta.url))
    ? ((await import('../shared/engine/voice')) as { bannedTokensIn: (t: string) => string[] })
    : null

  const per = runs.map(({ label, run }) => {
    const board = flatten(run, 'board')
    const ledger = flatten(run, 'ledger')
    return { label, run, board, ledger, trades: tradesOf(board), graded: gradedBoard(board) }
  })

  console.log('\n================ 1. THE WINDOW ================')
  for (const p of per)
    console.log(
      `${p.label.padEnd(8)} commit ${p.run.commit} modelVersion ${p.run.modelVersion ?? '?'} · ${p.run.days.length} days · ` +
        `blank boards ${p.run.days.filter(d => d.shape.blankBoard).length} · zero-trade days ${p.run.days.filter(d => d.shape.trades === 0).length} · ` +
        `blank sides ${p.run.days.reduce((s, d) => s + d.shape.blankSides, 0)} · tradeless sides ${p.run.days.reduce((s, d) => s + d.shape.tradelessSides, 0)}`,
    )

  console.log('\n================ 2. GRADES ================')
  for (const p of per) {
    const t = gradeHistogram(p.trades)
    const g = gradeHistogram(p.graded)
    const l = gradeHistogram(p.ledger)
    console.log(`${p.label}:`)
    console.log(`  board TRADE rows  n=${t.n} A=${t.A} B=${t.B} C=${t.C} → B ${pct(t.pctB)}  A ${pct(t.pctA)}`)
    console.log(`  board graded rows n=${g.n} A=${g.A} B=${g.B} C=${g.C} (${g.suppressed} of the Cs are a NULL grade) → B ${pct(g.pctB)}`)
    console.log(`  ledger rows       n=${l.n} A=${l.A} B=${l.B} C=${l.C} (${l.suppressed} null) → B ${pct(l.pctB)}`)
  }

  console.log('\n================ 3. PROBABILITY ================')
  for (const p of per) {
    const everyRow = [...p.graded, ...p.ledger]
    console.log(`${p.label}:`)
    for (const [what, rows] of [
      ['board graded', p.graded],
      ['ledger', p.ledger],
      ['every scored row', everyRow],
    ] as [string, Keyed[]][]) {
      const s = spreadOf(rows.map(r => r.probability))
      console.log(`  ${what.padEnd(16)} n=${s.n} distinct=${s.distinct} min=${f3(s.min)} max=${f3(s.max)} mean=${f3(s.mean)} sd=${f4(s.sd)}`)
    }
    const byBand = spreadByBand(everyRow)
    for (const band of Object.keys(byBand) as Band[]) {
      const s = byBand[band]!
      console.log(`    band ${band.padEnd(6)} n=${s.n} distinct=${s.distinct} min=${f3(s.min)} max=${f3(s.max)}`)
    }
    const w = withinContextResolution(everyRow)
    console.log(`    same-day same-context pairs at DIFFERENT convictions: ${w.separated}/${w.pairs} read different probabilities (${pct(w.pct)})`)
    // …and the same measure restricted to the INTERIOR of the evidence, between
    // the lowest and highest band midpoints. Outside it the curve is flat BY
    // DESIGN (readCurve extends flat off both ends and never extrapolates), so
    // counting those pairs as failures of resolution would score the engine for
    // refusing to invent a number.
    const interior = everyRow.filter(r => Math.abs(r.composite) >= 32.5 && Math.abs(r.composite) <= 62.5)
    const wi = withinContextResolution(interior)
    console.log(`    …restricted to the evidenced interior (32.5 ≤ |composite| ≤ 62.5, n=${interior.length}): ${wi.separated}/${wi.pairs} (${pct(wi.pct)})`)
    // THE ROUNDING, isolated. `probability` on the row is the curve read through
    // engine.ts's 2dp round; `pRaw` is the read itself. Where the two disagree in
    // distinct-value count, the staircase the reader sees is the ROUNDING's, not
    // the calibration's — and that is a display decision, not a model one.
    const raw = everyRow.map(r => r.pRaw).filter((x): x is number => x != null)
    if (raw.length) {
      const rs = spreadOf(raw)
      const ri = withinContextResolution(interior.filter(r => r.pRaw != null).map(r => ({ ...r, probability: r.pRaw! })))
      console.log(`    UNROUNDED curve read: n=${rs.n} distinct=${rs.distinct} min=${f4(rs.min)} max=${f4(rs.max)} · interior pair resolution ${ri.separated}/${ri.pairs} (${pct(ri.pct)})`)
    }
  }
  for (const p of per) console.log(`  ${p.label} risk ladder ended at rung ${p.run.riskFinal?.rung ?? '?'} — ${(p.run.riskFinal?.history ?? []).map(h => `${h.date} R${h.from}→R${h.to} (${h.evidence})`).join(' · ') || 'no rung change'}`)

  console.log('\n================ 4. MONOTONICITY — the synthetic probe ================')
  const xs = probeGrid()
  const probeStates: { label: string; state: CalibrationState }[] = [
    { label: 'seed-shape (recon §3.2, the documented inversion)', state: seedLikeState() },
    { label: 'thin-lucky-top (the shrinkage inversion)', state: thinTopState() },
    { label: 'A-reachable plant', state: aReachableState() },
    ...(N.calibrationFinal ? [{ label: `window final (${N.commit})`, state: N.calibrationFinal }] : []),
  ]
  let monoViolations = 0
  let monoContexts = 0
  for (const ps of probeStates) {
    const ctxs = contextsIn(ps.state)
    const v = monotonicityViolations(ctxs, xs, (c, x) => probabilityFor(ps.state, c.side, c.regime, x, c.cohort).p)
    monoViolations += v.length
    monoContexts += ctxs.length
    console.log(`  ${ps.label}: ${ctxs.length} contexts × ${xs.length} samples (${xs[0]}→${xs[xs.length - 1]}) — ${v.length ? `${v.length} VIOLATIONS` : 'monotone'}`)
    for (const x of v.slice(0, 10)) console.log(`      ${x.context}: p(${x.prevX})=${f4(x.prevP)} → p(${x.x})=${f4(x.p)}`)
  }
  const sampled = spreadByBand([...gradedBoard(flatten(N, 'board')), ...flatten(N, 'ledger')])
  console.log(`  bands the WINDOW itself sampled: ${(Object.keys(sampled) as Band[]).map(b => `${b}(n=${sampled[b]!.n})`).join(' ')}`)

  console.log('\n================ 5. A-REACHABILITY ================')
  const organicA = per.map(p => `${p.label} ${gradeHistogram(p.graded).A} on the board / ${gradeHistogram(p.ledger).A} in the ledger`)
  console.log(`  ORGANIC (this window, this seed): ${organicA.join(' · ')}`)
  let aProbe: { days: number; boardA: number; ledgerA: number; examples: string[] } | null = null
  if (aProbePath) {
    const P = read(aProbePath)
    const pb = gradedBoard(flatten(P, 'board'))
    const pl = flatten(P, 'ledger')
    aProbe = {
      days: P.days.length,
      boardA: pb.filter(r => r.grade === 'A').length,
      ledgerA: pl.filter(r => r.grade === 'A').length,
      examples: pb.filter(r => r.grade === 'A').slice(0, 6).map(r => `${keyOf(r)} |c|=${Math.abs(r.composite)} p=${r.probability} risk=${r.riskPct}`),
    }
    console.log(`  SYNTHETIC PROBE (${P.commit}, calibration re-planted daily): ${aProbe.boardA} grade-A board rows over ${aProbe.days} days (${aProbe.ledgerA} in the ledger)`)
    for (const e of aProbe.examples) console.log(`      ${e}`)
  } else {
    console.log('  SYNTHETIC PROBE: not supplied (--aprobe)')
  }

  console.log('\n================ 6. OUTCOMES vs BASELINE ================')
  const excess = (rows: Keyed[], h: 5 | 10) => rows.map(r => (h === 5 ? r.outcome5 : r.outcome10)).filter(Boolean).map(o => o!.excessPct)
  const wins = (rows: Keyed[], h: 5 | 10) => rows.map(r => (h === 5 ? r.outcome5 : r.outcome10)).filter(Boolean).map(o => (o!.hit ? 1 : 0))
  const baseT = tradesOf(flatten(B, 'board'))
  const newT = tradesOf(flatten(N, 'board'))
  for (const h of [5, 10] as const) {
    const w = welch(excess(newT, h), excess(baseT, h))
    const hw = welch(wins(newT, h), wins(baseT, h))
    console.log(
      `  ${h}d avg excess — new ${f3(w.meanA)}% (n=${w.nA}) vs baseline ${f3(w.meanB)}% (n=${w.nB}) · t=${f3(w.t)} df=${f3(w.df)}`,
    )
    console.log(`  ${h}d win rate  — new ${pct(hw.meanA)} vs baseline ${pct(hw.meanB)} · t=${f3(hw.t)}`)
  }
  console.log('\n  BRIER (mean (p − hit)² on 10-session outcomes), by scoring epoch:')
  const brierRows = (r: RunFile) => flatten(r, 'ledger')
  const oldEpoch = brierRows(B).filter(r => (r.modelVersion ?? 2) === 2)
  const newEpoch = brierRows(N).filter(r => (r.modelVersion ?? 0) === 3)
  const bOld = brierOf(oldEpoch)
  const bNew = brierOf(newEpoch)
  console.log(`    modelVersion 2 (baseline ledger): n=${bOld.n} mean=${f4(bOld.mean)}`)
  console.log(`    modelVersion 3 (new ledger):      n=${bNew.n} mean=${f4(bNew.mean)}`)
  console.log(`    Δ = ${bOld.mean != null && bNew.mean != null ? f4(bNew.mean - bOld.mean) : 'n/a'} (gate: new ≤ old + 0.02)`)

  console.log('\n================ 7. THE DIFF, ATTRIBUTED ================')
  const boardKeys = (r: RunFile) => gradedBoard(flatten(r, 'board')).map(keyOf)
  const ledgerKeys = (r: RunFile) => flatten(r, 'ledger').map(keyOf)
  const full = diffKeys(boardKeys(B), boardKeys(N))
  console.log(`  baseline → new (EVERYTHING stage 2 shipped): shared ${full.shared.length} · new-only ${full.newOnly.length} · baseline-only ${full.refOnly.length}`)
  console.log(`    sleeve names newly on the board: ${sleeveKeys(full.newOnly).join(' ') || '—'}`)
  console.log(`    sleeve names dropped:            ${sleeveKeys(full.refOnly).join(' ') || '—'}`)
  let floor: { board: DiffSets; ledger: DiffSets } | null = null
  const mid = runs.find(r => r.label === 'mid')?.run
  if (mid) {
    floor = { board: diffKeys(boardKeys(mid), boardKeys(N)), ledger: diffKeys(ledgerKeys(mid), ledgerKeys(N)) }
    console.log(`\n  pre-floor (${mid.commit}) → new (${N.commit}) — THE EXPECTED-MOVE FLOOR ALONE:`)
    console.log(`    board:  admitted ${floor.board.newOnly.length} ${floor.board.newOnly.join(' ')} · suppressed ${floor.board.refOnly.length} ${floor.board.refOnly.join(' ')}`)
    console.log(`    ledger: admitted ${floor.ledger.newOnly.length} ${floor.ledger.newOnly.join(' ')} · suppressed ${floor.ledger.refOnly.length} ${floor.ledger.refOnly.join(' ')}`)
    console.log(`    of the suppressed, SLEEVE names: ${sleeveKeys([...floor.board.refOnly, ...floor.ledger.refOnly]).join(' ') || '—'}`)
  }

  console.log('\n================ 8. THE BORN-BELOW CAP ================')
  const census = bornBelowCensus([...gradedBoard(flatten(N, 'board')), ...flatten(N, 'ledger')])
  console.log(`  reads extended DOWNWARD off the evidence: ${census.capped}`)
  console.log(`  …of which the cap demoted (uncapped grade was A/B): ${census.demoted}`)
  console.log(`  …demoted rows still carrying size (a full trade became a half): ${census.demotedToHalfSize.length}`)
  console.log(`  …rows that lost ETP ELIGIBILITY (would have been full-tier A/B at their rung): ${census.lostLeverageEligibility.length}`)
  console.log(`  …rows carrying an ACTUALLY ROUTED instrument anywhere in the window: ${census.routedRowsInWindow} (levMap is empty in this harness by design, so the line above is a counterfactual)`)

  console.log('\n================ 9. THE VOICE ================')
  let voiceOut: { checked: number; defects: VoiceDefect[] } | null = null
  if (voice) {
    const defects = voiceDefects(newT, voice.bannedTokensIn)
    voiceOut = { checked: newT.length, defects }
    console.log(`  board trade rows swept: ${newT.length} · defects: ${defects.length}`)
    for (const d of defects.slice(0, 15)) console.log(`      ${d.key}: ${d.faults.join(',') || 'clean'} banned=[${d.banned.join(' ')}]`)
  } else {
    console.log('  voice.ts absent — no sweep')
  }

  // ------------------------------------------------------------------ the gate --
  const t = gradeHistogram(newT)
  const everyNewRow = [...gradedBoard(flatten(N, 'board')), ...flatten(N, 'ledger')]
  const spreadAll = spreadOf(everyNewRow.map(r => r.probability))
  const w5 = welch(excess(newT, 5), excess(baseT, 5))
  const c1 =
    N.days.every(d => d.shape.trades > 0) && N.days.every(d => d.shape.blankSides === 0)
  const c2 = t.pctB != null && t.pctB <= 0.75
  const c3a = spreadAll.distinct >= 15
  const c3b = monoViolations === 0
  const c4 = !!aProbe && aProbe.boardA > 0
  const c5a = w5.t != null && Math.abs(w5.t) < 2
  const c5b = bOld.mean != null && bNew.mean != null && bNew.mean <= bOld.mean + 0.02
  const c6 = !!voiceOut && voiceOut.defects.length === 0
  const verdict = c1 && c2 && c3a && c3b && c4 && c5a && c5b && c6

  console.log('\n================ THE STAGE-2 GATE ================')
  console.log(`1. zero-trade days 0 AND blank sides 0 — ${c1 ? 'PASS' : 'FAIL'}`)
  console.log(`2. B ≤ 75% of graded board TRADE rows: ${pct(t.pctB)} — ${c2 ? 'PASS' : 'FAIL'}`)
  console.log(`3a. ≥15 distinct probabilities: ${spreadAll.distinct} — ${c3a ? 'PASS' : 'FAIL'}`)
  console.log(`3b. monotone in every probed context (${monoContexts} contexts): ${monoViolations} violations — ${c3b ? 'PASS' : 'FAIL'}`)
  console.log(`4. an A is reachable end-to-end (synthetic probe): ${aProbe?.boardA ?? 'not run'} — ${c4 ? 'PASS' : 'FAIL'}`)
  console.log(`5a. win5/avg5 within noise: t=${f3(w5.t)} — ${c5a ? 'PASS' : 'FAIL'}`)
  console.log(`5b. Brier(new) ≤ Brier(old) + 0.02: ${f4(bNew.mean)} vs ${f4(bOld.mean)} — ${c5b ? 'PASS' : 'FAIL'}`)
  console.log(`6. every board trade row has a clean thesis + falsifier: ${voiceOut?.defects.length ?? 'not run'} defects — ${c6 ? 'PASS' : 'FAIL'}`)
  console.log(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}`)

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        mode: 'stage2-gate',
        runs: per.map(p => ({
          label: p.label,
          commit: p.run.commit,
          modelVersion: p.run.modelVersion ?? null,
          days: p.run.days.length,
          trades: gradeHistogram(p.trades),
          boardGraded: gradeHistogram(p.graded),
          ledger: gradeHistogram(p.ledger),
          probability: spreadOf([...p.graded, ...p.ledger].map(r => r.probability)),
          byBand: spreadByBand([...p.graded, ...p.ledger]),
          withinContext: withinContextResolution([...p.graded, ...p.ledger]),
        })),
        monotonicity: probeStates.map(ps => ({
          label: ps.label,
          contexts: contextsIn(ps.state).length,
          violations: monotonicityViolations(contextsIn(ps.state), xs, (c, x) => probabilityFor(ps.state, c.side, c.regime, x, c.cohort).p),
        })),
        bandsSampledByWindow: sampled,
        aProbe,
        outcomes: {
          d5: { excess: welch(excess(newT, 5), excess(baseT, 5)), win: welch(wins(newT, 5), wins(baseT, 5)) },
          d10: { excess: welch(excess(newT, 10), excess(baseT, 10)), win: welch(wins(newT, 10), wins(baseT, 10)) },
        },
        brier: { old: bOld, new: bNew },
        diff: { baselineToNew: full, floorOnly: floor },
        bornBelow: census,
        voice: voiceOut,
        gate: { c1, c2, c3a, c3b, c4, c5a, c5b, c6, verdict },
      },
      null,
      1,
    ),
  )
  console.log(`\nwrote ${outPath}`)
}

// Importable for the unit test (vitest sets VITEST); executed as a script otherwise.
if (!process.env.VITEST)
  await (process.argv.includes('--velocity-probe') ? probeMain() : process.argv.includes('--aggregate') ? aggregateMain() : main())
