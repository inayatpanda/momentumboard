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
// FIFTH MODE — `--seed-out <path>`: the window mode again, but the walk SERIALISES
// what it learned into a `shared/engine/seed.json`-shaped artefact (stage 2b). It is
// a flag rather than a fifth loop for the same reason --plant-a is: a seed measured
// by a copy of the pipeline is a seed measured on a copy. `--seed-generation <n>` is
// REQUIRED with it — the generation is how loadState decides a regenerated seed may
// displace the live blob, and an artefact may not guess which walk made it. In this
// mode the walk starts from an EMPTY calibration (never the committed seed — "do not
// mix a regenerated seed with the committed one, regenerate whole", backtest.ts) and
// crypto is filtered out of the universe (stage 1c is unbuilt — see isCryptoSymbol).
// After the walk it also runs the REFERENCE SWEEP (spec §9, `referenceSweep` below):
// the same candles and window put through `seedFromHistory` with no board in the way,
// over the universe the WALK ITSELF CONSIDERED — the union of every name buildBoard
// asked for candles on, day by day, minus the context tapes and crypto. It measures
// the UNCONDITIONAL gate-clearing rate the artefact's grades will be anchored to. The
// walk's buckets say what a published row is worth; the sweep says what an ordinary
// candidate is worth, and a grade is the gap. Two notes a reader of the artefact
// needs and cannot see in the number:
//   · The stored anchor is rounded to 4dp BEFORE the sane-band check, so the band
//     admits [0.24995, 0.55005) in raw terms — a 0.5500499 sweep stores 0.55 and
//     passes. The rounding is deliberate (the number checked is the number stored);
//     the half-tick of slack at each edge is its consequence, not a second policy.
//   · The sweep APPROXIMATES the walk's model rather than reproducing it. Same
//     `composeCall`, same v3 composite arithmetic, same 10-session close-based hit
//     rule — but it scores with `DEFAULT_WEIGHTS` (never the walk's nudged vector)
//     and with the price-derived factors only: technical, momentum and seasonality,
//     with sector, world-tape, news, social, insider and smart-money all null. The
//     regime IS point-in-time real (SPY/QQQ slope, breadth, VIX). One gate differs
//     and is worth knowing: `seedFromHistory` passes no `gates`, so the sweep runs
//     MODERATE (deadZone 25 / minExpectedMove 1.5) while an `--appetite aggressive`
//     walk runs 20 / 1.0 — the anchor is therefore "an ordinary candidate a moderate
//     board would have looked at", a slightly stricter population than the walk's
//     own admission, and it reads a little HIGHER for it. It is a benchmark, not a
//     replica of the row in front of the reader.
//   npx tsx scripts/replay-window.ts --from 2024-08-12 --to 2026-08-11 \
//     --seed-out /tmp/seed-candidate.json --seed-generation 2 --out /tmp/walk.json
// `--symbols A,B,C` narrows the walk universe (default: the whole REPLAY_UNIVERSE) —
// a targeted diagnostic run, and what lets the unit test walk a fixture universe.
// Both are NEW-mode only; nothing above changes shape or output because of them, and
// the pre-Stage-1 baseline worktree never passes them (its calibration module has no
// `seedGeneration` field to stamp).
//
// Candles are cached in ./.replay-cache (gitignored); REPLAY_CACHE_DIR overrides
// it, which is how the baseline worktree reads the SAME bars as the new run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import type { Candle } from '../shared/types'
import type { FactorName, Prediction } from '../shared/engine/types'
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
  type BucketPopulation,
  type CalibrationState,
  type WeightsState,
  CALIB_DEF_VERSION,
  ENGINE_MODEL_VERSION,
  bandFor,
  baseHitRate,
  gradeFor,
  gradePrediction,
  initWeights,
  probabilityFor,
} from '../shared/engine/calibration'
import { seedFromHistory } from '../shared/engine/backtest'
import { DEFAULT_WEIGHTS } from '../shared/engine/composite'
import { exchangeFor } from '../shared/symbols'
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

/** Is this a crypto pair? Crypto is EXCLUDED from the deep-seed universe because
 * stage 1c is unbuilt: there is no crypto cohort and no crypto base rate, so a
 * crypto row books into the EQUITY buckets and is graded against SPY — and crypto
 * trades weekends, so its bar index and SPY's diverge and the "10-session" horizon
 * is not even the same wall-clock span on the two sides of that excess. Precedent:
 * hypeCluster.ts:167-168 keeps crypto out of cluster detection for the same reason,
 * until stage 1c gives it a matched clock.
 *
 * NOT plain `exchangeFor(sym) === 'CRYPTO'`. That predicate tests the DASH first
 * (shared/symbols.ts:4-8) and only then the '.', so `BT-A.L` — BT Group, an LSE
 * equity sitting in SLEEVE_MIRROR — reads as CRYPTO, and a filter written the
 * obvious way would silently shrink the seed universe by a real name. An exchange
 * suffix settles it: a symbol carrying one is listed on that exchange, whatever
 * else is in the string. (The same ordering is a live defect in production's
 * market-hours and news paths; out of scope here, recorded in the task report.) */
// Delegates cleanly since Stage-3a Task 3: exchangeFor reads the suffix before
// the dash, so the local no-dot guard (which existed to keep BT-A.L out of the
// crypto bucket) is no longer load-bearing — kept as belt over braces.
export const isCryptoSymbol = (sym: string): boolean => !sym.includes('.') && exchangeFor(sym) === 'CRYPTO'

/** The population a v3 seed may measure: the walk universe with crypto removed. */
export const seedUniverse = (syms: string[] = REPLAY_UNIVERSE): string[] => syms.filter(s => !isCryptoSymbol(s))

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

/** Is a stage-gated engine module present in THIS tree? Every optional module here
 * (the dip lane, the velocity lane, the sleeve, the voice, the funnel trace) is
 * guarded on disk so this one file still loads inside the pre-Stage-1 baseline
 * worktree, where they do not exist.
 *
 * A PATH, not `new URL(…, import.meta.url)`. Under vitest the suite runs in the
 * jsdom environment, whose global `URL` is jsdom's own class rather than Node's —
 * `fs` refuses it and `existsSync` answers FALSE for every one of these, silently,
 * so every walk driven from the suite reported every optional module absent. The
 * board never depended on it (buildBoard imports the lanes itself); the harness's
 * dip/velocity diagnostics did, and so does the funnel-trace invariant this walk
 * now enforces — an instrument that disarms itself under test is worse than none. */
const stageModule = (file: string): string => join(REPO_ROOT, 'shared', 'engine', file)

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
  /** The route-blocked short PROMOTED to fill an empty side (engine.ts). Carried
   * since Stage-3a Task 4 because it is the one reader-visible zero-size class
   * that is NOT a grade decision, and the trace codes it separately
   * (`called-observation`) — without it the parity check could not tell a promoted
   * observation from an ordinary watch row. Always false in a pre-Stage-2 tree. */
  observation: boolean
  contract: boolean
  catalyst: string | null
  setup: string | null
  /** WHICH POPULATION THE ENGINE PRICED AND BOOKED THIS ROW IN (stage 3c, the
   * provenance partition — engine.ts stamps it at publish, pre-grade). 'sized' is
   * every candidate the reader could in principle have been offered; 'shadow' is
   * the three pre-grade causes that were never on offer at any grade. Null in any
   * tree older than the stamp, and null means POOLED here — the read this
   * harness did before the partition existed. */
  accrual: 'sized' | 'shadow' | null
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
  // ---- read back off the stored prediction at walk end (Stage 3b) ----
  /** THE ENGINE'S OWN 10-session grade, as it stands in `predictions:${date}` when
   * the walk finishes — NOT `outcome10` above, which the harness recomputes over
   * the full untruncated history for every row including the ones the engine
   * never got to grade. The post-mortem invariant is about what the ENGINE
   * classified of what the ENGINE graded, so it reads this and only this.
   * `null` = the engine never graded the row; absent = the walk could not read it
   * back at all (a near miss, or a pre-Stage-3b tree). */
  storedOutcome10?: { hit: boolean; excessPct: number; stopped: boolean } | null
  /** The deterministic post-mortem the engine stamped on this row when it graded
   * it a loser (postMortem.ts). ADDITIVE and always optional — it is written
   * ELEVEN sessions after the day that published the row, so it is backfilled at
   * walk end rather than captured in the day loop, and it is EXCLUDED from the
   * published-parity comparison by name. */
  postMortem?: PostMortemLike
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
   * the names buildBoard actually evaluated.
   *
   * It once said the lane "cannot fire in this harness" because `capUsdM` is null
   * for every name (approximation #4, no point-in-time cap source) and
   * VELOCITY_MIN_CAP_USD_M refuses an unknown cap. THAT IS NO LONGER TRUE. While
   * `VELOCITY_SHADOW_FIRST` is true the gate reads
   * `capUsdM == null ? !VELOCITY_SHADOW_FIRST : capUsdM < VELOCITY_MIN_CAP_USD_M`
   * (engine.ts:1450, flag at :610) — an unknown cap is ADMITTED, cap-less, as a
   * SHADOW row, precisely so the learning record fills (engine.test.ts:2419-2425,
   * "an UNKNOWN cap passes the liquidity floor only while the lane is shadowed").
   * So the lane does fire here, and a cap-less deep seed does get real
   * `velocity:long:*` setup buckets; they book into `evidence.shadow` rather than
   * `evidence.seed` (calibration.ts:479-480) and never reach the risk ladder
   * (engine.ts:459-462).
   *
   * The diagnostic stays regardless, and is still the honest instrument: it runs
   * the lane's own gates WITHOUT the engine's liquidity floor, so it reports the
   * would-be rows a cap-equipped run would have sized, next to the shadow rows this
   * run actually published. Without it the window could only say "0 sized velocity
   * rows" and nothing about why. */
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
  /** THE GRADE ANCHOR on the day the board was built — every grade threshold is
   * relative to it, so a grade histogram without it is unreadable. Since spec §9
   * that is the calibration's stored `referenceBase` when it carries one and the
   * pooled base otherwise, which is exactly what `gradeFor` was handed: the field
   * has always meant "the number the grades were measured against", and its job is
   * to stay that number rather than to stay the pooled rate. Identical to the
   * pooled base on every blob without a reference — including every walk, which
   * starts from `emptyLearningState`. */
  baseRate: number
  /** THE DAY'S FUNNEL TRACE (Stage 3a), read straight back out of the carrying
   * store — every candidate's fate under the gate that ended its run. ADDITIVE and
   * OPTIONAL: a pre-Stage-3a tree writes no such blob and the field is simply
   * absent, which is what lets this harness keep loading in the baseline worktree.
   *
   * `nearMisses` and `emptySides` ride the trace blob too and are deliberately NOT
   * copied here: the near-miss rows are already in `board` (flagged `nearMiss`),
   * and a diagnostics file carrying the ten `FactorScore` objects of every near
   * miss a second time would roughly double for nothing. */
  trace?: DayTrace
  /** THE TRACE DAY THIS MORNING'S PASS PRICED (Stage 3b) — the one day the miss
   * ledger accrued, ten sessions after the refusals it measures, or null when
   * nothing had matured yet. Surfaced per day because the accrual walking forward
   * one day per pass IS the mechanism, and a summary at the end would hide a pass
   * that measured nothing. */
  missAccrued?: (MissDayLike & { date: string }) | null
}

