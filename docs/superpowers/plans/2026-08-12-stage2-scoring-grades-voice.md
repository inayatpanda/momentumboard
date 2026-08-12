# Stage 2: Scoring, Grades, Voice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine scores in the owner's order with EMAs and volume thrust in the core read, emits a continuous monotone probability that makes grade A reachable, sizes eligibility by each name's own expected move instead of flat capacity floors, and speaks every call as a decisive thesis with a falsifier.

**Architecture:** Four mechanism changes behind unchanged contracts: (1) the technical read gains an EMA stack + volume thrust (additive `TechnicalRead` fields; `emaLast` promoted to `shared/indicators.ts`); (2) `probabilityFor` becomes a read-path curve — per-rung isotonic (PAVA) band estimates, piecewise-linear across band midpoints, shrunk toward the rung's pooled estimate — with bucket KEYS, write path, and hit definition frozen; (3) the three flat capacity floors collapse into one per-name `expectedMovePct` eligibility floor; (4) `thesis`/`falsifier` become stored optional fields produced deterministically and consumed by the paper and UI. `ENGINE_MODEL_VERSION` 2→3 stamps the epoch; an explicit weights re-base migration ships because `migrateWeights` only fills nulls (recon §2.3 — without it production scores on v2 weights forever).

**Recon:** `.superpowers/sdd/stage2-recon.md` (HEAD 2ae4484) — every line anchor below comes from it; re-verify by symbol.

