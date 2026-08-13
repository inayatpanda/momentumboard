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