// ----------------------------------------------- the funnel trace, in the walk --
// Stage 3a Task 4. The trace is written by `buildBoard` into the SAME carrying
// store this walk drives, so surfacing it costs one read per day — no engine
// change, no second code path, and the walk's diagnostics become the first place
// the funnel can be read back over a window.
//
// The shapes below MIRROR shared/engine/funnelTrace.ts rather than importing it,
// for the reason every mirror in this file exists: a static import would not
// resolve in the pre-Stage-1 baseline worktree this harness still has to load in.
// The mirror cannot drift silently — `GATE_CODE_MIRROR` is checked against the
// engine's own union in replay-window.test.ts.

export interface TraceRow {
  gate: string
  side?: 'long' | 'short'
  source?: string
  detail?: string
}
export interface DayTrace {
  rows: Record<string, TraceRow>
  counts: { notCandidate: number }
}

/** The blob key, mirrored (funnelTrace.ts `funnelTraceKey`). */
const funnelTraceKeyOf = (date: string): string => `funnel-trace:${date}`

/** Every code `GateCode` declares (shared/engine/types.ts). */
export const GATE_CODE_MIRROR: ReadonlySet<string> = new Set([
  'not-candidate', 'trimmed', 'no-candles', 'no-data',
  'dead-zone-core', 'dead-zone-context', 'capacity-data', 'expected-move',
  'entry-wait', 'entry-chase', 'entry-reversal', 'evidence-fail', 'dip-refused',
  'grade-watchonly', 'route-blocked', 'diversity', 'slot-cut', 'shadow-capped',
  'called-full', 'called-half', 'called-shadow', 'called-watch', 'called-below-base', 'called-observation',
])

/** THE READER GOT THIS ROW. Mirrors `PUBLISHED_GATES`: the size decisions, the
 * promotion that fills an empty side, and the route-blocked shadow that still
 * reaches the ledger. */
const PUBLISHED_GATE_CODES: ReadonlySet<string> = new Set([
  'called-full', 'called-half', 'called-shadow', 'called-watch', 'called-below-base', 'called-observation', 'route-blocked',
])

/** The gates that fire BEFORE a side exists and therefore key on the bare name:
 * the two trims, the candle miss, and the tape that produced no read at all. */
const SIDE_FREE_GATES: ReadonlySet<string> = new Set(['trimmed', 'no-candles', 'no-data'])

/** The called-* code `publishCall` must have written for a row of this shape —
 * derived from what the READER can see on the row itself, never from the trace.
 * That is the point: two independent readings of one decision, compared.
 *
 * A shadow admits two codes because `route-blocked` is the more specific truth
 * about a shadow an ISA cannot place, and the ROW carries no field that separates
 * them (the engine records that distinction by id, deliberately — "the ledger must
 * not grow a field that means why we hid it"). Both are one size class: zero,
 * ledger-only. */
export function expectedCalledGates(r: Pick<Row, 'shadow' | 'watchOnly' | 'belowBase' | 'observation' | 'grade' | 'contract'>): string[] {
  if (r.shadow) return ['called-shadow', 'route-blocked']
  if (r.observation) return ['called-observation']
  if (r.watchOnly) return r.belowBase ? ['called-below-base'] : ['called-watch']
  // sized: full is A/B ON the core-data contract; everything else sized is half
  return (r.grade === 'A' || r.grade === 'B') && r.contract ? ['called-full'] : ['called-half']
}

/** THE CONSISTENCY INVARIANT, for one day. Returns every violation it finds (an
 * empty array is the pass) so a failure names the row instead of just failing.
 *
 * (a) EXACTLY ONCE. Every row keys by (name, side-or-none); the key parses, the
 *     row's own `side` agrees with it, the gate is declared, and the side-free
 *     gates stay side-free in both directions. One key, one fate.
 * (b) THE READER'S ROWS MATCH — ONE-DIRECTIONAL. Every board and ledger row the
 *     reader gets has a trace row at its exact key carrying a called-* code of the
 *     right SIZE CLASS; and conversely no called-* row exists for a (name, side)
 *     the reader never got — so a shadow the budget dropped (`shadow-capped`) or a
 *     row a cut took off the board sits in the trace and in neither published
 *     surface.
 *
 *     NEAR-MISS BOARD ROWS ARE EXEMPT from the called-* match, by design: a near
 *     miss is on the board carrying the gate that REFUSED it (dead-zone-core,
 *     expected-move…) because it cleared nothing and has no publication to name.
 *     Asserting the converse over them would assert against the board's own
 *     contract. They are NOT exempt from being traced: a near miss is a scored
 *     name, so it holds a row — and that row must never read as a publication.
 *     (Either side satisfies it: the board's near-miss side comes from the ROUNDED
 *     core read and composeCall's from the raw one, so a core that rounds to -0
 *     can legitimately be a long near miss against a short refusal.)
 */
export function traceViolations(day: { date: string; board: Row[]; ledger: Row[]; trace?: DayTrace }): string[] {
  const v: string[] = []
  const t = day.trace
  if (!t || !t.rows || typeof t.counts?.notCandidate !== 'number')
    return [`${day.date}: no funnel trace was written for this day — the funnel's record of the run is missing`]

  // ---- (a) one row per (name, side-or-none), and the key says which ----
  const seen = new Map<string, string>()
  for (const [key, row] of Object.entries(t.rows)) {
    const m = /^([^:]+)(?::(long|short))?$/.exec(key)
    if (!m) {
      v.push(`${key}: not a trace row key (SYM or SYM:long|short)`)
      continue
    }
    const [, sym, side] = m
    if (sym !== sym.toUpperCase()) v.push(`${key}: symbol is not upper-cased — one name spelled two ways is two rows`)
    const norm = side ? `${sym.toUpperCase()}:${side}` : sym.toUpperCase()
    const prior = seen.get(norm)
    if (prior) v.push(`${key}: a second row for ${norm} (already ${prior}) — a name and side appear exactly once`)
    seen.set(norm, key)
    if ((row.side ?? null) !== (side ?? null)) v.push(`${key}: row.side=${row.side ?? 'none'} disagrees with the key`)
    if (!GATE_CODE_MIRROR.has(row.gate)) v.push(`${key}: '${row.gate}' is not a declared GateCode`)
    else if (side && SIDE_FREE_GATES.has(row.gate)) v.push(`${key}: '${row.gate}' fires before a side exists and may not carry one`)
    else if (!side && !SIDE_FREE_GATES.has(row.gate)) v.push(`${key}: '${row.gate}' names a side's fate and may not be side-free`)
  }

  // ---- (b) the reader's rows, matched one-directionally ----
  const keyOfRow = (r: Row) => `${r.sym.toUpperCase()}:${r.side}`
  const match = (r: Row, where: 'board' | 'ledger') => {
    const trace = t.rows[keyOfRow(r)]
    if (!trace) {
      v.push(`${where} ${keyOfRow(r)} has no trace row — the reader got a row the funnel never recorded`)
      return
    }
    const want = expectedCalledGates(r)
    if (!want.includes(trace.gate))
      v.push(
        `${where} ${keyOfRow(r)} reads '${trace.gate}', expected ${want.join(' | ')} ` +
          `(shadow=${r.shadow} watchOnly=${r.watchOnly} belowBase=${r.belowBase} observation=${r.observation} grade=${r.grade} contract=${r.contract})`,
      )
  }
  const nearMissKeys = new Set<string>()
  for (const r of day.board) {
    if (r.nearMiss) {
      nearMissKeys.add(keyOfRow(r))
      const trace = t.rows[keyOfRow(r)] ?? t.rows[`${r.sym.toUpperCase()}:${r.side === 'long' ? 'short' : 'long'}`]
      if (!trace) v.push(`near miss ${keyOfRow(r)} has no trace row on either side — a near miss is a scored name and carries the gate that refused it`)
      else if (PUBLISHED_GATE_CODES.has(trace.gate)) v.push(`near miss ${keyOfRow(r)} reads '${trace.gate}' — a near miss cleared no gate and can never read as a publication`)
      continue
    }
    match(r, 'board')
  }
  for (const r of day.ledger) {
    if (r.nearMiss) {
      v.push(`near miss ${keyOfRow(r)} reached the ledger — near misses are board-only`)
      continue
    }
    match(r, 'ledger')
  }

  // …and the converse: a called-* code means the reader GOT the row.
  const readerKeys = new Set([...day.board.filter(r => !r.nearMiss), ...day.ledger].map(keyOfRow))
  // (the keys compare as written: `traceRowKey` upper-cases the name and the side
  // is a literal, and a row whose name is NOT upper-cased is already a violation
  // above — so upper-casing here would only mangle the side back into a miss)
  for (const [key, row] of Object.entries(t.rows)) {
    const published = PUBLISHED_GATE_CODES.has(row.gate)
    if (published && !readerKeys.has(key)) v.push(`${key} reads '${row.gate}' and the reader got no such row — a called-* code that published nothing`)
    if (!published && readerKeys.has(key) && !nearMissKeys.has(key)) v.push(`${key} reads '${row.gate}' yet the reader got the row`)
  }
  return v
}

// ------------------------------------------ the regret machinery, in the walk --
// Stage 3b Task 4. BOTH mechanisms already RUN here and always have: the walk
// calls `gradeOutstanding` every morning, the post-mortem is stamped inside it at
// the point the loser becomes known, and the miss ledger's hook is its last
// statement. So nothing below drives a second code path — it SURFACES what the
// engine did (the ledger blob read back out of the carrying store; the
// post-mortems read back off the prediction rows at walk end) and then CHECKS it.
//
// WHY THE POST-MORTEMS ARE READ AT THE END and not in the day loop: a row
// published on day D is graded ELEVEN sessions later, so the field is written
// into `predictions:D` on a much later morning. The snapshot the loop takes on
// day D structurally cannot carry it.
//
// The shapes are MIRRORED rather than imported, for the reason every mirror in
// this file exists: a static import of a Stage-3b module would not resolve in the
// pre-Stage-1 baseline worktree this harness still has to load in. Both mirrors
// are drift-guarded in replay-window.test.ts against the modules' own source,
// exactly like GATE_CODE_MIRROR.

/** missLedger.ts `MISS_LEDGER_KEY`. */
export const MISS_LEDGER_KEY_MIRROR = 'miss-ledger'
/** gateState.ts `GATE_STATE_KEY`. */
export const GATE_STATE_KEY_MIRROR = 'gate-state'
/** missLedger.ts `MISS_EXCESS_MIN` — ±5pp, deliberately five times the hit bar.
 * A move inside it is not an opportunity the engine owes anyone an apology for,
 * so nothing inside it may ever be charged to a gate. */
