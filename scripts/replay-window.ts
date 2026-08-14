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
//
// SIXTH MODE — `--classify --ref <run.json> --new <run.json>`: THE CONTROLLED DIFF
// (stage 3c task 5). Matched-key attribution over `{grade, riskPct, probability}`
// between two runs, every changed row handed one of the sanctioned causes
// (`classifyDiff` below) — and a run that cannot name one fails. Pure counters over
// two JSONs plus the gate arithmetic, so it opens no store and asks the engine for
// nothing it did not already record. Also prints the gate-eligibility readout off
// the new run's own miss ledger.
//   npx tsx scripts/replay-window.ts --classify --ref /tmp/pre.json --new /tmp/post.json
//
// SEVENTH MODE — `--wildcard-diff --ref <off.json> --new <on.json>`: THE EXPERIMENT
// SLOT'S SHIP GATE (stage 3d task 3). Two runs of ONE window, `WILDCARD=off` against
// the lane live, everything else held: the experiments taken and their cadence, the
// one-slot and causal invariants, and the controlled diff that decides whether the
// lane changed anything it was not given. Pure counters over two JSONs.
//   WILDCARD=off GATES=off npx tsx scripts/replay-window.ts --from … --out /tmp/off.json
//   GATES=off        npx tsx scripts/replay-window.ts --from … --out /tmp/on.json
//   npx tsx scripts/replay-window.ts --wildcard-diff --ref /tmp/off.json --new /tmp/on.json
//
// EIGHTH MODE — `--spine crypto`: THE WEEKEND WALK (stage 1c phase B task B3). The
// window mode again, on the OTHER clock: the walk's days come from BTC-USD's own
// bars instead of SPY's, so Saturdays and Sundays are ordinary sessions and the
// crypto lane can be replayed on the calendar it actually keeps. It turns the lane
// ON by default (`CRYPTO=off` is then the lane-off arm), warms the three pairs into
// `.replay-cache`, serves a crypto tape at its own 365-bar year, records each pass's
// matured crypto grades, and carries the crypto partition's own two blobs in the
// artefact beside the equity ones. The equity spine is untouched: on it the lane
// stays off and every artefact is byte-identical to the one that shipped before B3.
//   npx tsx scripts/replay-window.ts --spine crypto --from … --to … \
//     --watchlist BTC-USD,ETH-USD,SOL-USD --out /tmp/crypto-on.json
//   CRYPTO=off npx tsx scripts/replay-window.ts --spine crypto … --out /tmp/crypto-off.json
//
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
import { isCryptoSymbol } from '../shared/symbols'
import { leverageAllowed, type LevMap } from '../shared/engine/riskLadder'
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

/** THE ROUTABLE-SHORTS MIRROR — production's `config.levMap`, as this harness has
 * to model it [stage 3c task 4 fix wave].
 *
 * WHY IT EXISTS. The walk used to run `levMap: {}`, which was the right call while
 * the question was "did stage 1 change the board?" (unroutable on both sides is a
 * fair comparison). It is the wrong call for a SEED: an ISA cannot short stock, so
 * a short with no inverse-ETP route is `unshortable` — one of the three pre-grade
 * shadow causes — and an empty map therefore made EVERY short a shadow. Generation
 * 4 shipped with zero sized short evidence anywhere in the file while production
 * routes shorts daily, so the first routable short would have been graded against
 * a population that had never contained one.
 *
 * IT IS REPRESENTATIVE, NOT AUTHORITATIVE, and cannot be otherwise: the real map
 * lives in the runtime `config` blob, owner-maintained through the API (spec
 * amendment 2026-07-02 (7)), and is not committed anywhere in this repo — so
 * unlike `SLEEVE_MIRROR` and `GATE_CODE_MIRROR` there is no source file to
 * drift-guard it against. What is modelled is the SHAPE the owner's map has: a few
 * dozen of the most liquid names, the US megacaps carrying both directions, some
 * UK names long-only, and the long tail of the universe carrying nothing.
 *
 * WHAT THE MEASUREMENT ACTUALLY DEPENDS ON is key membership, not the strings:
 * `unshortable` asks only whether a short route EXISTS, and the ticker itself is
 * carried as a label (`Prediction.instrument`) that nothing in this harness ever
 * prices or fetches a candle for. The strings follow the Leverage Shares LSE
 * convention (`3L`/`3S` + a name code, `2L`/`2S` for the doubles); `3LTS.L` is
 * real (it is in this repo's own Yahoo fixtures), and `3LAL.L`/`3SMI.L` came from
 * the owner's T212 catalogue — the rest are convention-shaped and NOT
 * name-verified. Anything read off this map beyond "could the reader place this
 * side of this name?" is reading more than it says.
 *
 * DRIFT NOTE: if the owner's map gains or loses names, this one does not notice.
 * A seed walked on a stale mirror over-states routability for names dropped from
 * the real map and under-states it for names added — both of which move sized
 * short evidence and nothing else. Re-check it when a generation is emitted;
 * `replay-window.test.ts` guards the properties, never the contents. */
export const LEVMAP_MIRROR: LevMap = {
  // US megacaps and high-beta favourites — both directions, as the liquid
  // single-stock ETP pairs do
  AAPL: { long2x: '2LAP.L', long3x: '3LAP.L', short2x: '2SAP.L', short3x: '3SAP.L' },
  MSFT: { long2x: '2LMS.L', long3x: '3LMS.L', short2x: '2SMS.L', short3x: '3SMS.L' },
  NVDA: { long2x: '2LNV.L', long3x: '3LNV.L', short2x: '2SNV.L', short3x: '3SNV.L' },
  GOOGL: { long2x: '2LAL.L', long3x: '3LAL.L', short2x: '2SAL.L', short3x: '3SAL.L' },
  AMZN: { long2x: '2LAZ.L', long3x: '3LAZ.L', short2x: '2SAZ.L', short3x: '3SAZ.L' },
  META: { long2x: '2LMT.L', long3x: '3LMT.L', short2x: '2SMT.L', short3x: '3SMT.L' },
  TSLA: { long2x: '2LTS.L', long3x: '3LTS.L', short2x: '2STS.L', short3x: '3STS.L' },
  AVGO: { long3x: '3LAV.L', short3x: '3SAV.L' },
  AMD: { long2x: '2LAD.L', long3x: '3LAD.L', short2x: '2SAD.L', short3x: '3SAD.L' },
  INTC: { long3x: '3LIN.L', short3x: '3SIN.L' },
  MU: { long3x: '3LMI.L', short3x: '3SMI.L' },
  NFLX: { long3x: '3LNF.L', short3x: '3SNF.L' },
  QCOM: { long3x: '3LQC.L', short3x: '3SQC.L' },
  CRM: { long3x: '3LCR.L', short3x: '3SCR.L' },
  ORCL: { long3x: '3LOR.L', short3x: '3SOR.L' },
  ADBE: { long3x: '3LAB.L', short3x: '3SAB.L' },
  PLTR: { long2x: '2LPL.L', short2x: '2SPL.L' },
  COIN: { long3x: '3LCO.L', short3x: '3SCO.L' },
  MSTR: { long2x: '2LMR.L', short2x: '2SMR.L' },
  SMCI: { long2x: '2LSM.L', short2x: '2SSM.L' },
  ARM: { long2x: '2LAR.L', short2x: '2SAR.L' },
  UBER: { long3x: '3LUB.L', short3x: '3SUB.L' },
  BA: { long3x: '3LBO.L', short3x: '3SBO.L' },
  JPM: { long3x: '3LJP.L', short3x: '3SJP.L' },
  GS: { long3x: '3LGS.L', short3x: '3SGS.L' },
  XOM: { long3x: '3LXM.L', short3x: '3SXM.L' },
  CVX: { long3x: '3LCX.L', short3x: '3SCX.L' },
  LLY: { long3x: '3LLY.L', short3x: '3SLY.L' },
  PFE: { long3x: '3LPF.L', short3x: '3SPF.L' },
  DIS: { long3x: '3LDS.L', short3x: '3SDS.L' },
  WMT: { long3x: '3LWM.L', short3x: '3SWM.L' },
  IBM: { long3x: '3LIB.L', short3x: '3SIB.L' },
  PYPL: { long3x: '3LPY.L', short3x: '3SPY.L' },
  NKE: { long3x: '3LNK.L', short3x: '3SNK.L' },
  // …and the UK sleeve LONG-ONLY. The single-stock inverse line-up on LSE names is
  // thin, and a mirror that handed every name a short would delete the
  // `unshortable` path from the walk entirely — the pre-grade shadow cause the
  // partition is built to measure.
  'RR.L': { long3x: '3LRR.L' },
  'BP.L': { long3x: '3LBP.L' },
  'HSBA.L': { long3x: '3LHS.L' },
  'BARC.L': { long3x: '3LBC.L' },
}

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
// ONE predicate, not two: containment (stage 1c A1) made shared/symbols.ts the
// canonical home; the replay re-exports it so the two can never drift.
export { isCryptoSymbol } from '../shared/symbols'
// …and imports it for its own use below (a re-export binds nothing locally).

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

// ------------------------------------------------------- the crypto spine --
// STAGE 1c PHASE B TASK B3. Everything below is MIRRORED from the crypto
// modules rather than imported, for the reason every mirror in this file exists:
// a static import of `shared/engine/crypto*.ts` would not resolve in the
// pre-Stage-1 baseline worktree this harness still has to load in. Each mirror is
// drift-guarded against the real module in replay-window.test.ts, exactly like
// GATE_CODE_MIRROR and MISS_LEDGER_KEY_MIRROR. The two places that need the
// crypto FUNCTIONS (the grade recomputation at walk end) import them
// dynamically, behind the same `existsSync(stageModule(…))` guard the dip and
// velocity lanes use.

/** cryptoCalibration.ts `CRYPTO_UNIVERSE` — the three pairs the partition is
 * defined over. */
export const CRYPTO_UNIVERSE_MIRROR: string[] = ['BTC-USD', 'ETH-USD', 'SOL-USD']
/** cryptoLane.ts `CRYPTO_REGIME_SYMBOL` — whose tape the cohort's regime is, and
 * therefore the tape the crypto spine is cut from. */
export const CRYPTO_REGIME_SYM_MIRROR = 'BTC-USD'
/** cryptoCalibration.ts `CRYPTO_CALIB_KEY` / cryptoLane.ts `CRYPTO_RISK_KEY`. */
export const CRYPTO_CALIB_KEY_MIRROR = 'crypto-calibration'
export const CRYPTO_RISK_KEY_MIRROR = 'crypto-risk'
/** cryptoCalibration.ts `CRYPTO_HORIZONS` — a week, the graded horizon and a
 * month, in CRYPTO bars. The middle one is `CRYPTO_GRADE_HORIZON`. */
export const CRYPTO_HORIZONS_MIRROR: number[] = [7, 14, 29]
/** PUBLICATION TO OUTCOME, in calendar days, and the number the evidence quotes.
 * A call dated D takes its entry at the first bar OPENING after D (D+1), its
 * outcome bar is fourteen bars later (D+15), and that bar must be COMPLETE
 * before the grader may read it (`completedCryptoBars`) — so the pass that
 * grades it is D+16's. Sixteen against the equity fourteen: the crypto clock is
 * SLOWER in wall-clock terms even though its horizon is longer in bars. */
export const CRYPTO_PUBLISH_TO_GRADE_DAYS = CRYPTO_HORIZONS_MIRROR[1] + 2

/** A CALENDAR year of a 24/7 tape (cryptoCalibration.ts
 * `swingCapacityLookback250.crypto`), and the depth the replay must serve a
 * crypto pair at. Production reads `cachedCandles` = Yahoo `1y` = ~366 daily
 * bars for a coin; the harness's own 252-bar tail is a TRADING year, so serving
 * crypto at 252 would quietly measure the pair's typical travel — the
 * denominator `cryptoMomentumFactor` is expressed in — over fifty weeks of a
 * tape production reads a full year of. */
export const CRYPTO_YEAR_BARS = 365

/** How deep a tape this symbol's own clock wants. Equities keep the 252-bar
 * trading year they have always had; nothing about an equity run moves. */
export const tailBarsFor = (sym: string): number => (isCryptoSymbol(sym) ? CRYPTO_YEAR_BARS : ONE_YEAR_BARS)

export interface CryptoSpineRead {
  /** The walk's days, in order — one per crypto session the tape carries. */
  days: string[]
  /** Calendar days inside the window the tape does NOT carry. */
  gaps: string[]
  /** How many of `days` are Saturdays or Sundays — the days the equity spine
   * structurally cannot have, and the ones B3 exists to walk. */
  weekend: number
}

/** THE CRYPTO SESSION SPINE — the pair's own bars, never SPY's.
 *
 * `tradingDays` derives the equity spine from a real index series "so holidays
 * are handled by the exchange itself". The same construction is right here and
 * means something different: a crypto session IS a UTC calendar day, the venue
 * never closes, and the pair's own bars are the only honest record of which days
 * it traded. Sat and Sun are ordinary sessions.
 *
 * THE ONE PLACE IT DIVERGES FROM `tradingDays` is what a missing day means. For
 * SPY a gap is Thanksgiving — correct, expected, and rightly silent. For BTC
 * there is no such thing as a closed day, so a gap is a TAPE DEFECT (a bad
 * fetch, a Stooq fallback that served 300 rows instead of 365) and the walk must
 * be able to say so on the page rather than quietly walking a shorter window
 * than the operator asked for. So the holes are counted and returned. */
export function cryptoSpine(index: Candle[], fromISO: string, toISO: string): CryptoSpineRead {
  const have = new Set<string>()
  for (const c of index) {
    const iso = new Date(c.t * 1000).toISOString().slice(0, 10)
    if (iso >= fromISO && iso <= toISO) have.add(iso)
  }
  const days = [...have].sort()
  const gaps: string[] = []
  for (const d = new Date(`${fromISO}T00:00:00Z`); d.toISOString().slice(0, 10) <= toISO; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10)
    if (!have.has(iso)) gaps.push(iso)
  }
  const weekend = days.filter(d => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())).length
  return { days, gaps, weekend }
}

export type SpineKind = 'equity' | 'crypto'

export interface CryptoLeverRead {
  value: 'on' | 'off'
  /** `default` — the mode chose it; `caller` — the operator set `CRYPTO` and the
   * walk obeyed. A run log that cannot say which is a run whose arm is a guess. */
  source: 'default' | 'caller'
  why: string
}

