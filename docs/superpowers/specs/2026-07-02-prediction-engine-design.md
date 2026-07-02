# Prediction Engine — Design

**Date:** 2026-07-02
**Status:** Draft — awaiting user review
**Depends on:** existing MomentumBoard/STREET SIGNAL codebase (shared libs, Netlify functions, Blobs store, daily compose pipeline)

## Problem

The daily paper's picks are produced by an LLM reading a JSON dump of real data. The data is real; the *prediction* is not concrete — there is no deterministic score behind a call, no probability, and the outcome scoring (`scorePicks`, `signalStats`) never changes how tomorrow's calls are made. The system reports on itself but does not learn.

## Goal

A deterministic, inspectable prediction engine that:

1. Emits **scored trade calls** — per ticker: direction, calibrated probability, expected move, entry zone, ATR stop, target, horizon (5 and 10 sessions), and the factor breakdown that produced it.
2. **Learns daily**: matured predictions are graded against what price actually did; grading updates (a) the score→probability calibration map and (b) the factor weights, both deterministically and within bounds.
3. **Demotes the LLM to journalist**: the paper's ideas must come from the engine's scored board. The LLM writes the narrative and may add qualitative overlay flags (news nuance, politics) — which are themselves logged and scored.

### Non-goals

- No ML training pipeline, no external infra beyond Netlify + free-tier APIs.
- No intraday signals — the cadence stays daily.
- No pretence of certainty: probabilities start wide and honest ("insufficient history") and sharpen as the ledger grows.

## Judgment calls made during design (user was AFK — override any of these)

1. **Prediction shape = scored trade calls** (direction + probability + entry/stop/target + horizon), not a bare leaderboard. Matches the analyst-persona preference: conviction + reasons + invalidation.
2. **Shorts stay scored but are labelled "avoid/fade — not executable in a T212 ISA"**. They still earn/lose credibility in the ledger.
3. **Benchmark honesty**: outcomes are graded on *excess return vs SPY* over the same horizon, not raw return — a win in a melt-up must beat beta.

## Approaches considered

**A. Deterministic multi-factor engine + calibration loop (chosen).** Pure-function factor scores → weighted composite → calibrated probability; outcomes update calibration and weights. Inspectable, testable, works on free tier, builds directly on existing `shared/` code (technicals, setups, capacity, sectors, social, videoTrends). Weakness: qualitative factors (news, politics) are crude at first — mitigated by the scored LLM overlay.

**B. LLM-ensemble with aggressive scoring (rejected).** Multiple independent LLM analyses that must agree, scorecards fed back into prompts. Cheap, but it is what exists today with more steps: not reproducible, "learning" via prompt text is weak, provider drift breaks continuity.

**C. Offline-trained ML model (rejected).** Gradient boosting on engineered features. Needs training infra, survivorship-bias-free history, and a far larger universe to avoid overfitting; opaque; violates the free-tier/solo-maintainer constraint. YAGNI.

## Architecture

```
                       05:30 UTC weekday kick
                              │
                    ┌─────────▼──────────┐
                    │ predict-background │  (new Netlify background fn)
                    │  1. build universe │
                    │  2. gather data    │  (existing cached fetchers)
                    │  3. factor scores  │  shared/engine/factors.ts
                    │  4. composite      │  shared/engine/composite.ts
                    │  5. write ledger   │  Blobs: predictions:<date>
                    └─────────┬──────────┘
                              │ scored board
                    ┌─────────▼──────────┐
                    │ report-compose     │  (existing, modified)
                    │ LLM narrates the   │
                    │ board; ideas MUST  │
                    │ cite board entries │
                    └─────────┬──────────┘
                              │
              paper + picks ledger (existing pipe)
                              │
                    ┌─────────▼──────────┐
                    │ evaluate (in       │
                    │ predict run, step 0│
                    │ before predicting) │
                    │ grade matured preds│  shared/engine/calibration.ts
                    │ update calibration │  Blobs: engine-calibration
                    │ update weights     │  Blobs: engine-weights (versioned)
                    └────────────────────┘
                              │
                 tomorrow's run uses new weights → loop closed
```

## Components

### 1. `shared/engine/factors.ts` — factor computation (pure, tested)

Each factor returns `{ score: number | null, detail: string }` where score is **signed −100..+100** (positive = long edge, negative = short edge), `null` = data unavailable (weight renormalised, never treated as zero).

