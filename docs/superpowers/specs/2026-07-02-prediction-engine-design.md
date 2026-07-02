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
| `earningsRisk` | Finnhub earnings calendar | earnings within horizon → *risk flag* that **forces the call to shadow** (a binary print is a coin flip — logged for the print-edge ledger, kept off the live board; binary gate, not a score) |
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

## Amendment 2026-07-02: close-based stop grading

A point-in-time replay (`scripts/engine-replay.ts`, 29 shadow + 1 live calls over 5 weeks) showed intraday-pierce stop grading was measuring noise, not judgment: 1.5×ATR ≈ 4.9% of entry sits inside normal weekly range, 5 calls were wick-pierced yet closed positive by day 10 (10d hit 31.0% pierced vs 51.7% ignoring stops), and the sole live call (LLY, +4.0% excess) graded 0-for-2 on one tick. **Change:** `gradePrediction()` and the seed's inline check now mark `stopped` only when a bar CLOSES beyond the stop; wicks are survivable. Stop distance unchanged (1.5×ATR; close-based@1.5× tied intraday@2.0× on the ledger and keeps grading aligned with the advertised level); execution advice on cards still treats the stop as a hard intraday level. Re-scored ledger: 10/30→13/30 at 5d, 9/30→12/30 at 10d; PLTR 5/18 and OXY 6/8 losers still grade stopped misses. Seed reground: same 816 outcomes, hits 350→384 (42.9%→47.1%).

**WATCHPOINTS deliberately not implemented** (small-n, left to the live learning loop): weak-stage shorts on persistent-theme names went 0/3 (CEG); weak-shorts with capacityPct ≥ 9% hit 25% vs 50% below — squeeze-prone; trending-longs 1/7 in a flat tape.

## Amendment 2026-07-02 (2): open-based grading, earnings→shadow, shadow dedup

Three measurement-purity fixes, evidenced by an identical-data before/after replay + reseed.

- **Grade from the entry OPEN, not the prior close.** The paper publishes pre-open, so crediting/blaming a call for the untradeable Fri-close→Mon-open gap is dishonest (audit: AMZN graded from Friday 272.68 when Monday was the first fillable session). `gradePrediction()` and `seedFromHistory()` now base raw + SPY returns at the entry session's open; `channelCred.gradeChannelStances()` got the same fix (it had the same bias — was basing at the first post-video *close*, now its *open*). Stop check stays close-based; `priceAtPrediction` is still recorded (it's the level the card printed). Replay (same 5 wks, 30 calls, identical fetch): live hit-rate unchanged (11/19 5d, 9/19 10d); shadows netted a wash (5d 2→3, 10d 3→2); avg excess drifted ≤0.04pp — Fri→Mon gaps were small on these large caps. Seed reground on identical 2y data: same 816 outcomes, hits 384→377 (47.1%→46.2%), concentrated in short:red:25-40 (−5) and long:amber:25-40 (−3), offset by short:green:25-40 (+3).
- **Earnings inside the horizon → SHADOW, not half-size.** A binary print is a coin flip; half-sizing it onto the live board just pollutes the calibration buckets the learning loop feeds on. `buildBoard` now forces `shadow` (riskPct 0, instrument null, off `engine-board`) when `earningsRisk`; the flag is kept on the ledger so we can later ask "does the engine have edge INTO prints?".
- **One outstanding shadow per sym+side.** In the replay CEG ate three shadow slots in three weeks saying the same wrong thing — correlated outcomes teach nothing while starving fresh names. `buildBoard` skips a shadow candidate if a recent prior date (last ~10 in `predictions-index`) still holds an ungraded (no `outcome5`) prediction for that sym+side; live calls are exempt, freed slots fall to the next-ranked shadows.

## Amendment 2026-07-02 (3): insider rotation + smartMoney experiment

