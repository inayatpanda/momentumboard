# Funnel Surgery + Regret Learning — Design

**Date:** 2026-08-11 · **Status:** approved in dialogue, pending owner review of this doc
**Supersedes nothing; extends** `2026-07-02-prediction-engine-design.md` and the three-layer redesign (5104ed8).

## 1. Problem

Owner verdict: "so many easy win stocks have come and gone, even the famous ones… you are still stuck at short Tesla, JACK etc." Concrete example: Corning (GLW) dropped hard after earnings, owner bought, +30%; the engine never saw it.

Measured (Helm mirror, 28 editions to 2026-08-11):

- 6 of the last 10 editions had **zero actionable picks**; 3 dates missing entirely (quota-dead runs).
- 24 of 32 picks are grade **B**; 1 A ever. Grading carries no information.
- 25 unique tickers, skewed small/mid momentum (NRGV/PATH/JACK ×3). Famous names ~absent.

Owner-selected miss classes: **big names on big news**, **steady runners** invisible to a movers-only scanner, **empty board days** — and (spec-review addition) **hype runners**: occasional small/mid caps in mid-mania (AAOI, the quantum cluster), explicitly acknowledged as unreliable, to be ridden sized-down rather than trusted.

## 2. Diagnosis (from the 2026-08-11 code map; file refs at that date)

1. **Discovery cannot see dips.** Screens = `day_gainers`, `most_actives`, `small_cap_gainers`; `day_losers` is typed but never fetched (`lib/screener.ts:5`). A GLW-style post-earnings drop never enters the funnel, and a momentum engine would read it as a short anyway — there is no dip-buy lane.
2. **Megacaps are structurally excluded.** `JOIN_CAPACITY = 8` (p80 |10-session move| ≥ 8%) keeps calm large caps out of the roster (`shared/engine/roster.ts:60`); the trim sheds the largest caps first (`roster.ts:94-108`). Discovery only admits them via `most_actives` or top-2-sector membership.
3. **Grade A is arithmetically unreachable.** A needs a non-provisional bucket at p ≥ base+0.12 = 0.487; the best well-sampled bucket is 0.440. The 70+ composite band has **no bucket anywhere**, so the engine's highest-conviction calls fall to base rate → grade C → watch-only (`calibration.ts:137-186`). Every published trade is B by construction.
4. **Probability is a step function of (side, regime, band, cohort) only.** Composite 26 and 39 grade identically. In a green tape an ordinary long (25-40 band) = 0.392 → C → watch-only, while a thin pooled short bucket (n=8, p=0.500, provisional) → B → tradeable. This is "stuck at short Tesla".
5. **Learning is nearly inert.** 8 of 10 factor weights have zero IC observations (null/zero scores are skipped, `calibration.ts:297`); the two that move have shifted <1% over 778 observations. A factor with zero contrary evidence still decays (`meanDisagree` defaults 0). `setupBuckets` (778 obs), `bySetup`, pattern sightings, news-tone, overlay stats: collected, never consumed. The scorecard feeds nothing back.

## 3. Owner decisions (2026-08-11 dialogue)

1. Learning must also **learn from misses** (miss ledger + gate attribution + bounded feedback), not only grade its own calls.
2. The board is **never blank**: always the best 1–3 per side, honestly graded, risk-sized by grade.
3. Factor priority: **charts (EMAs, volume) → recent trend + stock news → major geopolitical news → sector** — with geopolitics acting as tape/sector tilt and news also *nominating* candidates.
4. Voice: **decisive calls with a stated falsifier**; when a call fails, say why it failed, record it, move on.
5. Approach A chosen over (B) continuous ML probability model and (C) quick-wins-only.
6. A **wildcard lane** added at owner request, with its design fully delegated to Claude — chosen as the experiment slot (§4.1) because it converts the miss ledger's correlational regret into causal evidence.

Standing constraints: $0 data cost; GH Actions runtime stays within a few minutes of today's ~19 min/day; calibration discipline intact (context can't invent calls; hit definition untouched).

## 4. Design

### 4.1 Seeing (universe + discovery)

