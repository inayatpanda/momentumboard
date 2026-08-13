# Stage 2b — the 2-year walk: results and the decision it forces

**Date:** 2026-08-13 · **Artefact:** generation 2, defVersion 3, modelVersion 3 (scratchpad `stage2b/seed-candidate.json`, not committed) · **Command:** `replay-window.ts --from 2024-08-12 --to 2026-08-11 --seed-out … --seed-generation 2` · **Wall-clock: 25.5s** (recon estimated 8–13 min; the perf contingency was never close to needed) · **API calls: 0** (all 187 symbols from `.replay-cache/`).

## What the walk produced (vs the committed seed)

| | committed (gen 1) | deep seed (gen 2) |
|---|---|---|
| graded rows | 778 | **6,790** |
| main buckets | 11 | **21** (every below-70 slice populated ×6/6) |
| setup keys | 9 (no velocity) | **23** incl. `velocity:long:{25-40,40-55,55-70}` = 635 rows |
| 70+ band | **0 rows anywhere** | 1,398 rows (long:green 1,270 · short:red 82 · short:amber 46) |
| IC computable | technical uncomputable (778/0 all-agree), 8 factors 0/0 | **all four core factors** (tech 5161/552 · mom 5697/15 · seas 3724/1882 · sector 562/51) |
| velocity historical record | none | 2,434 shadow rows / 959 hits (39.4%) |
| base rate | 0.3670 | **0.4161** |
| blank boards (walk) | — | 0/501 · zero-trade days 64/501 |

Per-(side, regime) band table (n/hits):

| slice | 25-40 | 40-55 | 55-70 | 70+ |
|---|---|---|---|---|
| long:amber | 349/167 | 484/212 | 566/228 | — |
| long:green | 381/138 | 524/220 | **584/282 (48.3%)** | **1270/528 (41.6%)** |
| long:red | 294/112 | 367/149 | 86/47 | — |
| short:amber | 373/131 | 97/39 | 80/34 | 46/19 |
| short:green | 672/277 | 121/65 | 44/24 | — |
| short:red | 188/66 | 115/37 | 67/26 | 82/24 |

**Structural A-reachability gate: PASS** — three slices carry n ≥ 30 in BOTH straddling bands (long:green, short:amber, short:red), long:green among them. bornBelowCensus: the 25-40 band is populated in every slice — the C-cap fires for conviction reasons, not missing-slice reasons. Walk-forward honesty: `sliceBefore` point-in-time slicing is test-pinned; the walk starts from an EMPTY calibration stamped generation 2 (the committed seed provably cannot swap itself in — guard test landed in c6f48fc).

## The finding that stops the stage: the curve is flat where it matters

`long:green` hits **48.3% at 55-70 but 41.6% at 70+** — the top band performs at the base rate. PAVA correctly pools the inversion flat (~0.437 max read), and every other slice tops out lower. Meanwhile the base rate the grades are measured against ROSE to 0.4161 (the board-driven population is selected, so its base is high — recon §7.4 predicted precisely this trade-off). Result: **no read anywhere clears base + 0.05.**

**Acceptance re-run (July-14 → Aug-11 window, candidate installed as cold start): 531 of 531 rows grade C.** Distinct probabilities 12 (range 0.35–0.46 — the curve is alive, just compressed below the B-bar). Blank boards 0/21, zero-trade days 0/21. Task 4's gate "grade distribution not ≥90% single-grade" **FAILS** — by its own design.

What this measurement actually says: **within the population the engine publishes, the v3 composite's conviction ladder does not separate outcomes** — a composite-75 board row has not (over these 2 years) beaten a composite-45 board row by enough to earn a grade step. The old seed made B/A attainable only because it measured a different question ("is a board pick better than ANY gate-clearing call?" — yes, by a lot). The deep seed asks "is a HIGH-composite board pick better than a low one?" — and the honest answer today is "barely".

## The decision (owner's, not mine — it alters grading semantics)

