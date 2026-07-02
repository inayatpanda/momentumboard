# Prediction Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic multi-factor prediction engine with a self-improving calibration loop, feeding the daily paper scored trade calls instead of LLM guesses.

**Architecture:** Pure scoring/learning modules in `shared/engine/` (factors → composite → calibration → risk ladder → roster), orchestrated by a new `predict-background` Netlify function that grades yesterday before predicting today; the compose pipeline consumes the board and may only narrate it. State lives in Netlify Blobs; a backtest script pre-seeds weights from real candle history.

**Tech Stack:** TypeScript, vitest, Netlify functions + Blobs, Yahoo chart/screener + Finnhub free tier (existing fetchers).

## Global Constraints

- Free tier only: Yahoo chart proxy for candles, Finnhub free endpoints, headline RSS. No new paid services, no new dependencies.
- Nothing published anywhere new; no deploys inside this plan (user deploys batched via CLI per their preference).
- Never treat missing data as zero: a factor with no data returns `score: null` and its weight renormalises away.
- All Blobs bounded: predictions-index 250 dates, weights history 100, brier 250, channel recent 200/channel, risk history 50, roster 80.
- Dates: ISO `YYYY-MM-DD` computed in Europe/London; maturity measured in trading sessions via candle indices, never calendar days.
- Repo idiom: compact code, sibling `*.test.ts`, comments only for constraints code can't show.
- Run tests with `npx vitest run <file>`; full suite `npm test` must stay green at every commit.

---

### Task 1: Engine types + factor functions

**Files:**
- Create: `shared/engine/types.ts`
- Create: `shared/engine/factors.ts`
- Test: `shared/engine/factors.test.ts`

**Interfaces:**
- Consumes: `TechnicalRead` from `shared/technicals.ts`, `SeasonalitySummary` from `shared/seasonality.ts`.
- Produces (used by Tasks 2, 8, 9):

```ts
// shared/engine/types.ts
import type { RegimeColor } from '../types'

export type FactorName = 'technical' | 'momentum' | 'sector' | 'social' | 'channels' | 'insiders' | 'news' | 'seasonality'

export interface FactorScore {
  score: number | null // signed −100..+100 toward LONG; null = no data (weight renormalises)
  detail: string
}

export interface EngineCall {
  sym: string
  side: 'long' | 'short'
  composite: number // signed; |x| is conviction
  factors: Record<FactorName, FactorScore & { weight: number }>
  expectedMovePct: number
  entry: number
  stop: number
  target: number
  capacityPct: number
  smallCap: boolean
  earningsRisk: boolean
  stage: string | null
  note: string
}

export interface GradedCall extends EngineCall {
  probability: number // 0..1 calibrated
  provisional: boolean
  grade: 'A' | 'B' | 'C'
  riskRung: number
  riskPct: number // suggested % of capital at risk
  instrument: { ticker: string; leverage: number } | null
  paperOnly: boolean // true when a short has no executable mapping at this rung
}

export interface PredOutcome {
  excessPct: number // side-adjusted, vs SPY same window
  rawPct: number
  spyPct: number
  stopped: boolean
  hit: boolean
}

export interface Prediction extends GradedCall {
  id: string // `${date}:${sym}:${side}`
  date: string
  regime: RegimeColor | 'unknown'
  priceAtPrediction: number
  overlay?: { flag: 'boost' | 'caution' | 'veto'; reason: string }
  outcome5?: PredOutcome
  outcome10?: PredOutcome
}
```

Factor signatures (all pure):