export const MISS_EXCESS_MIN_MIRROR = 5
/** missLedger.ts `MISS_SKIP_GATES` — the rows a miss may never be charged for:
 * the two SIZED publications (the reader got the row and a size; it grades in the
 * ledger already) and the three shadow shapes (an audition the engine
 * deliberately withheld, which also grades already, with a real published stop). */
export const MISS_SKIP_GATE_MIRROR: ReadonlySet<string> = new Set(['called-full', 'called-half', 'called-shadow', 'route-blocked', 'shadow-capped'])
/** postMortem.ts `POSTMORTEM_CLASSES`, IN PRECEDENCE ORDER — the order is the
 * definition, so the mirror is an array and the drift guard compares it ordered. */
export const POSTMORTEM_CLASS_MIRROR: readonly string[] = ['stopped', 'thesis-break', 'market-drag', 'news-reversal', 'adverse-move']
/** missLedger.ts `MISS_LEDGER_DAYS_MAX` — the retained day window. The ONE way a
 * measured day may legally vanish between two passes is `recordMissDay` pruning
 * the oldest once this many are held. */
export const MISS_LEDGER_DAYS_MAX_MIRROR = 60
/** postMortem.ts `POSTMORTEM_HORIZON` — the calibrated ten sessions, used here
 * only to work out which morning the engine graded a row on. */
export const POSTMORTEM_HORIZON_MIRROR = 10
/** How many graded losers the walk re-classifies from scratch. Twenty is enough
 * to catch a precedence rule that stopped holding and cheap enough to run on
 * every window: the coverage claim (`classified === losers`) is TOTAL, and this
 * is the depth check underneath it. */
export const REGRET_SAMPLE_K = 20

export interface MissExampleLike {
  date: string
  sym: string
  side: 'long' | 'short'
  /** POSITIVE on a cost, NEGATIVE on a save — the sign is what tells the two
   * apart inside one bounded list. */
  excessPct: number
  gate: string
  /** the row died before a side existed and was scored BOTH ways */
  bare?: boolean
}
export interface MissGateStatLike {
  cost: number
  costExcessSum: number
  saved: number
  savedExcessSum: number
  unchecked: number
  examples: MissExampleLike[]
}
export interface MissDayLike {
  checked: number
  unchecked: number
  misses: number
}
export interface MissLedgerLike {
  gates: Record<string, MissGateStatLike>
  days: Record<string, MissDayLike>
}
export interface PostMortemLike {
  cls: string
  detail: string
  at: number
  sentence?: string
  via?: string
  clsBefore?: string
}

/** What the invariants are checked AGAINST: the walk's own record of the window.
 * Every claim the ledger makes is settled against the trace the walk itself
 * captured and the rows the reader actually got — two independent readings of one
 * morning, compared, which is the same instrument shape `traceViolations` uses. */
export interface RegretContext {
  /** The walked dates, in walk order — the only dates a `days` entry may name. */
  dates: string[]
  /** Each walked day's trace, by date (absent when that day wrote none). */
  traces: Record<string, DayTrace | undefined>
  /** SIZED published rows per date, keyed `SYM:side`: the population that may
   * never appear as a miss, read off the ROW's own `riskPct` rather than off the
   * gate code the ledger is being checked for. */
  sized: Record<string, Set<string>>
}

export function regretContextOf(days: { date: string; board: Row[]; ledger: Row[]; trace?: DayTrace }[]): RegretContext {
  const traces: RegretContext['traces'] = {}
  const sized: RegretContext['sized'] = {}
  for (const d of days) {
    traces[d.date] = d.trace
    sized[d.date] = new Set([...d.board, ...d.ledger].filter(r => r.riskPct > 0).map(r => `${r.sym.toUpperCase()}:${r.side}`))
  }
  return { dates: days.map(d => d.date), traces, sized }
}

/** The rows in a day's trace a miss may be charged for — every row whose gate is
 * not on the skip list. `checked + unchecked` for that day must equal it exactly:
 * a truncation nobody can see is the silence Stage 3 exists to end. */
export const missCandidateCount = (t?: DayTrace): number => Object.values(t?.rows ?? {}).filter(r => !MISS_SKIP_GATE_MIRROR.has(r.gate)).length

/** THE MISS LEDGER'S INVARIANTS, over the whole window. Returns every violation
 * so a failure names the row rather than just failing.
 *
 * (a) A PUBLISHED, SIZED ROW IS NEVER A MISS — checked twice over, because it is
 *     the claim the whole feature stands on. Once totally: the skip gates may not
 *     appear in `gates` AT ALL, and since every charge and every unchecked row is
 *     booked under the trace row's own gate, their absence proves no such row was
 *     ever charged anywhere in the window. Once again per example, against the
 *     BOARD: no example may name a (date, sym, side) the reader had a size on.
 * (b) THE DAYS ARE THE WALK'S DAYS, CONTIGUOUSLY. Exactly one trace day crosses
 *     the ten-session maturity line per pass, and the engine works the newest
 *     matured day each time, so over a contiguous walk the measured days are the
 *     oldest N walked dates with no gap. A hole means a matured day was skipped
 *     and never revisited — the one failure mode of "newest first, one per pass".
 * (c) THE ACCOUNTING CLOSES. Per day, checked + unchecked = the day's candidate
 *     count. Over the window, Σ gate.unchecked = Σ day.unchecked and Σ gate.cost
 *     = Σ day.misses — the same events counted along two different axes, so a row
 *     that fell out of one and not the other is caught. (Only while nothing has
 *     been pruned: the per-gate columns are lifetime, the days window is 60.)
 * (d) EVERY EXAMPLE IS REAL. Its date was walked, its gate is what the trace says
 *     refused that exact key, and its excess is outside the ±5pp bar. */
export function missLedgerViolations(ledger: MissLedgerLike | null | undefined, ctx: RegretContext): string[] {
  const v: string[] = []
  if (!ledger) return v // nothing has matured yet — an absence, not a zero
  const days = Object.keys(ledger.days ?? {}).sort()
  const gates = Object.entries(ledger.gates ?? {})

  // (a) the total half
  for (const [gate] of gates)
    if (MISS_SKIP_GATE_MIRROR.has(gate))
      v.push(`miss ledger charges '${gate}' — a row the reader got a size on (or a shadow that grades already) can never be a miss`)

  // (b) the days
  for (const d of days) if (!ctx.dates.includes(d)) v.push(`miss-ledger day ${d} is not a day this walk walked — the ledger measured a morning that never happened`)
  const walked = days.filter(d => ctx.dates.includes(d))
  if (walked.length) {
    const first = ctx.dates.indexOf(walked[0])
    const expected = ctx.dates.slice(first, first + walked.length)
    for (const d of expected) if (!ledger.days[d]) v.push(`miss-ledger has no entry for ${d}, a matured trace day between ${walked[0]} and ${walked[walked.length - 1]} — a day that matured and was never measured is never revisited`)
  }

  // (c) the accounting
  for (const d of walked) {
    const entry = ledger.days[d]
    const want = missCandidateCount(ctx.traces[d])
    if (!Number.isInteger(entry.checked) || !Number.isInteger(entry.unchecked) || !Number.isInteger(entry.misses) || entry.checked < 0 || entry.unchecked < 0 || entry.misses < 0)
      v.push(`miss-ledger day ${d} carries a nonsense count: ${JSON.stringify(entry)}`)
    if (entry.checked + entry.unchecked !== want)
      v.push(`miss-ledger day ${d}: checked ${entry.checked} + unchecked ${entry.unchecked} is not the ${want} refusals the trace recorded — a population went missing`)
    if (entry.misses > entry.checked * 2) v.push(`miss-ledger day ${d}: ${entry.misses} misses out of ${entry.checked} priced rows — a row can cost at most one side`)
  }
  if (days.length < 60 && walked.length === days.length) {
    const dayUnchecked = days.reduce((s, d) => s + (ledger.days[d].unchecked ?? 0), 0)
    const gateUnchecked = gates.reduce((s, [, g]) => s + (g.unchecked ?? 0), 0)
    if (dayUnchecked !== gateUnchecked) v.push(`miss-ledger: ${dayUnchecked} unchecked rows by day but ${gateUnchecked} by gate — an unpriced row was charged to no gate`)
    const dayMisses = days.reduce((s, d) => s + (ledger.days[d].misses ?? 0), 0)
    const gateCost = gates.reduce((s, [, g]) => s + (g.cost ?? 0), 0)
    if (dayMisses !== gateCost) v.push(`miss-ledger: ${dayMisses} misses by day but ${gateCost} cost events by gate — a miss was charged to no gate`)
  }

  // (d) the examples
  for (const [gate, g] of gates) {
    for (const ex of g.examples ?? []) {
      const key = `${ex.date}:${ex.sym}:${ex.side}`
      if (ex.gate !== gate) v.push(`${key}: filed under '${gate}' but the example says '${ex.gate}'`)
      if (!ctx.dates.includes(ex.date)) {
        v.push(`${key}: names a day this walk never walked`)
        continue
      }
      if (Math.abs(ex.excessPct) < MISS_EXCESS_MIN_MIRROR) v.push(`${key}: charged at ${ex.excessPct}pp, inside the ±${MISS_EXCESS_MIN_MIRROR}pp bar — the miss bar is not the hit bar`)
      if (ctx.sized[ex.date]?.has(`${ex.sym.toUpperCase()}:${ex.side}`)) v.push(`${key}: charged as a miss although the reader was given a size on it that morning`)
      const rows = ctx.traces[ex.date]?.rows ?? {}
      // a bare row keys on the name alone and is scored BOTH ways, so its example
      // carries a side the trace row deliberately does not
      const traced = ex.bare ? rows[ex.sym.toUpperCase()] : rows[`${ex.sym.toUpperCase()}:${ex.side}`]
      if (!traced) v.push(`${key}: the funnel never recorded such a refusal that morning`)
      else if (traced.gate !== ex.gate) v.push(`${key}: charged to '${ex.gate}' but the funnel says '${traced.gate}' ended its run`)
    }
  }
  return v
}

/** ONE DAY PER PASS, AND NEVER TWICE. The blob is additive, so a day accrued a
 * second time double-charges its gates forever — `days[date]` is the engine's
 * guard and this is the walk watching that guard hold, morning after morning,
 * against the real store rather than a fixture. */