- **Core sleeve**: curated list of ~120 liquid famous names — US megacaps + household names (incl. GLW), high-beta favourites (AMD, PLTR, COIN, MSTR…), liquid T212-routable UK large caps (RR.L, BP.L, SHEL.L…). Lives in shared config under `coreSleeve`, merged via the established `withDefaults()` union (config-blob staleness trap). Admin-editable later; not this project.
- **Evaluation budget**: one batched Yahoo quote call ranks the sleeve by *unusualness* = |today's move| / own typical move; top ~40 join full candle evaluation. Candidate budget 110 → ~180. Priority slot for sleeve movers ≈ catalyst tier; quiet sleeve names cost one quote row only.
- **Roster bypass**: sleeve names are permanent candidates — `JOIN_CAPACITY` and the largest-cap-first trim do not apply to them. Roster continues to govern discovered names.
- **`day_losers` wired** as a fourth screen (one-line fetch + tests). Feeds short candidates *and* the dip-buy lane.
- **Dip-buy lane** (setup family `reversal`, long): eligible names = core sleeve or cap > $10B. Trigger: drop ≥ 12% from 20-session high, or gap-down ≥ 7% on earnings/news. Hold evidence required (this is the knife guard): close back above the 50-EMA **or** reclaim of the trigger-day low, on volume ≥ 1.5× 20-day average; no new 5-session low on entry day. Costs 1–2 days of entry lag by design.
- **Capacity rethink**: the flat capacity floor (6, catalyst-relaxed 4) is replaced for sleeve/large names by per-name expectation scaling — targets, stops and ladder size scale to the name's own `typical10dMovePct` (existing machinery). A 6%-mover GLW is a valid, smaller-sized trade.
- **Hype/velocity lane** (setup family `velocity`, long; owner examples: quantum 2025, space + AAOI 2026 — "not saying these are reliable", and the theme is variable year to year). **Theme-agnostic by principle: no theme is ever hard-coded.** Manias are recognised from the tape's own signature. Two doors into one lane:
  - **Early door — catch the start**: break of the 20-session high on relative volume ≥ 3× the 20-day average (computed from candles we already fetch — no new data). Enters at **quarter size**, stop under the breakout level; most breakouts fail, so commitment is small.
  - **Confirmation door — ride the middle**: +15% over 5 sessions or ≥3 up-days of 5 on volume ≥ 2× average, **with an entry-timing rule**: never buy the Nth consecutive green day — enter on the first pause that holds the 8-EMA, or the reclaim after it. Trades at **half size**. Prevents systematically buying the blow-off candle on sharp AAOI-shaped pops.
  - **Discovery**: `day_gainers` deepened 25 → 50 rows (same single call). **Hype-cluster detection keys on social co-mention + abnormal return co-movement** (names talked about together *and* moving together within a rolling week, ≥3 names), with sector/theme tags only as a hint — IONQ/RGTI/QBTS never shared a clean tag. Detected cluster members get elevated candidate priority. The static theme list survives only as a seed and earns no special trust.
  - Both doors carry a tight trailing falsifier (first close below the 8-EMA or the 5-session low, whichever is nearer), are labelled explicitly as momentum-not-quality, and grade under the `velocity` family so the per-setup calibration (§4.3) learns what hype-riding is actually worth and promotes or buries the lane on evidence.
- **Crypto lane** (calibration cohort `crypto`; owner request at spec approval). Universe: **BTC-USD, ETH-USD, SOL-USD only** — majors with reliable free Yahoo candles; alts/memecoins are out of scope. Evaluated daily sleeve-style (three quote rows + candles). **Crypto-native regime**: BTC vs its own 50/200-EMA sets a crypto tape (green/amber/red) independent of the equity regime; ETH/SOL calls require BTC-regime agreement. Signal logic reuses the existing lane mechanics (continuation, dip-buy with knife guard, velocity doors) — no bespoke crypto indicators. **Own calibration cohort with its own benchmark**: hits for ETH/SOL measure excess vs BTC, BTC measures absolute +1pp — an *additive* cohort; equity buckets, hit definition and `CALIB_DEF_VERSION` untouched. **Routing**: crypto-native symbol on the board, routed like levMap does — to the T212 trackers (BITP.L / ETHC.L, seen in the 2026-07-25 catalogue pull) or proxy equities; live ISA routability is verified against the owner's T212 catalogue during implementation, and anything unroutable runs as a labelled shadow rather than pretending. **Half-size initially** — the cohort earns standard sizing only when its buckets prove out. Crypto trades weekends and the engine already publishes weekend editions, so crypto falsifiers are checked on every edition, not just trading days.
- **Wildcard lane — the experiment slot** (design delegated to Claude by the owner, 2026-08-11). One slot, **quarter-size hard cap**, a new wildcard only when the previous closes (~weekly at the 10-session horizon); never counts toward the 3/side board caps; excluded from risk-ladder rung progression; stop mandatory; must be T212-routable or it runs as a shadow. Purpose: generate the evidence the learning loop cannot otherwise get — blocked calls produce no outcomes, so gates only ever accumulate *correlational* regret; the wildcard actually takes a blocked trade and produces **causal** evidence. Deterministic selection priority: (1) the highest-composite idea blocked by exactly one gate, preferring the gate with the thinnest ledger evidence; (2) any 70+ composite candidate (the band with zero calibration data anywhere); (3) an LLM catalyst nominee with chart corroboration that just missed the dead zone. If nothing qualifies, no wildcard that week — experiment slot, not a quota. Voice: distinctly labelled ("🃏 Wildcard"), states the hypothesis under test, warns it loses more often than the board; mandatory post-mortem win or lose. Outcomes feed calibration buckets normally AND write causal per-gate evidence into the miss ledger, tagged `wildcard` so its record stays separable; a winning wildcard streak against one gate is the strongest trigger for §4.3's bounded loosening.