```ts
// shared/engine/factors.ts
export function technicalFactor(read: { stage: Stage; volumeConfirmed: boolean; rvol: number | null } | null): FactorScore
export function momentumFactor(closes: number[] | null, spyCloses: number[] | null): FactorScore // 21d RS vs SPY, clamp(rs*4, ±80)
export function sectorFactor(rankPct: number | null): FactorScore // 0=weakest..1=strongest sector by rs21 → (rank−0.5)*80
export function socialFactor(row: { redditRank: number | null; surgeMultiple: number | null; sources: number } | null, rsi: number | null): FactorScore // 0..60, halved when rsi>70 (crowded)
export function channelsFactor(stances: { channel: string; stance: 'bull' | 'bear' | 'neutral' }[], credOf: (channel: string) => number): FactorScore // Σ(±1 × 2·cred) × 18, clamp ±70
export function insiderFactor(summary: { isCluster: boolean; buyers: string[] } | null | undefined): FactorScore // cluster 45, any buy 20, none 0; undefined→null
export function newsFactor(headlinesForSym: string[]): FactorScore // keyword polarity, clamp ±50; empty → 0 'quiet tape'
export function seasonalityFactor(summary: SeasonalitySummary | null, month: number): FactorScore // null unless reliable; clamp(avgPct*4, ±15)
```

Stage→score map (technicalFactor): early-reversal 70, pullback 55, basing 25, trending 15, weak −30, extended −45, exhausted −70, falling-knife 0 ("wait"). `volumeConfirmed` multiplies by 1.2, clamp ±100. News keywords — positive: beat, beats, surge, soars, soar, jumps, jump, upgrade, upgraded, record, wins, rally, tops, top; negative: miss, misses, plunge, plunges, sinks, sink, falls, fall, cut, cuts, downgrade, downgraded, probe, lawsuit, recall, warns, warn, slump, slumps. Score = clamp(15·net + 5·sign(net)·hits, ±50).

- [ ] **Step 1: Write failing tests** — `shared/engine/factors.test.ts` covering: stage map values (early-reversal 70·1.2=84 when volume-confirmed; exhausted −70), momentum clamp both signs and null passthrough, sector rank 1.0→+40 / 0→−40, social cap at 60 and RSI>70 halving, channels credibility weighting (bull from cred-0.9 channel outweighs bear from cred-0.3), insiders cluster/none/undefined, news polarity + empty, seasonality null below reliability gate and clamp ±15.
- [ ] **Step 2: Run** `npx vitest run shared/engine/factors.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `types.ts` + `factors.ts` exactly per signatures.
- [ ] **Step 4: Run again** — expect PASS.
- [ ] **Step 5: Commit** `feat(engine): factor scores — technical/momentum/sector/social/channels/insiders/news/seasonality`

---

### Task 2: Composite → EngineCall

**Files:**
- Create: `shared/engine/composite.ts`
- Test: `shared/engine/composite.test.ts`

**Interfaces:**
- Consumes: `FactorScore`, `EngineCall` (Task 1), `EntryQuality`/`Stage` (shared/technicals).
- Produces (used by Tasks 7, 8, 9):

```ts
export const DEFAULT_WEIGHTS: Record<FactorName, number> = {
  technical: 1.0, momentum: 0.8, sector: 0.6, social: 0.5, channels: 0.6, insiders: 0.4, news: 0.4, seasonality: 0.3,
}
export const LONG_REGIME_MULT = { green: 1.0, amber: 0.8, red: 0.55, unknown: 0.8 } as const
export const SHORT_REGIME_MULT = { green: 0.7, amber: 0.9, red: 1.1, unknown: 0.9 } as const