1. **Reference-anchored grading.** Keep the board-population buckets (they price probability honestly) but anchor grade thresholds to a FIXED reference base (the unconditional sweep base ≈ 0.37, stored as its own field) instead of the pooled bucket base. Board rows then grade B at ≥ 0.42, A at ≥ 0.47 — long:green 55-70 reads B, and A stays rare but earnable. One field + one line in `gradeFor`; the semantics become "graded against the market's gate-clearing odds", which arguably matches what a reader thinks a grade means. **My recommendation.**
2. **Ship as measured.** Install the seed; accept an all-C, half-size board until Stage 3's learning improves discrimination. Maximally honest; violates spec §8's "A appears when earned / B no longer ≥75%" in spirit (single-grade distribution) and regresses Stage 2's headline (B at 57.1%).
3. **Seed from the sweep population instead** (recon §2.5 option A). Restores attainable grades by measuring against the unconditional population — but mismatches the population live accrual adds to the same buckets, so the base drifts upward over months and grades silently tighten. The plan rejected this for that reason.
4. **Don't install; keep the committed seed.** Foregoes everything the walk fixed (empty 70+, dead IC, no velocity record). Not recommended.

Option 1 preserves every deliverable of this walk AND the meaning of grades; it needs a short ratified addendum to the spec (grade thresholds anchor to a stored reference base; CALIB_DEF_VERSION unchanged — grading is presentation over the same outcomes, not a hit-definition change).

## Also recorded

