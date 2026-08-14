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

**Ship recommendation:** install generation 2 as measured (all-C at half size, honest probabilities, thesis/falsifier voice carrying conviction in words), because the alternative — keeping generation 1 — shows readers B-grades manufactured by a stale yardstick. Everything is reversible, and reversal still counts UP: `replay-window.ts`'s floor refuses `--seed-generation` at or below the committed one, so rolling back an installed generation means emitting the NEXT generation from the older-shaped walk — a 25-second walk + deploy, never a re-emission of the number already in the tree. NOTE: the plan's Task-4 gate "grade distribution not ≥90% single-grade" fails by construction under any honest yardstick this window — shipping requires the owner to explicitly waive that gate with the evidence above in hand.

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

---

## Stage 3c Task 5 — the controlled diff: every changed grade has a name

**Date:** 2026-08-14 · **Window:** the acceptance window, 2026-07-14 … 2026-08-11 (21 sessions) · **Command:** `replay-window.ts --classify --ref <arm>.json --new <arm>.json`, over runs of `replay-window.ts --from 2026-07-14 --to 2026-08-11` · **API calls: 0** · **Artefacts:** `/tmp/stage3c/t5/{acc-3bship,acc-pre3c,acc-pre3c-code,acc-gen4,acc-gen4-gatesON}.{json,log}`.

### The arms, and the adjudication that picked them

Stage 3c changes published numbers by design, so the gate is not "nothing moved" — it is that **everything that moved has a name, computed rather than asserted**. `enrichFromCalibration` now records, beside the shipped read, the same read with each mechanism withdrawn (`pPooled` = pooled + no family = the pre-3c read; `pSized` = the partition only; `pRaw` = what shipped), *against the blob the board was actually built on*. The two differences ARE the two mechanisms, per row, in probability points. `classifyDiff` differences them across two arms and hands every changed row one of: **partition · blend · weights-loop · curve-drift · board-echo · unclassified**, the last of which fails the run.

Three arms were built, all with the SAME `LEVMAP_MIRROR`, the same candle cache, gates off (or absent) on both sides and regret on both sides:

| arm | code | evidence | what it is |
|---|---|---|---|
| **A1 — 3b-shipped** | `d46eb70` (pre-3c) in a worktree, the mirror byte-copied in | its own committed **generation 3** | what the reader was actually being shown before this batch |
| **A2 — legacy-blob** | HEAD | generation 4 with every `shadowN`/`shadowHits` **stripped** | the byte-identity construction: a blob with no sub-counts reads exactly as pre-3c |
| **A3 — pre-3c code, batch evidence** | `d46eb70`, mirror in | the shipped **generation 4** file, unmodified | **the controlled diff proper** — the only thing different from the shipped arm is the CODE |
| **B — shipped** | HEAD (`2146e41`) | committed generation 4 | what the batch publishes |

**A2 was measured and rejected as the primary arm, and the reason is a finding.** A stripped blob is pre-3c *at day one only*: at HEAD `updateCalibration` stamps sub-counts on every partition-aware accrual, so the walk **re-partitions its own blob** the moment its first outcomes mature. Measured per session, the reference arm's rows showing a live partition: `07-14 … 07-28: 0/34 … 0/39` — then `07-29: 36/41`, and 30–36 of every day after. There is no data-only way to hold the partition off across a window at HEAD; a pre-3c reference needs pre-3c CODE. A3 is that arm, and its audit is clean: **0 rows partitioned, 0 rows blended, largest |composite| move 0.0000** — pre-3c code never writes a sub-count, so its blob cannot wake the mechanism behind its own back.

### The classified diff — A3 → B (mechanisms isolated, evidence identical)

| | matched keys | changed | partition | blend | weights-loop | curve-drift | board-echo | **unclassified** |
|---|---|---|---|---|---|---|---|---|
| board | 349 | 198 | 144 | 54 | 0 | 0 | 0 | **0** |
| ledger | 450 | 204 | 147 | 57 | 0 | 0 | 0 | **0** |
| **total** | | **402** | **291** | **111** | **0** | **0** | **0** | **0** |

**Twelve grade changes, each named**, identical on both cuts: ten `B → C` from the **blend** (`QCOM` ×2, `INTC` ×2, `MU` ×3, `TSLA` ×2, `IBM` — every one a short) and two from the **partition** (`2026-07-31 KLAC long C → B`, `2026-08-11 AMD short B → C`). Seven rows are published by the shipped arm and not by the reference (3 board, 4 ledger: `IBM short` watch rows on three dates, plus a `BA long` and a `PRU.L short` shadow) and **none in the other direction** — no sized trade among them.