| Factor | Source (already fetched today) | Sketch |
|---|---|---|
| `technical` | `technicalStage()` | stage→score map: early-reversal +70, pullback +55, basing +25, trending +15, weak −30, extended −45, exhausted −70, falling-knife 0 (wait); volume-confirmed multiplies ×1.2 |
| `momentum` | candles | 21d return vs SPY 21d return (relative strength), clamped |
| `sector` | `computeSectorRows` | ticker's sector RS21 rank percentile, scaled |
| `social` | reddit/stocktwits pulse | rank + surge multiple → 0..+60; *contrarian cap*: social alone can never exceed 60 and decays if RSI>70 (crowded) |
| `channels` | `computeConsensus` | net bullish-vs-bearish mention score for the ticker across tracked channels |
| `insiders` | `fetchInsiderBuys` | recent cluster buys → +; sells ignored (noise) |
| `newsPressure` | headlines + Finnhub news | count/recency of ticker-tagged headlines; sign from title keyword polarity (crude by design; nuance is the LLM overlay's job) |
| `earningsRisk` | Finnhub earnings calendar | earnings within horizon → *risk flag*, halves position of any call and is shown on the card (binary gate, not a score) |
| `macroRegime` | `regimeFromCandles` + econ calendar | market-level multiplier on ALL long scores: green ×1.0, amber ×0.8, red ×0.55 (and inverse for shorts); high-impact econ event within 2 sessions → note on card |

### 2. `shared/engine/composite.ts` — score → call (pure, tested)

- Composite = Σ(weight_f × score_f) / Σ(weight_f present), regime multiplier applied last. Range −100..+100; |composite| < 25 → no call (dead zone — most tickers most days are a "no").
- **Capacity gate stays**: no call unless `swingCapacity ≥ 6%`; strong grade needs ≥ 8% (existing rule, kept).
- Direction = sign. Horizon = 5 and 10 sessions (both graded).
- Expected move = min(|composite|/100, 0.8) × swingCapacity.
- Entry zone = last close ± 0.5×ATR (limit-style). Side-aware chase rule: `entryQuality='chase'` (extended/exhausted) excludes **long** calls outright — but is precisely the fade setup, so it feeds short scores; `falling-knife` excludes shorts (the move is spent) and longs (no turn yet).
- Stop = entry − 1.5×ATR (long) / + 1.5×ATR (short). Target = entry + max(2×ATR, expectedMove).
- Grade: A/B/C from calibrated probability (A ≥ 62%, B ≥ 55%, C ≥ 50% — below 50% calibrated means the engine has no edge in that bucket and the call is suppressed).

### 3. `shared/engine/calibration.ts` — the learning loop (pure, tested)

- **Grading**: a prediction matures at 5 (and again at 10) sessions. Outcome = excess return vs SPY over the same window, sign-adjusted for shorts. Hit = excess return > 0. Also records raw return, MFE/MAE vs stop/target (stopped-out = miss regardless of later recovery).
- **Calibration map**: composite-score buckets (25–40, 40–55, 55–70, 70+ per side) → realized hit rate with Laplace smoothing `(hits+2)/(n+4)`; probability shown = smoothed rate; while bucket n < 15, card shows "provisional" and grade caps at B.
- **Weight learning**: per factor, maintain running information stats: mean outcome when factor agreed with the call vs disagreed (a poor-man's IC). Weekly (every 5 trading days), weights nudge toward performers: `w ← clamp(w × (1 + 0.15 × normalizedIC), 0.4×w₀, 2×w₀)`. Bounded, slow, versioned — every weight change is written to `engine-weights` history with the evidence that caused it.
- **Regime split**: calibration and IC stats tracked separately per regime (green/amber/red); the map used is the current regime's if it has n ≥ 15, else the pooled one.

### 4. Ledger — Netlify Blobs schema

- `predictions:<YYYY-MM-DD>` — array of Prediction records (immutable after write; same-day rerun overwrites whole day):
  `{ ticker, side, composite, probability, provisional, grade, expectedMovePct, entry, stop, target, horizon, priceAtPrediction, factors: {name: {score, weight, detail}}, regime, earningsRisk, llmOverlay?: {flag, reason} }`
- `predictions-index` — array of dates written (bounded, last 250).
- `engine-weights` — `{ current: {factor: weight}, history: [{date, changes, evidence}] }` (history bounded 100).
- `engine-calibration` — bucket stats per side per regime + pooled; Brier score series (bounded 250).
- `engine-scorecard` — rolled-up: hit rates by grade/factor/regime, avg excess return, Brier trend. Feeds the paper's "own scorecard" section and the UI.

### 5. `netlify/functions/predict-background.mts` — the daily run

Order: (0) grade matured predictions + update calibration/weights → (1) build universe → (2) gather data via existing cached fetchers → (3) factors → (4) composite → (5) write ledger + scored board to Blobs (`engine-board`) → (6) log to runlog. Kicked by `report-kick` before compose (compose waits on board freshness; if the board is stale > 24h, compose runs in legacy mode with a visible "engine offline" note in the paper).

**Universe** (~60 tickers, deduped, capped): watchlist + top-2-sector members + social trending (top 10) + Yahoo screener day-gainers/most-active (top 15, price > $2). Liquidity floor: 20d avg dollar volume > $5M.

### 6. `report-compose-background.mts` changes

- Gathers `engine-board` and passes it to section prompts with the hard rule: *ideas must be selected from board entries; ticker, side, entry, stop, target, probability are copied verbatim; the LLM writes the case, it does not invent the numbers*.
- LLM may attach one overlay flag per idea (`boost | caution | veto`) with a reason (news/politics nuance). Vetoed ideas drop from the paper but stay in the ledger marked vetoed — so the overlay itself gets graded (did vetoes dodge losers? did boosts outperform?).
- Picks capture (existing `/report` PUT) now also stores the prediction id so paper picks and ledger entries join cleanly.

### 7. Backtest pre-seed — `shared/engine/backtest.ts` + `npm run seed-engine`

Technical/momentum/sector factors are computable from 1y of candles. A local script replays the universe day-by-day over the past year, produces synthetic ledger outcomes, and emits initial weights + a starting calibration table (marked `seeded: true`). Social/channels/news/insiders start at neutral prior weight and learn live only. This is what makes the engine concrete on day one instead of after months.

### 8. Frontend (minimal — the app is the frontend)

- **Board tab on Intel screen**: today's scored board — ticker, side, grade, probability (with "provisional" badge), entry/stop/target, factor bars, earnings flag.
- **Engine section on Research screen**: calibration curve (predicted vs realized by bucket), weight history with evidence, Brier trend, scorecard by grade/factor/regime.
- Prediction cards link to TickerDetail as picks already do.

## Error handling

- Every factor fetch isolated with the existing `grab()` pattern; a `null` factor renormalises weights rather than polluting the composite.
- Engine failure never blocks the paper: compose degrades to current behavior + "engine offline" banner; runlog records the failure.
- Same-day reruns idempotent (day-keyed overwrite). Dates computed in Europe/London consistently. Maturity counted in *trading sessions* via candle indices (existing pattern), so weekends/holidays never skew grading.
- Blobs bounded everywhere (dates index 250, weights history 100, Brier 250) — no unbounded growth.

## Testing

- Factors, composite, calibration: vitest unit tests with candle fixtures (existing repo pattern — every lib has a sibling `.test.ts`).
- Calibration invariants: probabilities monotonic in score bucket after smoothing; weights never exit clamp bounds; provisional flag until n ≥ 15.
- Backtest determinism: same fixture in → identical seed weights out.
- Integration smoke: `predict` against `memoryStore` with fixture data end-to-end → valid ledger day.
- Grading edge cases: stopped-out-then-recovered = miss; short grading sign; missing candles = ungraded, not zero.

## Success criteria

1. Every idea in the paper traces to a ledger prediction with a visible factor breakdown — zero LLM-invented tickers or numbers.
2. The ledger grades itself daily; calibration map and weights visibly update (with evidence) as history accumulates.
3. Scorecard reports excess-vs-SPY hit rates and Brier trend by grade/factor/regime in both the paper and the app.
4. Engine outage degrades gracefully; paper still publishes.
5. All tests green; seed script produces non-trivial initial weights from real candles.

## Build phases (for the implementation plan)

1. Engine core: factors + composite + tests.
2. Calibration/grading + ledger schema + tests.
3. `predict-background` fn + universe builder + report-kick wiring.
4. Compose integration (board-constrained ideas + overlay flags).
5. Backtest seed script + initial weights.
6. UI: board + engine scorecard.
