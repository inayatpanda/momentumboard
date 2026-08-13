# Stage 2b — Deep Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Companion reading: `.superpowers/sdd/stage2b-recon.md`** — every file:line claim below is sourced there; read the section named in each task before coding.

**Goal:** Regenerate the calibration seed from a 2-year price-derived, chronologically walk-forward replay of the CURRENT v3 engine, so every band (including 70+) carries real samples per (side, regime) slice, grade A is organically earnable, the four core factors get IC measured under v3, and the dip/velocity lanes carry a measured historical record — then actually install it in production, which today's code cannot do.

**Architecture:** `scripts/replay-window.ts` (the Stage-1/1b/2 acceptance harness) IS the deep-seed engine — it already drives the real `gradeOutstanding → buildBoard` day-by-day with a carrying store, strict `sliceBefore` point-in-time slicing, all lanes, sleeve, roster, screens, and the real `gradePrediction`. Stage 2b adds (1) a generation-keyed seed install path in `loadState`, (2) a `--seed-out` serialisation mode, (3) the 2-year walk itself with acceptance instruments, (4) the regenerated `seed.json` committed WITH its code in one commit (the 21441fd pattern) and deployed.

**Tech stack:** TypeScript, vitest, tsx; no new dependencies; candles come from `.replay-cache/` (187 symbols × 5y already on disk — zero API calls).

## Global Constraints