- Momentum IC nDisagree = 15 (thin but computable; the factor almost never disagrees with the composite's sign inside the published population — worth watching in Stage 3's IC repairs).
- Cohort-tagged keys: 0 in the artefact (cohortless 3-part keys, matching the committed seed's shape — cohort rungs fill from live accrual, per the fallback-ladder design).
- Zero-trade days 64/501 (12.8%) — the walk spans the 2024-08 → 2025-04 chop; not a defect, the board held C/watch rows those days (blank boards 0).
- The three pre-walk refusal guards (probe-seed exclusion, generation floor, `--symbols` hygiene) landed in c6f48fc after Task 2's review; the generation floor is why a Task-4 world can't accidentally warm-start a future walk.

## Addendum — the regenerated artefact and the sized-only truth (option 1 executed)

**referenceBase measured = 0.4158** (unconditional sweep, 166 symbols — the walk's own asked-universe, 4,178 rows) vs pooled 0.4161: the yardstick the owner chose exists and sits exactly where the pool sits. Acceptance window under the final artefact: still 531/531 C. The old committed seed's 0.367 base — and therefore today's live B-grades — were an apples-to-oranges artefact (66 symbols, different window, v2 model).

**But the sized-only decomposition changes the story.** The 1,259 rows readers would actually trade (watch and shadow rows excluded):
- Aggregate: 42.3% graded hits (+0.8pp over reference) and **+3.05pp mean excess per trade** (median 0 — right-skewed, big winners carry it; the engine makes money on magnitude, not frequency).
- **`long:green:55-70`: 67/117 = 57.3% — clears the A-bar** (≥0.5158, n≥30) on its own merits.
- **`long:green:70+`: 250/612 = 40.8% — the inversion is real in the sized data**, not a dilution artefact. The composite's top end is overconfident; PAVA correctly pools the 57% cell down against it (to ~43.5%), which is what erases the A.
- The velocity lane's 2,434 shadow rows (39.4%) additionally dilute every bucket they touch — by ratified design ("graded, learning"), but the provenance is not partitioned at read time.

**What this means:** grades cannot honestly separate until two Stage-3 items land: (1) provenance-partitioned bucket reads (sized evidence grades sized rows; shadow evidence prices shadow rows), (2) the 70+ inversion investigated as a MODEL question (why does maximum conviction underperform?). Both are learning-stage work, now with the data to do it.

**Ship recommendation:** install generation 2 as measured (all-C at half size, honest probabilities, thesis/falsifier voice carrying conviction in words), because the alternative — keeping generation 1 — shows readers B-grades manufactured by a stale yardstick. Everything is reversible: a generation-3 seed re-installs in a 25-second walk + deploy. NOTE: the plan's Task-4 gate "grade distribution not ≥90% single-grade" fails by construction under any honest yardstick this window — shipping requires the owner to explicitly waive that gate with the evidence above in hand.

---

## Addendum 2 — generation 3: the seed is measured under the vector production scores with

**Why generation 2 never installed.** It was committed (b029a00) and would have installed at the next 05:35 predict run; Stage 3's recon (§0.1) read the artefact before that happened and found the defect. `weights.current` carried the walk's ~450 compounding IC nudges — `next = cur·(1 + 0.15·ic)` every 15 graded rows, with no stability bound and no floor at all once `PRUNE_MIN_N` lifts it. The shipped vector was technical **0.0791** against a base of 1.0, momentum **1.8** (the hard 2× cap), sector 0.598, seasonality 5.75e-05. The composite is a weight-normalised core mean, so that is momentum **72.7%** of production scoring and technical **3.2%** — the owner's ratified factor order (spec §4.2: charts/EMAs/volume first) inverted. Worse, the buckets were accrued *under that drifting vector*: the measurement and the vector production would score with disagreed, so the calibration priced rows the live engine would never produce.

**The fix (three pieces, all test-first).**
1. `scripts/replay-window.ts` — in seed mode only, after each day's `gradeOutstanding`, `current` is pinned back to `base`. `ic`, `gradedSinceNudge` and `history` keep accruing: the IC **measurement** continues, only the **applied** vector is frozen at `DEFAULT_WEIGHTS`. Bounding the nudge itself is Stage 3c's stability work; it does not belong inside a seed.
2. `seedArtefactFrom` throws when any factor's `current` deviates from `base` — belt over braces. `base` drift was already caught because `rebaseWeights` reacts to it on load; `current` drift is reacted to by nothing, which is exactly why it shipped.
3. Re-walked as generation 3 (`--from 2024-08-12 --to 2026-08-11`, 0 API calls) and committed over `shared/engine/seed.json`.

**What the frozen vector changed.** Same window, same universe, same 501 days — only the scorer held still.

| | gen 2 (drifting vector) | gen 3 (frozen vector) |
|---|---|---|
| `weights.current` | technical 0.0791 · momentum 1.8 · sector 0.598 · seasonality 5.75e-05 | **= `base` = DEFAULT_WEIGHTS** (technical 1.0 · momentum 0.9 · sector 0.3 · seasonality 0.3) |
| graded rows | 6,790 | 6,608 |
| main buckets | 21 | **18** |
| setup keys | 23 | 16 |
| pooled base | 0.4161 | 0.4161 |
| **referenceBase** | 0.4158 | **0.4158 — unchanged** |
| symbols | 159 | 159 |
| IC (core four) | tech 5161/552 · mom 5697/15 · seas 3724/1882 · sector 562/51 | tech 5194/49 · mom 5099/144 · seas 3579/1547 · sector 588/69 |
| evidence | seed 4356/1866 · shadow 2434/959 | seed 4359/1841 · shadow 2249/908 |

`referenceBase` not moving is the cleanest available evidence that the anchor is what it claims to be: the sweep runs `seedFromHistory` over the raw tape, so it never touches the factor stack and cannot move when the scoring vector does. The buckets moved a great deal; the yardstick they are read against did not budge. (Test-pinned in `calibration.test.ts`.)

**And the 70+ inversion largely evaporates.** Recon §9 mechanism 1a predicted that under gen-2 weights the top band was being *flooded* by extension rather than earned by conviction. It was:

| slice | gen 2 | gen 3 |
|---|---|---|
| `long:green:70+` | **1270 / 528 = 41.6%** (below the 48.3% at 55-70 — the inversion) | **26 / 13 = 50.0%** |
| `short:amber:70+` | 46 / 19 = 41.3% | *gone* |
| `short:red:70+` | 82 / 24 = 29.3% | 3 / 0 |

Under the ratified vector only 26 long:green rows in two years reach 70+, and they hit **50.0%** — nine points above the 41.58% reference, and above every band below them (55-70 42.3% · 40-55 43.0% · 25-40 39.6%). The gen-2 top band was 1,270 rows of *most-extended name*, not *maximum conviction*, exactly as §9.1a argued from the arithmetic. **This does not close the Stage-3 70+ item** — n=26 is under `gradeFor`'s nEff ≥ 30 bar, so the honest reading is "the flood is gone and what remains is too thin to conclude from". It reframes the question from "why does maximum conviction underperform?" to "the band that underperformed was not maximum conviction".

**Acceptance window (2026-07-14 → 2026-08-11, gen 3 installed as cold start):** 0/21 blank boards, 0/21 zero-trade days, 529 board+ledger rows → **518 C / 11 B** (gen 2: 531/531 C), 13 distinct probabilities spanning 0.34–0.48, composite range −54.7…+65.3. Task 4's "not ≥90% single-grade" gate still **fails** (97.9% C) — that remains Stage 3c's work, and the owner's waiver from Addendum 1 still stands. What changed is not the grade histogram; it is that the vector behind it is honest.

**Still open, booked for Stage 3c.** The nudge loop is unbounded in *production* too. Generation 3 installs `current = base` and the seed's deep IC beside it, so from the first live nudge the same compounding drift starts again from DEFAULT_WEIGHTS — slower than the walk's cadence, but in the same direction and with the same absent floor. The seed is now honest about its own measurement; the loop that will move it away from that measurement is not yet bounded. Recon §5.2's candidates (a `minDisagree` floor symmetric with `nAgree`, per-factor `[0.5×, 1.5×]` bounds, calendar cadence) are the shortlist.

---

## Addendum 3 — generation 4: measured under the partition, the brakes and the blend (Stage 3c Task 4)

Same instrument, same window, same universe as generation 3 — `npx tsx scripts/replay-window.ts --from 2024-08-12 --to 2026-08-11 --seed-generation 4`, 501 trading days, 36s, zero API calls. What is new is what the engine underneath it now does: it books a **provenance sub-count** on every graded row (Task 1), it measures IC under a **two-sided floor and a hard weight band** (Task 2), and it runs with **`GATES=off` pinned by the walk itself** (Task 4 decision (d) — gate feedback moves on live evidence and a live cadence clock, never on a synthetic tape it could then re-judge its own later days under).

| | gen 3 | gen 4 |
|---|---|---|
| graded rows | 6,608 | 6,554 |
| main buckets | 18 | 18 (**17 now carry sub-counts**) |
| setup keys | 16 | 16 |
| pooled base | 0.4161 | 0.4169 |
| **sized base** | *(no partition)* | **0.4247 on 4,197 rows** |
| **referenceBase** | 0.4158 | **0.4158 — unchanged again** |
| symbols | 159 | 159 |
| IC (core four) | tech 5194/49 · mom 5099/144 · seas 3579/1547 · sector 588/69 | tech 5134/47 · mom 5109/72 · seas 3590/1479 · sector 590/65 |
| evidence | seed 4359/1841 · shadow 2249/908 | seed 4367/1844 · shadow 2187/888 |

`referenceBase` has now held at **0.4158 across three consecutive generations** — through a total re-scoring of the factor stack (gen 3) and through the partition and the blend (gen 4). The sweep runs `seedFromHistory` over the raw tape; it never touches any of them.

### The partition, per band

`shadowN` counts the rows shadowed by the three PRE-GRADE causes (lane stand-down, earnings print inside the horizon, unroutable short). Everything else — including every watch, below-base and grade-null row — accrues SIZED, because those are the band's own recovery record (Task 1's re-ratified discriminator).

| bucket | n | shadowN | sizedN | pooled | sized |
|---|---:|---:|---:|---:|---:|
| `long:green:40-55` | 1828 | 67 | 1761 | 0.430 | 0.428 |
| `long:amber:25-40` | 968 | 129 | 839 | 0.442 | 0.434 |
| `long:green:25-40` | 715 | 248 | 467 | 0.406 | **0.443** |
| `short:green:25-40` | 688 | 688 | 0 | 0.452 | — |
| `short:amber:25-40` | 505 | 505 | 0 | 0.392 | — |
| `long:red:25-40` | 436 | 77 | 359 | 0.346 | 0.351 |
| `long:amber:40-55` | 373 | 17 | 356 | 0.405 | 0.407 |
| `short:red:25-40` | 258 | 258 | 0 | 0.333 | — |
| `long:red:40-55` | 190 | 15 | 175 | 0.437 | **0.463** |
| `short:red:40-55` | 126 | 126 | 0 | 0.325 | — |
| `long:green:55-70` | 123 | 36 | 87 | 0.423 | **0.368** |
| `short:amber:40-55` | 104 | 104 | 0 | 0.452 | — |
| `long:red:55-70` | 89 | 4 | 85 | 0.551 | **0.565** |
| `short:red:55-70` | 63 | 63 | 0 | 0.381 | — |
| `long:amber:55-70` | 47 | 5 | 42 | 0.340 | 0.286 |
| `long:green:70+` | 26 | 0 | 26 | 0.500 | 0.500 |
| `short:green:40-55` | 12 | 12 | 0 | 0.500 | — |
| `short:red:70+` | 3 | 3 | 0 | 0.000 | — |
| **total** | **6554** | **2357** | **4197** | **0.4168** | **0.4246** |

Two things fall out of this table and both matter more than the histogram.

**1. EVERY SHORT IN THIS ARTEFACT IS A SHADOW.** The harness runs with an empty `levMap` by design (§13: shorts are unroutable in *both* runs, so the comparison is fair), which makes every short row `unshortable` — one of the three pre-grade causes. Generation 4 therefore carries **no sized short evidence at all**, and a sized short read falls through every rung to the sized base (0.4247, nEff 0, provisional). That is the honest answer to "how did shorts a reader could actually place do?" — nothing ever measured one — but it is a live behaviour change for the routable shorts production *does* have (`3SMI.L`/`3LAL.L` are in the real levMap), which under generation 3 read the pooled short curve. Test-pinned in `calibration.test.ts` so it is a known property rather than a discovery.

**2. THE UNMASKING PAYOFF WAS ALREADY SPENT BY GENERATION 3.** Addendum 1 predicted this stage from gen-2 data: `long:green:55-70` sized read **57.3%** (67/117), "clears the A-bar on its own merits". Measured now: **36.8%** (32/87). The 57.3% cell was an artefact of the gen-2 nudged vector — the same vector whose inverted factor order Addendum 2 removed — and gen 3 had already collapsed that bucket to 42.3% pooled before the partition ever ran. Across the whole file the shadow dilution is worth **+0.8pp** (0.4168 pooled → 0.4246 sized), not the several points a band would need to cross `gradeFor`'s +0.05 B threshold.

The decomposition that shows where the prediction went, computed off the walk's own 6,554 graded rows:

| slice | rows | hit rate |
|---|---:|---:|
| pooled (everything) | 6,554 | 0.4168 |
| sized by CAUSE (what ships) | 4,197 | **0.4246** |
| …of those, rows that also carried SIZE | 1,234 | 0.4019 |
| …of those, rows that carried none (watch / below-base / grade-null) | 2,963 | 0.4340 |

Addendum 1's decomposition keyed on SIZE. Task 1's review re-ratified the discriminator to the shadow's CAUSE, and the two disagree by 2.3pp in the opposite direction to the prediction: the rows a band demotes to watch go on to do *better* than the rows it sized. Sealing them out (size-keying) would have made every sized band look worse and frozen its recovery — which is the argument the re-ratification was made on, now with a number against it.

### IC under the brakes

| factor | nAgree | mean agree | nDisagree | mean disagree | IC | weight |
|---|---:|---:|---:|---:|---:|---:|
| technical | 5134 | +1.474 | 47 | +1.023 | +0.045 | 1.0 |
| momentum | 5109 | +1.490 | 72 | +0.050 | +0.144 | 0.9 |
| seasonality | 3590 | +1.213 | 1479 | +2.063 | −0.085 | 0.3 |
| sector | 590 | −0.946 | 65 | −2.657 | +0.171 | 0.3 |
| catalyst · news · channels · social · insiders · smartMoney | 0 | — | 0 | — | ineligible | unchanged |

All four measured factors clear the new two-sided floor (`nAgree ≥ 20 AND nDisagree ≥ 20`) on both columns — gen 2's momentum stood on **fifteen** disagreements. `current === base === DEFAULT_WEIGHTS` in the file, as generation 3 established.

**The six zeros are now a deliberate erasure, not an accident.** Task 2's `ZERO_IS_A_READING` admits news's zero, because `newsFactor([])` is the genuine "quiet tape" reading and the factor has no null path. This harness hands it an empty tape every single morning — so the walk booked **5,181 fabricated news observations**, both columns far past the twenty-observation floor, an IC of pure selection (against every long, with every short) that production would have nudged a real weight on at the first pass after install. The emitter drops the IC *and* the history lines of every factor `makeDeps` cannot feed (`WALK_ABSENT_FACTORS`: social, insiders, smartMoney, channels, news, catalyst) and prints what it dropped in the run log. A factor never shown a headline ships no opinion about headlines.

### The acceptance window, gen 3 vs gen 4 — the controlled diff

Both runs at the same commit, same window (2026-07-14 → 2026-08-11), `GATES=off` on both sides so gate feedback is structurally incapable of contributing a change. The only variable is which seed `loadState` cold-starts from.

| | gen 3 installed | gen 4 installed |
|---|---|---|
| blank boards / zero-trade days | 0/21 · 0/21 | 0/21 · 0/21 |
| board graded rows | 200 → **197 C / 3 B** | 200 → **195 C / 5 B** |
| sized board TRADE rows | 63 → **62 C / 1 B** | 63 → **60 C / 3 B** |
| ledger rows | 309 → 301 C / 8 B | 309 → 299 C / 10 B |
| board + ledger | 509 → **498 C / 11 B (97.84% C)** | 509 → **494 C / 15 B (97.05% C)** |
| distinct published p | 9 | 10 |
| published p range | 0.35 – 0.48 | 0.36 – 0.50 |
| gate-state blob | none (pinned off) | none (pinned off) |

**Every changed grade is attributable.** Of 309 shared ledger rows, 210 moved in grade, size or probability; **two changed grade**, both `C → B` (`2026-07-31 ARM long`, `2026-07-31 INTC long`), both with a *byte-identical composite* on both sides, both sized reversals at |c| ≈ 51 whose sized read cleared +0.05 over the anchor where the pooled read did not. Both also doubled in size (0.5 → 1.0 risk), which is the same decision travelling. Nothing else changed grade in either direction, and no row appeared or disappeared (309 keys on both sides). 44 rows carry a composite that moved by ±0.1–0.2 — the nudge loop reading the two seeds' slightly different IC — and **none of them changed grade**; that is a third path and it is reported rather than hidden.

Directionally the partition made most reads *lower*, not higher: 198 of 309 ledger probabilities fell, 12 rose. The shadow slice was pulling bands UP in this window, not down.

**Monotonicity, on the shipped curve.** The probe now sweeps what the reader is actually handed: every (cohort, side, regime) × **both populations** × **every setup family the state carries on that side** — 30 contexts × 27 samples = **810 reads**, on the gen-4 seed and again on the acceptance window's final blob. **Zero violations on both.** The pooled unblended ladder the probe swept before Stage 3c is now a curve nobody is shown; a test in `replay-window.test.ts` plants a family whose earned band step breaks D2 and proves the widened probe catches what the old one missed.

### The verdict on the payoff gate

- **(a) grade distribution no longer ≥97% single-grade — NOT MET, and recorded.** 97.05% C on board+ledger (from 97.84%), 97.5% on board-graded rows, 95.2% on the sized trade rows the reader is asked to act on. B count 11 → 15 (+36%), and 1 → 3 on sized trade rows. What holds the rest at C is neither the evidence floor nor the born-below cap (0 rows demoted by either: `nEff < 15` is empty and 118 born-below rows all graded C on their own p): it is that the bands themselves sit at 0.41–0.46 against a 0.4158 anchor, and B needs 0.4658. The remaining separation has to come from the model, not from the bookkeeping. Addendum 1's prediction that the partition would supply it was measured on a vector that no longer exists.
- **(b) zero monotonicity violations on the shipped curve — MET.** 810 population- and setup-aware reads, twice, clean.
- **(c) every changed grade attributes to a sanctioned path — MET.** Two grade changes, both partition, both on identical composites; gates structurally pinned off on both sides.
- **(d) referenceBase ≈ unchanged — MET exactly.** 0.4158, third generation running.
- **(e) suite green — MET.** 1,832 tests / 139 files, `tsc -b` clean.

### Still open, found by this install

**The setup blend is dark on generation 4, and cannot turn itself on.** `blendSetup` refuses a family bucket with no sub-counts (a fully-sized bucket and a never-partitioned one are the same bytes — adjudicated in Task 2). `updateCalibration.book` writes a sub-count only when an UNSIZED row lands. Together those two rules mean a family that never shadows can *never* prove it is sized: `continuation:long:40-55` carries **1,668 rows, every one of them sized, and is permanently mute**, while the families that *can* prove partition (velocity:long, continuation:short, fade:short) are 100% shadow and have no sized slice to blend. Every one of the 16 families in this artefact is at one extreme or the other, so the mechanism Task 2 shipped contributes exactly nothing to the numbers above — the two C→B moves are the partition alone.

The naive repair is worse than the state it fixes: writing `shadowN: 0` on a sized accrual would let a MIXED bucket (gen-3's unpartitioned legacy rows plus a few new stamped ones) claim all of them as provably sized, which is the exact hazard the refusal was adjudicated to prevent. The honest repairs are blob-level (a `partitionedSince` marker) or emitter-level (an artefact whose every row was stamped from a blank start may say so about itself — provable here, and only here). Both are design decisions with an author, and neither belongs in an install. **Booked for the batch decision.**

---

## Correction — 2026-08-14: generation 4 re-emitted (Task 4 fix wave)

**Two findings above are now obsolete and are corrected here rather than edited away.**

**§ "EVERY SHORT IN THIS ARTEFACT IS A SHADOW" is no longer true.** The empty `levMap` was replaced by `LEVMAP_MIRROR` (replay-window.ts) — a representative, documented model of the owner's real map, 38 names, US both-directions and UK long-only. The walk now routes shorts as production does: the short buckets hold **3,748 rows of which 2,365 are sized** (36.9% shadow, from 100%), and a sized short read is a real curve read in every regime instead of falling to the sized base at nEff 0.

**§ "The setup blend is dark on generation 4, and cannot turn itself on" is fixed, and the fix is not the naive one.** `updateCalibration` now stamps `shadowN: 0, shadowHits: 0` explicitly on every partition-aware accrual, so **present-zero means "partitioned, all sized"** and absent still means "never partitioned". The mixed-bucket hazard that made this unsafe is retired by the generation swap itself: `loadState` replaces the calibration blob whole and never merges, so post-generation-4 no bucket in any store can hold legacy and stamped evidence at once. **Ten of the sixteen families now clear the 30-sized-outcome floor**, `continuation:long:40-55` (1,661 rows, none of them shadows) among them; the six that stay mute are honest — three `velocity:long:*` are 100% shadow, three are under the floor.

**Re-measured, same window and universe:** 8,554 graded rows in 19 buckets (all 19 partitioned), shadow slice 1,982 (23.2%), pooled base 0.4196, sized base 0.4282 over 6,572 rows, zero-trade days 70 → 41 of 501, blank boards 0/501. **`referenceBase` 0.4158, unchanged for a fourth measurement** — the sweep is unconditional and levMap-independent.

**The acceptance window** (21 days): board+ledger 509 → **799 rows, 784 C / 15 B**; board-graded 349 rows (345 C / 4 B); sized trade rows 63 → **120, of which 57 are shorts** (56 C / 1 B) where both earlier cuts had none.

**The payoff gate moves in both directions.** (a) is still not met and the percentage is worse (98.12% C) because the board gained a short side and shorts grade C like everything else — the B count itself did not fall. (d) referenceBase and (e) suite green still hold (1,838 tests / 139 files). **(b) now FAILS**: with the blend awake, 11 of 810 shipped reads break monotonicity on the seed and 10 on the window's final blob, all in blended contexts, all on a band edge (x = 40, 56, 70), worst step 2.9pp. The ladder alone is still perfectly monotone in both populations. The cause is structural — the ladder is isotonic by construction while a family's read is a step function of the call's band — and it reaches published rows: five same-day pairs in the acceptance window are priced lower at higher conviction (worst: 2026-07-31, TSLA short −54.4 at 0.3762 vs QCOM short −55.3 at 0.3460), **none of which changed a grade**. Pinned in `replay-window.test.ts` with its count, boundaries and bound. The repair — fitting the family's bands isotonically, or refusing a blend that would break the step — changes every blended price and is a model decision with an author; it is booked, not taken.

## Correction 2 — 2026-08-14: the family read is a curve (Task 4 fix wave 2)

**The finding above is repaired, and the repair is the house's own Stage-2 pattern one level down.** The controller ratified it into the plan's Global Constraints before it was built: `p_setup` is an **isotonic family curve**, not a band step. `setupCurveFor` (calibration.ts) takes the family's SIZED band records — each band still having to PROVE it is partitioned, or it contributes no point — fits them with the same `isotonicFit` (weighted PAVA) the main ladder is built from, applies the same running-max guard, and `blendSetup` reads it at the call's own `|composite|` through the same `readCurve` (piecewise-linear between band midpoints, flat off both ends). `bandFor` no longer appears in the blend at all: a call's band picks a POINT on the family's curve, never which bucket the family *is*. The mix (0.7/0.3), the sized-read-only rule, the unpartitioned refusal and the price-not-evidence-mass semantics are untouched. **Two monotone functions of x mixed at fixed weights are monotone**, so D2 is structural again rather than lucky.

**One adjudication was needed and is recorded in code**: the 30-sized-outcome floor is now the FAMILY's total across its sized bands, not one band's. The floor is an admission test for a specialist *model*, and the model is one curve over the family; a per-band floor would be the step's rule outliving the step, dropping exactly the thin top that PAVA and the flat extension exist to price honestly. No second condition on the shape (no "and one band ≥ 15") — the fit already refuses to let a thin band speak louder than its evidence. Two consequences, both deliberate and both pinned: a family can now speak in a band it never booked (the flat extension, §4.2's own floor), and bands under 30 on their own participate through the family total.

**Generation 4 re-emitted** (`--from 2024-08-12 --to 2026-08-11 --seed-generation 4`, gates pinned off, 501 trading days, 159 symbols): 8,526 graded rows in 19 buckets (all partitioned), 16 setup keys, shadow slice 1,982 (23.2%), pooled base 0.4196, sized base 0.4282 over 6,544 rows, zero-trade days 41 → **35** of 501, blank boards 0/501. **`referenceBase` 0.4158 — unchanged for a fifth measurement.**

**The blend fires per FAMILY now**: four of the six (`continuation:long` 2,865 sized · `continuation:short` 2,309 · `reversal:long` 1,312 · `fade:short` 56) clear the floor and move the price in **12 of the 18 blended probe contexts**; `velocity:long` (0 sized — lane stand-downs, never on offer) and `fade:long` (2 rows) stay honestly mute.

**The payoff gate, re-run.**

| | gen 4 (band step) | **gen 4 (family curve)** |
|---|---|---|
| (b) monotonicity — seed / acceptance blob | 11 / 10 violations of 810 reads | **0 / 0 — monotone** |
| published same-day inversions | 5 | **0** |
| board + ledger | 799 — 784 C / 15 B (98.12% C) | **806 — 766 C / 40 B (95.04% C)** |
| board-graded | 349 — 345 C / 4 B (98.85% C) | **352 — 336 C / 16 B (95.45% C)** |
| sized TRADE rows | 120 — 116 C / 4 B (96.67% C) | **123 — 110 C / 13 B (89.43% C)** |
| …of those, SHORTS | 57 — 56 C / 1 B | **60 — 50 C / 10 B** |
| (d) referenceBase | 0.4158 | **0.4158** |
| (e) suite | 1,838 / 139 | **1,844 / 139** |

- **(b) MET.** 810 population- and setup-aware reads on the shipped seed and 810 on the acceptance window's final blob, all monotone; the bare ladder is asserted separately so a future regression can be located on the right side of the mix. The five published inversions are gone, measured the same way they were found (same day, same side, regime, family and population, ordered by `|composite|`).
- **(a) IS NOW MET on all three cuts**, and it was not the aim — this fix was asked for D2 alone. **95.04% C** board+ledger, 95.45% board-graded, **89.43%** on the rows the reader could size. B went 15 → 40, and 10 of the 13 sized-trade Bs are shorts. The mechanism is PAVA, not a threshold move: pooling a thin, unlucky top band with the fat band beneath it RAISES what the family says at high conviction. `continuation:short` is the case — its raw sized bands read 0.4489 / 0.4205 / 0.3182 / 0.4286, a descending staircase, so the fit pools **all four into one flat 0.4368**, which is the honest reading of a shape whose outcome does not improve with conviction. A 55-70 short continuation call's family term therefore moves 0.3182 → 0.4368, and 0.3 of that (+3.6pp on p) is enough to carry rows over the anchor+0.05 B gate that the step's downward jump was pushing them under. **Grade separation was never a bookkeeping problem alone — the step was actively suppressing it.** The four family curves are: `continuation:long` 0.4159 / 0.4256 / 0.4256, `continuation:short` flat 0.4368, `reversal:long` 0.4127 / 0.4326 / 0.4663 / 0.5000 (already monotone, untouched by the fit), `fade:short` flat 0.4167 on its single band.
- **(c)** not re-run as a controlled key-by-key diff, unchanged from the previous cut's reason: the two artefacts do not share a row population (799 → 806 rows).

**What did not change.** The refusal semantics (absent sub-counts still refuse, per band), the mix weight, `nEff`/`provisional`/`belowEvidence` (still the ladder's, never blended), the pooled read (a shadow is still priced by the pure ladder), and every legacy blob's byte-identical behaviour. CALIB/MODEL stay at 3: what a hit IS has not moved, and the blend was already part of model 3.