**The weights loop was silent.** Handed the same IC evidence, the two arms nudged identically: `max |Δ|composite||` = 0.0000 over 799 rows. Task 2's brakes never bound over 21 sessions — they are insurance, and this window did not need to draw on it.

**Direction, measured over all 806 shipped rows.** The partition moves p by a mean of +0.05pp (longs −0.06pp, shorts +0.07pp) and at most ±2.6pp; the blend by a mean of −0.015pp and at most ±2.6pp. Small moves, concentrated at the B threshold (anchor + 0.05 = 0.4658), which is where a grade lives.

**And the honest consequence, stated plainly:** reading generation 4's own evidence with pre-3c code — pooled, unblended — yields **more** B grades than the shipped read does (board-graded 26 B vs 16 B; sized trades 18 B vs 13 B). The two mechanisms NET REMOVE ten Bs on this window. That is the unmasking working: those Bs were priced against a population that included rows nobody was ever offered, and the shorts among them are exactly where the shadow slice was fattest. The batch's B-count improvement over what shipped is carried by the regenerated evidence (Task 4's own gate), not by the two read mechanisms.

### The classified diff — A1 → B (ships-vs-shipped, the reader-facing before/after)

| | matched keys | changed | partition | blend | weights-loop | curve-drift | board-echo | **unclassified** |
|---|---|---|---|---|---|---|---|---|
| board | 349 | 311 | 141 | 2 | 113 | 55 | 0 | **0** |
| ledger | 450 | 367 | 142 | 2 | 140 | 83 | 0 | **0** |
| **total** | | **678** | **283** | **4** | **253** | **138** | **0** | **0** |

Every row still has a name, and the two extra columns are the two things A3 holds fixed. **curve-drift** is the generation swap itself — gen-3's buckets against gen-4's, evidence whose change was measured by Task 4's payoff gate. **weights-loop** is the same swap one level up: both seeds carry the *identical frozen vector* (`current ≡ base ≡ DEFAULT`, verified factor by factor), but their IC evidence differs (technical 5194/49 vs 7033/104, momentum 5099/144 vs 7076/61, …), so the in-window nudge loop lands in different places — `max |Δ|composite||` = **1.2 points** on a 20–70 scale, 253 rows, 8 grade changes. Reported, bounded, and gone the moment the evidence is held fixed (A3: zero).

**Grade histograms across the arms** (board+ledger · board-graded · sized board trades · of those, shorts):

| arm | board + ledger | board-graded | trades | trade shorts |
|---|---|---|---|---|
| A1 — 3b-shipped | 801 — 26 B / 775 C | 350 — 10 B / 340 C | 119 — 9 B / 110 C | 56 — 8 B / 48 C |
| A3 — pre-3c code on gen-4 | 799 — 60 B / 739 C | 349 — 26 B / 323 C | 120 — 18 B / 102 C | 57 — 15 B / 42 C |
| **B — shipped** | **806 — 40 B / 766 C** | **352 — 16 B / 336 C** | **123 — 13 B / 110 C** | **60 — 10 B / 50 C** |

### The first gate-eligibility readout on live-shaped data, gates ARMED

A side-run of arm B with the gates on (`GATES` unset — the production setting) produced **output byte-identical to the gates-off arm** apart from each day's wall-clock `ms`: same board, same ledger, same calibration blob, same miss ledger, same risk state. `gate-state` after the window is **null** — the hook writes only on a real change, and there was none. The trace records one gate set for all 21 sessions: `deadZone 20 · minExpectedMovePct 1` (the aggressive preset).

| gate | source | cost | saved | n | unpriced | verdict |
|---|---|---|---|---|---|---|
| `deadZone` | dead-zone-core | 189 | 157 | 346 | 2 | **HELD** — 346 attributed outcomes, but the ratio is 1.20 and loosening needs 2× |
| `minExpectedMovePct` | expected-move | 1 | 0 | 1 | 0 | **INELIGIBLE** — 1 attributed outcome, under the 30 bar |
| `contextCap` | dead-zone-context | 0 | 0 | 0 | 0 | **INELIGIBLE — unmeasured**, exactly as Task 3 predicted it would stay until live evidence accrues |

Reported for hygiene, not tunable: `entry-wait 2/1 · slot-cut 41/53 [9 unpriced] · called-watch 38/33 [double-booked] · trimmed 0/0 [7 unpriced] · diversity 0/4 · dip-refused 1/4`. **Both markers surface**: `called-watch` carries the double-booked flag (its outcomes already steer calibration — one event may not move two levers), and `trimmed` reads 0/0 with 7 unpriced because every one of its rows is a `bare` mirror pair, excluded from the sided counts by the hygiene rule while its unpriced column keeps saying so.

This reproduces Task 3's live-shaped finding on a second, independent window: **the dead zone's +526pp of net cost lives in magnitude, not in count.** By its own count-based rule it has not earned a notch.

### The in-walk invariants, over the window

All four runs enforced them daily and none threw: 21/21 sessions **funnel-trace consistent** (2,796 trace rows, 1,320 carrying `core`, 822 carrying `priorGate` — including **367 `shadow-capped ← route-blocked`**, the attribution 3b shipped with nothing measuring it); the **miss ledger** accrued 10 matured days, one per pass, never twice, with `checked + unchecked` equal to the day's candidates on every one (990 priced, 18 unpriced, 297 misses); **post-mortems 115/115 losers of 215 graded**, 20 re-derived against the tape with the pinned precedence order holding. 0/21 blank boards and 0/21 zero-trade days on every arm.

### The verdict

**Every changed row in both comparisons has a name; `unclassified` is 0 in all four cuts.** The batch's own numbers stand as Task 4 recorded them (`referenceBase` 0.4158 for a fifth measurement, 0 monotonicity violations over 810 shipped reads on both blobs, 0 published same-day inversions), and the gates that could have moved under them did not, because on this evidence none of them has earned it.

### What day one will actually look like — read this before comparing the board to the table above

**The acceptance window's short-side B grades will largely NOT materialise on the first mornings, and that is the mechanism working rather than a regression.** Arm B's `LEVMAP_MIRROR` is a 38-name model of the owner's map (US both-directions, UK long-only); production's real `levMap` is a handful of inverse ETPs (`3SMI.L`/`3LAL.L`), so it routes *far* fewer shorts than the walk did. A short with no route is `unshortable` — a pre-grade shadow — and under the partition a shadow row is priced against shadow evidence and carries no size, so it can neither be published as a sized B nor accrue into the sized short slice. Ten of the thirteen sized-trade Bs in the shipped arm are shorts; production will only see their like on the names it can actually place.

**Nothing is lost by that, and nothing is faked to cover it.** The generation-4 seed already carries the historical sized short record the walk measured (short buckets 3,748 rows, 2,365 of them sized), so the moment a real routed short grades, it reads a curve that has evidence underneath it rather than falling to a provisional base — and the live sized short slice grows from real routed shorts only. The reader-facing consequence is a board that is long-heavier and B-thinner than the acceptance table for as long as the routable universe stays small; the fix for that is the owner's ISA route list, not the engine's read.

---

## Stage 3d Task 3 — 🃏 the experiment slot proves itself: deterministic, solitary, causal

**Date:** 2026-08-14 · **Window:** the acceptance window, 2026-07-14 … 2026-08-11 (21 sessions) · **Arms:** `GATES=off` + regret ON on both sides; `WILDCARD=off` (lane-off) vs the lane live, run **twice**. **API calls: 0** (warm `.replay-cache`). **Command:** `replay-window.ts --wildcard-diff --ref <off>.json --new <on>.json` over `replay-window.ts --from 2026-07-14 --to 2026-08-11`. **Artefacts:** `/private/tmp/.../t3/{off,on-1,on-2}.{json,log}`, `wcdiff.log`.

### The experiments the window took

| # | session | date | name | side | rung | gate under test | gate evidence at choice | core | grade / p | size | outcome (engine) | post-mortem | booked |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 2026-07-14 | **ORCL** | short | 1 | `entry-wait` | **0** priced / 0 unpriced | −41.2 | C / 0.45 | 0.25% (**paper**) | **HIT +7.8pp**, stop never touched | `won` | ✅ true |
| 2 | 12 | 2026-07-29 | **KO** | long | 1 | `expected-move` | **0** priced / 0 unpriced | +20.8 | C / 0.42 | 0.25% | still open at walk end (tape: miss −6.1pp) | — | — (nothing owed) |

Both hypotheses are template-built from numbers and reached the row verbatim, e.g. *"entry-wait has 0 priced outcomes and 0 unpriced in the miss ledger, none of them causal; this takes the short it blocked, core read −41.2, for one real outcome with a stop."*

**ORCL is PAPER MONEY and the evidence says so on the row.** A short wildcard passes the routability filter (the name *has* an inverse ETP) but `mapInstrument` is reached only at `sizedFraction === 1`, and a quarter can never be that — so it publishes `instrument: null`, `paperOnly: true`. **The one causal sample this window bought sits on a row an ISA could not have placed.** The causal evidence is real; the P&L is not, and will not be until quarter-size short routing exists.

### Cadence: FEW — and it is the one-slot invariant doing it, not luck

**2 experiments in 21 sessions**, exactly 11 sessions apart. Task 2's concern — *"the lane fires readily on thin fixtures; with an empty miss ledger every gate reads `gateEvidenceN 0`, so the slot spends on the first eligible day"* — is **confirmed as to day one and refuted as to cadence**:

- It *does* spend on session 1. With no matured trace days yet the ledger is empty, every gate ties at thinness 0, and `byThinnestGate` degenerates to `byConviction` — so the gate under test was chosen *by the row* (the highest-|core| single-gate-blocked candidate) rather than by an evidence gap. That is the concern, live.
- It then **cannot fire again for 11 sessions**, and did not. The second pick, on session 12, was *not* degenerate: by then the ledger held a matured day, `dead-zone-core` carried 346 attributed outcomes and `expected-move` genuinely carried **0** — the thinness preference discriminated correctly and bought the unmeasured gate over the measured one. The mechanism works the moment it has anything to work with.
- **The degeneracy is a cold-ledger artefact, not a live condition.** Production's miss ledger has been accruing since 3b shipped; a fresh walk's session 1 is the only place every gate ties.

**Recommendation (RECORDED, not implemented — the plan says adjudicate and record):** **do NOT add a minimum-evidence floor to rung 1.** A floor ("only test a gate with ≥ k measured outcomes") inverts the rung's own rationale — the slot exists to buy evidence where there is least of it — and would permanently starve exactly the gates nothing has ever measured (`dead-zone-context` has read 0 across two independent windows). The exposure a floor would address is bounded already: one mediocre pick, once, at cold start, for 11 sessions.

**The cheaper fix, if the owner wants one:** make rung 1's all-zero case an explicit tie-break instead of an incidental one — when every candidate's `gateEvidenceN` is 0, prefer the gate that refused the MOST rows in that day's trace (the gate whose unmeasured-ness is costing the most), then conviction. It needs no data the day does not already have, it cannot starve an unmeasured gate, and it is strictly better than "whichever gate the highest-conviction row happened to carry". One function, `wildcardLane.ts`, and its determinism is unaffected (the sort stays total).

**Also recorded: rungs 2 and 3 never fired.** Rung 1 found a candidate on both occasions, so the unmeasured-rung and catalyst-nominee arms are still pinned only by fixtures. They are unexercised on live-shaped data.

### The one-slot invariant, and the `.slice(-10)` boundary — asserted in-walk

The slot is held by a scan over `predictions-index … .slice(-10)`, so it has a boundary and the walk now asserts it rather than assuming it (`wildcardViolations`, enforced daily by the harness, which throws on the first violation):

- **The two release conditions coincide exactly.** An experiment published on session *i* falls out of the lookback on session *i + 10 + 1*, and the engine first grades it at ten sessions on session *i + 10 + 1*. `WILDCARD_SLOT_LOOKBACK === POSTMORTEM_HORIZON` is now a pinned constant relation, checked as an invariant and as a unit test: **while they are equal the slot is always released by the OUTCOME and never merely by the window sliding out from under it.** Task 2's judgment 10 ("a wildcard whose tape never arrived stops holding the slot once it leaves the window") is therefore a bound that costs nothing in the ordinary case — and if anyone shortens the lookback, un-graded release becomes the *normal* path and the walk says so out loud.
- **The window exercised the boundary at its tightest point.** ORCL published on session 1 and graded on session 12; KO seated on session 12 — the *first session it legally could*. The invariant is not vacuously satisfied here; it is satisfied with zero slack.
- Also pinned in-walk over the window: one wildcard row per day, both cuts naming the same one; `riskPct > 0`; `accrual: 'sized'`; never shadow, watch-only, near-miss or contract-claiming; `instrument: null` (leverage structurally unreachable at 0.25); a real falsifying stop; the trace coding it `called-wildcard` with `priorGate` remembering the gate under test.

### Determinism

The lane-on walk was run **twice**. Every byte of both run files is identical except each day's wall-clock `ms` — same experiments, same rungs, same gates, same hypotheses, same levels, same outcomes, and the `--wildcard-diff` output is character-identical across the two.

### The controlled diff — lane-off vs lane-live

**806 matched keys · 4 rows only the lane-on arm has, all 4 the experiments (board + ledger) · 0 rows only the lane-off arm has · 0 near-miss displacements** (no near-miss row shared a chart with either experiment in this window, so the splice never fired — its handling is pinned by fixture).

**Split at the accrual, because the ratified design opens exactly one channel.** A wildcard is the reader's money at a quarter of the rung, so its graded outcome accrues into `engine-calibration` like any sized row's (plan, Global Constraints: *"its calibration accrual is normal"*). A whole-window byte-identity claim is therefore incompatible with the design the moment an experiment grades inside the window, and the guard is split rather than waved at:

| | ordinary rows moved | verdict |
|---|---|---|
| sessions 1–11 (**before** any experiment graded) | **0** | **the seating perturbs nothing** — the lane publishes after both cuts and changes no ordinary row on the day it seats, which is the real claim about selection |
| sessions 12–21 (after ORCL's outcome reached the blob) | 386 | the one observation the design lets through |

Every one of those 386 moves is on a **read-derived** field and nothing else: `pRaw`/`pPooled`/`pSized` 386, `nEff` 82, `probability` 11, `grade` 2, `gradeUncapped` 2. **Zero** moves on composite, entry/stop/target, expected move, setup family, accrual stamp, risk rung, catalyst, thesis or size. The harness fails the run on any move outside the read set, and on any size move not standing behind a grade move.

**The single grade change, traced to the last decimal.** `2026-08-03 MU short C → B` (one row, both cuts). The B threshold is anchor + 0.05 = **0.4658**; MU's unrounded read is **0.46512** lane-off and **0.46605** lane-on. One extra graded sized short in `short:amber:40-55` (n 395→396, hits 198→199) moved it 0.0009 across the line. `riskPct` is 0 on both — it is a watch row, so no size moved with it.

**The separable records held, byte for byte.**

| record | lane-off | lane-on | reading |
|---|---|---|---|
| `byGrade` | C 161 / shadow 49 / B 5 | C 161 / shadow 49 / B 5 **+ `wildcard {n:1,hits:1}`** | its own 🃏 key; **C did not fatten by one** |
| `byRegime` | — | **delta 0** | the live/skill pane never sees the experiment |
| `bySetup` | — | **+1** (`continuation`) | the shape pane counts it — the most honest sample the family has |
| `byPostMortem` | — | **delta 0** | the win is stamped `won` and excluded — a win is not one of the ways the engine loses |
| lifetime counters | — | **delta 0** | `skillGraded` refuses it |
| Brier trail | — | **length delta 0** | not a forecast the engine stood behind |
| `risk-state` | — | **identical** | no rung, no ladder evidence, no factor IC |

**And the causal column is a SUBSTITUTION, not an addition — the cleanest possible reading of "one event, one lever".**

| gate | causal | stopless `cost` | movable `sidedCost`/`sidedSaved` |
|---|---|---|---|
| `entry-wait` (the slot tested it) | **n 1, hits 1**, example tagged `wildcard: true`, `hit: true` | **−1** | **+0 / +0** |

In the lane-off arm ORCL's 2026-07-14 refusal was priced as a *stopless* miss (`cost` 2). In the lane-on arm the row was published, so `called-wildcard` puts it in `MISS_SKIP_GATES` and the miss walk never prices it — `cost` falls to 1 — while `accrueCausalOutcome` charges the same event once as a **real, stopped, sided** outcome. The gate's movable evidence count is *unchanged*; only the quality of the measurement behind it improved. That is exactly what the slot was built to do, and no gate the slot never visited moved its stopless population at all.

**One further ledger-side difference, named rather than glossed:** the miss walk's 40-fetch budget counts a name already in the candle cache as free, and the lane-on arm's grading pass warms one extra name — so on 2026-07-17 the budget reached one refusal further (`checked +1`, `unpriced −1`, `slot-cut unchecked 9→8`; that row landed inside the ±5pp band, so no gate's cost or saved moved). It makes the ledger *more* complete on that day, never less, and changes no gate's verdict.

### The verdict

**PASS.** Every difference between the two arms is one of four named things: the experiment rows, their causal ledger entry, their own separable records, or the sized-calibration accrual the design ratified — and that last one moves read-derived fields only, from session 12 on, to a total of one grade. Nothing the lane was not given moved. `unclassified` has no equivalent here because there is no unclassified: the harness fails the run outright on a forbidden field, an unearned size, an unexplained row on either side, or a broken slot invariant.

**Supporting evidence from a second, independent window:** the two-year `--seed-out` walk in the suite now runs these same invariants over **27 experiments** and passes every one — one slot throughout, every graded experiment booked with its receipt, every gate's causal count equal to the experiments graded against it, and no double-book (the fix wave's documented one-blob-write residual is now an asserted inequality rather than an unwatched risk).

**The honest scoreboard at n=1.** One booked causal outcome, a hit, on a paper-only short. The standing warning that experiments lose more often than the board is neither confirmed nor contradicted by a single sample, and the slot's own record says so.