export function missAccrualViolations(prev: MissLedgerLike | null | undefined, next: MissLedgerLike | null | undefined): string[] {
  const v: string[] = []
  const before = prev?.days ?? {}
  const after = next?.days ?? {}
  const kept = Object.keys(after).sort()
  for (const [d, entry] of Object.entries(before)) {
    if (!after[d]) {
      // THE ONE LEGAL DISAPPEARANCE: `recordMissDay` prunes the oldest entries
      // once the 60-day window is full, and the prune is what makes "newest
      // matured day, one per pass" safe — a day old enough to be dropped can
      // never be selected again. Anything else is a measured day being unmeasured.
      if (kept.length >= MISS_LEDGER_DAYS_MAX_MIRROR && d < kept[0]) continue
      v.push(`miss-ledger day ${d} disappeared between passes — a measured day may never be unmeasured`)
      continue
    }
    if (JSON.stringify(after[d]) !== JSON.stringify(entry)) v.push(`miss-ledger day ${d} was RE-ACCRUED: ${JSON.stringify(entry)} → ${JSON.stringify(after[d])} — the blob is additive, so twice is double-charged`)
  }
  const added = Object.keys(after).filter(d => !before[d])
  if (added.length > 1) v.push(`miss-ledger accrued ${added.length} new days in one pass (${added.join(', ')}) — exactly one trace day matures per session`)
  return v
}

/** EVERY GRADED LOSER EXPLAINS ITSELF — and nothing else does.
 *
 * Read off `storedOutcome10`, which is the ENGINE's own grade as it stands in the
 * prediction blob at walk end, never the harness's independent regrade: the
 * question is whether the engine classified what the engine graded. A row the
 * walk could not read back at all (`storedOutcome10` undefined — a near miss, or
 * a pre-Stage-3b tree) is skipped rather than failed. */
export function postMortemViolations(days: { date: string; board: Row[]; ledger: Row[] }[]): string[] {
  const v: string[] = []
  for (const day of days) {
    for (const r of day.ledger) {
      if (r.storedOutcome10 === undefined) continue
      const key = `${day.date}:${r.sym}:${r.side}`
      const pm = r.postMortem
      if (!r.storedOutcome10) {
        if (pm) v.push(`${key}: carries a post-mortem although the engine never graded it`)
        continue
      }
      if (r.storedOutcome10.hit) {
        if (pm) v.push(`${key}: won and still carries a post-mortem — winners get nothing`)
        continue
      }
      if (!pm) {
        v.push(`${key}: the engine graded it a loser and it explains nothing`)
        continue
      }
      if (!POSTMORTEM_CLASS_MIRROR.includes(pm.cls)) v.push(`${key}: '${pm.cls}' is not a declared post-mortem class`)
      if (!pm.detail) v.push(`${key}: a class with no detail — the sentence is the half a human reads`)
      if (!Number.isFinite(pm.at) || pm.at <= 0) v.push(`${key}: stamped at ${pm.at}`)
    }
  }
  return v
}

/** One loser, re-classified from scratch. `row`/`outcome` are the shapes
 * postMortem.ts declares, kept structural so this file never grows a dependency
 * on the full prediction. */
export interface PrecedenceSample {
  key: string
  row: { side: 'long' | 'short'; date: string; stop: number; trail?: 'velocity'; catalyst?: { kind: string; reason: string } | null }
  outcome: { hit: boolean; stopped: boolean; excessPct: number; rawPct: number; spyPct: number }
  postMortem: PostMortemLike
  candles: Candle[]
}

/** THE PINNED TOTAL ORDER, RE-DERIVED. The classifier is a PARAMETER so this is
 * the engine's own `classifyLoser` doing the work — a spot-check that used a copy
 * of the rules would only prove the copy agrees with itself — and so the suite can
 * drive a broken one through the same code and watch the instrument fire.
 *
 * The stored class may legally differ from the tape's in exactly ONE way: the
 * budgeted LLM pass upgrading a row to `news-reversal`, which keeps what it
 * replaced in `clsBefore` (postMortemLlm.ts). That is compared against
 * `clsBefore`; an upgrade that kept no record of what it overwrote is itself a
 * violation. The detail is compared too, except on an upgrade, where the class's
 * own words legitimately move into a longer sentence. */