/** THE LEVER THE PIN BECAME (B3, lifting the `CRYPTO=off` line B2 left here).
 *
 * B2 pinned the lane off in `main()` because the harness sliced every tape on an
 * EQUITY session spine and two of the three pairs were not even in
 * `.replay-cache`. Both facts are now false — `cryptoSpine` above is the crypto
 * clock and the warm step fetches the pairs — so the pin becomes what the house
 * pattern says it should be: an env-driven arm, one per tree, with a DEFAULT
 * PER MODE and a refusal for the one combination that would lie.
 *
 *  · equity spine, nothing set → OFF. Every mode that shipped before B3 —
 *    `--baseline`, `--plant-a`, `--seed-out`, the ordinary window walk — behaves
 *    exactly as it did, byte for byte. That is the conservative default and it
 *    is deliberate: the equity walk is the instrument three stages of evidence
 *    were measured on, and B3 may not move it.
 *  · equity spine, `CRYPTO` set to anything but `off` → BLOCKED. This is the
 *    lie: it would replay a 24/7 cohort against a Mon–Fri calendar, publish no
 *    weekend row, and grade a 14-bar horizon over a spine missing two days in
 *    seven — the precise failure Phase A shipped to stop, wearing a lane.
 *  · crypto spine, nothing set → ON. The mode exists for the lane.
 *  · crypto spine, `CRYPTO=off` → OFF, and that is the LANE-OFF ARM of the
 *    controlled diff: the same window, the same spine, the same tapes, one
 *    lever. It is the only way to prove no equity blob byte moved. */
export function resolveCryptoLever(spine: SpineKind, env: string | undefined): CryptoLeverRead {
  if (spine === 'equity') {
    if (env == null) return { value: 'off', source: 'default', why: 'the equity spine walks a Mon–Fri calendar; the lane is off exactly as it was before B3' }
    if (env === 'off') return { value: 'off', source: 'caller', why: 'CRYPTO=off, as the caller asked' }
    throw new Error(
      `BLOCKED: CRYPTO=${env} on the equity spine — a crypto cohort cannot be replayed against SPY's calendar (no weekend session, a 14-bar horizon spanning a spine missing two days in seven). Run the lane on its own clock: --spine crypto`,
    )
  }
  if (env === 'off') return { value: 'off', source: 'caller', why: 'the LANE-OFF arm: same window, same spine, same tapes, one lever' }
  return { value: 'on', source: env == null ? 'default' : 'caller', why: 'the crypto session spine walks the pairs’ own days and the lane rides it' }
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
      // …at the depth THIS symbol's own clock counts a year in (`tailBarsFor`):
      // 252 bars for an equity, as it has always been, and 365 for a coin, which
      // is what production's `cachedCandles` (Yahoo `1y`) serves it. The crypto
      // lane reaches this same dep — `cryptoCandleMap(deps.candles, …)` — so a
      // 252-bar tail would hand the pair's capacity and momentum denominators
      // fifty weeks of tape and call it a year.
      return s ? s.slice(-tailBarsFor(sym)) : null
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
  /** The routed ETP, if any — `mapInstrument` against `LEVMAP_MIRROR`, so a
   * full-tier A/B row on a mirrored name carries one. (It was null for the whole
   * window while the mirror was `{}`; the census reads this field rather than
   * assuming either answer, which is what let the change be noticed at all.) */
  instrument: string | null
  /** THE VOICE (stage 2 T5). Absent on a near miss BY DESIGN — that row cleared no
   * gate, so it has no belief to state. */
  thesis: string | null
  falsifier: string | null
  /** THE EXPERIMENT SLOT'S RECORD (stage 3d, types.ts's `Prediction['wildcard']`),
   * carried whole because every number the walk has to report about a wildcard —
   * which gate it tested, which rung chose it, the evidence gap it was spent to
   * close, whether the ledger has been paid — lives here and nowhere else. The
   * catalyst kind says a row IS one; this says what it was FOR. Absent on every
   * ordinary row and in every tree older than the field. */
  wildcard?: WildcardRecordLike
  /** THE PARTITION THIS ROW BELONGS TO (Stage 1c B1's `Prediction.cohort`).
   * Present ONLY on a crypto-lane row — an equity row has never carried it and
   * still does not, so every artefact this harness has ever written is
   * unchanged. It is the field the walk reads to know which GRADER a row's
   * diagnostic outcome must be recomputed with: a crypto row measured against
   * SPY over ten equity sessions is exactly the leak Phase A shipped to stop,
   * and the harness would have re-introduced it in its own artefact. */
  cohort?: string
  /** THE ROW'S NOTE — carried on a cohort row and nowhere else. It is where the
   * lane's cold-start sentence and its paper-only sentence live (`cryptoVoice`
   * appends to `note` and to the evidence detail, never to the thesis), and both
   * are a ratified requirement of the design rather than decoration, so the walk
   * has to be able to read them back. */
  note?: string
  // ---- recomputed post-publication from the SAME calibration blob (HEAD only) ----
  /** The UNROUNDED curve read. `probability` on the row is this quantised to 2dp
   * (engine.ts), and the two are reported side by side on purpose: the curve can
   * be perfectly continuous while the STORED number is a staircase with finer
   * steps, and only the pair says which of those is true. */
  pRaw?: number
  /** THE SAME READ WITH THIS STAGE'S TWO MECHANISMS PEELED OFF, one at a time,
   * against the SAME blob the board was built on [stage 3c task 5 — the
   * controlled diff's instrument].
   *
   *   `pPooled` — pooled population, no family: EXACTLY what `probabilityFor`
   *               answered before the partition and the blend existed, so it is
   *               the pre-3c read of this row on this evidence.
   *   `pSized`  — the row's OWN population, still no family: the partition
   *               applied and nothing else.
   *   `pRaw`    — above: the row's population AND its family — what shipped.
   *
   * The two differences are therefore the two mechanisms, per row, in probability
   * points: `pSized − pPooled` is the partition's contribution and `pRaw − pSized`
   * is the blend's. Recorded at publication time rather than reconstructed later
   * because the blob moves every morning — a post-hoc recomputation off the final
   * state would attribute today's row to a curve it was never priced on.
   *
   * Both are undefined in a pre-stage-2 tree (the enrichment returns before them)
   * and on a near miss (no read path at all). */
  pPooled?: number
  pSized?: number
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
  /** THE CRYPTO ROWS THIS MORNING'S PASS GRADED (Stage 1c B3), each with the
   * morning it published — so "grading matures on the crypto clock" is a number
   * the artefact carries rather than a claim the evidence has to assert.
   *
   * Read per pass and not at walk end, because the CLOCK is the whole point: the
   * final blobs say a row was graded, but only the pass that graded it says
   * WHEN, and sixteen calendar days against the equity fourteen is the
   * difference the crypto partition exists to keep. Present only on a run with
   * the lane on; absent everywhere else, so no artefact this harness has already
   * written moves. */
  cryptoMatured?: CryptoMatured[]
}

/** One crypto row's maturity, as the pass that graded it saw it. */
export interface CryptoMatured {
  /** the morning the row PUBLISHED */
  published: string
  sym: string
  side: 'long' | 'short'
  hit: boolean
  excessPct: number
  stopped: boolean
  /** publication → the pass that booked the outcome, in calendar days. The crypto
   * clock's own arithmetic says 16 (`CRYPTO_PUBLISH_TO_GRADE_DAYS`); anything
   * else is a tape gap or a walk that skipped a session, and the artefact should
   * be able to say which. */
  gradedAfterDays: number
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
  /** THE CODE THIS ROW CARRIED BEFORE THE LAST `revise` OVERWROTE IT
   * (funnelTrace.ts). Stage 3a wrote it for the `shadow-capped ← route-blocked`
   * attribution; Stage 3d relies on it for the one record that says which gate an
   * experiment overrode, since the publication overwrites the row itself. */
  priorGate?: string
  /** the row's core read, carried by the recorder on every row that produced one */
  core?: number
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
  'called-full', 'called-half', 'called-shadow', 'called-watch', 'called-below-base', 'called-observation', 'called-wildcard',
  'crypto-contained',
])

/** THE READER GOT THIS ROW. Mirrors `PUBLISHED_GATES`: the size decisions, the
 * promotion that fills an empty side, and the route-blocked shadow that still
 * reaches the ledger. */
const PUBLISHED_GATE_CODES: ReadonlySet<string> = new Set([
  'called-full', 'called-half', 'called-shadow', 'called-watch', 'called-below-base', 'called-observation', 'called-wildcard', 'route-blocked',
])

/** The gates that fire BEFORE a side exists and therefore key on the bare name:
 * the two trims, the candle miss, and the tape that produced no read at all. */
/** Codes that fire BEFORE a side is decided, and must therefore carry none.
 *
 * `crypto-contained` (stage 1c A1) joins them because it is recorded in
 * `addSource` — the candidate door, upstream of any composite, so upstream of any
 * direction. A1 taught `GATE_CODE_MIRROR` and `MISS_SKIP_GATE_MIRROR` the new
 * code and not this set, and the residual was invisible until a walk actually
 * refused a coin: the very first day of A2's containment arm threw the trace
 * invariant on both names. It is a mirror fix, not an engine one — nothing the
 * reader sees moved — and it is exactly what the parity arm exists to find. */
const SIDE_FREE_GATES: ReadonlySet<string> = new Set(['trimmed', 'no-candles', 'no-data', 'crypto-contained'])

/** The called-* code `publishCall` must have written for a row of this shape —
 * derived from what the READER can see on the row itself, never from the trace.
 * That is the point: two independent readings of one decision, compared.
 *
 * A shadow admits two codes because `route-blocked` is the more specific truth
 * about a shadow an ISA cannot place, and the ROW carries no field that separates
 * them (the engine records that distinction by id, deliberately — "the ledger must
 * not grow a field that means why we hid it"). Both are one size class: zero,
 * ledger-only. */
export function expectedCalledGates(r: Pick<Row, 'shadow' | 'watchOnly' | 'belowBase' | 'observation' | 'grade' | 'contract' | 'catalyst'>): string[] {
  if (r.shadow) return ['called-shadow', 'route-blocked']
  // The EXPERIMENT SLOT (Stage 3d) — read off the row's own catalyst tag, which
  // is the same discriminator the engine's ladder and factor-IC exclusions use.
  // It sits above the size classes because its code names WHY the row published
  // rather than what size it earned: the row is on the board at a quarter of the
  // rung precisely because a gate refused it, and none of full/half/watch can say
  // that. Below `shadow` because a wildcard that shadowed was never seated.
  if (r.catalyst === WILDCARD_CATALYST_KIND_MIRROR) return ['called-wildcard']
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

/** catalyst.ts `WILDCARD_CATALYST_KIND` — the tag the experiment slot stamps on
 * its one row a day (Stage 3d). Two readings in this file key off it: the
 * called-* class a wildcard row must carry, and the post-mortem rule that makes
 * it the only population examined on a WIN. Drift-guarded in the suite. */
export const WILDCARD_CATALYST_KIND_MIRROR = 'wildcard'
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
 * ledger already), the three shadow shapes (an audition the engine deliberately
 * withheld, which also grades already, with a real published stop) — and the
 * WILDCARD (Stage 3d), whose real, stopped outcome is charged to the gate it
 * overrode as CAUSAL evidence, so a stopless copy of the same fortnight must
 * never be charged beside it. */
export const MISS_SKIP_GATE_MIRROR: ReadonlySet<string> = new Set(['called-full', 'called-half', 'called-shadow', 'called-wildcard', 'route-blocked', 'shadow-capped', 'crypto-contained'])
/** postMortem.ts `POSTMORTEM_CLASSES`, IN PRECEDENCE ORDER — the order is the
 * definition, so the mirror is an array and the drift guard compares it ordered.
 * `won` is the sixth and is NOT part of that precedence: it is the wildcard's
 * win branch (Stage 3d), assigned by `classifyOutcome` and by nothing else. */
export const POSTMORTEM_CLASS_MIRROR: readonly string[] = ['stopped', 'thesis-break', 'market-drag', 'news-reversal', 'adverse-move', 'won']
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
  /** THE ONE ROW THE ENGINE ACTUALLY TOOK (stage 3d). Stamped on causal
   * examples and nowhere else, so a human reading a gate's examples back can
   * tell the experiment from the dozens of refusals measured beside it. */
  wildcard?: true
  /** …and whether the reader's quarter-size position came good. Present only on
   * a causal example — a miss example had no stop and no position. */
  hit?: boolean
}
export interface MissGateStatLike {
  cost: number
  costExcessSum: number
  saved: number
  savedExcessSum: number
  unchecked: number
  examples: MissExampleLike[]
  /** THE HYGIENIC SIDED COUNTS (stage 3b) — the only numbers allowed to move a
   * gate, and the ones a causal outcome adds to (missLedger.ts). Optional
   * because a gate charged only by the bare-mirror path carries neither. */
  sidedCost?: number
  sidedSaved?: number
  /** THE EXPERIMENT'S OWN COLUMN (stage 3d, missLedger.ts's `MissCausal`) —
   * real, stopped, sided outcomes on trades this gate refused. Absent until the
   * wildcard slot has been spent on this gate, and a surface printing "0 causal"
   * would read as a verdict, so absence is kept as absence. */
  causal?: { n: number; hits: number; examples: MissExampleLike[] }
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
  /** The walked dates the ledger's own selection rule CAN reach
   * (`priceableTraceDates`). Identical to `dates` on the equity spine and on
   * every context built without a tape, which is why nothing that predates the
   * crypto spine changes: it is only on a spine carrying days SPY has no bar for
   * that the two lists differ. OPTIONAL, and absent reads as `dates`: a context
   * built by hand (a fixture) is asserting about a walk with one day per
   * session, which is the case the field was invented to stop assuming. */
  priceable?: string[]
}

/** WHICH WALK DAYS THE MISS LEDGER CAN EVER PRICE — the harness's mirror of
 * `maturedTraceDate` + `accrueMissLedger`'s guard, and a finding rather than a
 * convenience (B3; recorded in the walk-results doc).
 *
 * The engine picks the day to price by mapping every trace date onto a SPY BAR
 * INDEX (`spy.findIndex(c => c.t >= epoch)`) and taking the newest, then returns
 * without pricing anything if that day is already in the ledger — it never falls
 * back to an older unpriced one. Two walk dates that land on the same SPY bar
 * are therefore ONE slot: the earlier wins it, the later is unreachable forever.
 *
 * On the equity spine that is unreachable-by-construction — one session, one bar
 * — which is why the invariant could always be stated over the walk's own dates.
 * On the crypto spine every Saturday, every Sunday and every US market holiday
 * collapses onto the session that follows it, so the ledger's measured days are
 * a strict subset of the walked ones BY DESIGN. Asserting contiguity over the
 * walk's dates there would fail a correct run, and — worse — would hide the real
 * claim, which is that no day the engine COULD have priced was skipped.
 *
 * Indices are stable under `sliceBefore` (it drops from the end only), so the
 * full tape gives the same buckets the engine's truncated one does. */
export function priceableTraceDates(dates: readonly string[], spy: Candle[] | null | undefined): string[] {
  if (!spy?.length) return [...dates]
  const out: string[] = []
  let best = -1
  for (const d of dates) {
    const epoch = Date.parse(d) / 1000
    if (!Number.isFinite(epoch)) continue
    const idx = spy.findIndex(c => c.t >= epoch)
    if (idx === -1) continue // no session at or after it — never selectable
    if (idx > best) {
      best = idx
      out.push(d)
    }
  }
  return out
}

/** THE WALK DAY THE ENGINE FIRST GRADED A ROW PUBLISHED ON `dates[i]` — eleven
 * SPY sessions on, expressed in whatever days the spine happens to keep.
 *
 * The rule itself is unchanged and is the engine's: a pass on day k sees bars
 * strictly before k, so a row published at session s is first gradeable by the
 * pass at session s + 11. What changes on the crypto spine is that a walk day is
 * no longer a session — eleven sessions is fifteen calendar days across two
 * weekends — so the day is FOUND by session count rather than assumed at
 * `i + 11`. Without a tape, and on the equity spine with one, the answer is
 * exactly `dates[i + 11]`: the two agree by construction, and the equity walks
 * that shipped before B3 are unaffected. */