export interface ComposeInput {
  sym: string
  factors: Record<FactorName, FactorScore>
  weights: Record<FactorName, number>
  regime: RegimeColor | 'unknown'
  capacityPct: number | null
  atr: number | null
  lastClose: number | null
  entryQuality: 'early' | 'neutral' | 'chase' | 'wait' | null
  stage: Stage | null
  earningsWithinHorizon: boolean
  capUsdM: number | null
}
export function composeCall(input: ComposeInput): EngineCall | null
```

Rules (each is a test): weighted mean over non-null factors only; regime multiplier by side; dead zone |adj| < 25 → null; capacity gate < 6 or null → null; missing atr/lastClose → null; side-aware chase — long+`chase` → null, `wait` → null both sides, short+stage `early-reversal`/`pullback` → null (never short fresh strength); expectedMovePct = round1(min(|adj|/100, 0.8) × capacity); smallCap = cap < $2000M → stop 2×ATR else 1.5×ATR; long: stop = entry − mult·atr, target = entry + max(2·atr, entry·expectedMove/100); short mirrored; `note` one line naming the top two contributing factors.

- [ ] **Step 1: Failing tests** — all-null factors → null; strong long fixture (technical 84, momentum 40) green regime → side long, composite ≥ 25, sane levels (stop<entry<target); same fixture red regime → composite ×0.55 may fall in dead zone → null; short fixture (exhausted −84) red regime → side short, stop>entry>target; chase-long exclusion; wait exclusion; short-on-pullback exclusion; capacity 4 → null; smallCap stop wider than largeCap stop on same ATR.
- [ ] **Step 2: Run** `npx vitest run shared/engine/composite.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(engine): composite call — weighted factors, regime-aware, side-aware entry gates`

---

### Task 3: Calibration, grading, weight learning

**Files:**
- Create: `shared/engine/calibration.ts`
- Test: `shared/engine/calibration.test.ts`

**Interfaces:**
- Consumes: `Prediction`, `PredOutcome` (Task 1), `Candle`.
- Produces (used by Tasks 6, 7, 8):

```ts
export interface BucketStat { n: number; hits: number }
export interface CalibrationState {
  buckets: Record<string, BucketStat> // `${side}:${regime}:${band}`
  brier: { date: string; mean: number; n: number }[]
  seeded?: boolean
}
export type Band = '25-40' | '40-55' | '55-70' | '70+'
export function bandFor(absComposite: number): Band
export function probabilityFor(state: CalibrationState, side: 'long'|'short', regime: string, absComposite: number): { p: number; n: number; provisional: boolean }
// regime bucket if its n ≥ 15, else pooled across regimes; p = (hits+2)/(n+4); provisional = chosen n < 15
export function gradeFor(p: number, provisional: boolean, capacityPct: number): 'A' | 'B' | 'C' | null
// A: p≥.62 ∧ !provisional ∧ capacity≥8 · B: p≥.55 · C: p≥.50 · else null (suppressed); provisional caps at B
export function gradePrediction(pred: { date: string; side: 'long'|'short'; priceAtPrediction: number; stop: number }, candles: Candle[], spyCandles: Candle[], horizon: 5 | 10): PredOutcome | null
// entryIdx = first candle t ≥ Date.parse(date)/1000; null if fewer than horizon bars after; stopped = any low ≤ stop (long) / high ≥ stop (short) in (entryIdx..entryIdx+h]; excess = sign·(stockRet − spyRet); hit = !stopped ∧ excess>0
export function updateCalibration(state: CalibrationState, pred: { side: string; regime: string; composite: number }, outcome: PredOutcome): CalibrationState

export interface IcStat { nAgree: number; sumAgree: number; nDisagree: number; sumDisagree: number }
export interface WeightsState {
  base: Record<FactorName, number>
  current: Record<FactorName, number>
  ic: Record<FactorName, IcStat>
  gradedSinceNudge: number
  history: { date: string; changes: Record<string, { from: number; to: number; ic: number }>; evidence: string }[]
}
export function initWeights(base?: Record<FactorName, number>): WeightsState
export function updateIcStats(state: WeightsState, pred: Prediction, outcome: PredOutcome): WeightsState
// per non-null non-zero factor: agree = (score>0) === (side==='long'); accumulate outcome.excessPct
export function maybeNudgeWeights(state: WeightsState, dateISO: string): WeightsState
// only when gradedSinceNudge ≥ 15; per factor with nAgree+nDisagree ≥ 20: ic = clamp((meanAgree−meanDisagree)/10, ±1); w ← clamp(w·(1+0.15·ic), 0.4·base, 2·base); log history, reset counter
export function brierPoint(preds: { probability: number; outcome5?: PredOutcome }[]): number | null // mean (p − hit)²
```

- [ ] **Step 1: Failing tests** — bandFor edges (25, 40, 70); probability Laplace (0 data → 0.5, 10/10 hits → 12/14); pooled fallback when regime bucket thin; provisional flag; gradeFor matrix incl. capacity<8 blocks A and provisional caps B; gradePrediction on synthetic candles: clean long hit, long stopped intraday then recovered = miss, short sign correctness, too-recent → null; updateIcStats agree/disagree bookkeeping; maybeNudgeWeights: no-op below 15 graded, clamps at 2×base and 0.4×base, history written; brierPoint arithmetic.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(engine): calibration map, outcome grading vs SPY, bounded factor-weight learning`