- **CALIB_DEF_VERSION stays 3.** Frozen: HIT_EXCESS_MIN=1, horizon 10 sessions, entry = entry session's OPEN, stop = close-through over [entryIdx, entryIdx+horizon] using the PUBLISHED stop, SPY benchmark side-adjusted, bandFor edges 40/55/70. (recon §7.1)
- **ENGINE_MODEL_VERSION is 3** — the regenerated seed must carry `modelVersion: 3` explicitly in the artefact, not via the migrate backfill. (recon §7.1)
- **Do not mix a regenerated seed with the committed one — regenerate whole** (backtest.ts:31-40 standing position; quote it in code comments where relevant).
- **The emitted `weights.base` must be byte-identical to `DEFAULT_WEIGHTS`** (composite.ts:22) or `rebaseWeights` zeroes the seeded IC on first production load. (recon §4.4 — this is how the CURRENT seed's IC has been silently discarded since Stage 2 shipped.)
- **Crypto is excluded from the seed universe**: filter `exchangeOf(sym) === 'CRYPTO'` (shared/symbols.ts:5). `ETH-USD` is in `REPLAY_UNIVERSE` today and MUST NOT enter the equity seed (weekend bars break the 10-session clock; no crypto cohort exists until Stage 1c). (recon §7.6)
- **The walk starts from an EMPTY calibration** — not the committed v2-model seed. Warm-up (first weeks grade against baseHitRate 0.5, no As) is correct walk-forward behaviour and self-heals. (recon §2.6.3)
- **Population = the board-driven walk** (recon §2.5 option B): the seed measures exactly the population production grades — published board + watch + shadow rows. The symbol×date sweep (`seed-engine.ts`/`backtest.ts` today) measures a population production never grades and is retired by this stage. Consequence owned per recon §7.4: the seeded base rate will be HIGHER than the sweep's 0.367 (board picks are selected), so grade A's absolute bar rises — that is the honest bar, because grades are relative to the base rate of the very population they price. The hybrid (sweep + walk) is REJECTED: it mixes two populations inside single buckets and doubles the artefact surface.
- No Co-Authored-By trailer on any commit. Deploys are explicit `wrangler` commands (push ≠ deploy since the Cloudflare cutover).
- Full suite green after every task (baseline 1,373 / 121 files).

---

### Task 1: The install path — a generation-keyed seed swap

**The problem (recon §7.2, §1.4):** `loadState` (netlify/functions/lib/engine.ts:308-332) swaps in the committed seed ONLY when `stored.defVersion !== CALIB_DEF_VERSION`. Both are 3 and stay 3, so a regenerated seed reaches nothing but a cold start. *This is the single most likely way for Stage 2b to ship and have zero effect.*

**Files:**
- Modify: `shared/engine/calibration.ts` (CalibrationState type + migrate), `shared/engine/types.ts` if WeightsState lives there (recon §1.1 — confirm), `netlify/functions/lib/engine.ts:308-332` (loadState)
- Test: `shared/engine/calibration.test.ts`, `netlify/functions/lib/engine.test.ts`

**Interfaces:**
- Produces: `seedGeneration?: number` on BOTH `CalibrationState` and `WeightsState` (absent ⇒ 1, via `migrateCalibration`/`migrateWeights` backfill `??= 1`); loadState swap rule below. Task 2's serialiser stamps `seedGeneration` into the emitted artefact; Task 4 bumps the committed seed to generation 2.

**The swap rule (implement exactly):**

```ts
// loadState, after the existing defVersion swap:
// A regenerated seed at the SAME outcome definition announces itself by
// generation. The stored blob wins forever otherwise — that is correct for
// live accrual, but it means a better seed could never land (stage 2b).
// On swap the stored blob is REPLACED, not merged: "do not mix a regenerated
// seed with the committed one — regenerate whole" (backtest.ts header).
const storedGen = calibration.seedGeneration ?? 1
const seedGen = seedCal.seedGeneration ?? 1
if (seedGen > storedGen && seedCal.defVersion === CALIB_DEF_VERSION) {
  console.log(`CALIBRATION: seed generation ${storedGen} → ${seedGen} — replacing ` +
    `${calibration.evidence?.live?.n ?? 0} live rows with the deeper seed (they are inside its window)`)
  calibration = clone(seedCal)
}
```

Weights swap in the same block, same condition, keyed on the WEIGHTS blob's own `seedGeneration` vs `seed.weights.seedGeneration` — both blobs came from one walk; swapping one without the other mixes scoring epochs. After the swap `rebaseWeights` still runs (it must no-op because Task 2 guarantees `base === DEFAULT_WEIGHTS`).

**Steps:**
- [ ] Write failing tests: (a) stored gen 1 + seed gen 2, same defVersion → stored is replaced wholesale (bucket from stored absent afterwards; seed's buckets present; evidence aggregate = the seed's); (b) stored gen 2 + seed gen 2 → stored WINS (no replacement — the swap fires once); (c) stored gen absent (legacy) reads as 1; (d) seed gen 2 but seed defVersion ≠ CALIB_DEF_VERSION → NO swap (a bad artefact must not install); (e) weights: same four cases; (f) the existing defVersion-mismatch swap still works unchanged.
- [ ] Run: `npx vitest run shared/engine/calibration.test.ts netlify/functions/lib/engine.test.ts` — expect the new cases FAIL.
- [ ] Implement: type fields + `??= 1` in the two migrate functions + the loadState block above.
- [ ] Run the same suites — PASS; then full suite.
- [ ] Commit: `feat(engine): a deeper seed can announce itself — generation-keyed install for same-definition regenerations`

### Task 2: `--seed-out` — the walk serialises a seed artefact

**Files:**
- Modify: `scripts/replay-window.ts` (main(), arg parsing at :837-838 area, the stale comment at :724-729), `scripts/seed-engine.ts` (retire: replace body with a pointer comment naming replay-window's --seed-out as its successor and WHY — recon "Spec assumptions" table; keep the file so the spec's reference resolves), `shared/engine/backtest.ts` (only if seedFromHistory needs the explicit modelVersion stamp for the retirement note)
- Test: `scripts/replay-window.test.ts`

**Interfaces (consumes from Task 1):** `seedGeneration` fields. **Produces:** `--seed-out <path>` and `--seed-generation <n>` flags; the artefact shape written is EXACTLY the committed `shared/engine/seed.json` shape `{ generatedAt, symbols, weights, calibration }` (recon §1.1) with these guarantees, each pinned by a test:

1. `calibration.defVersion === 3`, `calibration.modelVersion === 3`, `calibration.seedGeneration === <n>` — all EXPLICIT in the artefact (self-describing; no migrate backfill reliance).
2. `weights.base` deep-equals `DEFAULT_WEIGHTS` and `weights.seedGeneration === <n>` (the rebaseWeights no-op guarantee — recon §4.4).
3. Universe: `REPLAY_UNIVERSE.filter(s => exchangeOf(s) !== 'CRYPTO')`; the artefact's `symbols` count reflects the filtered list; a test feeds a universe containing `ETH-USD` and asserts no crypto row exists in any emitted bucket key's provenance (walk skips it entirely).
4. Evidence relabel at serialisation: the walk's rows book as live/shadow (live grading never passes provenance — recon §1.4); the emitted artefact relabels aggregate evidence to `{ seed: live_n_hits_folded, live: {0}, shadow: <unchanged> }` with a comment explaining shadow rows (velocity lane) keep their provenance because that is what they are — a measured shadow record, not sized history (recon §2.6.7).
5. Serialisation reads `engine-calibration` AND `engine-weights` from the carrying store at walk end (engine-weights is currently never read back out — recon §2.6.1).
- [ ] Also fix the stale comment at replay-window.ts:724-729: the velocity lane DOES fire cap-less while `VELOCITY_SHADOW_FIRST=true` (engine.ts:1413 admits unknown caps as shadows) — say so, cite engine.test.ts:2419-2425.

**Steps:**
- [ ] Failing tests first: run a tiny walk (2 equity symbols + SPY fixture candles, ~30 sessions — follow the existing test fixtures in replay-window.test.ts) with `--seed-out`; assert guarantees 1-5 on the emitted JSON.
- [ ] Implement; targeted suite; full suite.
- [ ] Commit: `feat(engine): the replay walk can emit what it learned — --seed-out writes a v3 seed artefact`

### Task 3: The 2-year walk + acceptance evidence (execution task — minimal code)

**Command (from repo root; measure and record wall-clock):**
`npx tsx scripts/replay-window.ts --from 2024-08-12 --to 2026-08-11 --seed-out /tmp/stage2b/seed-candidate.json --seed-generation 2 --out /tmp/stage2b/walk-diag.json`

Candles: all from `.replay-cache/` (fetched 2026-08-12; 0 API calls). The tail ~10 sessions' calls stay ungraded (horizon extends past the window) — they simply never book; honest, no action.

**Perf contingency ONLY if needed:** main() re-slices the whole universe per day (replay-window.ts:926-932, O(days×syms×bars) ≈ 70M bar copies at 500 days). If measured runtime exceeds ~45 min, add a per-symbol index cursor; otherwise DO NOT (YAGNI — recon §2.6.4 expects 8-13 min).

**Evidence document** (`docs/superpowers/plans/2026-08-13-stage2b-walk-results.md`), all instruments already exist in the diagnostics JSON + bornBelowCensus (replay-window.ts:1710):
- [ ] Per-band table (n/hits/laplace-p) TOTAL and per (side, regime) slice — the committed-seed baseline comparison table is recon §8 (778 rows, 70+ = 0, six empty cells below 70).
- [ ] **A-reachability check (the stage's headline gate):** list every (side, regime) slice where BOTH 55-70 and 70+ carry n ≥ 30 (the `nEff = min straddling n` rule, calibration.ts:254-266 — a rich 70+ band alone does NOT make an A). GATE: at least 2 slices qualify, and `long:green` is one of them. If the walk's board is too top-concentrated to fill 55-70, the documented fallback knob is widening what the walk BOOKS (near-miss rows are already constructed by buildBoard) — a design change needing a ratified decision, NOT silent inclusion.
- [ ] baseHitRate before (0.3670) vs after; derived thresholds (B = base+0.05, A = base+0.10); sanity: post-seed base ∈ [0.35, 0.55].
- [ ] IC table: all four core factors with nAgree/nDisagree both > 0 (the committed seed's technical column is all-agree 778/0 — uncomputable; v3's damping should produce disagreements. If a factor still shows nDisagree = 0, record WHY before shipping).
- [ ] setupBuckets: `velocity:long:*` rows exist (n > 0) with the shadow-provenance note; dip/reversal enrichment vs the 9-key baseline.
- [ ] bornBelowCensus: the 25-40 band is populated in EVERY (side, regime) slice that admits calls (recon §7.3 — the C-cap must fire for conviction reasons, not missing-slice reasons).
- [ ] Walk-forward honesty spot-check: pick 3 dates across the window; assert their graded outcomes use only bars ≤ date+horizon and their composites use only bars < date (sliceBefore already enforces; the check documents it).
- [ ] No code commit from this task unless the perf cursor was needed (then: `perf(replay): a cursor instead of 70M bar copies — the 2-year walk in minutes`).

### Task 4: Regenerate, gate, ship — one commit, then deploy

**Files:** `shared/engine/seed.json` (replaced by the Task-3 artefact), any test pinning old seed numbers (recon §8 says calibration.test.ts pins some — update them to read from the artefact rather than re-pinning literals where feasible).

**Steps:**
- [ ] Copy the gated artefact over `shared/engine/seed.json`.
- [ ] **Re-run the July-Aug acceptance window** (`--from 2026-07-14 --to 2026-08-11`, the Stage-1/2 gate window) with the new seed installed as the walk's cold start (this is now the committed seed, so a plain run uses it): GATE = no blank boards; grade distribution not ≥90% single-grade; win5/avg5 within noise of the Stage-2 gate run (§15 of 2026-08-11-stage1-replay-results.md); at least one organic A-grade read occurs IF any slice qualified in Task 3 (synthetic-A machinery already proven — this is the organic twin).
- [ ] Full suite green (update pinned numbers test-first where they break).
- [ ] ONE commit: code-nothing-but-seed + test updates: `feat(engine): two years of walked history — the seed knows every band now (generation 2)` — the 21441fd pattern: the artefact and the tree that produced it travel together.
- [ ] Deploy BOTH surfaces (`npx wrangler pages deploy`; `cd workers/cron && npx wrangler deploy`) — the seed ships inside the functions bundle.
- [ ] Verify the production install: trigger one predict cycle (or wait for the next scheduled one), then read the runlog/`engine-calibration` blob via authed API or `wrangler d1 execute`: `seedGeneration = 2`, evidence.seed.n = the walk's total, and the board's grades reflect the new thresholds. Record the console.log swap line if observable.
- [ ] Push (post-cutover, push is safe and deploys nothing by itself).

## Self-review notes
- Spec §4.4's literal "expanded seed-engine.ts" is deliberately superseded (recon documents the contradiction; seed-engine.ts is retired with a pointer, not expanded).
- Spec §4.4's "world-tape tone (oil/VIX/gold/futures)" — worldTape reads equity indices + ES/NQ futures + VIX only (recon §5.1); all price-derivable and ALREADY replayed by the harness; oil/gold never feed a factor. No task needed.
- The 2dp probability rounding bottleneck (engine.ts:1148) is NOT touched here — it's an owner-facing option logged from Stage 2.
- hypeCluster: no code change; `social: async () => []` keeps clusters null (recon confirms).