- **Insider coverage across the full roster (Fix A).** `buildBoard` fetched Form-4 insider buys for the watchlist only, so ~75 roster names always went to a null factor. New `collectInsiderCoverage()` (insiders.ts) caches each symbol's summary 24h under `insiders:cov:${sym}` (distinct namespace from market-data's `insiders:${list}` key — avoids a single-symbol collision) with an explicit `{summary:null}` marker so "checked, no buys" (factor 0) is distinguishable from "never checked" (factor null). Each run fetches the watchlist plus a deterministic date-rotated slice of ~20 non-watchlist US names (`start=(dayIndex*20)%n`, no Math.random), chunked to 15/call (fetchInsiderBuys' internal cap) — full roster accumulates over ~3-4 runs. Wired via a new `insiderCoverage` engine dep. Live dry-run: 23/65 checked on a cold store, 3 with buys (RIVN/SOFI clusters).
- **13F smart-money overlap as a 9th factor (Fix B, an EXPERIMENT).** `smartMoneyFactor` (+25 fund newly-bought/increased, −20 exited, clamp ±30, detail names the fund(s) and states the "13F, filed <date> — up to 45d lag" staleness; null when unmatched). Issuer→ticker matching (`matchSmartMoney` in edgar.ts) is deliberately conservative — exact normalised equality against a curated alias map and/or the `cap:` cache company name, never prefix/substring — because a wrong match is worse than a miss. `edgar:fund-moves` gets a 12h cache. Added to `FactorName`, `DEFAULT_WEIGHTS` at **0.3** (intentionally small). Matchable roster fraction is low by design (the roster is mostly small-cap momentum names these value funds don't hold); dry-run fired on 3/65 (NVDA/META/UNH via Scion). **Explicit expectation: the IC learning loop may decay smartMoney's weight to the [0.4× base = 0.12] floor — that is a VALID outcome, not a bug. The point of the experiment is to let the loop measure whether stale 13F overlap carries any edge, and kill it if not.**
- **Weight migration.** `migrateWeights()` (calibration.ts, called in `loadState`) backfills any factor key absent from a stored/seeded weights snapshot (seed.json predates smartMoney) into base/current/ic, so an old blob never silently zeroes a new factor. seed.json intentionally NOT regenerated — the backtest doesn't replay smartMoney and the migration handles the missing key.

## Amendment 2026-07-02 (4): AI roster nominations

A one-way pipe from the paper's LLM to the engine's ROSTER (its hunting ground) — never its board. The engine stays 100% LLM-free; a nomination is just one more candidate source facing the identical capacity≥8 / dollar-vol≥$5M / price≥$1 gates and the full factor stack. The `discovery` compose section (no new LLM call) gains a `nominations` field: up to 3 tickers, each REQUIRING a cited concrete headline/event, explicitly told a nomination is not a trade call and must not name an engineBoard/watchlist ticker. `validateNominations` (newspaper.ts, pure/tested) cleans junk→clean (uppercase /^[A-Z0-9.-]{1,10}$/i, non-empty reason ≤180 chars, dedupe, max 3); `mergeNominations` persists blob `ai-nominations` ({sym,reason,date,at}, newest-wins dedupe, 7-day/~5-session expiry, cap 15, written even when empty so expiry advances). `buildBoard` reads the blob and `addSource(sym,'ai-nomination')` for unexpired entries alongside screener/social/rotation/watchlist. **Timing:** compose runs AFTER predict in the daily chain, so nominations naturally feed the NEXT morning's board. **Attribution:** the roster entry already carries `source`, so an ai-nomination join/drop is recorded in `engine-roster` + `engine-roster-log` automatically — no extra code.

## Amendment 2026-07-02 (5): world-tape regime refinement + news-tone logging

The engine fires 05:20 UTC — Asia closed, Europe open, US futures live — so the overnight world tape carries real information the daily regime (SPY/QQQ closes) can't yet see. `shared/engine/worldTape.ts` (pure/tested) reads it and nudges conviction, bounded and attributable.

- **Vote rule.** Each of ^N225/^HSI/^GDAXI/^FTSE/ES=F/NQ=F casts an **off** vote at ≤ −0.75% or an **on** vote at ≥ +0.75%; ^VIX adds one extra **off** at +5% or more, one extra **on** at −5% or less. `tone = risk-off` when off ≥ 4 and on ≤ 1, `risk-on` mirrored, else `mixed`. A null read (source down / no fresh bar) casts nothing — fail-soft. Symbols route via Yahoo candles (derive change from the last two closes; `isYahooSymbol` sends `^`/`=F` to Finnhub, which won't serve them).
- **Bound.** `worldMult` is the ONLY allowed set: risk-off → long ×0.85, short ×1.1; risk-on → long ×1.1, short ×0.85; mixed → 1. So the tape can add at most **+10%** conviction and shave at most **−15%** — applied in `composeCall` after the regime multiplier, before the dead-zone check, so it can move a marginal call across the 25 line but nothing more.
- **Calibration-bucket invariant.** World tape scales |composite| (conviction/band) only; the `regime` STRING that keys the calibration bucket (`side:regime:band`) is passed through UNTOUCHED. The overnight tape never changes which regime bucket a prediction learns in — that stays anchored to the SPY/QQQ regime. Each call records `worldTape:{tone,mult}`; the board blob records `worldTape:{tone,votes,detail}`.
- **Global news tone — DISPLAY / LOG ONLY, explicitly NOT a factor.** `newsTone(titles)` sums polarity over ALL media titles on the same POS/NEG lexicon `newsFactor` uses (exported, not duplicated): score ≤ −4 sour, ≥ +4 upbeat, else neutral. Written to the board blob (`newsTone`) and appended to `news-tone-history` (bounded 250; `engine` fn surfaces the last 30). It touches no composite, factor or multiplier — factor status must be EARNED from this logged history before it may ever enter the maths.

## Amendment 2026-07-02 (6): India watch

Light-touch, context-only awareness — NSE/BSE aren't tradeable in the user's ISA, so this adds no factor and no scanning job. `^NSEI` ("Nifty 50") joins `WORLD_SYMBOLS` in `shared/engine/worldTape.ts`: India's session is live at the engine's 05:20 UTC run alongside Europe, so it casts an off/on vote under the same existing ±0.75% rule — no special-casing (Yahoo serves its daily candles same as the other index/future symbols). `MEDIA_FEEDS` (`netlify/functions/lib/engine.ts`) gains two verified Indian headline feeds — `ET India` and `LiveMint` — flowing into the same paper headlines / per-ticker news matching / logged news-tone surface the other five outlets already use. The overall title cap was raised 30→40 so the two new feeds don't crowd out FT/MarketWatch/CNBC/Barron's/Bloomberg.

## Amendment 2026-07-02 (7): T212 holdings auto-tracking + levMap seed + config preservation

- **Config merge-on-write (bug fix).** The phone's `mirrorConfig()` builds its PUT from the local watchlist/rules/notes only — never the engine-only fields — so every routine phone sync used to WIPE the seeded `levMap`, the manual `riskRungOverride` pin and `favouriteChannels`. `config-sync` PUT now merges: an absent field preserves the stored value; an explicit value (incl. an explicit `null` override) replaces. `validateConfig` now distinguishes an ABSENT `riskRungOverride` (→ `undefined`, preserve) from a present-but-invalid / explicit-null one (→ `null`, "engine decides"), so the merge can tell "phone left it out" from "user cleared the pin". The prod `levMap` was seeded via the API (GET → merge → PUT → GET verify) with the name-verified `.L` Leverage Shares tickers.
- **T212 holdings auto-tracking.** The fetch + `normalizeT212Ticker` moved to `netlify/functions/lib/t212lib.ts` (`fetchT212Positions(env, fetchFn?)` → normalized positions or null on any failure; `t212.mts` reuses it). The daily `buildBoard` fetches the real book fail-soft, writes blob `holdings` `{at, positions}`, and joins held symbols to the roster CANDIDATE pool with `source: 'holding'` — same capacity/liquidity gates as any mover, added LAST so a large book never evicts the movers from the 110-candidate cap, and NOT watchlist-immortal. It then writes blob `holdings-reads` `[{sym, stage, entryQuality, note, capacityPct, pplPct, quantity}]` — the engine's read-only daily opinion on every holding (cap 80, per-holding fail-soft → null stage for an unreadable name). The paper's compose data gains `t212Holdings {count, totalPpl, top:[≤8 by |pplPct|]}`; `/api/engine` surfaces `holdingsReads`; the Desk shows an austere collapsible "T212 holdings" pane (blue only on the marker) that is read-only tracking — the existing import button remains the way to journal a position for stop alerts.