---

### Task 4: Channel credibility

**Files:**
- Create: `shared/engine/channelCred.ts`
- Test: `shared/engine/channelCred.test.ts`

**Interfaces:**
- Consumes: `VideoExtract` shape (netlify/functions/lib/videoTrends.ts) — redeclare the minimal structural type locally to keep shared/ free of netlify imports: `{ url: string; channel: string; at: number; tickers: { sym: string; stance: 'bull'|'bear'|'neutral' }[] }`.
- Produces (used by Tasks 7, 8, 9):

```ts
export interface ChannelCredEntry { graded: number; hits: number; sumExcess: number; recent: { key: string; at: number; sym: string; stance: string; hit: boolean }[] }
export type ChannelCredState = Record<string, ChannelCredEntry>
export function credibilityOf(state: ChannelCredState, channel: string, favourites: string[]): number
// (hits + prior·8)/(graded + 8), prior 0.6 for favourites else 0.5 — ~20 graded calls dominate the prior
export function gradeChannelStances(extracts: ExtractLike[], candlesBySym: Map<string, Candle[]>, spyCandles: Candle[], state: ChannelCredState, nowSec: number): { state: ChannelCredState; graded: number }
// stance = mini-prediction: entry = close of first session after video `at`; grade at +5 sessions, excess vs SPY, bear sign-flipped; dedupe by key `${url}|${sym}`; skip neutral; only extracts 7–60 days old; recent capped 200/channel
```