export function precedenceViolations(
  samples: PrecedenceSample[],
  classify: (row: PrecedenceSample['row'], o: PrecedenceSample['outcome'], candles: Candle[]) => { cls: string; detail: string },
): string[] {
  const v: string[] = []
  for (const s of samples) {
    let truth: { cls: string; detail: string }
    try {
      truth = classify(s.row, s.outcome, s.candles)
    } catch (e) {
      v.push(`${s.key}: re-classifying it threw — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const upgraded = s.postMortem.cls === 'news-reversal'
    const stored = upgraded ? s.postMortem.clsBefore : s.postMortem.cls
    if (stored === undefined) {
      v.push(`${s.key}: reads 'news-reversal' with no clsBefore — the upgrade must record the deterministic class it replaced`)
      continue
    }
    if (stored !== truth.cls) v.push(`${s.key}: stored '${s.postMortem.cls}' but the tape says '${truth.cls}' — the precedence order did not hold`)
    else if (!upgraded && s.postMortem.detail !== truth.detail) v.push(`${s.key}: the class agrees and the detail does not — stored '${s.postMortem.detail}' vs '${truth.detail}'`)
  }
  return v
}

/** A deterministic spread over a population, for the precedence spot-check. Hashed
 * rather than sliced: the sample must be identical run to run (a proof that
 * changes when you re-run it is not a proof) without being the first k rows of the
 * calendar or the alphabet. */
export function regretSample<T>(items: T[], k: number, keyOf: (t: T) => string): T[] {
  const h = (s: string) => {
    let x = 0
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0
    return x
  }
  return [...items].sort((a, b) => h(keyOf(a)) - h(keyOf(b)) || keyOf(a).localeCompare(keyOf(b))).slice(0, k)
}

/** THE WINDOW'S POST-MORTEM CENSUS — the histogram Stage 3c reads to learn HOW the
 * engine loses, plus the coverage numbers that say whether the histogram is
 * complete. */
export interface PostMortemCensus {
  /** Rows the ENGINE graded at ten sessions inside this window. */
  graded: number
  losers: number
  /** …of which carry a class. `classified === losers` is the invariant. */
  classified: number
  byClass: Record<string, number>
  /** The scorecard's own key: setup family × regime × class. */
  byKey: Record<string, number>
  /** Losers re-classified from scratch and compared against the stored class. */
  sampled: number
  /** Post-mortems carrying a bought sentence. STRUCTURALLY ZERO in the walk — it
   * builds its own deps and never carries `postMortemSentence` — so a non-zero
   * here would mean the harness had grown an LLM dependency. */
  sentences: number
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
  observation: !!(p as { observation?: boolean }).observation,
  contract: !!p.evidence?.contract,
  catalyst: p.catalyst?.kind ?? null,
  setup: p.setup ?? null,
  accrual: (p as { accrual?: 'sized' | 'shadow' }).accrual ?? null,
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
 * module had moved on underneath it.
 *
 * IN THE ROW'S OWN POPULATION, AND WITH ITS OWN FAMILY [stage 3c task 4, binding
 * from the Task-1 review]. This recomputation was POOLED and unblended, which was
 * byte-identical to the board until the partition and the blend existed. From
 * generation 4 on it is not: engine.ts prices a candidate against SIZED history
 * with `call.setup` in hand, and prices a pre-grade shadow against the pool. A
 * pooled recomputation would hand the born-below census, the §3 rounding read and
 * the monotonicity gate a curve no row was ever graded on — the gate would pass or
 * fail on a counterfactual. The stamp travels on the row (`accrual`), so the
 * choice is read rather than inferred; absence is a pre-stamp tree and reads
 * pooled, exactly as this function always did. */
export function enrichFromCalibration(rows: Row[], cal: CalibrationState | null, baseRate: number): void {
  if (!cal) return
  for (const r of rows) {
    if (r.nearMiss) continue // a near miss never went through the read path at all
    // cohort 'unknown' is not a simplification here: `capUsdM` is null for every
    // name in a price-only replay (approximation #4), so publishCall's own
    // capCohortOf returned exactly this on the row being reproduced.
    const population: BucketPopulation = r.accrual === 'sized' ? 'sized' : 'pooled'
    const read = probabilityFor(cal, r.side, r.regime, Math.abs(r.composite), 'unknown', population, r.setup) as unknown as {
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

// ------------------------------------------------- the seed artefact (2b) --

/** EXACTLY the committed `shared/engine/seed.json` shape. The file is read by
 * `loadState` and by nothing else, so its shape is a contract with one consumer
 * and must not drift from it. */
export interface SeedArtefact {
  generatedAt: string
  symbols: number
  weights: WeightsState
  calibration: CalibrationState
}

const cloneJson = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const zero = () => ({ n: 0, hits: 0 })

/** THE FACTORS THIS HARNESS CANNOT FEED — one entry per empty dependency in
 * `makeDeps` above, and the complement of the four the tape alone can score
 * (technical, momentum, sector, seasonality).
 *
 *   social       `social: async () => []`
 *   insiders     `insiderCoverage: async () => new Map()`
 *   smartMoney   `smartMoney: async () => []`
 *   channels     no YouTube stances — the walk's config carries `ytChannels: []`
 *   news         `mediaTitles: async () => []`
 *   catalyst     `newsCatalysts: async () => []`
 *
 * WHY THE LIST HAS TO EXIST AT ALL [stage 3c task 4, binding from the Task-2
 * review]. Until stage 3c every one of these was self-cleaning: an absent input
 * produced a null or a zero, and `updateIcStats` skipped both, so a price-only
 * walk simply left their IC at zero (the generation-3 artefact carries exactly
 * that — six columns of 0/0). Task 2's `ZERO_IS_A_READING` deliberately admits
 * news's zero, because `newsFactor` has no null path and its "quiet tape" branch
 * is a real reading of a real tape. In production that is right. HERE the tape is
 * empty by construction, so every graded row books the same fabricated
 * observation — against every long, with every short — and two years of them sail
 * past both twenty-observation floors with a mean that is pure selection. Install
 * that and the first live nudge moves a real weight on a measurement nobody made.
 *
 * So the artefact drops them. Not the walk — the walk keeps its blob and its
 * diagnostics; the SEED, at serialisation, because the seed is the thing
 * production loads. The rule is stated as "the walk could not feed it" rather
 * than "its column looks odd": zeroing an already-empty column is a no-op, which
 * is what makes the list safe to state in full rather than trimmed to whichever
 * factor happens to misbehave this generation. The day a dependency stops being
 * empty, its name comes off this list in the same commit. */
export const WALK_ABSENT_FACTORS: readonly FactorName[] = ['social', 'insiders', 'smartMoney', 'channels', 'news', 'catalyst']

/** How many graded rows a reference sweep must carry before its reading may be
 * stored. A thin reference is WORSE than none: absence falls back to the pooled
 * base — a known quantity with known semantics — while a stored 0.31 read off
 * forty rows silently becomes the yardstick for every grade the seed ever hands
 * out. Five hundred is the same order as the committed generation-1 seed's whole
 * population (778) — a floor set where "this is as much evidence as the seed we
 * already trust" becomes true, not at a number that merely sounds large. */
const REFERENCE_MIN_N = 500
/** The sanity band (2026-08-13 walk-results doc). Every measurement of the
 * unconditional gate-clearing rate so far has sat near 0.37; a sweep reading 0.08
 * or 0.90 has measured something other than what it believes — a broken hit rule,
 * a benchmark mismatch, a universe that collapsed to one name — and the failure
 * mode of accepting it is a seed that grades everything or nothing for a year.
 *
 * The band is checked AFTER the 4dp round, deliberately (the number checked is the
 * number stored), so in raw terms it admits [0.24995, 0.55005): a 0.2499501 sweep
 * stores 0.25 and passes, a 0.2494999 sweep stores 0.2495 and is refused. Half a
 * tick of slack at each edge is the consequence of rounding first, not a second
 * policy — and it is stated here because "outside [0.25, 0.55]" in the refusal
 * message is otherwise a hair narrower than what the code does. */
const REFERENCE_MIN = 0.25
const REFERENCE_MAX = 0.55

/** THE REFERENCE SWEEP (spec §9) — the unconditional population, measured with the
 * SAME machinery that graded the walk.
 *
 * The walk's buckets describe the rows the board PUBLISHES, which is a selected
 * population; this measures the rows the market OFFERS. The gap between the two is
 * the whole content of a grade: "how much better is this pick than any ordinary
 * candidate?" is the question a reader actually asks, and it cannot be answered
 * from the published population alone.
 *
 * `seedFromHistory` is called rather than reimplemented, deliberately: it is the
 * grading TWIN of the live path (same 10-session horizon, same close-based stop,
 * same HIT_EXCESS_MIN, same entry-at-next-open basis — backtest.ts states and
 * pins the correspondence), and a second implementation of that arithmetic would
 * be a second thing to keep in step with `gradePrediction` forever. Its
 * walk-forward honesty is structural: every factor reads `candles.slice(0, i + 1)`,
 * the regime reads `spy.slice(0, j + 1)` with breadth computed per date from
 * bar-k-and-earlier SMAs, and the outcome is taken from bars i+1 … i+1+HORIZON —
 * strictly after the decision. (The per-symbol outer loop means accumulation is not
 * globally chronological, which is irrelevant here: nothing in the sweep READS the
 * buckets as it fills them; only the final pooled rate is used.)
 *
 * The pooled estimate is spelled out rather than delegated to `baseHitRate`,
 * because `baseHitRate` returns a flat 0.5 below fifty observations — a thin sweep
 * would come back looking exactly like an ordinary measurement, and 0.5 sits
 * inside the sanity band. Here the raw `n` travels with the rate and the caller
 * refuses on it.
 *
 * Pure and deterministic: no clocks, no RNG, no network. */
export function referenceSweep(input: {
  /** Every non-crypto name the walk ASKED for candles on, across the whole window
   * (the caller's `sweptUniverse`, not the list it was handed — a roster arrival or
   * a theme-door name is part of the population the board draws from), each
   * truncated to the bars the walk's LAST morning could see, which is what bounds
   * the sweep from above. */
  bySym: Map<string, Candle[]>
  spy: Candle[]
  qqq?: Candle[]
  vix?: Candle[]
  /** The walk's own `--from`. Bounds the sweep from below (backtest.ts `window`). */
  fromISO: string
}): { rate: number; n: number } {
  const { calibration } = seedFromHistory(input.bySym, input.spy, input.qqq, input.vix, { fromISO: input.fromISO })
  const t = Object.values(calibration.buckets).reduce((a, b) => ({ n: a.n + b.n, hits: a.hits + b.hits }), { n: 0, hits: 0 })
  return { rate: (t.hits + 2) / (t.n + 4), n: t.n }
}

/** Turn the two blobs the walk leaves in the carrying store into a seed artefact.
 *
 * Every rule below exists because its absence fails SILENTLY in production:
 *
 * 1. SELF-DESCRIBING STAMPS. `defVersion`/`modelVersion`/`seedGeneration` are
 *    written explicitly rather than left to `migrateCalibration`'s `??=` backfill.
 *    The committed seed says `modelVersion: 2` today for exactly that reason — the
 *    seeder never wrote one and the constant happened to be 2 the day it ran. A
 *    committed artefact should not have to be loaded to be read.
 * 2. `weights.base` MUST equal `DEFAULT_WEIGHTS`. `rebaseWeights` runs on every
 *    load and, when the stored base disagrees, re-bases and ZEROES the IC — so a
 *    drifted base ships "seeded IC stats for all four core factors" that production
 *    deletes on arrival (it has been deleting the committed seed's since stage 2).
 *    This throws rather than rewriting the base: a base that drifted means the IC
 *    beside it was measured under another vector, and quietly relabelling it would
 *    make the seed lie about which model earned it.
 * 3. THE EVIDENCE RELABEL. The walk's rows book as live/shadow, because live
 *    grading never passes `provenance` (engine.ts). Relative to the engine that
 *    will LOAD this file they are not live at all — they are prior. So the
 *    aggregate live tally folds into `seed` and live is zeroed. `shadow` is left
 *    exactly as it stands: a velocity-lane shadow row IS a measured shadow record,
 *    not sized history, and flattening it into `seed` would claim the risk ladder
 *    had seen money on tape where it never did.
 * 4. THE BRIER TRAIL IS DROPPED. `calibration.brier` feeds `brierImproving`, which
 *    argues for risk-ladder promotions (engine.ts). A seed that handed production a
 *    250-day promotion argument dated to a walk would size the reader's next trade
 *    on tape they never traded. The committed seed ships `[]`; so does this.
 * 5. BOTH BLOBS OR NEITHER. A missing half is a throw, never a default — the
 *    weights blob has never been read back out of this harness before, and a silent
 *    `initWeights()` fallback would emit a seed with no IC at all and look fine.
 * 6. ONE GENERATION ON BOTH HALVES. loadState swaps calibration and weights
 *    independently, each keyed on its own blob's generation. Halves that disagree
 *    install asymmetrically and silently: one epoch's buckets beside another
 *    epoch's factor evidence.
 * 7. THE GRADE ANCHOR IS MEASURED (spec §9). `reference` is REQUIRED, not optional:
 *    a v3 artefact grades against the unconditional sweep, and an emission that
 *    forgot to run one would fall back to the pooled base and reproduce the all-C
 *    board the addendum exists to fix — silently, because the file would still
 *    load. It is thrown out rather than clamped when it is thin or absurd: a
 *    reference is the yardstick for every grade the seed will ever hand out, and a
 *    clamped yardstick is a wrong one with a plausible face.
 *
 * Pure, and it does not mutate its inputs — the walk's store keeps its own state. */
export function seedArtefactFrom(input: {
  calibration: CalibrationState | null
  weights: WeightsState | null
  /** Distinct symbols that contributed at least one published row — the population
   * this evidence was drawn from, which is what the committed seed's `symbols`
   * (`bySym.size`) means too. Never "the universe I was handed". */
  symbols: number
  generation: number
  /** What `referenceSweep` read over the same window and universe — the raw pooled
   * rate and the sweep's own row count. Validated and rounded here, never taken on
   * trust and never supplied by an operator (spec §9). */
  reference: { rate: number; n: number }
  generatedAt?: string
}): SeedArtefact {
  const { generation } = input
  if (!Number.isInteger(generation) || generation < 1)
    throw new Error(`BLOCKED: --seed-generation must be a positive integer, got ${JSON.stringify(input.generation)}`)
  if (!input.calibration) throw new Error('BLOCKED: the walk left no `engine-calibration` blob — there is nothing to serialise')
  if (!input.weights) throw new Error('BLOCKED: the walk left no `engine-weights` blob — a seed without its factor IC is half an artefact')

  // guarantee 7 — the grade anchor, validated before anything is stamped
  const { rate, n } = input.reference
  if (!Number.isFinite(rate) || !Number.isFinite(n))
    throw new Error(`BLOCKED: the reference sweep returned a non-finite reading (rate ${rate}, n ${n}) — the grade anchor may not be NaN`)
  if (n < REFERENCE_MIN_N)
    throw new Error(
      `BLOCKED: the reference sweep graded only ${n} rows, under the ${REFERENCE_MIN_N} a stored anchor needs. A thin reference is worse than none — absence falls back to the pooled base, a stored guess does not. Widen the window or the universe.`,
    )
  // rounded FIRST, so the number that is checked is the number that is stored
  const referenceBase = Math.round(rate * 1e4) / 1e4
  if (referenceBase < REFERENCE_MIN || referenceBase > REFERENCE_MAX)
    throw new Error(
      `BLOCKED: the reference sweep read ${referenceBase} over ${n} rows, outside the sane band [${REFERENCE_MIN}, ${REFERENCE_MAX}]. Every honest measurement of the unconditional gate-clearing rate has sat near 0.37; this one measured something else.`,
    )

  const calibration = cloneJson(input.calibration)
  const weights = cloneJson(input.weights)

  const names = [...new Set([...Object.keys(DEFAULT_WEIGHTS), ...Object.keys(weights.base ?? {})])] as (keyof typeof DEFAULT_WEIGHTS)[]
  const drifted = names.filter(n => weights.base?.[n] !== DEFAULT_WEIGHTS[n])
  if (drifted.length)
    throw new Error(
      `BLOCKED: weights.base disagrees with DEFAULT_WEIGHTS on ${drifted.join(', ')} — rebaseWeights would zero this seed's IC on the first production load. Re-run the walk on a tree whose DEFAULT_WEIGHTS is the one it scored with.`,
    )
  // guarantee 2b — and `current` is the half that fails silently. A drifted `base`
  // is caught above only because `rebaseWeights` reacts to it on load; a drifted
  // `current` is reacted to by NOTHING — it simply becomes production's scoring
  // vector. Generation 2 shipped 450 compounding nudges that way (technical 0.0791
  // on a base of 1.0, momentum at the 2× cap, 73 % of the composite), inverting the
  // ratified factor order and pricing buckets under a vector that was still moving.
  // Seed mode pins `current` to `base` after every graded day, so an unpinned vector
  // here means the pin did not run and the artefact is not what it claims to be.
  const unpinned = names.filter(n => weights.current?.[n] !== weights.base?.[n])
  if (unpinned.length)
    throw new Error(
      `BLOCKED: weights.current deviates from weights.base on ${unpinned.join(', ')} — the walk's compounding nudges are inside this artefact. A seed is only honest if it was measured under the vector production will score with; seed mode pins current to base after every graded day.`,
    )
  // guarantee 8 — no IC from a factor this harness could not feed (see
  // WALK_ABSENT_FACTORS). Both halves go: the COLUMN, which production would nudge
  // on, and the factor's line in every `history` entry, which the weights panel
  // would otherwise report as a measured change. `current` is already pinned to
  // `base` by the check above, so nothing about the shipped vector moves here —
  // what is removed is the claim that something measured it.
  for (const f of WALK_ABSENT_FACTORS) {
    weights.ic[f] = { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }
    for (const h of weights.history ?? []) delete h.changes[f]
  }
  weights.seedGeneration = generation

  calibration.defVersion = CALIB_DEF_VERSION
  calibration.modelVersion = ENGINE_MODEL_VERSION
  calibration.seedGeneration = generation
  calibration.referenceBase = referenceBase
  calibration.seeded = true
  calibration.setupBuckets ??= {}
  calibration.brier = []
  const ev = calibration.evidence ?? { seed: zero(), live: zero(), shadow: zero() }
  calibration.evidence = {
    seed: { n: ev.seed.n + ev.live.n, hits: ev.seed.hits + ev.live.hits },
    live: zero(),
    shadow: ev.shadow,
  }

  return { generatedAt: input.generatedAt ?? new Date().toISOString(), symbols: input.symbols, weights, calibration }
}

/** The blank slate a seed walk starts from. NOT the committed seed: `loadState`'s
 * cold start would otherwise hand the walk generation 1's 778 rows and the artefact
 * would ship a MIXTURE of two scoring epochs inside one set of buckets — the exact
 * thing backtest.ts's header forbids ("do not mix a regenerated seed with the
 * committed one — regenerate whole") and the thing loadState's own swap refuses to
 * do (it REPLACES, never merges). Stamped with the generation being emitted so the
 * committed seed cannot swap itself in over the walk's own state mid-run. */
function emptyLearningState(generation: number): { calibration: CalibrationState; weights: WeightsState } {
  return {
    calibration: {
      buckets: {},
      setupBuckets: {},
      brier: [],
      seeded: false, // during the walk these ARE live rows; the relabel happens at serialisation
      defVersion: CALIB_DEF_VERSION,
      modelVersion: ENGINE_MODEL_VERSION,
      seedGeneration: generation,
      evidence: { seed: zero(), live: zero(), shadow: zero() },
    },
    weights: { ...initWeights(), seedGeneration: generation },
  }
}

export async function main() {
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
  // SEED MODE (stage 2b). Presence, not value: `--seed-out` with no path is a typo,
  // and a walk that ran for ten minutes and then found it had nowhere to write is
  // the worst possible time to discover one.
  const seedOut = process.argv.includes('--seed-out') ? arg('seed-out', '') : null
  if (seedOut === '' || seedOut?.startsWith('--'))
    throw new Error(`BLOCKED: --seed-out needs a path to write the artefact to${seedOut ? ` (got the next flag, ${seedOut})` : ''}`)
  const seedGeneration = seedOut ? Number(arg('seed-generation', 'x')) : 0
  if (seedOut && (!Number.isInteger(seedGeneration) || seedGeneration < 1))
    throw new Error(
      'BLOCKED: --seed-out requires --seed-generation <n>, a positive integer. It is how loadState decides this artefact may displace the live blob (it installs only when the seed announces a HIGHER generation), so it cannot be guessed here.',
    )
  // A fabricated calibration must never wear a seed's clothes: --plant-a
  // overwrites engine-calibration with a hand-written A-reachability fixture
  // every morning, and --baseline measures the OLD screens — either one walked
  // into --seed-out would serialise as a legitimate v3 artefact with no tell.
  if (seedOut && (plantA || baseline))
    throw new Error('BLOCKED: --seed-out cannot run with --plant-a or --baseline — a probe calibration is not a seed')
  // The floor: the walk starts from a blank stamped with THIS generation, and
  // loadState's swap fires whenever the committed seed announces a HIGHER one
  // (engine.ts). Emitting at or below the committed generation would let the
  // committed seed install itself INTO the walk on day one — the two-epoch
  // mixture the design forbids — and the artefact could never install anyway.
  if (seedOut) {
    const committed = (await import('../shared/engine/seed.json')).default as {
      calibration?: { seedGeneration?: number }
    }
    const committedGen = committed.calibration?.seedGeneration ?? 1
    if (seedGeneration <= committedGen)
      throw new Error(
        `BLOCKED: --seed-generation ${seedGeneration} is not above the committed seed's generation ${committedGen} — the walk would warm-start from the committed seed and the artefact could never install`,
      )
  }
  // The walk universe. `--symbols` narrows it (a targeted run, and what lets the
  // unit test walk a fixture universe); seed mode then removes crypto, which is the
  // contract rather than a property of whichever list arrived.
  const symbolsRaw = process.argv.includes('--symbols') ? arg('symbols', '') : null
  if (symbolsRaw === '' || symbolsRaw?.startsWith('--'))
    throw new Error(`BLOCKED: --symbols needs a comma-separated list${symbolsRaw ? ` (got the next flag, ${symbolsRaw})` : ''}`)
  const symbolsArg = symbolsRaw !== null
    ? symbolsRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : null
  const askedUniverse = symbolsArg ?? REPLAY_UNIVERSE
  const baseUniverse = seedOut ? seedUniverse(askedUniverse) : askedUniverse
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    /* not a repo — fine */
  }

  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`replay-window: mode=${baseline ? 'BASELINE' : plantA ? 'A-PROBE' : 'NEW'} commit=${commit} window=${from}..${to} appetite=${appetite} gainers=${gainersDepth}`)
  console.log(`cache: ${CACHE_DIR}`)
  if (seedOut) {
    // THE SEED WALK DOES NOT ADVANCE GATE STATE [stage 3c task 4, plan decision
    // (d)]. Gate feedback is a LIVE mechanism on a live clock: it counts sessions
    // off `predictions-index` and prices attributed outcomes the reader was really
    // handed. A synthetic two-year tape would arm it in the first months and then
    // re-judge every later day of its own window under a dead zone the walk itself
    // moved — the buckets would be a blend of thresholds production has never run,
    // with nothing in the artefact to say which day changed. Worse, it is silent:
    // the seed carries no gate state at all, so the moved thresholds simply
    // disappear behind numbers that look measured.
    //
    // Set here rather than asked of the operator, because a forgotten env var
    // produces a plausible artefact. Set on the PROCESS because that is the seam
    // gateState.ts reads (`GATES=off`, the rollback lever) — the walk drives the
    // real engine, and the real engine is the thing that must stand down.
    process.env.GATES = 'off'
    console.log(
      `seed mode: generation ${seedGeneration} → ${seedOut} · universe ${baseUniverse.length}` +
        `${askedUniverse.length - baseUniverse.length ? ` (${askedUniverse.length - baseUniverse.length} crypto excluded: ${askedUniverse.filter(isCryptoSymbol).join(' ')})` : ''}` +
        ' · the walk starts from an EMPTY calibration, never the committed seed' +
        ' · gates: PINNED OFF (feedback moves on live evidence only)',
    )
  }

  // ---- warm the cache: the replay universe + the index/world series ----
  const warm = [...new Set([...baseUniverse, 'SPY', 'QQQ', ...WORLD_TAPE_SYMS])]
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
  if (existsSync(stageModule('dipLane.ts'))) {
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
  const velMod = existsSync(stageModule('velocityLane.ts'))
    ? ((await import('../shared/engine/velocityLane')) as unknown as VelocityModule)
    : null
  console.log(velMod ? 'velocity lane: present — velocity diagnostics enabled' : 'velocity lane: absent — no velocity diagnostics')
  // Same guard for the sleeve: the door trace uses the REAL rankSleeve when it
  // exists, and reports no sleeve door at all when it does not.
  let rankSleeve: ((closes: Map<string, number[]>, topN: number) => { sym: string }[]) | null = null
  if (existsSync(stageModule('coreSleeve.ts')))
    rankSleeve = (await import('../shared/engine/coreSleeve')).rankSleeve
  // …and the funnel trace is a Stage-3a module, detected the same way. When it is
  // there the walk ENFORCES the consistency invariant every day and stops on the
  // first violation: this walk is the acceptance instrument 3b and 3c read the
  // funnel through, and an instrument that keeps going after its own record has
  // stopped agreeing with the board is worse than no instrument. `FUNNEL_TRACE=off`
  // is the parity run — the recorder is deliberately a no-op there, so the trace is
  // empty by construction and there is nothing to check.
  const traceOff = process.env.FUNNEL_TRACE === 'off'
  const traceEnforced = existsSync(stageModule('funnelTrace.ts')) && !traceOff
  console.log(
    traceEnforced
      ? 'funnel trace: present — the walk enforces the consistency invariant daily'
      : traceOff
        ? 'funnel trace: STUBBED (FUNNEL_TRACE=off) — parity run, invariant not checked'
        : 'funnel trace: absent (pre-Stage-3a tree) — no funnel diagnostics',
  )

  // …and Stage 3b's two regret mechanisms, detected the same way. Both already RUN
  // in this walk — `gradeOutstanding` below is the engine's own daily pass — so what
  // is switched on here is the SURFACING and the CHECKING. `REGRET=off` is the
  // parity run: the engine then behaves exactly as the pre-3b tree did (no ledger
  // blob, no postMortem field), which is what makes the published-output comparison
  // a real one rather than a comparison of one run with itself.
  const regretOff = process.env.REGRET === 'off'
  const regretEnforced = existsSync(stageModule('missLedger.ts')) && existsSync(stageModule('postMortem.ts')) && !regretOff
  const classifyLoser = regretEnforced
    ? ((await import('../shared/engine/postMortem')).classifyLoser as unknown as Parameters<typeof precedenceViolations>[1])
    : null
  console.log(
    regretEnforced
      ? 'regret: present — the walk drives the miss ledger and the post-mortems, and enforces their invariants'
      : regretOff
        ? 'regret: STUBBED (REGRET=off) — parity run, no miss ledger and no post-mortems'
        : 'regret: absent (pre-Stage-3b tree) — no miss ledger, no post-mortems',
  )

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
  if (seedOut) {
    // Written BEFORE day one so `loadState`'s cold-start fallback never fires: the
    // artefact must be this walk's own record and nothing else's (see
    // emptyLearningState). Both blobs, because loadState reads both.
    const blank = emptyLearningState(seedGeneration)
    await store.write('engine-calibration', blank.calibration)
    await store.write('engine-weights', blank.weights)
  }

  const ctx = { current: { date: days[0], bars: new Map<string, Candle[]>(), screens: [], asked: new Set<string>() } as DayCtx }
  const deps = makeDeps(ctx)
  const out: DayOut[] = []
  /** The artefact's `symbols`: distinct names the walk PUBLISHED at least one row
   * for. Not the universe it was handed (a name the gates never let through
   * contributed nothing to these buckets) and not everything it evaluated (the
   * theme and rotation doors put ~150 names a day in front of the engine). This is
   * the population the emitted evidence was actually drawn from. */
  const walked = new Set<string>()
  /** The miss ledger as it stood after the PREVIOUS pass — the only way to see
   * what one pass accrued, and the only way to catch a day being charged twice. */
  let missLedgerPrev: MissLedgerLike | null = null
  /** THE SWEEP'S UNIVERSE (spec §9) — the union, across every replayed day, of every
   * name buildBoard ASKED for candles on, minus the context tapes it reads for regime
   * and sector colour and minus crypto.
   *
   * The handed `baseUniverse` is the wrong population for the anchor and was only
   * ever the convenient one: the roster carries names in as the walk runs, and the
   * theme and rotation doors put ~150 names a day in front of the engine that the
   * `--symbols`/REPLAY_UNIVERSE list never mentions. Anchoring grades to a sweep over
   * the handed list would answer "how does this pick compare with an ordinary name
   * from a list the board does not use", when the question §9 asks is "how does it
   * compare with an ordinary name the board ACTUALLY considered". `asked` is the
   * walk's own record of the latter, kept for the velocity diagnostic already.
   *
   * Accumulated rather than taken from the last day because the population is the
   * WINDOW's, not the final morning's — a name the roster dropped in March was still
   * a candidate in March, and the sweep grades March. */
  const sweptUniverse = new Set<string>()

  for (const date of days) {
    const t0 = Date.now()
    // Screen universe = sleeve ∪ the window's tickers ∪ whatever the roster has
    // earned so far. Rebuilt daily because the roster carries.
    const rosterSyms = ((await store.read<{ sym: string }[]>('engine-roster')) ?? []).map(e => e.sym)
    let universe = [...new Set([...baseUniverse, ...rosterSyms.map(s => s.toUpperCase())])]
    // The roster is built by this walk out of this universe, so it cannot introduce
    // a crypto name — but the filter is the seed's contract, not an inference about
    // where the roster came from, so it is applied where the universe is composed.
    if (seedOut) universe = seedUniverse(universe)
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
    // THE MISS LEDGER AS IT STANDS AFTER THIS MORNING'S PASS. One store read; the
    // pass itself did the work (engine.ts's hook is its last statement). Read here
    // rather than at the end because the ACCRUAL — one matured day per pass, never
    // the same day twice — is a per-pass claim, and only a per-pass read can make it.
    const missLedgerNow = regretEnforced ? ((await store.read<MissLedgerLike>(MISS_LEDGER_KEY_MIRROR)) ?? null) : null
    const accrualViolations = regretEnforced ? missAccrualViolations(missLedgerPrev, missLedgerNow) : []
    const accruedDate = Object.keys(missLedgerNow?.days ?? {}).find(d => !missLedgerPrev?.days?.[d]) ?? null
    const missAccrued = accruedDate ? { date: accruedDate, ...missLedgerNow!.days[accruedDate] } : null
    missLedgerPrev = missLedgerNow ? (JSON.parse(JSON.stringify(missLedgerNow)) as MissLedgerLike) : null
    // SEED MODE PINS THE SCORING VECTOR. The seed must be measured under the exact
    // vector production will score with; the walk's compounding nudges (recon §5:
    // `next = cur·(1 + 0.15·ic)`, ~450 of them over two years) drift away from it
    // whatever bounds they run under. Stage 3c's brakes narrowed that drift to the
    // hard [0.5×, 1.5×] band and put a two-sided IC floor in front of it — the old
    // unbounded-below path (no floor at all once the retired PRUNE_MIN_N lifted it)
    // is gone — but a band is not a pin, and a seed measured under ANY drifting
    // vector books buckets under a scorer that moved as they filled. So the pin
    // stays. Generation 2 shipped what happens without it: technical 0.0791
    // against a base of 1.0, momentum pinned at the 2× cap and 73 % of a
    // weight-normalised composite — the owner's ratified factor order inverted, and
    // buckets accrued under a vector that drifted underneath them as they filled.
    // Only the APPLIED vector is pinned: `ic`, `gradedSinceNudge` and `history` keep
    // accruing, so the artefact still carries the walk's factor measurement.
    if (seedOut) {
      const w = await store.read<WeightsState>('engine-weights')
      if (w) {
        w.current = { ...w.base }
        await store.write('engine-weights', w)
      }
    }
    if (plantA) await store.write('engine-calibration', aReachableState())
    const built = await buildBoard(store, deps as never, nowSec)
    const ledger = ((await store.read<Prediction[]>(`predictions:${date}`)) ?? []).map(p => rowOf(p, 'ledger'))
    const board = built.board.map(p => rowOf(p, 'board'))
    for (const r of [...board, ...ledger]) walked.add(r.sym.toUpperCase())
    // gradeOutstanding writes `engine-calibration`; buildBoard only reads it. So
    // the blob standing here IS the one every grade above was struck against.
    const calNow = await store.read<CalibrationState>('engine-calibration')
    // MOVES TO THE REFERENCE [§9] — this number feeds `gradeUncapped` and the
    // day's recorded `baseRate`, both of which are GRADE semantics, so they have to
    // be struck against the same anchor `engine.ts` used or the counterfactual
    // would answer a question the board never asked. Spelled out rather than
    // imported from `gradeBaseRate`: every static import in this file must also
    // resolve in the pre-Stage-1 baseline worktree, whose calibration module has no
    // such export (see the import block's note).
    const baseRate = calNow ? calNow.referenceBase ?? baseHitRate(calNow).rate : 0.5
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
    // the sweep's population grows HERE, from what the walk asked for, not from the
    // list it was handed. Crypto is filtered again rather than assumed away: `asked`
    // records whatever buildBoard reached for, and the seed's no-crypto contract is
    // enforced wherever a population is composed.
    if (seedOut) for (const sym of ctx.current.asked) if (!CONTEXT_TAPES.has(sym) && !isCryptoSymbol(sym)) sweptUniverse.add(sym)
    const shape = summariseBoard(built.board)
    const watched = watchList.map(sym => ({
      sym,
      doors: doorsFor(sym, screens, sleeveTop, rosterSyms),
      evaluated: ctx.current.asked.has(sym),
    }))
    // the funnel's own record of the day, straight out of the carrying store
    const trace = (await store.read<DayTrace>(funnelTraceKeyOf(date))) ?? undefined
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
      trace,
      missAccrued,
    })
    if (regretEnforced) {
      // the ledger's claims, settled against the walk's OWN record of the window:
      // the traces it captured and the sizes the reader was actually given.
      const violations = [...accrualViolations, ...missLedgerViolations(missLedgerNow, regretContextOf(out))]
      if (violations.length)
        throw new Error(
          `BLOCKED: the miss ledger disagrees with the walk on ${date} — ${violations.length} violation(s):\n  ` +
            `${violations.slice(0, 25).join('\n  ')}${violations.length > 25 ? `\n  …and ${violations.length - 25} more` : ''}`,
        )
    }
    if (traceEnforced) {
      const violations = traceViolations(out[out.length - 1])
      if (violations.length)
        throw new Error(
          `BLOCKED: the funnel trace disagrees with the board on ${date} — ${violations.length} violation(s):\n  ` +
            `${violations.slice(0, 25).join('\n  ')}${violations.length > 25 ? `\n  …and ${violations.length - 25} more` : ''}`,
        )
    }
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

  // ---- the post-mortems, read back off the rows the ENGINE graded ----
  // The field is written ELEVEN sessions after the morning that published the row
  // (ten to mature, and the pass that follows), so the day-D snapshot taken in the
  // loop above structurally cannot carry it: these are the final blobs.
  let missLedgerFinal: MissLedgerLike | null = null
  let postMortemCensus: PostMortemCensus | null = null
  if (regretEnforced) {
    missLedgerFinal = (await store.read<MissLedgerLike>(MISS_LEDGER_KEY_MIRROR)) ?? null
    const census: PostMortemCensus = { graded: 0, losers: 0, classified: 0, byClass: {}, byKey: {}, sampled: 0, sentences: 0 }
    const losers: { key: string; pred: Prediction; gradedOn: string }[] = []
    for (const [i, day] of out.entries()) {
      const preds = (await store.read<Prediction[]>(`predictions:${day.date}`)) ?? []
      const byKey = new Map(preds.map(p => [`${p.sym.toUpperCase()}:${p.side}`, p]))
      for (const r of [...day.board, ...day.ledger]) {
        const p = byKey.get(`${r.sym.toUpperCase()}:${r.side}`)
        if (!p) continue // a near miss is on the board and never in the prediction blob
        r.storedOutcome10 = p.outcome10 ? { hit: p.outcome10.hit, excessPct: p.outcome10.excessPct, stopped: p.outcome10.stopped } : null
        if (p.postMortem) r.postMortem = p.postMortem as PostMortemLike
      }
      // THE MORNING THE ENGINE GRADED THESE ROWS, and therefore the exact tape its
      // classifier held: a pass on walk day k sees bars strictly before day k, so a
      // row published on walk day i is first gradeable at 10 sessions when
      // i + 10 <= k - 1 — that is, on walk day i + 11. Re-classifying against any
      // other tape would compare the engine's answer with a question it never asked.
      const gradedOn = days[i + POSTMORTEM_HORIZON_MIRROR + 1] ?? days[days.length - 1]
      for (const p of preds) {
        if (!p.outcome10) continue
        census.graded++
        if (p.outcome10.hit) continue
        census.losers++
        const pm = p.postMortem as PostMortemLike | undefined
        if (!pm) continue
        census.classified++
        census.byClass[pm.cls] = (census.byClass[pm.cls] ?? 0) + 1
        const k = `${p.setup || 'unknown'}:${p.regime}:${pm.cls}`
        census.byKey[k] = (census.byKey[k] ?? 0) + 1
        if (pm.sentence) census.sentences++
        losers.push({ key: `${day.date}:${p.sym}:${p.side}`, pred: p, gradedOn })
      }
    }
    // …and k of them re-classified from scratch, with the engine's own classifier.
    const samples: PrecedenceSample[] = []
    for (const l of regretSample(losers, REGRET_SAMPLE_K, l => l.key)) {
      const full = await fullHistory(l.pred.sym)
      if (!full) continue
      const tape = sliceBefore(full, l.gradedOn).slice(-ONE_YEAR_BARS)
      samples.push({
        key: l.key,
        row: { side: l.pred.side, date: l.pred.date, stop: l.pred.stop, trail: l.pred.trail, catalyst: l.pred.catalyst ?? null },
        outcome: l.pred.outcome10!,
        postMortem: l.pred.postMortem as PostMortemLike,
        candles: tape,
      })
    }
    census.sampled = samples.length
    const violations = [...postMortemViolations(out), ...precedenceViolations(samples, classifyLoser!)]
    if (violations.length)
      throw new Error(
        `BLOCKED: the post-mortems disagree with the tape — ${violations.length} violation(s):\n  ` +
          `${violations.slice(0, 25).join('\n  ')}${violations.length > 25 ? `\n  …and ${violations.length - 25} more` : ''}`,
      )
    postMortemCensus = census
    const led = missLedgerFinal
    const ledDays = Object.keys(led?.days ?? {})
    console.log(
      `regret: miss ledger ${ledDays.length} day(s) — ${ledDays.reduce((s, d) => s + led!.days[d].checked, 0)} priced, ` +
        `${ledDays.reduce((s, d) => s + led!.days[d].unchecked, 0)} unpriced, ${ledDays.reduce((s, d) => s + led!.days[d].misses, 0)} misses · ` +
        `post-mortems ${census.classified}/${census.losers} losers of ${census.graded} graded (${census.sampled} re-derived) · ` +
        Object.entries(census.byClass)
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${c} ${n}`)
          .join(' '),
    )
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
  // …and the GATES, as feedback left them (Stage 3c, shared/engine/gateState.ts).
  // Unlike the two observations below, this one is NOT display-only: a gate that
  // moved mid-window changed the thresholds every later day was judged against,
  // so an artefact that did not carry it could not explain its own diff. Null on
  // any run with `GATES=off`, and on any window whose evidence never reached the
  // eligibility bar.
  const gateStateFinal = await store.read<unknown>(GATE_STATE_KEY_MIRROR)
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
        // the universe actually walked — identical to REPLAY_UNIVERSE.length in
        // every mode that does not narrow or filter it
        universe: baseUniverse.length,
        modelVersion: ENGINE_MODEL_VERSION,
        missing,
        days: out,
        calibrationFinal,
        riskFinal,
        gateStateFinal,
        // ADDITIVE (Stage 3b): the window's regret, as the engine measured it. Both
        // are OBSERVATIONS — no board, ledger, grade or size anywhere in this file
        // reads either, and a run with `REGRET=off` writes null for both.
        missLedgerFinal,
        postMortemCensus,
      },
      null,
      1,
    ),
  )
  console.log(`\nwrote ${outPath}`)

  if (seedOut) {
    // BOTH halves, read out of the carrying store at walk end. `engine-weights` has
    // never been read back out of this harness before — the diagnostics JSON above
    // captures the calibration blob and nothing else — and a seed without its
    // factor IC is the half of §4.4 that would have gone missing quietly.
    const weightsFinal = await store.read<WeightsState>('engine-weights')
    // THE REFERENCE SWEEP (spec §9), over the SAME candles the walk was driven from:
    // the same `fullHistory` cache, the same `--from`, and each series truncated with
    // the same `sliceBefore` the walk's LAST morning used — so the sweep cannot see a
    // bar the walk never had in hand. Its universe is `sweptUniverse`, the union of
    // what the walk actually considered, NOT the handed `baseUniverse`: the anchor
    // has to be the ordinary odds of the population the board draws from, and the
    // board draws from roster arrivals and theme/rotation names that no handed list
    // contains. It measures the unconditional population the board's rows will be
    // graded against; the walk's own buckets keep pricing them.
    const sweepBySym = new Map<string, Candle[]>()
    for (const sym of sweptUniverse) {
      const full = await fullHistory(sym)
      if (!full) continue
      const s = sliceBefore(full, to)
      if (s.length) sweepBySym.set(sym.toUpperCase(), s)
    }
    // What the change bought, in the run log: the handed universe is printed beside
    // the walked one so a reader can see how much of the board's own population a
    // baseUniverse sweep would have been blind to.
    const handed = new Set(baseUniverse.map(s => s.toUpperCase()))
    const missedByHanded = [...sweptUniverse].filter(s => !handed.has(s)).length
    const neverAsked = [...handed].filter(s => !sweptUniverse.has(s)).length
    console.log(
      `  sweep universe ${sweepBySym.size} symbols — the union of every name the walk ASKED for` +
        `${sweptUniverse.size === sweepBySym.size ? '' : ` (${sweptUniverse.size - sweepBySym.size} of ${sweptUniverse.size} had no history to sweep)`} · ` +
        `+${missedByHanded} the handed universe would have missed · ${neverAsked} of its ${handed.size} names the walk never asked for`,
    )
    const sweepSpy = sliceBefore(spyFull, to)
    const sweepQqq = await fullHistory('QQQ')
    const sweepVix = await fullHistory(VIX_SYMBOL.sym)
    const reference = referenceSweep({
      bySym: sweepBySym,
      spy: sweepSpy,
      qqq: sweepQqq ? sliceBefore(sweepQqq, to) : undefined,
      vix: sweepVix ? sliceBefore(sweepVix, to) : undefined,
      fromISO: from,
    })
    const artefact = seedArtefactFrom({
      calibration: calibrationFinal,
      weights: weightsFinal,
      symbols: walked.size,
      generation: seedGeneration,
      reference,
    })
    writeFileSync(seedOut, JSON.stringify(artefact, null, 1))
    const cal = artefact.calibration
    const totals = Object.values(cal.buckets).reduce((a, b) => ({ n: a.n + b.n, hits: a.hits + b.hits }), { n: 0, hits: 0 })
    console.log(`\nwrote ${seedOut} — generation ${seedGeneration}, defVersion ${cal.defVersion}, modelVersion ${cal.modelVersion}`)
    console.log(
      `  ${artefact.symbols} symbols · ${totals.n} graded rows in ${Object.keys(cal.buckets).length} buckets ` +
        `(${Object.keys(cal.setupBuckets ?? {}).length} setup keys) · base rate ${(baseHitRate(cal).rate).toFixed(4)}`,
    )
    // BOTH numbers, side by side, because the gap between them is the addendum: the
    // pooled base prices the board's own rows, the reference is what their GRADES
    // are measured against. `n` is printed because a reference is only as good as
    // the sweep under it, and a reader of the run log must be able to see that.
    console.log(
      `  reference base ${cal.referenceBase!.toFixed(4)} — unconditional sweep over ${sweepBySym.size} symbols, ${reference.n} graded rows ` +
        `(pooled base ${(baseHitRate(cal).rate).toFixed(4)}; grades anchor to the reference, probabilities to the pool)`,
    )
    console.log(`  evidence: seed ${cal.evidence!.seed.n}/${cal.evidence!.seed.hits} · shadow ${cal.evidence!.shadow.n}/${cal.evidence!.shadow.hits} · live 0 (folded into seed at serialisation)`)
    console.log(
      `  IC: ${(Object.keys(DEFAULT_WEIGHTS) as (keyof typeof DEFAULT_WEIGHTS)[])
        .filter(f => artefact.weights.ic[f] && (artefact.weights.ic[f].nAgree || artefact.weights.ic[f].nDisagree))
        .map(f => `${f} ${artefact.weights.ic[f].nAgree}/${artefact.weights.ic[f].nDisagree}`)
        .join(' · ') || 'none — no factor scored a graded call'}`,
    )
    // …and what the emitter REFUSED to ship with it (guarantee 8). Printed from the
    // difference between the walk's own blob and the artefact, so the line cannot
    // drift from what was actually dropped, and printed even when the answer is
    // "nothing" — a silent zeroing step is one nobody checks.
    const dropped = WALK_ABSENT_FACTORS.map(f => ({ f, n: (weightsFinal?.ic?.[f]?.nAgree ?? 0) + (weightsFinal?.ic?.[f]?.nDisagree ?? 0) })).filter(d => d.n > 0)
    console.log(
      `  phantom IC dropped: ${dropped.map(d => `${d.f} ${d.n} obs`).join(' · ') || 'none — every absent factor was already empty'}` +
        ` (a factor the price-only walk never fed may not ship a measurement)`,
    )
  }

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
  /** Stage 3b, both ADDITIVE and both null on a `REGRET=off` parity run. */
  missLedgerFinal?: MissLedgerLike | null
  postMortemCensus?: PostMortemCensus | null
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
  /** WHICH OF THE TWO CURVES OVER THESE BUCKETS [stage 3c]. A sized read and a
   * pooled read are different answers from the same blob once the partition has
   * sub-counts to work with, and the reader's money follows the sized one. */
  population: BucketPopulation
  /** The setup family blended into the read, or null for the bare ladder. */
  setup: string | null
}

/** The label a violation is reported under. */
export const probeLabel = (c: ProbeContext): string =>
  `${c.cohort}:${c.side}:${c.regime} ${c.population}${c.setup ? `/${c.setup}` : ''}`

/** THE READ THE READER ACTUALLY GOT, bound to a state: `probabilityFor` with the
 * context's own population and family. Exported because the gate and the tests
 * must probe ONE read path, and because the pooled unblended ladder — what this
 * probe swept before stage 3c — is now a curve nobody is shown. */
export const shippedRead = (state: CalibrationState) => (c: ProbeContext, x: number): number =>
  probabilityFor(state, c.side, c.regime, x, c.cohort, c.population, c.setup).p

/** Every (side, regime, cohort) a state actually carries evidence for, crossed
 * with every read that state can produce for it. Parsed from the bucket keys
 * themselves — legacy cohortless keys are 3-part and read as cohort 'unknown'
 * (which is exactly how an unknown-cap call reads them back), cohort-tagged keys
 * are 4-part. A context nothing was ever booked into is not probed: asserting
 * monotonicity on an empty rung tests the base-rate constant.
 *
 * THE CROSS PRODUCT [stage 3c task 4, binding from the Task-2 review]. One
 * context is no longer one curve:
 *   · POPULATION — both, always. A sized read is what grades a sized row; a
 *     pooled read is what prices a shadow. On an unpartitioned blob the two are
 *     byte-identical and the extra half of the sweep costs nothing.
 *   · SETUP — every family the state carries evidence for ON THAT SIDE, and only
 *     on the sized read, because `blendSetup` returns the ladder untouched on a
 *     pooled one. This is the half that matters: the blend is a BAND step
 *     (`setup:side:band`), so a family that earned its 0.3 in one band and not
 *     the next can put a downward step into the published curve that the ladder
 *     underneath is innocent of. A probe that never passed a setup would sweep a
 *     curve no reader is ever shown and call the gate passed. */
export function contextsIn(state: CalibrationState): ProbeContext[] {
  const seen = new Map<string, { side: 'long' | 'short'; regime: string; cohort: ProbeContext['cohort'] }>()
  for (const key of Object.keys(state.buckets)) {
    const parts = key.split(':')
    const [cohort, side, regime] = parts.length === 4 ? parts : ['unknown', parts[0], parts[1]]
    if (side !== 'long' && side !== 'short') continue
    seen.set(`${cohort}:${side}:${regime}`, { side, regime, cohort: cohort as ProbeContext['cohort'] })
  }
  const setupsBySide = new Map<string, Set<string>>()
  for (const key of Object.keys(state.setupBuckets ?? {})) {
    const [setup, side] = key.split(':')
    if (side !== 'long' && side !== 'short') continue
    if (!setupsBySide.has(side)) setupsBySide.set(side, new Set())
    setupsBySide.get(side)!.add(setup)
  }
  const out: ProbeContext[] = []
  for (const base of [...seen.values()].sort((a, b) => `${a.cohort}${a.side}${a.regime}`.localeCompare(`${b.cohort}${b.side}${b.regime}`))) {
    out.push({ ...base, population: 'pooled', setup: null })
    out.push({ ...base, population: 'sized', setup: null })
    for (const setup of [...(setupsBySide.get(base.side) ?? [])].sort()) out.push({ ...base, population: 'sized', setup })
  }
  return out
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
    const label = probeLabel(ctx)
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
  const voice = existsSync(stageModule('voice.ts'))
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
    const v = monotonicityViolations(ctxs, xs, shippedRead(ps.state))
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
          violations: monotonicityViolations(contextsIn(ps.state), xs, shippedRead(ps.state)),
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