**Ratified design decisions (controller, 2026-08-12):**
- **D1 — sector demotes by WEIGHT ONLY (0.6 → 0.3), staying core.** Moving it out of core changes coreDen/coverage/famAgree/contract (recon §2.1) — an architecture change the spec never asked for.
- **D2 — monotone reads via weighted PAVA.** The evidence is currently non-monotone (shorts 40-55 score worse than 25-40; recon §3.2). The spec's gate demands p non-decreasing in |composite| within side/regime/cohort, so the read pools adjacent inverted bands (isotonic regression, n-weighted) before interpolating. The write path stores what happened; the read path applies the one prior "more conviction is never worse in the same context".
- **D3 — new weights vector:** technical 1.0, momentum 0.9, catalyst 0.6, news 0.5, channels 0.5, social 0.5, insiders 0.4, seasonality 0.3, smartMoney 0.3, **sector 0.3**. Owner order: charts → trend + stock news → (geopolitics = worldTape, unchanged) → sector last.
- **D4 — weights migration resets `current` to the new base.** Live IC drift is <1% on two factors and zero on eight (recon §2.4) — nothing worth preserving; a history entry records the re-base. Keyed on a base-vector fingerprint, not ENGINE_MODEL_VERSION (which gates nothing at load).
- **D5 — eligibility = expected move, not capacity floors.** `expectedMovePct ≥ 1.5` (moderate) / `≥ 1.0` (aggressive) replaces `capacityFloor`/`catalystCapacityFloor`/`SLEEVE_CAPACITY_FLOOR`. Already per-name (expectedMovePct = f(|adj|, capacityPct)); a 6%-mover GLW with real conviction passes, a dead-money name fails on its own arithmetic. Catalyst relaxation preserved as −0.5 on the floor. `riskPct` gains NO new multiplicand — R-based position sizing already normalises per-name risk; the 20% position cap bounds notional (recon §5.2).
- **D6 — grade A:** `p ≥ base + 0.10` AND `nEff ≥ 30` (shrinkage-effective evidence, any rung). The `capacityPct ≥ 8` A-gate dies (D5 covers its purpose). B `≥ base+0.05` **now also requires `nEff ≥ 15`** (kills the thin-bucket provisional-B that made "stuck at short Tesla"); C `≥ base`; below → null (unchanged flags).
- **D7 — Brier epoch mixing is accepted and stamped.** Continuous p should improve Brier; `brierImproving`'s old-vs-new comparison is the desired signal. Rows already carry `modelVersion`.
- **D8 — thesis/falsifier are deterministic templates, stored, LLM-polished never LLM-invented.** Board-row falsifier ALERTS are Stage-3 scope (alerts today watch only journalled positions — recon §6.6 corrected the spec's claim; ticket recorded).
- **D9 — `scripts/engine-replay.ts` is RETIRED** (deleted): it forks `levelsFor`, omits `baseRate` (grades don't match production), and `replay-window.ts` supersedes it. Its `byGrade` idea moves into the Stage-2 gate aggregation.

## Global Constraints

- Commits on `main`, imperative, **NEVER a Co-Authored-By trailer**. **Do NOT push** until Task 7's gate passes and the owner has seen the evidence (grade semantics change what readers see — this is an owner-visible ship).
- FROZEN (recon §10): bucket keys + band edges on the WRITE path; `CALIB_DEF_VERSION = 3`; hit definition (`gradePrediction` + its `backtest.ts:130-149` twin stay bit-identical); stored blob shapes additive-only; `CONTEXT_MAX_PTS`/core-decides-direction/regime-string invariants; grading reads the published stop.
- The re-derivation load is KNOWN: 13 calibration tests + 17 engine buildBoard tests must be re-derived (recon §3.4 lists every line); Tier-C fixture files survive but their stale comments get truthed where touched.
- Suite baseline 1078 (112 files); green + `npx tsc -b` + `npm run build` before every commit.

---

### Task 1: `emaLast` promoted + the EMA stack and volume thrust in the technical read

**Files:** `shared/indicators.ts` (+test), `shared/technicals.ts` (+test), `shared/engine/dipLane.ts`, `shared/engine/velocityLane.ts` (both switch to the shared import — byte-identical behaviour, their tests must pass UNCHANGED).

**Interfaces:**
- `shared/indicators.ts` gains `export function emaLast(values: number[], period: number): number | null` — move the byte-identical helper from the lanes (recon §1.2); both lanes import it; delete both private copies.
- `TechnicalRead` (technicals.ts) gains ADDITIVE fields: `emaStack: { e8: number | null; e21: number | null; e50: number | null; aligned: 'bull' | 'bear' | 'mixed' | null }` (aligned = bull iff price > e8 > e21 > e50; bear iff inverted; mixed otherwise; null if any EMA null) and `volThrust: number | null` = ratio of mean volume over the last 5 sessions to the mean of the 20 before them (`null` under 30 candles) — a multi-day participation measure, distinct from the single-session `rvol` (recon §1.4).
- `technicalStage`'s stage cascade, entryQuality, note: UNCHANGED in this task.

- [ ] TDD: indicator tests (emaLast parity fixture copied from a lane test; volThrust arithmetic both directions; aligned truth table incl. null legs) → RED → implement → lanes' suites pass unchanged → full suite → commit `feat(engine): one EMA, shared — and the technical read finally sees the stack and the thrust`.

---

### Task 2: technicalFactor v3 + the owner's weights (with the migration that makes it real)

**Files:** `shared/engine/factors.ts` (+test), `shared/engine/composite.ts` (DEFAULT_WEIGHTS), `shared/engine/calibration.ts` (weights migration), `netlify/functions/lib/engine.ts` (loadState wiring), tests incl. recon Tier-D re-derivations.

**Scoring (technicalFactor v3):** input widens (structural type — additive at call sites, recon §1.2) to `{ stage, volumeConfirmed, rvol, emaStack, volThrust }`. Score = `STAGE_SCORE[stage]` (unchanged base) + stack bonus: aligned bull +15 / bear −15 / mixed 0 (null 0); thrust modifier: `volThrust ≥ 1.5` amplifies a non-zero score ×1.15, `≤ 0.6` damps ×0.85 (both directions — thrust is participation, not direction, unlike today's long-only amplify which stays as-is at `factors.ts:35`); clamp ±100. Detail names the stack state in plain words.

**Weights:** DEFAULT_WEIGHTS → D3 vector. **Migration (D4):** `rebaseWeights(state, base)` in calibration.ts — when `state.base` differs from `base` on any key: set `base` and `current` to the new vector, keep `ic` accrual, push a history entry `{ date, changes: {...}, evidence: 'stage-2 re-base to the owner-ordered vector' }`. Called from `loadState` (engine.ts:306-320) after `migrateWeights`. Idempotent (fingerprint equality short-circuits).

- [ ] TDD: factor tests (stack bonus both ways, thrust both ways, null legs leave v2 behaviour); migration tests (differing base → re-based once, idempotent second call, history entry; identical base → untouched); re-derive recon Tier-D composite pins (7 in composite.test.ts — recompute each expected composite under the new vector BY HAND in the test comments); full suite → commit `feat(engine): the charts speak first — owner-ordered weights, and a migration that actually re-bases production`.

---

### Task 3: the continuous, monotone probability curve + grades that discriminate

**Files:** `shared/engine/calibration.ts` (+test — the 13 Tier-A re-derivations), `netlify/functions/lib/engine.ts` (call site + ENGINE_MODEL_VERSION 3), re-derive the 17 Tier-B engine tests.

**The curve (complete code — the heart of the stage):**

```ts
/** Band midpoints for the read path. The write path's bandFor/keys are FROZEN. */
const BAND_MID: Record<Band, number> = { '25-40': 32.5, '40-55': 47.5, '55-70': 62.5, '70+': 77.5 }
const SHRINK_K = 25

/** Weighted PAVA: pool adjacent band estimates until non-decreasing in the band
 * midpoint. The one read-path prior: within a context, MORE conviction never
 * reads as WORSE. Evidence that disagrees is pooled, not overwritten. */
function isotonic(points: { mid: number; p: number; n: number }[]): { mid: number; p: number; n: number }[] {
  const blocks = points.map(pt => ({ ...pt }))
  let i = 0
  while (i < blocks.length - 1) {
    if (blocks[i].p <= blocks[i + 1].p + 1e-12) { i++; continue }
    const a = blocks[i], b = blocks[i + 1]
    const n = a.n + b.n
    blocks.splice(i, 2, { mid: (a.mid * a.n + b.mid * b.n) / n, p: (a.p * a.n + b.p * b.n) / n, n })
    if (i > 0) i--
  }
  return blocks
}

/** probabilityFor v3: same 5-rung ladder, but each rung that has ANY evidence
 * builds a curve over its bands: laplace per band → weighted PAVA → piecewise-
 * linear at |composite| (flat extension beyond the outer midpoints — so 70+
 * inherits AT LEAST the 55-70 level [spec §4.2]) → shrink toward the rung's
 * pooled laplace by nLocal/(nLocal + SHRINK_K), where nLocal interpolates the
 * two straddling bands' n. Returns { p, provisional, nEff }: nEff = shrinkage-
 * effective evidence at this composite; provisional = nEff < MIN_BUCKET_N.
 * gradeFor consumes nEff (D6) — the rung index no longer decides trust. */
```

The implementation replaces `probabilityFor`'s per-rung band lookup with `curveFor(state, side, regime, cohort, rung)` producing the isotonic points from `poolBuckets` calls per band (recon §3.3: poolBuckets must become per-band callable — it already is, one band per call). Rung selection: first rung with total n > 0 across ANY band (rungs 1-4), else rung 5 base rate. `gradeFor(p, nEff, baseRate)`: A `p ≥ base+0.10 && nEff ≥ 30`; B `p ≥ base+0.05 && nEff ≥ 15`; C `p ≥ base`; null below. The `provisional` return survives for display; `capacityPct` leaves the signature (D6) — update the one production call (engine.ts:1048-1049) and the flags that read `provisional`.

Also: `ENGINE_MODEL_VERSION = 3` (stamp only — recon §7.1); `probability` stays 2dp (display resolution decision, recorded); the `n ≥ 50 else 0.5` baseHitRate cliff stays (it's the cold-start guard).

- [ ] TDD order: isotonic unit tests FIRST (monotone in, untouched; the recon's real short inversion as a fixture — 0.41/0.25 pools to one weighted block; single point; all-equal); curve tests (interpolation between mids; flat extension both ends; 70+ ≥ 55-70 by construction; shrinkage toward pooled at low n; nEff arithmetic); THEN re-derive the 13 Tier-A tests (each expected value recomputed and shown in a comment); THEN gradeFor (D6 truth table incl. the thin-55-70-B kill: p 0.5 n 8 → nEff < 15 → C not B); THEN the 17 Tier-B engine tests (recon lists every line; the four load-bearing comments at engine.test.ts:132/1466/1652/2121 rewritten to the new arithmetic). Full suite → commit `feat(engine): probability is a curve — monotone, shrunk, and grade A is finally something the engine can earn`.

---

### Task 4: expected-move eligibility replaces the capacity floors

**Files:** `shared/engine/composite.ts` (+test), `shared/engine/catalyst.ts` (gates), `netlify/functions/lib/engine.ts` (sleeve flag removal), SitePages/FAQ copy.

`ComposeInput.sleeve` dies; `SLEEVE_CAPACITY_FLOOR` dies (recon §5.3 — three sites). `Gates` gains `minExpectedMovePct` (moderate 1.5, aggressive 1.0); the floor test at composite.ts:216-217 becomes: compute `expectedMovePct` first (levelsFor's formula — hoist that one line above the gate), then `if (expectedMovePct < gates.minExpectedMovePct - (catalyst ? 0.5 : 0)) return null`. capacityPct stays in the call payload (display + calibration keys untouched).

- [ ] TDD: a capacity-5 name at composite 45 passes moderate (expectedMove 2.25); the same name at composite 26 fails (1.3) but passes aggressive w/ catalyst (1.3 ≥ 0.5); GLW-class capacity-6 conviction-40 passes; sleeve flag gone from every call site; re-derive the composite tests that planted `sleeve: true`. Full suite → commit `feat(engine): eligibility is the move you can expect, not the volatility class you belong to`.

---

### Task 5: thesis + falsifier — the voice, stored

**Files:** `shared/engine/types.ts` (`thesis?: string`, `falsifier?: string` on EngineCall — optional, additive), `shared/engine/composite.ts`, `dipLane.ts`, `velocityLane.ts` (producers), `netlify/functions/lib/engine.ts` (near-miss/observation sites + publishCall passthrough — recon §6.5's five construction sites), the five projections (engine.mts ledger slim, journalistBoardRows, boardExportRows, api.ts EnginePrediction + LedgerPrediction), `newspaper.ts` (prompt: caseText builds FROM the stored thesis; invalidation line = the falsifier VERBATIM), `TodaysCalls.tsx`/`EngineBoard.tsx` (thesis replaces the machine-voiced `note` as the lead line; note survives as the evidence line), SitePages copy.

**Templates (deterministic; LLM may polish, never invent):**
- Composite: `"{Side} {sym} — {stage phrase} with {top core contributor phrase}{, and top context phrase if |ctx| ≥ 4pts}. Wrong if it closes {below|above} {stop}."`— phrases from existing `detail` strings, humanised (no factor names — the 2026-07-23 ban on internal field names in reader prose).
- Dip: `"Long {sym} — hit {dropPct}% and holding{news clause}. Wrong if it closes below {stop}."`
- Velocity: `"Long {sym} — {door phrase} on {volume phrase}. Wrong on the first close below the trail ({stop} today, and it ratchets)."`
- Near-miss/observation keep their existing honest sentences (thesis stays unset — they are not calls).

- [ ] TDD: template tests per producer (assert no factor-name leakage: the banned-token list from newspaper's rule); projection tests (each of the five carries both fields); newspaper test (invalidation cell === stored falsifier verbatim; caseText prompt cites the thesis); UI render tests in the two components' existing style. Full suite → commit `feat(voice): every call says what it believes and what would prove it wrong`.

---

### Task 6: retire `scripts/engine-replay.ts` (D9)

- [ ] Delete the script + its package.json entry if any; grep for references (docs mention it — update ENGINE-REVIEW-PLAN.md pointer if live); confirm replay-window.test.ts and suite green. Commit `chore(engine): one replay harness — the Monday sampler forked the maths and graded against the wrong base`.

---

### Task 7: the Stage-2 gate

**Files:** `scripts/replay-window.ts` (+test) — the aggregation it lacks (recon §8.2); `docs/superpowers/plans/2026-08-11-stage1-replay-results.md` §14.

**New aggregation (post-run, from the same JSON):** grade histogram (board + ledger, by mode); probability spread (distinct values, min/max/stddev, per-band); monotonicity check (sampled composites 26→78 within each side/regime/cohort present in the window: p non-decreasing — the D2 guarantee, asserted); A-reachability probe (plant a synthetic n≥30 bucket at base+0.12 → assert an A emerges end-to-end); Brier: mean brierPoint old-epoch rows vs new-epoch rows; baseline↔new diff table (the Stage-1b attributed-diff pattern).

**Gate (all must hold; report numbers, never tune):**
1. Window re-run (2026-07-14→08-11, baseline = worktree of 2ae4484): zero-trade days stay 0; blank sides stay 0.
2. Grade distribution: B ≤ 75% of graded board rows (was 100% baseline, 83% after 1b).
3. Probability: ≥ 15 distinct values across the window (the step function is dead); monotone within every (side, regime, cohort) sampled.
4. A-reachability: the synthetic probe produces an A; AND the window itself is reported honestly (an organic A is NOT required — the seed may not support one yet; say which).
5. win5/avg5 vs baseline within noise (report t); Brier new ≤ old + 0.02.
6. Voice: every board trade row in the window carries a thesis + falsifier with zero banned tokens.

If the gate FAILS: write it up, STOP, owner decides. On a clean pass: present the evidence to the owner BEFORE push (grade semantics are reader-visible — this ship needs their eyes, per the Global Constraints).

- [ ] Build aggregation (+unit tests for the pure parts) → run both modes → write §14 → commit `test(replay): stage 2's gate — the curve, the grades, and the voice, measured`.

---

## Self-Review Notes

- Spec §4.2 coverage: factor order+EMA/volume (T1-T2), continuous probability+A-reachable+70+ floor (T3), never-blank was Stage 1, thesis/falsifier voice (T5), raw probability beside grades (T3 display decision), per-name capacity rethink (T4 retires the §4.1 interim). ENGINE_MODEL_VERSION (T3). §6 ordering: 2b (deep seed) follows — T2's re-base is exactly why (recon §2.4: the seed replays DEFAULT_WEIGHTS).
- Known risks the gate watches: the D5 floor changes which names publish (window diff attributes it); D6's B-tightening will cut marginal Bs (that is its purpose — say how many); the weights migration fires exactly once in production (idempotence test + the history entry is the audit trail).
- Deliberately NOT here: board-row falsifier alerts (Stage-3 ticket), isotonic on the WRITE path (never), seed regeneration (2b), post-mortems/miss ledger (Stage 3).