### 4.2 Scoring + conviction

- **Technical factor upgraded** to read EMA structure (8/21/50 stack alignment and price position) and volume confirmation/thrust; verify what it reads today and extend, don't replace. Weight re-base to owner order: technical 1.0, momentum/trend 0.9, catalyst/news = strongest context slot, social/channels unchanged, sector demoted to last. `worldTape` stays the geopolitical tilt. Context cap and "context can't create or flip a call" invariants unchanged.
- **Continuous probability**: within-band piecewise-linear interpolation across band midpoints of the calibration table, shrunk toward the pooled estimate by n/(n+k) (k≈25). The 70+ region extrapolates from the 55-70 estimate, never *below* it. Bucket keys, hit definition, `CALIB_DEF_VERSION` unchanged — this changes the read path, not the evidence.
- **Grade A reachable**: pooled (rung-3/4) buckets with n ≥ 30 count as non-provisional evidence; A threshold base+0.10 (was +0.12 with per-name capacity ≥ 8, which dies with the capacity rethink). Raw probability printed beside every grade.
- **Never-blank board**: top 1–3 per side by rank, always named. Sizing: A = full ladder %, B = standard, C = **half**, below-base = shown with its probability but watch-only (money never goes on a below-base call — if a whole side is below base, the board says so explicitly rather than hiding the names). Evidence-contract failures may trade at half size and must name the missing evidence. Watch list unchanged.
- **Thesis + falsifier** on every call: deterministic template from the dominant factors ("Long GLW — overdone earnings reaction, holding the 50-EMA on rising volume. Wrong if it closes below 41.80."); stored on the prediction; LLM may polish wording, constrained to the stored facts. The falsifier is the stop the alerts already watch.

### 4.3 Learning (regret + post-mortem + repairs)

- **Funnel snapshot** `funnel-trace:{date}`: every symbol seen today → furthest stage reached and the gate that stopped it (`not-candidate` / `no-data` / `dead-zone` / `evidence-fail` / `grade-watchonly` / `trimmed` / `called`). Compact (symbol → code), written by `buildBoard`, fail-soft.
- **Miss detection** at +10 sessions, inside the existing grading pass: names not called whose 10-session excess vs SPY ≥ +5pp are misses; each charged to its snapshot gate. `miss-ledger` blob accrues per-gate `{cost, saved, examples}` — *saved* = names the gate blocked that went on to lose. Both sides always counted.
- **Bounded gate feedback**: a gate is eligible to move one notch when it has ≥ 30 attributed outcomes AND cost > 2× saved. Eligible gates and hard bounds: dead-zone 25 → floor 20; capacity floor 6 → floor 4 (where still applicable); context cap 12 → ceiling 16; evidence-contract core-agreement 2 → floor 2 (i.e. reportable but immovable for now). Max one notch per gate per 20 sessions; symmetric tightening when saves overtake cost; every move logged to the ledger, announced in the paper and on the engine panel. No other constant self-adjusts.
- **Post-mortems**: when a call closes as a loser, deterministic classification against its falsifier — `stopped` (stop hit), `thesis-break` (falsifier condition met), `market-drag` (lost absolutely but excess ≥ 0), `news-reversal` (catalyst tone flipped) — plus one plain LLM sentence in the paper, fail-soft to the deterministic line. Stored per call; aggregated by setup family × regime so the engine knows *how* it loses.
- **Weight-loop repairs**: (a) `nDisagree = 0` → skip the nudge instead of decaying against phantom evidence; (b) factors where zero is a genuine reading (news tone, seasonality) accrue IC on zero scores; null still skipped; (c) `setupBuckets` finally consumed — blended into probability at weight 0.3 once a `setup:side:band` bucket reaches n ≥ 30 (earn-influence rule); `velocity` joins continuation/reversal/fade as a fourth setup family so hype trades are graded on their own record; (d) `bySetup` surfaced in the client scorecard type. Pattern sightings and news-tone keep accruing untouched.

### 4.4 Deep seed — learning from the past year (owner request, 2026-08-11)