export function gradedOnDate(dates: readonly string[], spy: Candle[] | null | undefined, i: number, horizon = POSTMORTEM_HORIZON_MIRROR): string {
  const last = dates[dates.length - 1]
  if (!spy?.length) return dates[i + horizon + 1] ?? last
  const sessionOf = (d: string) => spy.findIndex(c => c.t >= Date.parse(d) / 1000)
  const from = sessionOf(dates[i])
  if (from === -1) return dates[i + horizon + 1] ?? last
  const want = from + horizon + 1
  for (let j = i + 1; j < dates.length; j++) if (sessionOf(dates[j]) >= want) return dates[j]
  return last
}

export function regretContextOf(days: { date: string; board: Row[]; ledger: Row[]; trace?: DayTrace }[], spy?: Candle[] | null): RegretContext {
  const traces: RegretContext['traces'] = {}
  const sized: RegretContext['sized'] = {}
  for (const d of days) {
    traces[d.date] = d.trace
    sized[d.date] = new Set([...d.board, ...d.ledger].filter(r => r.riskPct > 0).map(r => `${r.sym.toUpperCase()}:${r.side}`))
  }
  const dates = days.map(d => d.date)
  return { dates, traces, sized, priceable: priceableTraceDates(dates, spy) }
}

/** The rows in a day's trace a miss may be charged for — every row whose gate is
 * not on the skip list. `checked + unchecked` for that day must equal it exactly:
 * a truncation nobody can see is the silence Stage 3 exists to end. */
/** …and it mirrors BOTH of `missCandidates`' skips, not just the gate one.
 *
 * The ledger drops a refusal two ways (missLedger.ts): its GATE is a skip gate,
 * or its NAME is a crypto pair — "both layers, because the cost of a miss here
 * is a stopless SPY excess charged to an equity gate". Mirroring only the first
 * was invisible while every crypto trace row carried `crypto-contained` (itself
 * a skip gate), and became a false accounting violation the moment the crypto
 * lane started writing ordinary gate codes on its own names (Stage 1c Phase B):
 * the invariant would report "a population went missing" about rows the ledger
 * is DESIGNED never to see. A mirror that does not mirror is worse than no
 * mirror — it fails on the feature rather than on the bug. */
export const missCandidateCount = (t?: DayTrace): number =>
  Object.entries(t?.rows ?? {}).filter(([key, r]) => !MISS_SKIP_GATE_MIRROR.has(r.gate) && !isCryptoSymbol(key.split(':')[0])).length

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
 *     …over the days the rule can REACH (`ctx.priceable`): the ledger's clock is
 *     SPY's, so on a spine carrying days SPY has no bar for, several walk dates
 *     share one session and only the earliest of them is ever selectable. That
 *     is the walk's finding, not its licence — a reachable day with no entry is
 *     still a violation, and a priced day that was NOT reachable is a new one.
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

  // (b) the days — contiguous over the days the ledger's own rule can REACH
  // (`priceable`, which is `dates` itself on every equity-spine walk). A day the
  // engine could never have selected is not a hole; a day it could have and did
  // not still is.
  for (const d of days) if (!ctx.dates.includes(d)) v.push(`miss-ledger day ${d} is not a day this walk walked — the ledger measured a morning that never happened`)
  const reachable = ctx.priceable ?? ctx.dates
  for (const d of days) if (ctx.dates.includes(d) && !reachable.includes(d)) v.push(`miss-ledger day ${d} is a day the ledger's own selection rule can never reach — it collapses onto a later session's bar`)
  const walked = days.filter(d => ctx.dates.includes(d))
  const priced = walked.filter(d => reachable.includes(d))
  if (priced.length) {
    const first = reachable.indexOf(priced[0])
    const expected = reachable.slice(first, first + priced.length)
    for (const d of expected) if (!ledger.days[d]) v.push(`miss-ledger has no entry for ${d}, a matured trace day between ${priced[0]} and ${priced[priced.length - 1]} — a day that matured and was never measured is never revisited`)
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
 * a pre-Stage-3b tree) is skipped rather than failed.
 *
 * …AND A CRYPTO ROW IS NOT ONE OF THEM, by the same exclusion the engine states
 * at the accrual (`!cryptoRow` guards the post-mortem stamp, engine.ts): the
 * classifier reads `market-drag` and `news-reversal` off SPY, and the ledger it
 * feeds is SPY-benchmarked, so a coin has nothing to explain itself WITH. The
 * walk asserted the opposite until the lane first graded one — the crypto spine
 * found it, exactly as A1's parity arm found `SIDE_FREE_GATES`. Corrected here,
 * in the harness's mirror; nothing the reader sees moves. */
