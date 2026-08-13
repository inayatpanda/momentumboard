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