Rather than waiting for live evidence, pre-train everything **price-derived** on 1–2 years of history via an expanded `scripts/seed-engine.ts` replay: full core sleeve + historical movers, all lanes (continuation, dip-buy, velocity doors), core factors, world-tape tone (oil/VIX/gold/futures are just historical prices), graded with the SAME 10-session hit definition, accumulated **chronologically walk-forward** — each replayed day sees only data before it, so bucket probabilities are honest at every step. Deliverables: thousands of observations across all bands (the 70+ band and setup buckets get real samples; grade A earnable at launch), seeded IC stats for all four core factors, and a measured historical record for the dip and velocity lanes *before* they go live. **Honesty rules:** price-derived inputs only; no LLM-reconstructed news/social/pundit history ever feeds learning (hindsight contamination — the model knows what happened next); context factors stay null in the replay exactly as the current seed does; hit definition and `CALIB_DEF_VERSION` unchanged (same-definition seed regeneration is the established pattern, cf. the 10d switch in 21441fd). Historical *real* news archives (e.g. GDELT) are out of scope for now — revisit only if the price-only deep seed proves insufficient.

### 4.5 Data flow and error handling

Daily order unchanged: grade (now also: detect misses, write ledger, run post-mortems) → buildBoard (now also: sleeve quotes, losers screen, dip lane, funnel snapshot) → trace open ideas → compose. Every new component is fail-soft: sleeve quote batch or losers screen failing → today runs like yesterday; snapshot/ledger write failing → board still publishes; LLM post-mortem failing → deterministic sentence. New Yahoo load: 1–2 batch quote calls + ~40 extra candle fetches/day, within free tier; expected runtime +2–4 min.

## 5. Testing

- TDD per mechanism; suite currently green (~575 tests) stays green.
- Unit: sleeve merge + unusualness ranking; losers wiring; dip-lane trigger/hold/knife-guard truth table; velocity trigger + theme-cluster detection (≥3 co-occurring names, rolling week) + trailing-falsifier maths; wildcard selection determinism (priority order, one-slot invariant, no-candidate → no-wildcard, ladder exclusion); interpolation monotonicity (p non-decreasing in composite within side/regime/cohort; 70+ ≥ 55-70); A-reachability; sizing by grade; snapshot gate attribution; miss detection vs SPY excess; feedback bounds + notch cadence + symmetry; post-mortem classification precedence; IC repair cases.
- **Replay acceptance** (existing `scripts/engine-replay.ts` over the mirrored July–Aug window) before deploy: (1) zero blank boards across the window; (2) GLW-class dip names become visible candidates; (3) ≥ 1 core-sleeve name reaches a board during the window; (4) grade distribution is no longer ≥ 90% B; (5) no regression in win5/avg5 vs the shipped engine on the same window; (6) **velocity honesty check** — run both doors over the actual candles of the named runners (AAOI, the space cluster, and 2025's quantum names as an out-of-window probe): the fired entry dates must land *inside* the run with the trail exiting green on the winners, not at the top — or the lane doesn't ship.

## 6. Rollout

Four stages, each an independently shippable commit set on `main` (Netlify auto-deploys; **no Co-Authored-By trailer**):

1. **Seeing + never-blank board** — sleeve, `day_losers`, dip-buy lane, sizing-by-grade, capacity rethink. Immediate relief.
1b. **Velocity + crypto lanes** — two-door velocity with cluster detection; the BTC/ETH/SOL cohort.
2. **Scoring + grades + voice** — factor re-base, EMA/volume upgrade, continuous probability, A-reachability, thesis/falsifier. `ENGINE_MODEL_VERSION` 2 → 3.
2b. **Deep seed** — the §4.4 historical replay, regenerated after stage 2's scoring changes so the seed reflects the shipped model (running it before would seed the OLD factor mix).
3. **Learning** — snapshot, miss ledger, gate feedback, post-mortems, IC repairs, setup-bucket consumption, and the wildcard slot (it needs the ledger's gate machinery).

Per session protocol: the implementation plan goes through codex + DeepSeek review before any code is written.

## 7. Out of scope

Continuous/ML probability model (approach B); paid data sources; Twitter/X or Discord ingestion; admin UI for sleeve editing; changing the hit definition or `CALIB_DEF_VERSION` for existing equity buckets; renaming grades; desktop layout work; crypto beyond BTC/ETH/SOL (alts, DeFi, memecoins, on-chain data).

## 8. Success metrics (4 weeks post-stage-3)

- 0 blank actionable boards on trading days.
- Famous names: ≥ 1 core-sleeve name on the board in any week where the sleeve's best mover beat SPY by 5pp.
- Grades: A appears when earned; B no longer ≥ 75% of picks; C trades at half size instead of vanishing.
- Every closed losing call has a stored post-mortem line in the paper.
- Miss ledger live with per-gate cost/saved; first bounded gate move (if any) correctly announced.
- Velocity lane: when a hype cluster forms (≥3 co-moving theme names), its members appear as half-sized labelled trades or the miss ledger records which gate blocked them.
- Wildcard: present most weeks a candidate exists, hypothesis always stated, post-mortem on 100% of closures, record separable from the board's.
