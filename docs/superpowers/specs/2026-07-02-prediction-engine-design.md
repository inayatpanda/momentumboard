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
2. ~~Shorts labelled paper-only~~ **Superseded by user feedback**: shorts become executable via ISA-eligible leveraged/inverse ETPs once the risk ladder unlocks them (see Risk ladder section); unmapped or low-rung shorts stay scored as paper-only avoid/fade calls.
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
| `channels` | `computeConsensus` + new credibility ledger | net bullish-vs-bearish mention score, **weighted by each channel's graded track record** (see Channel credibility below). Favourites like *Stocks with Josh* start with a higher prior but are graded like everyone else |
| `seasonality` | `seasonalitySummary` over **5y candles** (new cache key `candles:<sym>:5y`, weekly TTL — 1y history fails the lib's own ≥500-candle reliability gate) | current calendar-month tendency + day-of-week tendency across the horizon; small capped weight (max ±15) because seasonal edges are real but thin; `null` when `reliable=false` — never faked |
| `insiders` | `fetchInsiderBuys` | recent cluster buys → +; sells ignored (noise) |
| `newsPressure` | headlines + Finnhub news | count/recency of ticker-tagged headlines; sign from title keyword polarity (crude by design; nuance is the LLM overlay's job). Feed list grows to **FT, MarketWatch, CNBC, Barron's, Bloomberg** (headline RSS — titles are free even behind paywalls) |
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

### 4. `shared/engine/channelCred.ts` — channel credibility (pure, tested)

Every `VideoExtract` stance (bull/bear per ticker, already produced by the transcript pipeline) is a mini-prediction with a timestamp. The evaluator grades them exactly like engine predictions: 5/10-session excess return vs SPY from the video date, sign-adjusted for bears. Per channel this accumulates `{graded, hits, avgExcess}` → a credibility score 0..1 (Laplace-smoothed).

- The `channels` factor weights each channel's stance by its credibility — a channel that's been right moves the needle; one that's been wrong fades toward zero influence automatically.
- User favourites (e.g. *Stocks with Josh*) get a starting prior of 0.6 instead of 0.5 — trust, but verify; 20 graded calls dominate the prior either way.
- The paper's street-check section shows the receipts: "Stocks with Josh: 62% on 34 graded calls" — the channel review the user asked for, with evidence instead of vibes.
- Stored in `channel-credibility` blob; bounded (per-channel rolling last 200 graded calls).

### 5. `shared/engine/riskLadder.ts` — performance-gated risk appetite (pure, tested)

Risk-taking starts modest and **earns its way up** as the scorecard proves out; it steps down fast when the engine goes cold. The rung is computed deterministically from the rolling scorecard — never from a feeling.

| Rung | Unlocks | Suggested risk per idea |
|---|---|---|
| R0 (start) | cash equity calls only, A/B grades actionable | 1.0% of capital |
| R1 | 2x leveraged ETPs on **A-grade** calls | 1.25% |
| R2 | 2x on A/B; up to 2 speculative ideas per paper | 1.5% |
| R3 | 3x ETPs on A-grade with volume confirmation | 2.0% |

- **Promote** after ≥25 graded predictions at the current rung with hit rate ≥55% and Brier not worsening. **Demote** one rung immediately if hit rate over the last 20 graded < 45%, or 3 consecutive leveraged calls stop out. Every rung change is written to the ledger with its evidence.
- Manual override lives in config (`riskRungOverride`) — the user's standing rule: risk rules are defaults to flag, not laws. The paper states the rung and why, every day.

**Leveraged execution (including shorts).** A T212 ISA can't short stock, but it can hold ISA-eligible leveraged/inverse ETPs (Leverage Shares, GraniteShares, WisdomTree). Config gains an instrument map `levMap: { underlying: { long2x?, long3x?, short2x?, short3x? } }` (user-maintained, seeded with the liquid ones: QQQ/SPY/TSLA/NVDA etc.). The engine emits the *underlying* call; execution mapping happens at render:

- Short call + rung ≥ R1 + mapping exists → the card shows the inverse ETP ticker as the executable instrument, with the underlying's levels translated (stop/target restated as underlying levels — "exit the ETP when NVDA reclaims 132", not ETP-price stops, because daily-rebalance path dependence makes ETP-price stops lie).
- Every leveraged card carries the decay warning: daily-rebalanced products bleed sideways; max hold = the 10-session horizon, hard; gap risk stated.
- No mapping or rung too low → the short stays on the board as **avoid/fade (paper-only)** and still gets graded — credibility is earned in paper before it's spent in leverage.

### 6. Ledger — Netlify Blobs schema

- `predictions:<YYYY-MM-DD>` — array of Prediction records (immutable after write; same-day rerun overwrites whole day):
  `{ ticker, side, composite, probability, provisional, grade, expectedMovePct, entry, stop, target, horizon, priceAtPrediction, factors: {name: {score, weight, detail}}, regime, earningsRisk, llmOverlay?: {flag, reason} }`
- `predictions-index` — array of dates written (bounded, last 250).
- `engine-weights` — `{ current: {factor: weight}, history: [{date, changes, evidence}] }` (history bounded 100).
- `engine-calibration` — bucket stats per side per regime + pooled; Brier score series (bounded 250).
- `engine-scorecard` — rolled-up: hit rates by grade/factor/regime, avg excess return, Brier trend. Feeds the paper's "own scorecard" section and the UI.
- `channel-credibility` — per-channel graded stance history + credibility score (rolling last 200 per channel).
- `risk-state` — `{ rung, sinceDate, history: [{date, from, to, evidence}] }` (history bounded 50).
- Prediction records additionally carry `{ riskRung, instrument?: {ticker, leverage, kind: 'etp'}, seasonalityNote? }`.

### 7. `netlify/functions/predict-background.mts` — the daily run

Order: (0) grade matured predictions **and channel stances** → update calibration/weights/credibility → recompute risk rung → (1) build universe → (2) gather data via existing cached fetchers (plus 5y candles for seasonality, weekly-TTL cache) → (3) factors → (4) composite → (5) apply risk ladder + instrument mapping → (6) write ledger + scored board to Blobs (`engine-board`) → (7) log to runlog. Kicked by `report-kick` before compose (compose waits on board freshness; if the board is stale > 24h, compose runs in legacy mode with a visible "engine offline" note in the paper).

**Universe — the self-curating roster (`engine-roster` blob).** The engine maintains its own follow list of names with demonstrated rapid-movement potential, auto-updated daily; the user's watchlist rides along but the roster is the engine's own hunting ground (~60-80 evaluated daily, tiered):

- **Discovery inflows**: Yahoo screeners (day gainers, most active, small-cap gainers), social trending, top-2-sector members, watchlist. Candidates join the roster only if `swingCapacity ≥ 8%` and they pass the liquidity floor (20d avg dollar volume > $5M, price > $1).
- **Small-cap tilt (the stated aim)**: market cap tracked per name (cap fetch already exists for the social board); the roster reserves at least a third of its slots for caps < $2B — small caps are where the best returns live, and also where the worst fills live, so their cards carry wider ATR stops and a gap-risk note, and they grade in their own calibration bucket (small-cap edges must prove themselves separately).
- **Fade side (betting against what ran)**: extended/exhausted stages on high-capacity names are short candidates by design (the side-aware chase rule) — the roster explicitly keeps recent vertical movers *after* they top out, because yesterday's rocket is tomorrow's fade.
- **Membership decay**: names drop off after 15 sessions without capacity ≥ 6% or on liquidity failure; watchlist names never auto-drop. Roster changes are logged (joined/dropped, why) and shown in the app — the "list of stocks to follow" the user asked the engine to own.

### 8. `report-compose-background.mts` changes

- Gathers `engine-board` and passes it to section prompts with the hard rule: *ideas must be selected from board entries; ticker, side, entry, stop, target, probability are copied verbatim; the LLM writes the case, it does not invent the numbers*.
- LLM may attach one overlay flag per idea (`boost | caution | veto`) with a reason (news/politics nuance). Vetoed ideas drop from the paper but stay in the ledger marked vetoed — so the overlay itself gets graded (did vetoes dodge losers? did boosts outperform?).
- Picks capture (existing `/report` PUT) now also stores the prediction id so paper picks and ledger entries join cleanly.

### 9. Backtest pre-seed — `shared/engine/backtest.ts` + `npm run seed-engine`

Technical/momentum/sector/**seasonality** factors are computable from candle history (5y fetch for seasonality). A local script replays the universe day-by-day over the past year, produces synthetic ledger outcomes, and emits initial weights + a starting calibration table (marked `seeded: true`). Social/channels/news/insiders start at neutral prior weight and learn live only. This is what makes the engine concrete on day one instead of after months.

### 10. Frontend (minimal — the app is the frontend)

- **Board tab on Intel screen**: today's scored board — ticker, side, grade, probability (with "provisional" badge), entry/stop/target, factor bars, earnings flag, executable instrument when leveraged.
- **Engine section on Research screen**: calibration curve (predicted vs realized by bucket), weight history with evidence, Brier trend, scorecard by grade/factor/regime, **risk rung dial with its evidence trail**, **channel credibility table** (per-channel hit rate, graded calls).
- Prediction cards link to TickerDetail as picks already do.

## Error handling

- Every factor fetch isolated with the existing `grab()` pattern; a `null` factor renormalises weights rather than polluting the composite.
- Engine failure never blocks the paper: compose degrades to current behavior + "engine offline" banner; runlog records the failure.
- Same-day reruns idempotent (day-keyed overwrite). Dates computed in Europe/London consistently. Maturity counted in *trading sessions* via candle indices (existing pattern), so weekends/holidays never skew grading.
- Blobs bounded everywhere (dates index 250, weights history 100, Brier 250) — no unbounded growth.

## Testing

- Factors, composite, calibration, risk ladder, channel credibility, roster membership: vitest unit tests with fixtures (existing repo pattern — every lib has a sibling `.test.ts`).
- Calibration invariants: probabilities monotonic in score bucket after smoothing; weights never exit clamp bounds; provisional flag until n ≥ 15.
- Risk ladder invariants: promotion needs the full evidence bar; demotion triggers exactly on the cold streak; override respected.
- Backtest determinism: same fixture in → identical seed weights out.
- Integration smoke: `predict` against `memoryStore` with fixture data end-to-end → valid ledger day.
- Grading edge cases: stopped-out-then-recovered = miss; short grading sign; missing candles = ungraded, not zero; seasonality `null` below the reliability gate.

## Success criteria

1. Every idea in the paper traces to a ledger prediction with a visible factor breakdown — zero LLM-invented tickers or numbers.
2. The ledger grades itself daily; calibration map and weights visibly update (with evidence) as history accumulates.
3. Scorecard reports excess-vs-SPY hit rates and Brier trend by grade/factor/regime in both the paper and the app.
4. Engine outage degrades gracefully; paper still publishes.
5. All tests green; seed script produces non-trivial initial weights from real candles.
6. The roster visibly self-updates (joins/drops with reasons) and holds its small-cap quota; the risk rung and channel credibility tables are visible with their evidence.

## Build phases (for the implementation plan)

1. Engine core: factors (incl. seasonality over 5y candles) + composite + tests.
2. Calibration/grading + ledger schema + channel credibility + tests.
3. Risk ladder + leveraged instrument mapping + tests.
4. `predict-background` fn + self-curating roster (small-cap tilt) + report-kick wiring.
5. Compose integration (board-constrained ideas + overlay flags + Barron's/Bloomberg feeds).
6. Backtest seed script + initial weights.
7. UI: board + engine scorecard + risk dial + channel credibility + roster view.