- [ ] **Step 1: Failing tests** — credibilityOf priors (empty state: favourite 0.6, other 0.5) and convergence (16 hits / 20 graded → (16+4)/28 ≈ 0.714 fav); gradeChannelStances grades a matured bull correctly (synthetic rising candles → hit), flips sign for bear, dedupes on second run (graded: 0), skips too-fresh videos.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(engine): channel credibility — every YouTube stance graded vs SPY, favourites trusted-but-verified`

---

### Task 5: Risk ladder + leveraged instrument mapping

**Files:**
- Create: `shared/engine/riskLadder.ts`
- Test: `shared/engine/riskLadder.test.ts`
- Modify: `shared/config.ts` (add optional `levMap` + `riskRungOverride` + `favouriteChannels` to `AppConfig`, validated: levMap values are ≤12-char strings keyed long2x/long3x/short2x/short3x; override 0–3; favourites string[] ≤10)

**Interfaces:**
- Produces (used by Tasks 7, 8, 9):

```ts
export interface RiskState { rung: 0|1|2|3; sinceDate: string; gradedAtRung: number; history: { date: string; from: number; to: number; evidence: string }[] }
export const RUNG_RISK_PCT = [1.0, 1.25, 1.5, 2.0] as const
export interface OutcomeLite { hit: boolean; stopped: boolean; leveraged: boolean }
export function initRisk(today: string): RiskState
export function computeRung(state: RiskState, outcomes: OutcomeLite[], brierImproving: boolean, override: number | null, today: string): RiskState
// override wins (history notes 'manual'); demote −1 if hitRate(last 20) < .45 (needs ≥20) or last 3 leveraged all stopped; promote +1 if gradedAtRung ≥ 25 ∧ hitRate(last 25) ≥ .55 ∧ brierImproving; gradedAtRung += new outcomes, resets on change
export type LevMap = Record<string, { long2x?: string; long3x?: string; short2x?: string; short3x?: string }>
export function leverageAllowed(rung: number, grade: 'A'|'B'|'C'): 0 | 2 | 3
// R3+A→3 · R2+(A|B)→2 · R1+A→2 · else 0
export function mapInstrument(side: 'long'|'short', sym: string, grade: 'A'|'B'|'C', rung: number, levMap: LevMap): { ticker: string; leverage: number } | null
// highest allowed leverage with a mapping; falls back 3x→2x; null when none
```

- [ ] **Step 1: Failing tests** — promotion requires all three conditions (25 graded at ≥55% but brier worsening → stays); demotion on cold streak exactly at <45%/20; three straight leveraged stop-outs demote even with fine hit rate; override respected + logged; leverageAllowed matrix; mapInstrument 3x fallback to 2x and null; rung floor 0 / ceiling 3; config validation round-trips levMap and rejects rung 5.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement (incl. config.ts changes).** **Step 4: Run** `npx vitest run shared/engine/riskLadder.test.ts shared` — PASS incl. existing config tests.
- [ ] **Step 5: Commit** `feat(engine): performance-gated risk ladder R0–R3 + leveraged ETP instrument mapping`

---

### Task 6: Self-curating roster

**Files:**
- Create: `shared/engine/roster.ts`
- Test: `shared/engine/roster.test.ts`

**Interfaces:**
- Produces (used by Task 8):

```ts
export interface RosterEntry { sym: string; joined: string; source: string; capUsdM: number | null; lastCapacity: number | null; lastQualified: string }
export interface RosterCandidate { sym: string; source: string; capUsdM: number | null; capacityPct: number | null; dollarVol20d: number | null; price: number | null }
export const ROSTER_MAX = 80
export function avgDollarVol20(candles: Candle[]): number | null // mean(c·v) over last 20 bars
export function updateRoster(current: RosterEntry[], candidates: RosterCandidate[], watchlist: string[], today: string): { roster: RosterEntry[]; joined: string[]; dropped: { sym: string; why: string }[] }
```

Rules: join needs capacity ≥ 8, dollarVol ≥ $5M, price ≥ $1; existing entries refresh cap/capacity and `lastQualified` bumps when capacity ≥ 6; non-watchlist drop after 21 calendar days (~15 sessions) unqualified ('went quiet') or on liquidity failure ('illiquid'); watchlist symbols always present, never dropped; trim to 80 by dropping largest-cap non-watchlist first while preserving a small-cap quota — after trim, count(cap<$2000M) ≥ ceil(len/3) whenever enough small-caps qualify.

- [ ] **Step 1: Failing tests** — join/reject on each gate; decay drop at 22 days but not 20; watchlist immortality; small-cap quota honoured when trimming (feed 100 candidates, 40 small → result ≥ ⌈80/3⌉ small); joined/dropped reasons populated; avgDollarVol20 arithmetic + null under 20 bars.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(engine): self-curating roster — capacity-gated, small-cap quota, decay with reasons`

---

### Task 7: Backtest seed

**Files:**
- Create: `shared/engine/backtest.ts`
- Create: `scripts/seed-engine.ts` (runner)
- Create: `shared/engine/seed.json` (generated output, committed)
- Test: `shared/engine/backtest.test.ts`
- Modify: `package.json` (script `"seed-engine": "node --experimental-strip-types scripts/seed-engine.ts"` — verify node ≥22.6 at execution; if the flag is unsupported fall back to writing the runner as plain `.mjs` importing compiled logic via `npx tsc -p tsconfig.json` is NOT acceptable — instead inline the replay loop in the script only if strip-types is unavailable)

**Interfaces:**
- Consumes: Tasks 1–3 pure functions + `technicalStage`, `swingCapacity`, `regimeFromCandles`, `seasonalitySummary`.
- Produces: `seedFromHistory(bySym: Map<string, Candle[]>, spy: Candle[]): { weights: WeightsState; calibration: CalibrationState }` and `shared/engine/seed.json` `{ generatedAt, symbols: number, weights, calibration }` with `calibration.seeded = true`.

Replay: per symbol, for i from 80 to len−11 step 5 (weekly sampling decorrelates): slice history to i, compute technical+momentum(+seasonality when slice ≥ 500 bars) factors, composite with DEFAULT_WEIGHTS (other factors null), regime from SPY slice (passed for both args of `regimeFromCandles` — QQQ unavailable historically here, acceptable for a seed), capacity from slice; when a call emerges grade it against bars i..i+5 (excess vs SPY same indices) and feed `updateCalibration` + `updateIcStats`; finish with one forced nudge (`gradedSinceNudge` requirement waived via direct call after setting counter) → seed weights.