export function postMortemViolations(days: { date: string; board: Row[]; ledger: Row[] }[]): string[] {
  const v: string[] = []
  for (const day of days) {
    for (const r of day.ledger) {
      if (r.storedOutcome10 === undefined) continue
      if (r.cohort === 'crypto') {
        // …and the exclusion is asserted in BOTH directions: a crypto row that
        // somehow carried one would mean the engine's own guard had failed.
        if (r.postMortem) v.push(`${day.date}:${r.sym}:${r.side}: a crypto row carries a post-mortem — the classifier reads SPY, and the partition is excluded from it`)
        continue
      }
      const key = `${day.date}:${r.sym}:${r.side}`
      const pm = r.postMortem
      if (!r.storedOutcome10) {
        if (pm) v.push(`${key}: carries a post-mortem although the engine never graded it`)
        continue
      }
      // …with ONE population examined either way: the wildcard slot (Stage 3d),
      // which is post-mortemed on every closure because an experiment whose
      // successes go unexamined is not an experiment. So a winning wildcard MUST
      // carry one, a winning anything-else must not, and both then fall through
      // to the same shape checks below.
      const experiment = r.catalyst === WILDCARD_CATALYST_KIND_MIRROR
      if (r.storedOutcome10.hit && !experiment) {
        if (pm) v.push(`${key}: won and still carries a post-mortem — winners get nothing`)
        continue
      }
      if (!pm) {
        v.push(`${key}: the engine graded it ${r.storedOutcome10.hit ? 'a winning experiment' : 'a loser'} and it explains nothing`)
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

// ================= THE EXPERIMENT SLOT, OVER A WINDOW (stage 3d task 3) ========
//
// Stage 3d publishes ONE blocked trade at a time, at quarter size, so a gate can
// be charged a real stopped outcome instead of another stopless upper bound. Three
// claims have to survive a window rather than a fixture, and all three are made
// here, against the walk's OWN record of what the reader was handed:
//
//   · SOLITARY — one row a day, and no second experiment until the previous one
//     closes. That invariant is enforced in the engine by a scan over
//     `predictions-index … .slice(-10)`, so it has a BOUNDARY, and the boundary is
//     asserted below rather than assumed (see `WILDCARD_SLOT_LOOKBACK`).
//   · CAUSAL — every experiment the engine graded reaches the miss ledger's causal
//     column, on the gate it was chosen to test, tagged, with the receipt stamped.
//   · SEPARABLE — see `wildcardControlledDiff`, which does that half against a
//     lane-off arm of the same window.

/** engine.ts's outstanding scan reads the last ten dated prediction blobs
 * (`predictions-index … .slice(-10)`), and that number is INLINE there — nothing
 * exports it, so this is a mirror with no import to drift against. It is checked
 * below against `POSTMORTEM_HORIZON_MIRROR` instead, which is the check that
 * matters: the two constants together decide whether the slot is released by the
 * experiment's OUTCOME or merely by the window sliding out from under it. */
export const WILDCARD_SLOT_LOOKBACK = 10

/** types.ts's `Prediction['wildcard']`, structurally (see `Row.wildcard`). */
export interface WildcardRecordLike {
  gate: string
  priority: number
  hypothesis: string
  gateEvidenceN: number
  /** the tri-state receipt: absent = nothing owed, false = the ledger is owed
   * this outcome, true = the ledger has it. */
  booked?: boolean
}

/** ONE EXPERIMENT, as the window saw it. */
export interface WildcardTaken {
  /** the walk index of the session it published on — the unit the one-slot
   * arithmetic is done in, because the slot counts SESSIONS and not dates. */
  at: number
  date: string
  sym: string
  side: 'long' | 'short'
  gate: string
  priority: number
  hypothesis: string
  gateEvidenceN: number
  composite: number
  probability: number
  grade: string
  riskPct: number
  setup: string | null
  regime: string
  /** MEASUREMENT, NOT A TRADE THE READER TOOK. `mapInstrument` is reached only at
   * `sizedFraction === 1` and a wildcard is capped at 0.25, so every short
   * wildcard publishes `instrument: null` and is paper money (wildcardLane.ts's
   * routability note). The causal evidence is real either way; the P&L is not. */
  paperOnly: boolean
  /** THE ENGINE'S OWN GRADE at ten sessions, read back off the prediction blob —
   * null when the window ended before the horizon closed. This is the one that
   * decides whether the ledger is owed anything. */
  outcome: { hit: boolean; excessPct: number; stopped: boolean } | null
  /** …and the harness's forward walk over the full tape, which can answer for a
   * row the engine never reached. Reported, never charged. */
  tapeOutcome: { hit: boolean; excessPct: number; stopped: boolean } | null
  postMortem: string | null
  booked?: boolean
}

const isWildcardRow = (r: Row): boolean => r.catalyst === WILDCARD_CATALYST_KIND_MIRROR

/** Every experiment the window took, in walk order. Read off the BOARD (the
 * ledger carries the same row) and deduplicated by key, so a name published on
 * both cuts is one experiment and not two. */
export function wildcardCensus(days: { date: string; board: Row[]; ledger: Row[] }[]): WildcardTaken[] {
  const out: WildcardTaken[] = []
  for (const [at, d] of days.entries()) {
    const seen = new Set<string>()
    for (const r of [...d.board, ...d.ledger]) {
      if (!isWildcardRow(r)) continue
      const key = `${r.sym.toUpperCase()}:${r.side}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        at,
        date: d.date,
        sym: r.sym,
        side: r.side,
        gate: r.wildcard?.gate ?? '(no record)',
        priority: r.wildcard?.priority ?? 0,
        hypothesis: r.wildcard?.hypothesis ?? '',
        gateEvidenceN: r.wildcard?.gateEvidenceN ?? -1,
        composite: r.composite,
        probability: r.probability,
        grade: r.grade,
        riskPct: r.riskPct,
        setup: r.setup,
        regime: r.regime,
        paperOnly: r.side === 'short' && !r.instrument,
        outcome: r.storedOutcome10 ?? null,
        tapeOutcome: r.outcome10 ?? null,
        postMortem: r.postMortem?.cls ?? null,
        booked: r.wildcard?.booked,
      })
    }
  }
  return out
}

/** WHAT THE SLOT MAY NEVER DO, over a window. Every claim is settled against the
 * walk's own record — the rows the reader got, the trace the funnel wrote and the
 * ledger the engine left — never against a re-derivation of the lane's choice. */
export function wildcardViolations(
  days: { date: string; board: Row[]; ledger: Row[]; trace?: DayTrace }[],
  ledger: MissLedgerLike | null | undefined,
): string[] {
  const v: string[] = []
  const census = wildcardCensus(days)

  // (a) THE BOUNDARY, ASSERTED. The slot is held by a scan over the last
  // WILDCARD_SLOT_LOOKBACK dated blobs, so an experiment stops holding it after
  // that many sessions WHETHER OR NOT it graded — the documented honest bound
  // (engine.ts). What makes that bound cost nothing is the arithmetic here: a row
  // published on session i is first gradeable on session i + horizon + 1, and it
  // falls out of the lookback on session i + lookback + 1. While the two are
  // EQUAL, the slot is always released by the outcome and never by the window.
  // Shorten the lookback and every experiment would release un-graded — the
  // cadence contract would change silently, and the causal sample the slot exists
  // to buy would be a coin toss on whether the tape arrived in time.
  if (WILDCARD_SLOT_LOOKBACK < POSTMORTEM_HORIZON_MIRROR)
    v.push(
      `the one-slot lookback (${WILDCARD_SLOT_LOOKBACK}) is shorter than the grading horizon (${POSTMORTEM_HORIZON_MIRROR}) — ` +
        'the slot would release on the window rather than on the experiment, and un-graded experiments would become the normal path',
    )

  // (b) ONE ROW A DAY, and both cuts telling the same story about it.
  for (const d of days) {
    const b = d.board.filter(isWildcardRow)
    const l = d.ledger.filter(isWildcardRow)
    if (b.length > 1) v.push(`${d.date}: ${b.length} wildcard rows on one board (${b.map(r => `${r.sym} ${r.side}`).join(', ')}) — the experiment slot is ONE row`)
    if (l.length > 1) v.push(`${d.date}: ${l.length} wildcard rows in one ledger — the experiment slot is ONE row`)
    if (b.length === 1 && l.length === 1 && `${b[0].sym}:${b[0].side}` !== `${l[0].sym}:${l[0].side}`)
      v.push(`${d.date}: the board's experiment is ${b[0].sym} ${b[0].side} and the ledger's is ${l[0].sym} ${l[0].side}`)
  }

  // (c) THE SHAPE OF AN EXPERIMENT, on the row and in the funnel's record.
  for (const d of days) {
    for (const r of d.board.filter(isWildcardRow)) {
      const key = `${d.date}:${r.sym}:${r.side}`
      if (!r.wildcard) v.push(`${key}: a wildcard row with no wildcard record — the catalyst kind says what it is and nothing says what it was for`)
      if (r.riskPct <= 0) v.push(`${key}: riskPct ${r.riskPct} — an experiment with no size buys no causal evidence`)
      if (r.accrual !== 'sized') v.push(`${key}: accrual '${r.accrual}' — a wildcard is the reader's money and books as sized`)
      if (r.shadow) v.push(`${key}: published as a shadow — a shadowed experiment was declined, not seated`)
      if (r.watchOnly) v.push(`${key}: watch-only — an experiment with no position measures nothing`)
      if (r.nearMiss) v.push(`${key}: still flagged a near miss — the wildcard replaced that row, it did not join it`)
      if (r.contract) v.push(`${key}: claims an evidence contract — a wildcard is published without one, deliberately`)
      if (r.instrument) v.push(`${key}: routed to ${r.instrument} — a quarter-size row can never reach mapInstrument, so leverage is structurally impossible`)
      if (!(Math.abs(r.stop - r.entry) > 0) || (r.side === 'long' ? r.stop >= r.entry : r.stop <= r.entry))
        v.push(`${key}: entry ${r.entry} stop ${r.stop} — an experiment without a falsifier is not one`)
      const t = d.trace?.rows[`${r.sym.toUpperCase()}:${r.side}`]
      if (!t) v.push(`${key}: no trace row — the funnel has no record of the day's one deliberate override`)
      else {
        if (t.gate !== 'called-wildcard') v.push(`${key}: the trace codes it '${t.gate}' — a seated experiment is 'called-wildcard'`)
        if (r.wildcard && t.priorGate !== r.wildcard.gate)
          v.push(`${key}: the row tests '${r.wildcard.gate}' and the trace remembers '${t.priorGate}' — the gate under test may never be re-derived`)
      }
    }
  }

  // (d) ONE SLOT ACROSS DAYS — the invariant the whole cadence rests on.
  for (let i = 1; i < census.length; i++) {
    const prev = census[i - 1]
    const next = census[i]
    const released = prev.at + WILDCARD_SLOT_LOOKBACK + 1
    if (next.at < released)
      v.push(
        `${next.date} spent the slot ${released - next.at} session(s) early — ${prev.sym} ${prev.side} (${prev.date}) was still open, ` +
          'and two experiments running at once is exactly the confounding the slot exists to avoid',
      )
  }

  // (e) THE CAUSAL EVIDENCE LANDED, and nothing else did.
  //
  // COUNTED ON `n`, CHECKED ON THE EXAMPLES THAT SURVIVED. `causal.examples` is a
  // BOUNDED TAIL — `.slice(-MISS_EXAMPLES_PER_GATE)` in missLedger.ts, the same
  // bound the miss examples live under — so over a long window the early
  // experiments are legitimately evicted from it while `n` and `hits` keep every
  // one. An invariant that looked for each graded experiment's example would
  // therefore fire on a two-year walk for doing exactly what it was built to do.
  // The population claim is made on the counters, which are complete; the
  // provenance claims are made on whichever examples are still there.
  const gates = Object.entries(ledger?.gates ?? {})
  const byRow = new Map(census.map(w => [`${w.date}:${w.sym.toUpperCase()}:${w.side}`, w]))
  let causalTotal = 0
  for (const [gate, stat] of gates) {
    const c = stat.causal
    if (!c) continue
    causalTotal += c.n
    // the gate's causal count IS the experiments this window graded against it —
    // no more (a double-book) and no fewer (a lost write with no receipt behind it)
    const mine = census.filter(w => w.gate === gate && w.outcome)
    if (c.n !== mine.length)
      v.push(`${gate}: ${c.n} causal outcome(s) booked and ${mine.length} experiment(s) graded against it — the column and the window disagree`)
    if (c.hits !== mine.filter(w => w.outcome!.hit).length)
      v.push(`${gate}: ${c.hits} causal hit(s) booked and ${mine.filter(w => w.outcome!.hit).length} experiment(s) hit`)
    if (c.hits > c.n) v.push(`${gate}: causal hits ${c.hits} exceeds causal n ${c.n}`)
    // the sided counts are what a gate may actually MOVE on, and a causal outcome
    // is one of each kind — a hit is a sided cost, a miss a sided save
    if ((stat.sidedCost ?? 0) < c.hits) v.push(`${gate}: ${c.hits} causal hit(s) but sidedCost ${stat.sidedCost ?? 0} — the causal outcome never reached the counts that move a gate`)
    if ((stat.sidedSaved ?? 0) < c.n - c.hits) v.push(`${gate}: ${c.n - c.hits} causal miss(es) but sidedSaved ${stat.sidedSaved ?? 0}`)
    for (const ex of c.examples) {
      if (ex.wildcard !== true) v.push(`${gate}: a causal example (${ex.date} ${ex.sym}) is not tagged as the experiment it was`)
      if (typeof ex.hit !== 'boolean') v.push(`${gate}: a causal example (${ex.date} ${ex.sym}) records no hit — the whole point is that this one had a position`)
      const w = byRow.get(`${ex.date}:${String(ex.sym).toUpperCase()}:${ex.side}`)
      if (!w) v.push(`${gate}: a causal example (${ex.date} ${ex.sym} ${ex.side}) names a row this window never published`)
      else {
        if (w.gate !== gate) v.push(`${gate}: charged ${ex.date} ${ex.sym}, which was published to test '${w.gate}'`)
        if (w.outcome && ex.hit !== w.outcome.hit) v.push(`${gate}: ${ex.date} ${ex.sym} booked hit=${ex.hit} and the engine graded hit=${w.outcome.hit}`)
      }
    }
  }
  // THE RECEIPT'S OWN BOUND (fix-wave F-4's residual, asserted here for the first
  // time): the ledger can hold at most one causal sample per experiment ever
  // published. A double-book — the one-blob-write window between the ledger write
  // and the receipt — shows up as this inequality failing and nowhere else.
  if (causalTotal > census.length)
    v.push(`the ledger holds ${causalTotal} causal outcome(s) and the window published ${census.length} experiment(s) — an outcome was booked twice`)
  for (const w of census) {
    const gate = gates.find(([g]) => g === w.gate)?.[1]
    const named = (gate?.causal?.examples ?? []).some(e => e.date === w.date && String(e.sym).toUpperCase() === w.sym.toUpperCase() && e.side === w.side)
    if (w.outcome && !gate?.causal) v.push(`${w.date}:${w.sym}:${w.side}: the engine graded it and '${w.gate}' carries no causal column at all — the slot bought nothing`)
    if (w.outcome && w.booked !== true) v.push(`${w.date}:${w.sym}:${w.side}: graded and booked=${String(w.booked)} — the receipt is what makes a lost write recoverable`)
    if (!w.outcome && named) v.push(`${w.date}:${w.sym}:${w.side}: charged to '${w.gate}' before the engine ever graded it`)
    if (!w.outcome && w.booked === true) v.push(`${w.date}:${w.sym}:${w.side}: stamped booked with no grade behind it`)
    // an experiment is post-mortemed on EVERY closure, win or lose — the whole
    // asymmetry the slot was added to end (postMortemViolations pins the general
    // rule; this pins that a WINNING experiment is the case it was widened for)
    if (w.outcome?.hit && w.postMortem !== 'won') v.push(`${w.date}:${w.sym}:${w.side}: won and reads '${w.postMortem}' — a winning experiment is examined too`)
  }
  return v
}

// ---------------------------------------- the controlled diff: lane on / off --
//
// The separability claim, measured rather than asserted: run the SAME window
// twice, once with `WILDCARD=off`, and the two arms may differ in four ways and
// no others —
//
//   1. the experiment rows themselves (and, at a key a wildcard took, the near
//      miss it replaced — both sides of that chart, which is the splice's own
//      one-direction-per-chart rule),
//   2. the miss ledger's causal column,
//   3. the separable records (`byGrade`'s 🃏 key, `bySetup`, the post-mortems),
//   4. …and THE ONE CHANNEL THE RATIFIED DESIGN OPENS ON PURPOSE: a wildcard is
//      the reader's money at a quarter of the rung, so its graded outcome accrues
//      into `engine-calibration` exactly as any sized row's does (plan, Global
//      Constraints: "its calibration accrual is normal"). From the session that
//      outcome lands, the two arms are reading a curve that differs by one
//      observation, and ordinary rows priced against it legitimately move.
//
// So the guard is split at that session rather than waved at. BEFORE the first
// experiment grades, the arms must be byte-identical — that is the real claim
// about SELECTION, and it is where a lane that perturbed the board would show.
// AFTER it, only the read may move: probabilities, the grades derived from them,
// and the sizes derived from those. A composite, a level, a setup family, an
// accrual stamp or a rung moving is a lane reaching somewhere it was never given.

/** What a calibration read may legitimately move. */
export const WILDCARD_READ_FIELDS: ReadonlySet<string> = new Set([
  'probability', 'grade', 'gradeUncapped', 'pRaw', 'pPooled', 'pSized', 'nEff', 'belowEvidence',
])
/** …and what a moved GRADE may then move, on that row and only if it did. */
export const WILDCARD_GRADE_DERIVED_FIELDS: ReadonlySet<string> = new Set(['riskPct', 'watchOnly', 'instrument'])

export interface WildcardRowDelta {
  key: string
  where: 'board' | 'ledger'
  /** the walk index of the row's session — which side of the accrual it sits on */
  at: number
  fields: string[]
}

export interface WildcardControlledDiff {
  shared: number
  /** keys only the lane-ON arm has. Every one must be an experiment. */
  newOnly: { key: string; where: 'board' | 'ledger'; wildcard: boolean }[]
  /** keys only the lane-OFF arm has. Every one must be a near miss on a chart the
   * experiment took that session — the splice clears BOTH sides of it. */
  refOnly: { key: string; where: 'board' | 'ledger'; displaced: boolean }[]
  /** a key where the experiment stands in the near miss's place */
  replaced: { key: string; where: 'board' | 'ledger' }[]
  /** the walk index of the first session an experiment's outcome could have
   * reached the calibration, or null when none graded inside the window */
  firstAccrual: number | null
  /** matched rows that moved BEFORE that session — MUST be empty */
  early: WildcardRowDelta[]
  /** …and at or after it: allowed, and only through the read */
  late: WildcardRowDelta[]
  /** every field that moved anywhere, with its count */
  fields: Record<string, number>
  /** moves no accrual can explain — a failure whenever they happen */
  forbidden: WildcardRowDelta[]
  /** grade-derived moves on a row whose grade did not move — also a failure */
  unearned: WildcardRowDelta[]
  passed: boolean
}

export function wildcardControlledDiff(ref: RunFile, neu: RunFile): WildcardControlledDiff {
  const census = wildcardCensus(neu.days)
  const atOf = new Map(neu.days.map((d, i) => [d.date, i]))
  // The first session an experiment's outcome could have reached the blob: the
  // engine grades a row published on session i at i + horizon + 1 (the harness's
  // own arithmetic, see `gradedOn`). Only experiments the engine actually graded
  // count — a row the window ended on top of accrued nothing.
  const graded = census.filter(w => w.outcome).map(w => w.at + POSTMORTEM_HORIZON_MIRROR + 1)
  const firstAccrual = graded.length ? Math.min(...graded) : null
  const wildcardSyms = new Map<string, Set<string>>()
  for (const w of census) wildcardSyms.set(w.date, (wildcardSyms.get(w.date) ?? new Set()).add(w.sym.toUpperCase()))

  const out: WildcardControlledDiff = {
    shared: 0, newOnly: [], refOnly: [], replaced: [], firstAccrual,
    early: [], late: [], fields: {}, forbidden: [], unearned: [], passed: false,
  }
  for (const where of ['board', 'ledger'] as const) {
    const a = new Map(flatten(ref, where).map(r => [keyOf(r), r]))
    const b = new Map(flatten(neu, where).map(r => [keyOf(r), r]))
    for (const [key, rb] of b)
      if (!a.has(key)) out.newOnly.push({ key, where, wildcard: isWildcardRow(rb) })
    for (const [key, ra] of a) {
      if (b.has(key)) continue
      const [date, sym] = key.split(':')
      out.refOnly.push({ key, where, displaced: !!ra.nearMiss && !!wildcardSyms.get(date)?.has(sym.toUpperCase()) })
    }
    for (const [key, ra] of a) {
      const rb = b.get(key)
      if (!rb) continue
      out.shared++
      const at = atOf.get(key.split(':')[0]) ?? 0
      if (isWildcardRow(rb) || isWildcardRow(ra)) {
        // the experiment standing where the near miss stood. Anything else at a
        // shared key would mean the lane took a name the board had published.
        if (isWildcardRow(rb) && ra.nearMiss) out.replaced.push({ key, where })
        else out.forbidden.push({ key, where, at, fields: ['catalyst'] })
        continue
      }
      const moved = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter(
        f => JSON.stringify(ra[f as keyof Row]) !== JSON.stringify(rb[f as keyof Row]),
      )
      if (!moved.length) continue
      for (const f of moved) out.fields[f] = (out.fields[f] ?? 0) + 1
      const delta: WildcardRowDelta = { key, where, at, fields: moved }
      ;(firstAccrual != null && at >= firstAccrual ? out.late : out.early).push(delta)
      const gradeMoved = moved.includes('grade')
      const bad = moved.filter(f => !WILDCARD_READ_FIELDS.has(f) && !WILDCARD_GRADE_DERIVED_FIELDS.has(f))
      const unearned = gradeMoved ? [] : moved.filter(f => WILDCARD_GRADE_DERIVED_FIELDS.has(f))
      if (bad.length) out.forbidden.push({ key, where, at, fields: bad })
      if (unearned.length) out.unearned.push({ key, where, at, fields: unearned })
    }
  }
  out.passed =
    out.newOnly.every(n => n.wildcard) &&
    out.refOnly.every(r => r.displaced) &&
    out.early.length === 0 &&
    out.forbidden.length === 0 &&
    out.unearned.length === 0
  return out
}

/** THE SEPARABLE RECORDS, differenced. The scorecard has already answered this
 * question once for shadows, and 3d's rule is that a wildcard takes the same
 * treatment — so the diff is the check that it did: a new `byGrade` key rather
 * than a fatter `C`, `byRegime` untouched, `bySetup` counting the shape, the
 * lifetime counters and the Brier trail refusing the experiment outright. */
export interface WildcardSeparability {
  byGradeWildcard: { n: number; hits: number } | null
  /** letters that moved between the arms — every one is a real, named grade */
  lettersMoved: string[]
  byRegimeDelta: number
  bySetupDelta: number
  byPostMortemDelta: Record<string, number>
  lifetimeDelta: number
  brierLenDelta: number
  totalGradedDelta: number
  /** calibration buckets that differ, and by how much */
  buckets: { key: string; nDelta: number; hitsDelta: number; shadowNDelta: number }[]
  evidenceDelta: { seed: number; live: number; shadow: number }
}

export function wildcardSeparability(ref: RunFile, neu: RunFile): WildcardSeparability {
  const a = ref.scorecardFinal ?? null
  const b = neu.scorecardFinal ?? null
  const sum = (o: Record<string, { n: number }> | undefined): number => Object.values(o ?? {}).reduce((s, x) => s + x.n, 0)
  const pm: Record<string, number> = {}
  for (const k of new Set([...Object.keys(a?.byPostMortem ?? {}), ...Object.keys(b?.byPostMortem ?? {})])) {
    const d = (b?.byPostMortem?.[k] ?? 0) - (a?.byPostMortem?.[k] ?? 0)
    if (d) pm[k] = d
  }
  const cal = (r: RunFile) => (r.calibrationFinal ?? null) as (CalibrationState & { evidence?: Record<string, { n: number }> }) | null
  const ca = cal(ref)
  const cb = cal(neu)
  const buckets: WildcardSeparability['buckets'] = []
  for (const key of new Set([...Object.keys(ca?.buckets ?? {}), ...Object.keys(cb?.buckets ?? {})])) {
    const x = (ca?.buckets ?? {})[key] as { n?: number; hits?: number; shadowN?: number } | undefined
    const y = (cb?.buckets ?? {})[key] as { n?: number; hits?: number; shadowN?: number } | undefined
    const d = { key, nDelta: (y?.n ?? 0) - (x?.n ?? 0), hitsDelta: (y?.hits ?? 0) - (x?.hits ?? 0), shadowNDelta: (y?.shadowN ?? 0) - (x?.shadowN ?? 0) }
    if (d.nDelta || d.hitsDelta || d.shadowNDelta) buckets.push(d)
  }
  const ev = (c: ReturnType<typeof cal>, k: string): number => c?.evidence?.[k]?.n ?? 0
  return {
    byGradeWildcard: b?.byGrade?.wildcard ? { n: b.byGrade.wildcard.n, hits: b.byGrade.wildcard.hits } : null,
    lettersMoved: [...new Set([...Object.keys(a?.byGrade ?? {}), ...Object.keys(b?.byGrade ?? {})])]
      .filter(k => k !== 'wildcard' && (a?.byGrade?.[k]?.n ?? 0) !== (b?.byGrade?.[k]?.n ?? 0)),
    byRegimeDelta: sum(b?.byRegime) - sum(a?.byRegime),
    bySetupDelta: sum(b?.bySetup) - sum(a?.bySetup),
    byPostMortemDelta: pm,
    lifetimeDelta: (b?.lifetime?.live.graded ?? 0) + (b?.lifetime?.shadow.graded ?? 0) - (a?.lifetime?.live.graded ?? 0) - (a?.lifetime?.shadow.graded ?? 0),
    brierLenDelta: (cb?.brier?.length ?? 0) - (ca?.brier?.length ?? 0),
    totalGradedDelta: (b?.totalGraded ?? 0) - (a?.totalGraded ?? 0),
    buckets,
    evidenceDelta: { seed: ev(cb, 'seed') - ev(ca, 'seed'), live: ev(cb, 'live') - ev(ca, 'live'), shadow: ev(cb, 'shadow') - ev(ca, 'shadow') },
  }
}

/** THE LEDGER, DIFFERENCED — and the identity worth looking for in it.
 *
 * A wildcard does not ADD evidence to the gate it tested. It SUBSTITUTES: the row
 * is published, so `called-wildcard` puts it in `MISS_SKIP_GATES` and the miss
 * walk never prices it — the stopless `cost`/`saved` population loses exactly that
 * row — while `accrueCausalOutcome` charges the same event once, as a real stopped
 * outcome, into the same `sidedCost`/`sidedSaved` counts that are allowed to move
 * a gate. One event, one lever, better instrument. So on a visited gate `cost` can
 * only ever FALL and the sided counts typically do not move at all; what changed
 * is the quality of the measurement behind them, which is the whole argument for
 * the slot's existence.
 *
 * A gate the slot never visited has no such story and may not move at all. */
export interface WildcardLedgerDelta {
  gates: {
    gate: string
    visited: boolean
    costDelta: number
    savedDelta: number
    uncheckedDelta: number
    sidedCostDelta: number
    sidedSavedDelta: number
    causal: { n: number; hits: number } | null
  }[]
  days: { date: string; checkedDelta: number; uncheckedDelta: number; missesDelta: number }[]
}

export function wildcardLedgerDelta(ref: RunFile, neu: RunFile): WildcardLedgerDelta {
  const visited = new Set((neu.wildcards ?? wildcardCensus(neu.days)).map(w => w.gate))
  const A = ref.missLedgerFinal
  const B = neu.missLedgerFinal
  const gates: WildcardLedgerDelta['gates'] = []
  for (const gate of new Set([...Object.keys(A?.gates ?? {}), ...Object.keys(B?.gates ?? {})])) {
    const a = A?.gates?.[gate]
    const b = B?.gates?.[gate]
    const d = {
      gate,
      visited: visited.has(gate),
      costDelta: (b?.cost ?? 0) - (a?.cost ?? 0),
      savedDelta: (b?.saved ?? 0) - (a?.saved ?? 0),
      uncheckedDelta: (b?.unchecked ?? 0) - (a?.unchecked ?? 0),
      sidedCostDelta: (b?.sidedCost ?? 0) - (a?.sidedCost ?? 0),
      sidedSavedDelta: (b?.sidedSaved ?? 0) - (a?.sidedSaved ?? 0),
      causal: b?.causal ? { n: b.causal.n, hits: b.causal.hits } : null,
    }
    if (d.costDelta || d.savedDelta || d.uncheckedDelta || d.sidedCostDelta || d.sidedSavedDelta || d.causal) gates.push(d)
  }
  const days: WildcardLedgerDelta['days'] = []
  for (const date of new Set([...Object.keys(A?.days ?? {}), ...Object.keys(B?.days ?? {})])) {
    const a = A?.days?.[date]
    const b = B?.days?.[date]
    const d = {
      date,
      checkedDelta: (b?.checked ?? 0) - (a?.checked ?? 0),
      uncheckedDelta: (b?.unchecked ?? 0) - (a?.unchecked ?? 0),
      missesDelta: (b?.misses ?? 0) - (a?.misses ?? 0),
    }
    if (d.checkedDelta || d.uncheckedDelta || d.missesDelta) days.push(d)
  }
  return { gates: gates.sort((x, y) => x.gate.localeCompare(y.gate)), days: days.sort((x, y) => x.date.localeCompare(y.date)) }
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
  // …and the experiment's record, spread rather than defaulted: `undefined`
  // serialises to nothing either way, but an absent KEY is what says "this tree
  // has no such field" to a reader of the JSON, and every ordinary row keeps the
  // shape it has always had.
  ...((p as { wildcard?: WildcardRecordLike }).wildcard ? { wildcard: (p as { wildcard?: WildcardRecordLike }).wildcard } : {}),
  // …and the row's PARTITION, spread for the same reason (Stage 1c B1 stamps it
  // on crypto-lane rows only, so an equity row's shape is exactly what it was) —
  // with the row's NOTE beside it, and only on such a row. The cold-start
  // sentence the lane is required to say out loud ("C at half size is the
  // designed floor, not a verdict") is appended to `note` and to the evidence
  // detail, NOT to the thesis, so a walk carrying the thesis alone could not
  // check the one piece of copy the ratified design made a requirement.
  ...((p as { cohort?: string }).cohort ? { cohort: (p as { cohort?: string }).cohort, note: p.note } : {}),
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
    // pre-stage-2 read path — no curve to report on. PER ROW, not per run: this
    // was a `return`, so one unusual row (a state no curve was ever built for)
    // silently left every LATER row un-enriched and the diff read them as
    // unchanged. A row the read path cannot price is one row's worth of missing
    // evidence, never the rest of the window's.
    if (read.nEff == null) continue
    r.pRaw = read.p
    r.nEff = read.nEff
    r.belowEvidence = !!read.belowEvidence
    r.gradeUncapped = (gradeFor as unknown as (p: number, nEff: number, base: number, below: boolean) => string | null)(
      read.p,
      read.nEff,
      baseRate,
      false,
    )
    // …and the two counterfactual reads the controlled diff is built on (see Row).
    // Same state, same conviction, same rung ladder — only the population and the
    // family are withdrawn, which is precisely what stage 3c added.
    r.pPooled = (probabilityFor(cal, r.side, r.regime, Math.abs(r.composite), 'unknown', 'pooled', null) as unknown as { p: number }).p
    r.pSized = (probabilityFor(cal, r.side, r.regime, Math.abs(r.composite), 'unknown', population, null) as unknown as { p: number }).p
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

/** THE PASS'S OWN RECORD OF WHAT MATURED ON THE CRYPTO CLOCK (Stage 1c B3).
 *
 * Called immediately after `gradeOutstanding`, with every morning the walk has
 * already published. A crypto row that now carries `outcome10` and was not
 * reported by an earlier pass matured HERE — so the gap between its publication
 * date and this morning is the crypto clock's wall-clock cost, measured rather
 * than asserted. `seen` is carried across passes so a row is reported once.
 *
 * Reads `cohort === 'crypto'` and not the symbol: the partition is the row's own
 * stamp (B1), a legacy crypto row from before the lane carries no cohort and is
 * NOT on the crypto basis, and the two must never be counted together. */
async function maturedCryptoIn(
  store: { read: <T>(key: string) => Promise<T | null> },
  publishedDays: string[],
  seen: Set<string>,
  onDate: string,
): Promise<CryptoMatured[]> {
  const found: CryptoMatured[] = []
  for (const d of publishedDays) {
    for (const p of (await store.read<Prediction[]>(`predictions:${d}`)) ?? []) {
      if ((p as { cohort?: string }).cohort !== 'crypto' || !p.outcome10) continue
      const key = `${d}:${p.sym}:${p.side}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({
        published: d,
        sym: p.sym,
        side: p.side,
        hit: p.outcome10.hit,
        excessPct: p.outcome10.excessPct,
        stopped: p.outcome10.stopped,
        gradedAfterDays: Math.round((Date.parse(`${onDate}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000),
      })
    }
  }
  return found
}

export async function main() {
  // WHICH CLOCK THIS WALK KEEPS (Stage 1c B3 — the line B2 left pinned here).
  //
  // B2's pin read: "the crypto lane is off in the walk until it has a spine",
  // because this harness sliced every tape on an EQUITY SESSION spine read off
  // SPY's calendar and two of the three pairs were not even in `.replay-cache`.
  // Both facts are now false. `--spine crypto` walks BTC-USD's own bars —
  // Saturdays and Sundays are ordinary sessions there — and the warm step below
  // fetches the pairs. So the pin becomes the house lever, with a default per
  // mode and a refusal for the combination that would lie (`resolveCryptoLever`).
  const spine = arg('spine', 'equity') as SpineKind
  if (spine !== 'equity' && spine !== 'crypto') throw new Error(`BLOCKED: --spine takes 'equity' or 'crypto' (got ${spine})`)
  const cryptoLever = resolveCryptoLever(spine, typeof process !== 'undefined' ? process.env?.CRYPTO : undefined)
  if (typeof process !== 'undefined' && process.env) process.env.CRYPTO = cryptoLever.value
  const cryptoOn = cryptoLever.value === 'on'
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
  // THE CRYPTO SPINE IS A VALIDATION INSTRUMENT, NOT A SEED PIPELINE AND NOT A
  // TREE COMPARISON. Each refusal is its own sentence because each is a
  // different mistake:
  //  · `--seed-out` — the committed seed is an EQUITY measurement swept over an
  //    equity universe with crypto filtered out, and it is emitted from a walk on
  //    the equity calendar. A seed measured over a spine with two extra days in
  //    seven would carry equity buckets nobody asked for. Deep-seeding crypto is
  //    a recorded follow-up with its own artefact; it is not this flag.
  //  · `--baseline` — the pre-Stage-1 worktree has no crypto lane, no crypto
  //    blob and no crypto module to load. A "baseline" on this spine would
  //    compare a tree against a clock it has never heard of.
  //  · `--plant-a` — it replants the EQUITY calibration every morning. On this
  //    spine the crypto rows are priced from the crypto blob, so an
  //    A-reachability claim read off such a run would be a claim about a cohort
  //    the planted evidence says nothing about.
  if (spine === 'crypto') {
    if (seedOut) throw new Error('BLOCKED: --seed-out on the crypto spine — the seed is an equity measurement on the equity calendar; crypto deep-seeding is its own artefact (recorded follow-up)')
    if (baseline) throw new Error('BLOCKED: --baseline on the crypto spine — the pre-Stage-1 tree has no crypto lane to walk')
    if (plantA) throw new Error('BLOCKED: --plant-a on the crypto spine — it plants the EQUITY calibration, which prices no crypto row')
  }
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
  // containment (1c A1): crypto is out of the walk universe in EVERY mode —
  // an unguarded baseline walk graded ETH against SPY for weeks.
  const baseUniverse = seedUniverse(askedUniverse)
  /** THE READER'S OWN WATCHLIST, replayed — `--watchlist BTC-USD,ETH-USD`
   * [stage 1c A2].
   *
   * The universe above is the walk's SCREEN; the watchlist is a different door
   * entirely, and it is the one production's crypto leak came through
   * (`starter.ts` ships BTC-USD/ETH-USD → `cfg.watchlist` → `addSource(sym,
   * 'watchlist')` at candidate priority 1, ahead of the roster and the sleeve).
   * `seedUniverse` cannot reach it — a watchlist name is fetched by symbol at the
   * door, not drawn from the screened list — so a walk that only strips the
   * universe proves nothing about the door the leak actually used.
   *
   * This flag exists so the containment claim can be made the way every claim
   * since 3a has been made: run the same window twice, once with the door
   * carrying coins and once without, and diff. NOT crypto-specific — it takes any
   * symbols — because a seam that only accepts the thing under test is a seam
   * that can only ever confirm it. Empty (the default) is byte-for-byte the
   * walk that shipped before this line. */
  const watchlistRaw = process.argv.includes('--watchlist') ? arg('watchlist', '') : null
  if (watchlistRaw === '' || watchlistRaw?.startsWith('--'))
    throw new Error(`BLOCKED: --watchlist needs a comma-separated list${watchlistRaw ? ` (got the next flag, ${watchlistRaw})` : ''}`)
  const watchlist = (watchlistRaw ?? '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(symbol => ({ symbol, category: isCryptoSymbol(symbol) ? 'Crypto' : 'Replay' }))
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
  // …and, on the crypto spine, THE THREE PAIRS — through this same cached path,
  // one 5y fetch each, cached on disk like every other tape (recon §8.4: ETH was
  // already here from the July walks; BTC and SOL have never been in any replay
  // universe or cache). BTC-USD is warmed whether or not the reader watchlisted
  // it and whether or not the lane is on: it is the SPINE's own series, so a run
  // that skipped it would have no days to walk. A pair Yahoo will not serve is
  // recorded MISSING exactly like an equity and the lane fails soft over it —
  // which is the SOL case specifically, since `stooq.ts` maps BTC and ETH only
  // and there is no fallback for it at all.
  const warm = [...new Set([...baseUniverse, 'SPY', 'QQQ', ...WORLD_TAPE_SYMS, ...(spine === 'crypto' ? [CRYPTO_REGIME_SYM_MIRROR, ...CRYPTO_UNIVERSE_MIRROR] : [])])]
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
  // THE SPINE. SPY's sessions, or — on the crypto clock — BTC-USD's own bars.
  // SPY is still fetched and still graded against on the equity side either way:
  // what the spine decides is which MORNINGS the walk simulates, not what an
  // equity row is measured with.
  let cryptoSpineRead: CryptoSpineRead | null = null
  let days: string[]
  if (spine === 'crypto') {
    const btcFull = await fullHistory(CRYPTO_REGIME_SYM_MIRROR)
    if (!btcFull) throw new Error(`BLOCKED: no ${CRYPTO_REGIME_SYM_MIRROR} tape — the crypto spine IS its bars, so there is no window to walk`)
    cryptoSpineRead = cryptoSpine(btcFull, from, to)
    days = cryptoSpineRead.days
  } else {
    days = tradingDays(spyFull, from, to)
  }
  if (limitDays) days = days.slice(0, limitDays)
  console.log(
    `${days.length} ${spine === 'crypto' ? 'crypto sessions' : 'trading days'}: ${days[0]} … ${days[days.length - 1]}` +
      (cryptoSpineRead
        ? ` · ${cryptoSpineRead.weekend} of them weekend days the equity spine cannot have` +
          (cryptoSpineRead.gaps.length ? ` · ⚠ ${cryptoSpineRead.gaps.length} MISSING crypto day(s) in the window: ${cryptoSpineRead.gaps.slice(0, 8).join(' ')}${cryptoSpineRead.gaps.length > 8 ? ' …' : ''}` : ' · no holes in the tape')
        : ''),
  )
  if (spine === 'crypto')
    console.log(
      `crypto lane: ${cryptoLever.value.toUpperCase()} (${cryptoLever.source}) — ${cryptoLever.why}` +
        ` · pairs warmed: ${CRYPTO_UNIVERSE_MIRROR.map(s => `${s}${missing.some(m => m.sym === s) ? '(MISSING)' : ''}`).join(' ')}`,
    )

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

  // …and Stage 3d's experiment slot, detected the same way. `WILDCARD=off` is the
  // lane's own seam and `REGRET=off` silences it too (a wildcard whose causal
  // write-back is dead is an experiment with no readout, wildcardLane.ts), so the
  // walk asks BOTH questions before it claims to be measuring the lane at all.
  const wildcardOff = process.env.WILDCARD === 'off' || regretOff || !existsSync(stageModule('wildcardLane.ts'))
  console.log(
    wildcardOff
      ? `wildcard: STUBBED (${process.env.WILDCARD === 'off' ? 'WILDCARD=off' : regretOff ? 'REGRET=off silences it' : 'pre-Stage-3d tree'}) — the lane-off arm of the controlled diff`
      : 'wildcard: present — the walk enforces the one-slot, shape and causal invariants over the window',
  )

  // …and the READER'S DOOR (stage 1c A2). Printed beside the other seams because
  // it is one: the containment arm of the crypto audit is a walk whose config
  // carries coins, and a reader of two logs must be able to tell the arms apart
  // without opening the artefacts.
  console.log(
    watchlist.length
      ? `watchlist: ${watchlist.map(w => w.symbol).join(', ')} — the reader's own door is open (${watchlist.filter(w => isCryptoSymbol(w.symbol)).length} crypto)`
      : 'watchlist: empty — the walk screens, nobody watches',
  )

  const { store } = makeStore()
  await store.write('config', {
    // `[]` unless `--watchlist` named names — the reader's own door, replayed.
    watchlist,
    rules: [],
    ytChannels: [],
    capital: 5000,
    // The routable-shorts mirror [fix wave]. It was `{}` until generation 4 was
    // measured, which made every short a pre-grade shadow and left the seed with
    // no sized short evidence at all. Both sides of any A/B comparison run this
    // same file, so a comparison stays a comparison — what changes is that the
    // walk can now SIZE a short, exactly as production can.
    levMap: LEVMAP_MIRROR,
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
  /** Every crypto row whose outcome has already been reported by an earlier
   * pass's census — the census reports each maturity ONCE, on the morning it
   * happened, which is what makes "sixteen days" a measurement rather than a
   * restatement of the final blob. */
  const cryptoMaturitySeen = new Set<string>()

  for (const date of days) {
    const t0 = Date.now()
    // Screen universe = sleeve ∪ the window's tickers ∪ whatever the roster has
    // earned so far. Rebuilt daily because the roster carries.
    const rosterSyms = ((await store.read<{ sym: string }[]>('engine-roster')) ?? []).map(e => e.sym)
    let universe = [...new Set([...baseUniverse, ...rosterSyms.map(s => s.toUpperCase())])]
    // The roster is built by this walk out of this universe, so it cannot introduce
    // a crypto name — but the filter is the seed's contract, not an inference about
    // where the roster came from, so it is applied where the universe is composed.
    universe = seedUniverse(universe) // every mode — containment (1c A1), not a seed nicety
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
    // …and THE CRYPTO ROWS THIS PASS JUST GRADED, on the same principle and for
    // the same reason: `gradeOutstanding` is the crypto grader too, and the pass
    // that books an outcome is the only witness to WHEN it matured. Every day
    // already published is re-read (an in-memory store, so this is free) and any
    // crypto row that now carries an outcome and did not before is reported
    // once, against the morning it published.
    const cryptoMatured = cryptoOn ? await maturedCryptoIn(store, out.map(d => d.date), cryptoMaturitySeen, date) : undefined
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
      ...(cryptoMatured ? { cryptoMatured } : {}),
    })
    if (regretEnforced) {
      // the ledger's claims, settled against the walk's OWN record of the window:
      // the traces it captured and the sizes the reader was actually given.
      // …with SPY's own series handed in, because the ledger's clock is SPY's:
      // on the crypto spine several walk days share one session and only the
      // earliest is ever selectable (`priceableTraceDates`). On the equity spine
      // the two lists are identical and this argument changes nothing.
      const violations = [...accrualViolations, ...missLedgerViolations(missLedgerNow, regretContextOf(out, spyFull))]
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
  // …and A CRYPTO ROW IS RECOMPUTED ON ITS OWN BASIS, never against SPY. The
  // harness's diagnostic grade is the one surface that could have re-introduced
  // Phase A's leak inside the artefact itself: `gradePrediction(pred, cs, spy, 10)`
  // is the SPY-benchmarked equity grader over ten equity sessions, and handing it
  // a coin is exactly what the twelve ETH rows in the last pre-A1 walk were. So a
  // row stamped `cohort: 'crypto'` is graded by `gradeCryptoPrediction` over the
  // crypto horizons (7 / 14 bars), on the COMPLETED tape — the partial bar Yahoo
  // is still writing today is cut at the same seam the engine cuts it at, so the
  // diagnostic and the engine's own stored outcome are commensurable.
  //
  // Dynamically imported behind the on-disk guard, like the dip and velocity
  // lanes: this file still has to load in the pre-Stage-1 worktree, where the
  // module does not exist.
  const cryptoGrader =
    cryptoOn && existsSync(stageModule('cryptoCalibration.ts'))
      ? ((await import('../shared/engine/cryptoCalibration')) as {
          completedCryptoBars: (candles: Candle[], nowSec: number) => Candle[]
          gradeCryptoPrediction: (
            pred: { date: string; side: 'long' | 'short'; priceAtPrediction: number; stop: number },
            candles: Candle[],
            horizon: number,
          ) => { hit: boolean; excessPct: number; stopped: boolean } | null
        })
      : null
  // The cut is the RUN's own UTC day, not the window's end: this pass grades
  // against the full untruncated tape on purpose (it reports outcomes the walk
  // itself never lived to see), and the only bar that must not be in it is the
  // one still being written.
  const nowRunSec = Math.floor(Date.now() / 1000)
  for (const day of out) {
    for (const r of [...day.board, ...day.ledger]) {
      const cs = await fullHistory(r.sym)
      if (!cs) continue
      const pred = { date: day.date, side: r.side, priceAtPrediction: r.entry, stop: r.stop }
      if (cryptoGrader && r.cohort === 'crypto') {
        const tape = cryptoGrader.completedCryptoBars(cs, nowRunSec)
        const c7 = cryptoGrader.gradeCryptoPrediction(pred, tape, CRYPTO_HORIZONS_MIRROR[0])
        const c14 = cryptoGrader.gradeCryptoPrediction(pred, tape, CRYPTO_HORIZONS_MIRROR[1])
        r.outcome5 = c7 ? { hit: c7.hit, excessPct: c7.excessPct, stopped: c7.stopped } : null
        r.outcome10 = c14 ? { hit: c14.hit, excessPct: c14.excessPct, stopped: c14.stopped } : null
        continue
      }
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
        // …and the EXPERIMENT'S RECEIPT, for exactly the reason the two above are
        // re-read here: `rowOf` snapshots the row the morning it published, and
        // `wildcard.booked` is stamped ELEVEN sessions later by the pass that
        // grades it. A snapshot can only ever say `undefined`, so the harness must
        // take the record as the blob finally holds it or it would be checking the
        // receipt against the moment before there was anything to receipt.
        const rec = (p as { wildcard?: WildcardRecordLike }).wildcard
        if (rec) r.wildcard = rec
      }
      // THE MORNING THE ENGINE GRADED THESE ROWS, and therefore the exact tape its
      // classifier held: a pass on walk day k sees bars strictly before day k, so a
      // row published on walk day i is first gradeable at 10 sessions when
      // i + 10 <= k - 1 — that is, on walk day i + 11. Re-classifying against any
      // other tape would compare the engine's answer with a question it never asked.
      // …counted in SPY SESSIONS and expressed in the spine's own days
      // (`gradedOnDate`), because "walk day i + 11" is only the same statement
      // when one walk day is one session. On the crypto spine eleven sessions is
      // fifteen calendar days, and a re-derivation handed a tape four days short
      // cannot find the session the engine's own detail line names.
      const gradedOn = gradedOnDate(days, spyFull, i)
      for (const p of preds) {
        // THE CENSUS IS THE EQUITY CLASSIFIER'S REPORT CARD, so the population is
        // the one the classifier is allowed to read: a crypto row is excluded
        // from the post-mortem at the accrual (engine.ts's `!cryptoRow`), so
        // counting it here would book it as a loser the classifier failed to
        // explain and quietly move `graded`, `losers` and the hit denominators
        // of an instrument the partition is not part of.
        if ((p as { cohort?: string }).cohort === 'crypto') continue
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

  // ---- 🃏 THE EXPERIMENT SLOT, over the window (stage 3d task 3) ----
  // Enforced HERE and not per day, for the same reason the post-mortems are: the
  // causal write-back and the receipt are stamped eleven sessions after the row
  // published, so a day-D snapshot structurally cannot carry them. These are the
  // final blobs and the rows as they finally stand. `WILDCARD=off` (the parity
  // arm) publishes none, so the census is empty and every check passes vacuously —
  // an absence, not a zero.
  let wildcards: WildcardTaken[] = []
  if (!wildcardOff) {
    wildcards = wildcardCensus(out)
    const violations = wildcardViolations(out, missLedgerFinal)
    if (violations.length)
      throw new Error(
        `BLOCKED: the experiment slot broke its own contract — ${violations.length} violation(s):\n  ` +
          `${violations.slice(0, 25).join('\n  ')}${violations.length > 25 ? `\n  …and ${violations.length - 25} more` : ''}`,
      )
    console.log(
      `wildcard: ${wildcards.length} experiment(s) in ${days.length} sessions` +
        (wildcards.length
          ? ` — ${wildcards
              .map(w => `${w.date} ${w.sym} ${w.side} p${w.priority} ${w.gate}[n=${w.gateEvidenceN}]${w.paperOnly ? ' (paper)' : ''} ${w.outcome ? (w.outcome.hit ? `HIT +${w.outcome.excessPct}pp` : `miss ${w.outcome.excessPct}pp`) : 'open'}`)
              .join(' · ')}`
          : ' — the slot went unspent'),
    )
  }

  // ---- ₿ THE CRYPTO LANE, over the window (Stage 1c B3) ----
  // A summary of what the lane did and what its clock cost, printed beside the
  // other lanes' lines so two logs can be told apart without opening the files.
  if (cryptoOn) {
    const matured = out.flatMap(d => (d.cryptoMatured ?? []).map(m => ({ ...m, on: d.date })))
    const rows = out.flatMap(d => [...d.board, ...d.ledger].filter(r => r.cohort === 'crypto'))
    const lags = [...new Set(matured.map(m => m.gradedAfterDays))].sort((a, b) => a - b)
    console.log(
      `crypto: ${rows.length} row(s) over ${days.length} crypto sessions · ` +
        `${matured.length} matured on the crypto clock` +
        (matured.length ? ` (${lags.join('/')} calendar days publication→grade; the clock says ${CRYPTO_PUBLISH_TO_GRADE_DAYS})` : '') +
        ` · grades ${Object.entries(rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.grade ?? 'null']: (a[r.grade ?? 'null'] ?? 0) + 1 }), {}))
          .sort()
          .map(([g, n]) => `${g}:${n}`)
          .join(' ')}`,
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
  // …and the honesty pane (Stage 3d): three of its four roll-ups carry the
  // experiment slot's separability, so the controlled diff has to be able to read
  // them rather than take the engine's word for the split.
  const scorecardFinal = (await store.read<ScorecardLike>('engine-scorecard')) ?? null
  // ---- the crypto spine's own three reads (Stage 1c B3) ----
  // ALL FOUR FIELDS BELOW ARE SPREAD, not written: on the equity spine the
  // artefact this harness produces is byte-identical to the one it produced
  // before B3, which is the guarantee that lets the lane ship without re-running
  // three stages of evidence. On the crypto spine they are present in BOTH arms
  // — the lane-off arm needs them too, or the controlled diff would be comparing
  // files of different shape.
  //
  //  · `weightsFinal` — the sixth equity blob. The other five are already here;
  //    this one has never been read out of a window walk (only out of `--seed-out`)
  //    and B3's whole claim is that NOT ONE equity blob byte moves when the lane
  //    runs. A claim over five of six blobs is not the claim.
  //  · the crypto partition's own two, beside the equity ones and never inside
  //    them, exactly as the engine writes them.
  const weightsFinal = spine === 'crypto' ? await store.read<WeightsState>('engine-weights') : null
  const cryptoCalibrationFinal = spine === 'crypto' ? await store.read<CalibrationState>(CRYPTO_CALIB_KEY_MIRROR) : null
  const cryptoRiskFinal = spine === 'crypto' ? await store.read<unknown>(CRYPTO_RISK_KEY_MIRROR) : null
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
        // …and the OTHER door (stage 1c A2): the symbols `--watchlist` put in
        // front of `addSource`, so an artefact says which arm of the containment
        // diff it is instead of leaving the reader to infer it from the log.
        watchlist: watchlist.map(w => w.symbol),
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
        scorecardFinal,
        // …and the window's experiments, in walk order (Stage 3d). Derivable from
        // `days` — `wildcardCensus` does exactly that — and carried anyway,
        // because it is the table the ship evidence is written from and a reader
        // of this file should not have to reconstruct the day's one deliberate
        // override by grepping a catalyst kind out of 800 rows.
        wildcards,
        // …and the CLOCK this walk kept, with the lever's own state and the
        // spine's holes (Stage 1c B3). Present only on the crypto spine, for the
        // reason above — and present in both of its arms, so a reader of two
        // files can tell which tree each one walked without opening the log.
        ...(spine === 'crypto'
          ? {
              spine,
              crypto: cryptoLever.value,
              cryptoSpine: { days: days.length, weekend: cryptoSpineRead?.weekend ?? 0, gaps: cryptoSpineRead?.gaps ?? [] },
              weightsFinal,
              cryptoCalibrationFinal,
              cryptoRiskFinal,
            }
          : {}),
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
  /** Stage 3c — the gates as feedback left them. Null on `GATES=off` and on any
   * window whose evidence never reached the eligibility bar. */
  gateStateFinal?: unknown
  /** THE HONESTY PANE as the window left it (`engine-scorecard`). Carried since
   * Stage 3d because three of the four panes answer a SEPARABILITY question about
   * the experiment slot — its own `byGrade` key, its exclusion from `byRegime`,
   * its inclusion in `bySetup` — and a controlled diff that could not read them
   * would be asserting the separation instead of measuring it. */
  scorecardFinal?: ScorecardLike | null
  /** THE WINDOW'S EXPERIMENTS (Stage 3d), in walk order. Empty on a lane-off arm
   * and absent in any tree older than the slot. */
  wildcards?: WildcardTaken[]
  /** Stage 1c B3 — the clock this walk kept, and the crypto partition's own two
   * blobs beside the equity six. Absent on every equity-spine run, which is what
   * keeps those artefacts byte-identical to the ones that shipped before B3. */
  spine?: SpineKind
  crypto?: 'on' | 'off'
  cryptoSpine?: { days: number; weekend: number; gaps: string[] }
  /** the sixth equity blob, carried so "not one equity blob byte moved" can be a
   * measurement over all six rather than over the five that happened to be here */
  weightsFinal?: WeightsState | null
  cryptoCalibrationFinal?: CalibrationState | null
  cryptoRiskFinal?: unknown
}

/** engine.ts's `engine-scorecard` blob, structurally (the mirror rule again). */
export interface ScorecardLike {
  byGrade: Record<string, { n: number; hits: number; sumExcess: number }>
  byRegime: Record<string, { n: number; hits: number }>
  bySetup: Record<string, { n: number; hits: number; sumExcess: number }>
  byPostMortem: Record<string, number>
  totalGraded: number
  lifetime?: { live: { graded: number; hits: number }; shadow: { graded: number; hits: number } }
  brierTail?: { date: string; mean: number; n: number }[]
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

// ------------------------------------------- the controlled diff (stage 3c) --
//
// THE BATCH'S SHIP EVIDENCE. Stage 3c changes published numbers BY DESIGN, so the
// acceptance gate cannot be "nothing moved" — it is "everything that moved has a
// name, computed rather than asserted". Two arms of the SAME binary over the SAME
// window with the SAME dependencies (one levMap mirror, gates off on both, regret
// on both) differ in exactly one thing: whether the calibration blob they were
// handed carries the partition's sub-counts. By the byte-identity pins a blob
// without them reads exactly as the pre-3c tree read — no partition, no blend —
// so the reference arm IS the shipped 3b behaviour, on this batch's own evidence.

/** WHY A ROW MOVED. The first three are the stage's own mechanisms and are the
 * only ones that change BEHAVIOUR; the last two are second-order and admitted
 * only against a proven first-order cause (see `classifyDiff`). */
export type DiffCause =
  /** the row's sized read differs from its pooled one — the provenance partition */
  | 'partition'
  /** the family's isotonic curve moved the price — the setup blend */
  | 'blend'
  /** the row's own |composite| moved: the IC nudge loop, reading two arms' worth of
   * slightly different observations. Sanctioned by the plan's brakes (bounded
   * per-factor weights, the minDisagree floor) and BOUNDED here — the histogram
   * reports the largest move it saw, so a loop that slipped its bands is visible. */
  | 'weights-loop'
  /** SECOND ORDER — no mechanism on this row: the POOLED curve underneath it has
   * moved, so the two arms are reading different evidence. Two things do that, and
   * the count means different things under each: the arms were handed different
   * SEEDS (a generation swap — the evidence itself is the change, already measured
   * by its own payoff gate), or they published different boards on earlier days and
   * booked different outcomes into the same buckets. Admitted only when a
   * first-order cause exists on this date or an earlier one. */
  | 'curve-drift'
  /** SECOND ORDER — no read-side movement at all: this row differs because another
   * row on the SAME DAY did (the risk budget is shared, slots compete, the ladder
   * rung multiplies every size). Admitted only when a first-order cause exists on
   * that same date. */
  | 'board-echo'
  /** nothing above explains it. The walk fails loudly. */
  | 'unclassified'

export const DIFF_CAUSES: DiffCause[] = ['partition', 'blend', 'weights-loop', 'curve-drift', 'board-echo', 'unclassified']

/** The four movements a row's price can be decomposed into, all in probability
 * points and all signed new-minus-reference. `partition` and `blend` are each
 * arm's OWN mechanism contribution differenced, not a re-derivation: a reference
 * arm that had begun to partition mid-window shows up here as a smaller
 * difference rather than as a hidden one. */
export interface DiffTerms {
  /** |composite| moved — the read's INPUT, upstream of every curve */
  composite: number
  /** (pSized − pPooled) new, minus the same in the reference */
  partition: number
  /** (pRaw − pSized) new, minus the same in the reference */
  blend: number
  /** pPooled new − pPooled reference: the shared curve's own drift */
  curve: number
  /** observations straddling the read — the mass `gradeFor` prices an A or B on */
  nEff: number
}

export interface RowDiff {
  key: string
  cause: DiffCause
  /** which of the three published numbers moved */
  fields: ('grade' | 'riskPct' | 'probability')[]
  grade: string | null
  risk: string | null
  probability: string | null
  terms: DiffTerms
  why: string
}

export interface ClassifiedDiff {
  /** keys present in BOTH arms — the population the attribution is made over */
  shared: number
  changed: RowDiff[]
  histogram: Record<DiffCause, number>
  unclassified: RowDiff[]
  /** Rows the new arm published and the reference did not, and the reverse. Outside
   * a matched-key diff by construction; reported because a diff that silently
   * dropped them would be measuring a population it chose. */
  newOnly: string[]
  refOnly: string[]
  /** THE ARM AUDIT. How many REFERENCE rows show any partition (`pSized ≠ pPooled`)
   * or any blend (`pRaw ≠ pSized`) at all — i.e. how far the reference arm drifted
   * away from pre-3c behaviour by accruing sub-counts of its own during the window.
   * Zero is a perfect arm; the number is published either way. */
  refPartitioned: number
  refBlended: number
  /** the largest |Δ|composite|| seen — the weights loop's own bound, measured */
  maxCompositeMove: number
}

const EPS = 1e-9

/** The three reads a row carries, feature-detected.
 *
 * A ROW FROM A PRE-3c TREE CARRIES ONLY `pRaw`, AND THAT IS NOT A GAP: before the
 * partition and the blend existed, this harness's recomputation WAS the pooled,
 * unblended read (see `enrichFromCalibration`'s own note). So such a row's two
 * counterfactuals are its own read — the arm contributed zero from both mechanisms
 * because it HAD neither, which is exactly what a reference arm is for. Detected on
 * the row rather than from the file's commit, the same way the enrichment detects
 * the tree it is running in.
 *
 * `null` = no read path at all (a near miss, or a pre-stage-2 tree) — a row that
 * cannot be decomposed and must not be quietly credited to a mechanism. */
const readsOf = (r: Keyed): { pooled: number; sized: number; shipped: number } | null =>
  r.pRaw == null ? null : { pooled: r.pPooled ?? r.pRaw, sized: r.pSized ?? r.pRaw, shipped: r.pRaw }

/** MATCHED-KEY, PER-ROW ATTRIBUTION over `{grade, riskPct, probability}`.
 *
 * Pure — two arrays of rows in, the histogram and the failures out — so the
 * arithmetic is pinned in the unit test rather than in a replay.
 *
 * The order of the tests is causal, not cosmetic. A moved |composite| is upstream
 * of every curve in this engine, so it is named first and the read-side terms below
 * it are reported but not credited; the two mechanisms come next, largest
 * contribution first; the shared curve's own drift after them; and a row with no
 * read-side movement whatsoever is a board effect, not a pricing one.
 *
 * THE SECOND-ORDER CLASSES CARRY A CONDITION, which is what keeps them from being
 * a place to put anything awkward. `board-echo` is admitted only if some other row
 * on the SAME DATE carries a first-order cause (the risk budget is shared within a
 * day and nowhere else); `curve-drift` only if a first-order cause exists on that
 * date or an earlier one (a bucket cannot drift before something changed what was
 * booked into it). Fail those conditions and the row is `unclassified` — which is
 * the whole point of the exercise. */
export function classifyDiff(ref: Keyed[], neu: Keyed[]): ClassifiedDiff {
  const R = new Map(ref.map(r => [keyOf(r), r]))
  const N = new Map(neu.map(r => [keyOf(r), r]))
  const shared = [...N.keys()].filter(k => R.has(k)).sort()
  const changed: RowDiff[] = []
  let refPartitioned = 0
  let refBlended = 0
  let maxCompositeMove = 0
  for (const r of R.values()) {
    const reads = readsOf(r)
    if (!reads) continue
    if (Math.abs(reads.sized - reads.pooled) > EPS) refPartitioned++
    if (Math.abs(reads.shipped - reads.sized) > EPS) refBlended++
  }
  for (const key of shared) {
    const a = R.get(key)!
    const b = N.get(key)!
    const fields: RowDiff['fields'] = []
    if (a.grade !== b.grade) fields.push('grade')
    if (a.riskPct !== b.riskPct) fields.push('riskPct')
    if (a.probability !== b.probability) fields.push('probability')
    const dComposite = Math.abs(b.composite) - Math.abs(a.composite)
    if (Math.abs(dComposite) > Math.abs(maxCompositeMove)) maxCompositeMove = dComposite
    if (!fields.length) continue
    const ra = readsOf(a)
    const rb = readsOf(b)
    const enriched = ra != null && rb != null
    const terms: DiffTerms = {
      composite: dComposite,
      partition: enriched ? rb.sized - rb.pooled - (ra.sized - ra.pooled) : 0,
      blend: enriched ? rb.shipped - rb.sized - (ra.shipped - ra.sized) : 0,
      curve: enriched ? rb.pooled - ra.pooled : 0,
      nEff: (b.nEff ?? 0) - (a.nEff ?? 0),
    }
    const row: RowDiff = {
      key,
      cause: 'unclassified',
      fields,
      grade: a.grade === b.grade ? null : `${a.grade}→${b.grade}`,
      risk: a.riskPct === b.riskPct ? null : `${a.riskPct}→${b.riskPct}`,
      probability: a.probability === b.probability ? null : `${a.probability}→${b.probability}`,
      terms,
      why: '',
    }
    if (Math.abs(dComposite) > EPS) {
      row.cause = 'weights-loop'
      row.why = `|composite| ${a.composite.toFixed(2)} → ${b.composite.toFixed(2)}`
    } else if (!enriched) {
      // A near miss is never enriched (it went through no read path), and neither is
      // any row from a pre-stage-2 tree. Either way there is no decomposition to
      // make, and a row that changed without one has not been explained.
      row.cause = 'unclassified'
      row.why = 'the row carries no read decomposition (a near miss, or a tree older than the instrument)'
    } else {
      const magnitude = Math.max(Math.abs(terms.partition), Math.abs(terms.blend), Math.abs(terms.curve))
      if (magnitude <= EPS) {
        // The price did not move at all. Either the partition changed the evidence
        // MASS without changing the value it read (nEff feeds the grade directly),
        // or nothing on this row's own read moved and the difference came from the
        // day around it.
        if (terms.nEff !== 0 && b.accrual === 'sized') {
          row.cause = 'partition'
          row.why = `same price, ${a.nEff} → ${b.nEff} observations — the sized slice is a different mass`
        } else {
          row.cause = 'board-echo'
          row.why = 'identical read on this row — the day around it differs'
        }
      } else if (Math.abs(terms.blend) === magnitude) {
        row.cause = 'blend'
        row.why = `the family moved p by ${(terms.blend * 100).toFixed(2)}pp`
      } else if (Math.abs(terms.partition) === magnitude) {
        row.cause = 'partition'
        row.why = `the sized read moved p by ${(terms.partition * 100).toFixed(2)}pp (nEff ${a.nEff} → ${b.nEff})`
      } else {
        row.cause = 'curve-drift'
        row.why = `the pooled curve itself moved ${(terms.curve * 100).toFixed(2)}pp under this read`
      }
    }
    changed.push(row)
  }
  // …and now the two second-order classes must answer for themselves.
  const dateOf = (k: string): string => k.split(':')[0] ?? ''
  const firstOrder = new Set(changed.filter(c => c.cause === 'partition' || c.cause === 'blend' || c.cause === 'weights-loop').map(c => dateOf(c.key)))
  const firstOrderDates = [...firstOrder].sort()
  for (const c of changed) {
    if (c.cause === 'board-echo' && !firstOrder.has(dateOf(c.key))) {
      c.cause = 'unclassified'
      c.why = `${c.why} — and NOTHING on ${dateOf(c.key)} carries a sanctioned cause`
    }
    if (c.cause === 'curve-drift' && !firstOrderDates.some(d => d <= dateOf(c.key))) {
      c.cause = 'unclassified'
      c.why = `${c.why} — and no sanctioned cause exists on or before ${dateOf(c.key)}`
    }
  }
  const histogram = Object.fromEntries(DIFF_CAUSES.map(c => [c, changed.filter(x => x.cause === c).length])) as Record<DiffCause, number>
  return {
    shared: shared.length,
    changed,
    histogram,
    unclassified: changed.filter(c => c.cause === 'unclassified'),
    newOnly: [...N.keys()].filter(k => !R.has(k)).sort(),
    refOnly: [...R.keys()].filter(k => !N.has(k)).sort(),
    refPartitioned,
    refBlended,
    maxCompositeMove,
  }
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
 *     pooled one. This is the half that matters: a blended read is a SECOND curve
 *     mixed into the first, and it is the half that has actually failed here — the
 *     family read was a band step until the task-4 fix wave, and the step put 11
 *     downward jumps into the published curve that the ladder underneath was
 *     innocent of. A probe that never passed a setup would sweep a curve no reader
 *     is ever shown and call the gate passed. */
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
  /** Rows carrying a ROUTED instrument anywhere in the window. MEASURED rather
   * than assumed, which is the point: it was zero for as long as the harness ran
   * an empty `levMap`, and with `LEVMAP_MIRROR` it is whatever the window actually
   * routed — so the census can say from the data whether the eligibility number
   * above is a counterfactual or a loss someone took. */
  routedRowsInWindow: number
}

/** What the born-below cap cost, counted two ways that must not be conflated: the
 * grades it demoted, and the LEVERAGE those demotions withheld. The second is a
 * counterfactual for every row on a name the mirror does not carry — no route, no
 * instrument to lose. What the census CAN measure honestly is eligibility: a row
 * that would have been a full-tier A/B at its rung is a row an equipped levMap
 * would have levered; `routedRowsInWindow` then says how many were. */
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
  console.log(`  …rows carrying an ACTUALLY ROUTED instrument anywhere in the window: ${census.routedRowsInWindow} (only LEVMAP_MIRROR names can route; for every other name the line above is a counterfactual)`)

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

// ---------------------------------------- main: the controlled diff (3c t5) --
//
//   npx tsx scripts/replay-window.ts --classify --ref /tmp/acc-pre3c.json --new /tmp/acc-gen4.json
//
// SIXTH MODE. Pure counters again — it opens no store and asks no engine anything
// except the gate arithmetic, which is imported dynamically so this file still
// runs in the pre-Stage-1 baseline worktree (gateState.ts does not exist there).
//
// It prints three things and one verdict: the classified per-row histogram over
// every matched board and ledger row, the ARM AUDIT (how faithfully the reference
// arm reproduced pre-3c behaviour), and — off the new run's own miss ledger — the
// gate-eligibility readout, which is the first time that arithmetic has been asked
// of live-shaped data with the gates armed. The verdict is `unclassified === 0`.
async function classifyMain(): Promise<void> {
  const refPath = arg('ref', '')
  const newPath = arg('new', '')
  if (!refPath || refPath.startsWith('--') || !newPath || newPath.startsWith('--'))
    throw new Error('BLOCKED: --classify needs --ref <run.json> (the pre-3c arm) and --new <run.json> (the shipped arm)')
  const ref = JSON.parse(readFileSync(refPath, 'utf8')) as RunFile
  const neu = JSON.parse(readFileSync(newPath, 'utf8')) as RunFile
  console.log(`controlled diff: ref=${refPath} (${ref.commit}) vs new=${newPath} (${neu.commit}) · ${ref.from}..${ref.to}`)

  const per = (['board', 'ledger'] as const).map(where => ({ where, d: classifyDiff(flatten(ref, where), flatten(neu, where)) }))
  const total = Object.fromEntries(DIFF_CAUSES.map(c => [c, per.reduce((s, p) => s + p.d.histogram[c], 0)])) as Record<DiffCause, number>
  for (const { where, d } of per) {
    console.log(
      `\n${where}: ${d.shared} matched keys · ${d.changed.length} changed · ${d.newOnly.length} new-only · ${d.refOnly.length} ref-only\n` +
        `  ${DIFF_CAUSES.map(c => `${c} ${d.histogram[c]}`).join(' · ')}`,
    )
    console.log(`  arm audit — reference rows showing a partition: ${d.refPartitioned} · showing a blend: ${d.refBlended} · largest |composite| move: ${d.maxCompositeMove.toFixed(4)}`)
    for (const c of DIFF_CAUSES.filter(x => x !== 'unclassified')) {
      const ex = d.changed.filter(x => x.cause === c).slice(0, 3)
      for (const e of ex) console.log(`    [${c}] ${e.key} ${[e.grade, e.risk, e.probability].filter(Boolean).join(' · ')} — ${e.why}`)
    }
    const gradeMoves = d.changed.filter(x => x.grade)
    console.log(`  grade changes: ${gradeMoves.length}${gradeMoves.length ? ` — ${gradeMoves.map(g => `${g.key} ${g.grade} [${g.cause}]`).join(' · ')}` : ''}`)
    for (const u of d.unclassified) console.log(`  UNCLASSIFIED ${u.key} ${[u.grade, u.risk, u.probability].filter(Boolean).join(' · ')} — ${u.why}`)
  }
  console.log(`\nTOTAL — ${DIFF_CAUSES.map(c => `${c} ${total[c]}`).join(' · ')}`)
  const rung = (r: RunFile): unknown => (r.riskFinal as { rung?: number } | null | undefined)?.rung ?? null
  console.log(`risk ladder rung: ref ${rung(ref)} · new ${rung(neu)}${rung(ref) === rung(neu) ? '' : ' — EVERY size is multiplied differently'}`)

  // ---- the gate-eligibility readout, on live-shaped data ----
  // Every tunable gate is reported, including the ones with nothing to say: a gate
  // that has never been measured must be visible AS unmeasured rather than absent.
  if (neu.missLedgerFinal && existsSync(stageModule('gateState.ts'))) {
    const { gateEligibility, GATE_MIN_ATTRIBUTED, GATE_COST_RATIO } = await import('../shared/engine/gateState')
    const { gateAttribution } = await import('../shared/engine/missLedger')
    const attribution = gateAttribution(neu.missLedgerFinal)
    const byGate = new Map(attribution.map(a => [a.gate, a]))
    console.log(`\ngate eligibility — ${GATE_MIN_ATTRIBUTED} attributed outcomes minimum, cost > ${GATE_COST_RATIO}× saved to loosen (and the reverse to tighten)`)
    for (const e of gateEligibility(attribution)) {
      const a = byGate.get(e.source)
      const verdict = e.doubleBooked
        ? 'INELIGIBLE — double-booked (its outcomes already steer calibration; one event may not move two levers)'
        : e.n === 0
          ? 'INELIGIBLE — unmeasured (and an unmeasured gate is not a costless one)'
          : e.n < GATE_MIN_ATTRIBUTED
            ? `INELIGIBLE — ${e.n} attributed outcomes, under the ${GATE_MIN_ATTRIBUTED} bar`
            : e.direction
              ? `ELIGIBLE — ${e.direction}`
              : `HELD — the ratio does not clear ${GATE_COST_RATIO}×`
      console.log(`  ${e.gate} (${e.source}): cost ${e.cost} · saved ${e.saved} · n ${e.n} · unpriced ${a?.unchecked ?? 0} — ${verdict}`)
    }
    // …and every OTHER gate the ledger attributed, with its markers. None of these
    // is tunable, so none can move — but a gate carrying the double-booked marker
    // or a pile of unpriced refusals is exactly what the hygiene rules exist for,
    // and a readout that showed only the three movable ones would hide them.
    const rest = attribution.filter(x => !gateEligibility(attribution).some(e => e.source === x.gate))
    console.log(`  not tunable, reported for hygiene: ${rest.map(x => `${x.gate} ${x.cost}/${x.saved}${x.doubleBooked ? ' [double-booked]' : ''}${x.unchecked ? ` [${x.unchecked} unpriced]` : ''}`).join(' · ')}`)
    console.log(`  gate-state after the window: ${JSON.stringify(neu.gateStateFinal ?? null)}`)
  }

  const failed = per.reduce((s, p) => s + p.d.unclassified.length, 0)
  console.log(`\nVERDICT: ${failed ? `BLOCKED — ${failed} changed row(s) with no name` : 'every changed row has a name'}`)
  if (failed) process.exitCode = 1
}

// ------------------------------- main: the wildcard controlled diff (3d t3) --
//
//   npx tsx scripts/replay-window.ts --wildcard-diff --ref /tmp/off.json --new /tmp/on.json
//
// SEVENTH MODE, and the ship gate for the experiment slot. Pure counters over two
// runs of ONE window — `WILDCARD=off` and the lane live, everything else held —
// asking the only question that matters about a lane that publishes rows: does it
// change anything it was not given? The verdict and the reasoning behind the split
// are at `wildcardControlledDiff`.
async function wildcardDiffMain(): Promise<void> {
  const refPath = arg('ref', '')
  const newPath = arg('new', '')
  if (!refPath || refPath.startsWith('--') || !newPath || newPath.startsWith('--'))
    throw new Error('BLOCKED: --wildcard-diff needs --ref <run.json> (WILDCARD=off) and --new <run.json> (the lane live)')
  const ref = JSON.parse(readFileSync(refPath, 'utf8')) as RunFile
  const neu = JSON.parse(readFileSync(newPath, 'utf8')) as RunFile
  console.log(`wildcard controlled diff: ref=${refPath} (${ref.commit}) vs new=${newPath} (${neu.commit}) · ${ref.from}..${ref.to}`)

  const census = neu.wildcards ?? wildcardCensus(neu.days)
  console.log(`\nTHE EXPERIMENTS — ${census.length} in ${neu.days.length} sessions`)
  for (const w of census)
    console.log(
      `  ${w.date} (session ${w.at + 1}) ${w.sym} ${w.side} · rung ${w.priority} · gate ${w.gate} (evidence n=${w.gateEvidenceN}) · ` +
        `core ${w.composite} · ${w.grade} p=${w.probability} · risk ${w.riskPct}%${w.paperOnly ? ' · PAPER (no quarter-size short route)' : ''}\n` +
        `      ${w.outcome ? `${w.outcome.hit ? 'HIT' : 'MISS'} ${w.outcome.excessPct >= 0 ? '+' : ''}${w.outcome.excessPct}pp${w.outcome.stopped ? ' (stopped)' : ''} · post-mortem '${w.postMortem}' · booked ${String(w.booked)}` : `still open at walk end (tape says ${w.tapeOutcome ? `${w.tapeOutcome.hit ? 'HIT' : 'MISS'} ${w.tapeOutcome.excessPct}pp` : 'nothing yet'})`}\n` +
        `      "${w.hypothesis}"`,
    )
  const gaps = census.slice(1).map((w, i) => w.at - census[i].at)
  console.log(
    `  cadence: ${gaps.length ? `${gaps.join(', ')} session(s) between experiments` : 'one experiment, no gap to measure'} · ` +
      `the slot releases at ${WILDCARD_SLOT_LOOKBACK + 1} sessions (lookback) and the horizon grades at ${POSTMORTEM_HORIZON_MIRROR + 1} — ` +
      `${WILDCARD_SLOT_LOOKBACK === POSTMORTEM_HORIZON_MIRROR ? 'the same session, so the slot is always released by the OUTCOME' : 'DIFFERENT sessions'}`,
  )

  const d = wildcardControlledDiff(ref, neu)
  console.log(
    `\nROWS — ${d.shared} matched keys · ${d.newOnly.length} lane-on only (${d.newOnly.filter(n => n.wildcard).length} experiments) · ` +
      `${d.refOnly.length} lane-off only (${d.refOnly.filter(r => r.displaced).length} near misses the experiment displaced) · ${d.replaced.length} replaced in place`,
  )
  for (const n of d.newOnly) console.log(`  + ${n.where} ${n.key}${n.wildcard ? ' — the experiment' : '  ⚠ NOT AN EXPERIMENT'}`)
  for (const r of d.refOnly) console.log(`  − ${r.where} ${r.key}${r.displaced ? ' — a near miss on the chart the experiment took' : '  ⚠ UNEXPLAINED REMOVAL'}`)
  console.log(
    `\nTHE ACCRUAL CHANNEL — first experiment outcome reaches the calibration on session ${d.firstAccrual == null ? 'never (none graded in-window)' : d.firstAccrual + 1}` +
      ` (${d.firstAccrual == null ? '—' : (neu.days[d.firstAccrual]?.date ?? '?')})`,
  )
  console.log(`  ordinary rows moved BEFORE it: ${d.early.length} — ${d.early.length ? 'THE LANE PERTURBED THE BOARD' : 'none, the seating changes nothing beside it'}`)
  console.log(`  ordinary rows moved AFTER it:  ${d.late.length} — the one observation the ratified design lets through`)
  console.log(`  fields moved: ${Object.entries(d.fields).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(' · ') || 'none'}`)
  for (const f of d.forbidden) console.log(`  ⚠ FORBIDDEN ${f.where} ${f.key} — ${f.fields.join(', ')}`)
  for (const u of d.unearned) console.log(`  ⚠ UNEARNED ${u.where} ${u.key} — ${u.fields.join(', ')} moved with no grade change behind it`)
  const gradeMoves = [...d.early, ...d.late].filter(x => x.fields.includes('grade'))
  console.log(`  grade changes: ${gradeMoves.length}${gradeMoves.length ? ` — ${gradeMoves.map(g => `${g.where} ${g.key}`).join(' · ')}` : ''}`)

  const s = wildcardSeparability(ref, neu)
  console.log('\nTHE SEPARABLE RECORDS')
  console.log(`  byGrade '🃏 wildcard': ${s.byGradeWildcard ? `n ${s.byGradeWildcard.n}, hits ${s.byGradeWildcard.hits}` : 'absent'} · letters moved: ${s.lettersMoved.join(', ') || 'none'}`)
  console.log(`  byRegime delta ${s.byRegimeDelta} (must be 0 — the live/skill pane) · bySetup delta ${s.bySetupDelta} (the shape pane counts it)`)
  console.log(`  byPostMortem delta: ${Object.entries(s.byPostMortemDelta).map(([k, n]) => `${k} ${n > 0 ? '+' : ''}${n}`).join(' · ') || 'none — a win is not one of the ways the engine loses'}`)
  console.log(`  lifetime delta ${s.lifetimeDelta} (must be 0) · Brier trail length delta ${s.brierLenDelta} (must be 0) · totalGraded delta ${s.totalGradedDelta}`)
  console.log(`  calibration buckets moved: ${s.buckets.map(b => `${b.key} n${b.nDelta >= 0 ? '+' : ''}${b.nDelta}/hits${b.hitsDelta >= 0 ? '+' : ''}${b.hitsDelta}/shadowN${b.shadowNDelta >= 0 ? '+' : ''}${b.shadowNDelta}`).join(' · ') || 'none'}`)
  console.log(`  evidence delta: seed ${s.evidenceDelta.seed} · live ${s.evidenceDelta.live} · shadow ${s.evidenceDelta.shadow}`)

  console.log('\nTHE CAUSAL COLUMN — and the substitution behind it')
  const led = wildcardLedgerDelta(ref, neu)
  for (const g of led.gates)
    console.log(
      `  ${g.gate}${g.visited ? ' (the slot tested it)' : ''}: causal ${g.causal ? `n ${g.causal.n} hits ${g.causal.hits}` : 'none'} · ` +
        `stopless cost ${g.costDelta >= 0 ? '+' : ''}${g.costDelta} saved ${g.savedDelta >= 0 ? '+' : ''}${g.savedDelta} · ` +
        `MOVABLE sidedCost ${g.sidedCostDelta >= 0 ? '+' : ''}${g.sidedCostDelta} sidedSaved ${g.sidedSavedDelta >= 0 ? '+' : ''}${g.sidedSavedDelta} · unpriced ${g.uncheckedDelta >= 0 ? '+' : ''}${g.uncheckedDelta}`,
    )
  for (const [gate, stat] of Object.entries(neu.missLedgerFinal?.gates ?? {}))
    for (const ex of stat.causal?.examples ?? []) console.log(`      ${gate} ← ${ex.date} ${ex.sym} ${ex.side} hit=${ex.hit} excess ${ex.excessPct}pp wildcard=${ex.wildcard}`)
  if (led.days.length)
    console.log(
      `  day accounting moved on ${led.days.length}: ${led.days.map(x => `${x.date} checked${x.checkedDelta >= 0 ? '+' : ''}${x.checkedDelta}/unpriced${x.uncheckedDelta >= 0 ? '+' : ''}${x.uncheckedDelta}/misses${x.missesDelta >= 0 ? '+' : ''}${x.missesDelta}`).join(' · ')}`,
    )
  // A gate the slot never went near may not move its stopless population at all.
  // (`unchecked` is exempt and says why in the readout: the miss walk's 40-fetch
  // budget counts a name already in the candle cache as free, and the experiment's
  // own grading warms one, so the budget can reach one refusal further. That makes
  // the ledger more complete on that day, never less, and moves no gate's verdict.)
  const strayed = led.gates.filter(g => !g.visited && (g.costDelta || g.savedDelta || g.sidedCostDelta || g.sidedSavedDelta))
  for (const g of strayed) console.log(`  ⚠ ${g.gate} moved and the slot never tested it`)

  const invariants = wildcardViolations(neu.days, neu.missLedgerFinal)
  for (const x of invariants) console.log(`  ⚠ ${x}`)
  const ok = d.passed && !invariants.length && !strayed.length && s.byRegimeDelta === 0 && s.lifetimeDelta === 0 && s.brierLenDelta === 0
  console.log(`\nVERDICT: ${ok ? 'the experiment slot is separable — every difference is the experiment, its causal entry, its own records, or the accrual the design ratified' : 'BLOCKED — see the flags above'}`)
  if (!ok) process.exitCode = 1
}

// Importable for the unit test (vitest sets VITEST); executed as a script otherwise.
if (!process.env.VITEST)
  await (process.argv.includes('--velocity-probe')
    ? probeMain()
    : process.argv.includes('--aggregate')
      ? aggregateMain()
      : process.argv.includes('--classify')
        ? classifyMain()
        : process.argv.includes('--wildcard-diff')
          ? wildcardDiffMain()
          : main())