Runner: fetches 2y candles from Yahoo for SECTORS members + SECTOR ETFs + SPY (direct `https://query1.finance.yahoo.com/v8/finance/chart/<sym>?range=2y&interval=1d`, UA header like `netlify/functions/lib/yahoo.ts` uses, 200ms delay between calls), runs `seedFromHistory`, writes `shared/engine/seed.json`, prints bucket counts. Local-only, no posting.

- [ ] **Step 1: Failing test** — determinism: fixture candles (two synthetic symbols, deterministic trends) in → identical output twice; calibration buckets non-empty; weights within clamp bounds; seeded flag true.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement backtest.ts.** **Step 4: Run** — PASS.
- [ ] **Step 5: Run the seeder** `npm run seed-engine` → commit `shared/engine/seed.json` (non-trivial: ≥200 graded synthetic outcomes expected across ~60 symbols).
- [ ] **Step 6: Commit** `feat(engine): backtest seed — technical/momentum weights pre-validated on 2y history`

---

### Task 8: IO glue — screener, 5y candles, cap helper, engine orchestrator, predict-background

**Files:**
- Create: `netlify/functions/lib/screener.ts` + `screener.test.ts`
- Create: `netlify/functions/lib/engine.ts` + `engine.test.ts`
- Create: `netlify/functions/predict-background.mts`
- Modify: `netlify/functions/lib/marketCache.ts` (add `cachedCandles5y`, `cachedCapUsdM`)
- Modify: `netlify/functions/report-kick.mts` (kick predict; predict chains to compose)

**Interfaces:**
- Consumes: everything from Tasks 1–6, existing fetchers (`cachedCandles`, `cachedQuote`, `fetchInsiderBuys`, `fetchNews`, `fetchRedditTrends`, `fetchStocktwitsTrending`, `combineSocialPulse`, `computeSectorRows`, `blobAppStore`).
- Produces:

```ts
// screener.ts — parse split from fetch for testability
export type ScreenKind = 'day_gainers' | 'most_actives' | 'small_cap_gainers'
export function parseScreen(json: unknown): { sym: string; price: number | null; capUsdM: number | null }[]
export async function fetchScreen(kind: ScreenKind, fetchFn?: typeof fetch): Promise<{ sym: string; price: number | null; capUsdM: number | null }[]> // graceful [] on any failure

// marketCache.ts additions
export async function cachedCandles5y(sym: string): Promise<Candle[] | null> // key `candles:${sym}:5y`, TTL 7d
export async function cachedCapUsdM(sym: string, finnhubKey: string): Promise<number | null> // reuses existing `cap:${sym}` key + Finnhub profile2, TTL 7d

// engine.ts — orchestration, store injected for tests
export async function gradeOutstanding(store: AppStore, nowSec: number): Promise<{ graded: number }>
export async function buildBoard(store: AppStore, env: { FINNHUB_API_KEY?: string }, nowSec: number): Promise<{ board: Prediction[]; rosterSize: number }>
```

Blob keys (all via `blobAppStore`): `predictions:<date>`, `predictions-index`, `engine-weights`, `engine-calibration`, `engine-scorecard`, `channel-credibility`, `risk-state`, `engine-roster`, `engine-board`.

`gradeOutstanding`: walk `predictions-index` newest→oldest (stop after 30 dates), for each ungraded horizon fetch cached candles + SPY, `gradePrediction`; on grade: `updateCalibration`, `updateIcStats`, collect `OutcomeLite`; then `maybeNudgeWeights`, brier point per day, `computeRung` (brierImproving = mean(last 5 brier) ≤ mean(prior 5), default true when <10 points), `gradeChannelStances` from `video-extracts` blob, rebuild `engine-scorecard` (hit rates by grade/factor-agreement/regime + avg excess + brier series tail).

`buildBoard`: read config (watchlist, favourites, levMap, override) → roster candidates from screeners×3 + social pulse + top-2-sector members + watchlist (capacity/dollarVol/price via `cachedCandles`, cap via `cachedCapUsdM` — screener caps pass through) → `updateRoster` → per roster symbol (≤80): candles, technicalStage, factors (sector rank from ticker's sector ETF rs21 percentile via SECTOR_MEMBERS reverse lookup; social row match; channel stances from last-7d `video-extracts`; insiders only for watchlist symbols (Finnhub budget), others null; news = media+symbol headlines filtered by word-boundary sym match; seasonality from `cachedCandles5y` only for symbols already passing |composite-without-seasonality| ≥ 20 — budget guard) → `composeCall` → `probabilityFor`/`gradeFor` → risk mapping (`RUNG_RISK_PCT`, `mapInstrument`, paperOnly) → Prediction[] sorted by |composite| desc, capped 12 per side → write `predictions:<date>` (merge-preserving any existing overlay/outcomes for same date), index, `engine-board` {date, generatedAt, board}.

`predict-background.mts`: admin auth (same as compose) → `gradeOutstanding` → `buildBoard` → runlog entry `{kind:'predict', graded, boardSize, rosterSize}` → finally POST `report-compose-background` with `x-app-token` (chain; even on engine failure — compose must still run in legacy mode). `report-kick.mts` now POSTs `predict-background` instead of compose (schedule moves to `20 5 * * 1-5` so the chain lands before 06:35 UK paper time; keep function name/config idiom).

- [ ] **Step 1: Failing tests** — `parseScreen` on captured Yahoo screener JSON fixture + garbage → []; `engine.test.ts` with `memoryStore()` + injected fetch fixtures: buildBoard end-to-end produces a valid Prediction (id/date/levels/factors), respects dead zone, writes all blobs; gradeOutstanding grades a fixture prediction planted 6 sessions back, updates calibration bucket n, risk state present.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement all files.** **Step 4: Run** `npm test` — PASS (whole suite).
- [ ] **Step 5: Commit** `feat(engine): daily predict run — grade yesterday, curate roster, score board, chain to compose`

---

### Task 9: Compose integration — the LLM becomes the journalist

**Files:**
- Modify: `netlify/functions/lib/newspaper.ts` (ideas section prompt + composed schema gains `overlay` per idea)
- Modify: `netlify/functions/report-compose-background.mts` (read `engine-board`, hard-constrain ideas, write overlays back, Barron's+Bloomberg feeds)
- Test: `netlify/functions/lib/newspaper.test.ts` (extend)

**Interfaces:**
- Consumes: `engine-board` blob `{ date, board: Prediction[] }`.
- Produces: composed ideas carry `{ predictionId, overlay?: { flag: 'boost'|'caution'|'veto', reason } }`; `predictions:<date>` records updated with overlays; vetoed ideas dropped from paper HTML but retained in ledger.

Changes: compose gathers `engine-board`; when fresh (same London date, else >24h → legacy mode + visible "engine offline" line in the paper standfirst), the ideas section prompt becomes: *select 3–6 ideas ONLY from `engineBoard`; copy ticker, side, entry, stop, target, probability, grade verbatim — you may not invent or alter numbers; write the case in your voice; optionally attach one overlay per idea `{flag: boost|caution|veto, reason}` grounded in headlines/news*. Feed list adds `['Barron's', 'https://www.barrons.com/xml/rss/3_7510.xml']` and `['Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss']`. After parse: validate every idea's ticker+side exists on the board (reject hallucinated ones), merge overlays into `predictions:<date>`, drop vetoes from the rendered paper, and the picks PUT carries `predictionId` per pick.

- [ ] **Step 1: Failing tests** — idea validation rejects a ticker not on the board and passes a board-matching one with numbers preserved; overlay merge writes into the right prediction record; veto excluded from HTML input list but present in ledger; legacy mode flagged when board stale.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(engine): paper ideas board-constrained — LLM narrates, overlay flags logged and graded`

---

### Task 10: Engine API endpoint + client

**Files:**
- Create: `netlify/functions/engine.mts`
- Modify: `src/lib/api.ts` (add `fetchEngine()`)
- Test: cover via Task 8's store shapes (endpoint is a thin read; follow `market-data.mts` auth idiom — authenticate, non-admin allowed read)

**Interfaces:**
- Produces (used by Task 11): `GET /.netlify/functions/engine` → `ApiEnvelope<{ board: { date: string; board: Prediction[] } | null; scorecard: unknown; weights: { current: Record<string, number>; history: unknown[] }; calibration: unknown; riskState: unknown; roster: { entries: RosterEntry[]; joined: string[]; dropped: { sym: string; why: string }[] } | null; channelCred: Record<string, { graded: number; hits: number }> }>` — weights history trimmed to last 10, channelCred summarised.

- [ ] **Step 1: Implement endpoint + client** (read-only aggregation of the blobs Task 8 writes; auth like existing functions; 300s CDN cache header like market-data uses if present).
- [ ] **Step 2: Run** `npm test` + `npm run build` — PASS/compiles.
- [ ] **Step 3: Commit** `feat(engine): read API — board, scorecard, weights, calibration, risk, roster, channel credibility`

---

### Task 11: UI — board + engine panel

**Files:**
- Create: `src/components/EngineBoard.tsx`
- Create: `src/components/EnginePanel.tsx`
- Modify: `src/screens/Intel.tsx` (EngineBoard section at top), `src/screens/Research.tsx` (EnginePanel section), `src/index.css` (reuse existing table/card classes; add only what's missing)

**Interfaces:**
- Consumes: `fetchEngine()` (Task 10).

EngineBoard: "THE BOARD" — per call: grade chip (A/B/C, provisional badge), sym+side, probability %, entry/stop/target, expected move, capacity, stage note, small-cap + earnings + paper-only tags, instrument ticker when leveraged (with decay warning line), factor mini-breakdown (name+signed score, weight-sorted). EnginePanel: risk rung dial (R0–R3 + evidence of last change), scorecard (hit rate by grade + avg excess + Brier trend arrow), calibration rows (band → predicted vs realized), weights table (current vs base with last-change evidence), channel credibility table (channel, graded, hit %), roster changes (joined/dropped + why). Match the app's newspaper-ish styling; tables scroll horizontally on mobile like existing ones.

- [ ] **Step 1: Implement components + wiring.**
- [ ] **Step 2: Verify** `npm run build` clean; `npm test` green; quick render sanity via existing component test setup (add smoke test rendering EngineBoard with a fixture Prediction).
- [ ] **Step 3: Commit** `feat(engine): UI — the board on Intel, engine panel (risk dial, calibration, weights, channels, roster) on Research`

---

### Task 12: End-to-end verification

- [ ] **Step 1:** `npm test` — whole suite green.
- [ ] **Step 2:** `npm run build` — clean.
- [ ] **Step 3:** `netlify dev` locally; hit `predict-background` with the app token; confirm blobs written (board non-empty on a weekday), then `engine` endpoint returns the board; load the app, see THE BOARD render.
- [ ] **Step 4:** Verify graceful degradation: temporarily point screener fetch at a dead URL in dev → board still builds from watchlist/sectors/social.
- [ ] **Step 5:** Commit any fixes; leave deploy to the user's batched-CLI preference (no deploy in this plan).

## Self-review (done)

- **Spec coverage:** factors incl. seasonality (T1), composite+gates (T2), calibration/learning/Brier (T3), channel credibility w/ favourites (T4), risk ladder + ETP mapping + config (T5), roster w/ small-cap quota + fade retention via extended/exhausted shorts (T2 gates + T6 membership), predict fn + chaining (T8), compose constraint + overlay + Barron's/Bloomberg (T9), seed (T7), UI (T11), error handling & bounds (global constraints + T8), tests throughout.
- **Placeholder scan:** none — every rule carries its numbers.
- **Type consistency:** `Prediction`/`FactorScore`/`WeightsState`/`RiskState`/`RosterEntry` names match across tasks; store key names listed once in T8 and reused in T9/T10.
