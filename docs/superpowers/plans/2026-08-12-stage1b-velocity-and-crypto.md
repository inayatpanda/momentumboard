# Stage 1b: The Velocity Lane — Implementation Plan (v2, rewritten after codex RETHINK)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine catches AAOI/quantum/space-class runners through two sized doors — an early breakout probe at quarter size and a confirmed-run entry at half size — with a live trailing falsifier, theme-agnostic hype-cluster elevation, and a replay gate proving entries land inside the named historical runs.

**Architecture:** One new pure lane module (`velocityLane.ts`, mirroring `dipLane.ts`: classify → call constructor → trail helper), one new pure cluster module (`hypeCluster.ts`) fed by a new `social-history` blob, wired into `buildBoard` through the existing lane-merge machinery (`publishCall` + the guards Stage 1 hardened). Live trail enforcement lands in `openTrace`/`paperBook`. **Crypto is NOT in this stage** — split to Stage 1c at review (spec §6).

**Review provenance:** v1 (velocity+crypto) got codex RETHINK — 3 blockers, 12 majors, D-decisions mostly rejected — plus gpt-oss compile-level nits. v2 is velocity-only; every velocity-relevant finding is folded in and marked `[C#]` below. Crypto's blockers became Stage 1c's requirements in the spec.

**Tech Stack:** TypeScript, vitest, Netlify Functions, Yahoo (free), Netlify Blobs.

## Global Constraints

- Commits on `main`, imperative; **NEVER a Co-Authored-By trailer**. **Do NOT push** until Task 7's replay gate passes (owner pre-authorized push on a clean pass, 2026-08-12).
- Fail-soft everywhere: any new fetch/module erroring leaves the board identical to a lane-less run (deep-compare standard).
- $0 data. Untouched: `CALIB_DEF_VERSION`, `ENGINE_MODEL_VERSION`, hit definition, `probabilityFor`, `gradeFor`, equity bucket keys, dead zones, dip lane semantics, observation/near-miss machinery (except the two integration guards below).
- `setupBuckets` accrual for the new family is ACCRUE-ONLY (the repo's earn-influence rule) — `probabilityFor` does not read it.
- Lane calls must not train factor IC (Stage 1's dip guard generalizes: `LANE_CATALYST_KINDS`) [gpt-oss P3].
- Suite green after every task (`npm test`, currently 958), `npx tsc -b` clean; `npm run build` green before each commit.
- Line anchors as of `de03c26`; find sites by symbol when they've drifted.

---

### Task 1: `velocityLane.ts` — classify, construct, trail

**Files:** Create `shared/engine/velocityLane.ts`, `shared/engine/velocityLane.test.ts`.

**Interfaces:**
- Consumes: `Candle` from `'../types'`; `EngineCall`, `clamp/round1/round2` from `'./types'`; the SMA-seeded `emaLast` pattern (copy dipLane's, or export it from a shared spot if trivial).
- Produces:
  - `classifyVelocity(candles: Candle[]): VelocityRead | null` — null iff < 30 candles. `VelocityRead = { door: 'early' | 'confirmation' | null; greenStreak: number; detail: string }`.
  - `velocityCall(sym: string, candles: Candle[], read: VelocityRead, capUsdM: number | null): EngineCall | null` — long only, null unless `read.door`.
  - `velocityTrail(candles: Candle[]): number | null` — the live falsifier level (Task 6 consumes it daily).
  - `VELOCITY_DOOR_CAP = { early: 0.25, confirmation: 0.5 } as const` (Task 5's sizing input).

**Rules (each `[C#]` marks the codex finding it answers):**
- Shared inputs: `avgVol20` = mean volume of the 20 sessions EXCLUDING today (`slice(-21,-1)`); `ema8` = SMA-seeded EMA of all closes; `greenStreak` = consecutive up-closes ending today.
- **Early door:** today's close > the max CLOSE of the prior 20 sessions **excluding today** [gpt-oss #7 — the breakout level must not include the breakout bar], AND today's volume ≥ 3× `avgVol20`, AND `greenStreak ≤ 2`.
- **Confirmation door:** (close/close[−6] − 1 ≥ 15%) OR (≥3 up-days in the last 5 **where at least one qualifying UP-day printed ≥ 2× `avgVol20`** — the volume evidence must sit ON an up-day, not on a high-volume down day [C7]); AND the entry-timing rule: `greenStreak ≤ 2` AND close > `ema8` (the first pause that holds the 8-EMA, or the reclaim after it).
- Both doors open → **early wins** (smaller size on the younger, riskier read).
- `velocityCall`: entry = last close; **stop = `velocityTrail(candles)`** where trail = `max(ema8, min(INTRADAY LOW of the prior 5 completed sessions — EXCLUDING today))` [C3 — a low5 including today's own bar can never fire against today's close]; null if stop ≥ entry. Target = entry + 2 × (entry − stop) (2R; momentum runs are ridden, not measured by retrace). Composite = `round1(clamp(25 + |5-session move %|, 25, 55))`. `setup: 'velocity'`, `stage: 'trending'`, `evidence.contract: true` with NOMINAL coverage/famAgree marked as such in a comment (the dip-lane convention), factors record in the composite.ts:159-161 shape with a `technical` placeholder score (+40) and weight 0.

- [ ] **Step 1: failing truth-table tests** — calm tape (no door); breakout day on 3× volume (early); breakout on 2× volume (no door — threshold is 3×); +16%/5-sessions with a pause holding the 8-EMA (confirmation); 3-of-5 up-days where the ONLY ≥2× volume day was the down day (no door [C7]); 5th consecutive green day (no door — entry timing); both-doors tape (door === 'early'); `velocityCall` levels (stop = max(ema8, prior-5 low), target = 2R, composite in [25,55]); stop ≥ entry → null; `velocityTrail` on a washout tape (today's low undercutting the prior-5 low must NOT drag the trail down — trail reads prior sessions [C3]).
- [ ] **Step 2: RED.** — [ ] **Step 3: implement.** — [ ] **Step 4: GREEN + `npm test`.**
- [ ] **Step 5: Commit** `feat(engine): the velocity lane — two doors, one trail, and the Nth green day is never bought`

---

### Task 2: family + kind + IC isolation

**Files:** Modify `shared/engine/types.ts` (SetupFamily union + `route`-free — no other type changes), `shared/engine/composite.ts` (`setupFamilyOf` untouched — 'velocity' is stamped by the lane, verify no exhaustive switch breaks [gpt-oss #1: grep `SetupFamily` consumers]), `shared/engine/catalyst.ts` (ADD `'velocity'` to the kind union + `export const VELOCITY_CATALYST_KIND = 'velocity' as const` + `export const LANE_CATALYST_KINDS: ReadonlySet<string> = new Set([DIP_CATALYST_KIND, VELOCITY_CATALYST_KIND])`), `netlify/functions/lib/engine.ts` (the IC guard at ~line 340 becomes `!LANE_CATALYST_KINDS.has(pred.catalyst?.kind ?? '')` — verify the polarity against the existing dip test), calibration setupBuckets accept the new family (verify the key template is family-agnostic — it is: `${setup}:${side}:${band}`).

- [ ] Failing tests: a graded velocity prediction leaves factor-IC counts untouched but accrues its `velocity:long:{band}` setup bucket; the existing dip IC test still passes. RED → implement → GREEN → commit `feat(engine): lane calls are quarantined from factor learning as a family, not a special case`.

---

### Task 3: `day_gainers` 25 → 50

**Files:** `netlify/functions/lib/screener.ts` — `fetchScreen` gains a `count` param (default 25), `parseScreen` a matching slice param; `defaultDeps.screens` passes 50 for `day_gainers` only. Tests: URL carries count=50 for gainers, 25 elsewhere; parse respects the wider slice.
- [ ] RED → implement → GREEN (+ full suite) → commit `feat(engine): the gainers screen digs 50 deep — mid-caps stop losing to penny rockets`.

---

### Task 4: `social-history` + `hypeCluster.ts`

The spec's cluster inputs don't exist yet: `combineSocialPulse` returns one day's independent trending ranks — there is no co-mention data and no history [C8]. This task builds the honest version: a persisted daily trending snapshot, and clusters detected from **repeated co-appearance across days** plus **abnormal return co-movement**, requiring real sample sizes.

**Files:** Create `shared/engine/hypeCluster.ts` + test; modify `netlify/functions/lib/engine.ts` (write the history blob after the social fetch).

**Interfaces:**
- `TrendDay = { date: string; syms: string[] }`; blob `social-history` = last 21 `TrendDay`s (append-if-new-date, fail-soft).
- `detectClusters(history: TrendDay[], closesBySym: Map<string, number[]>, spyCloses: number[]): string[][]` — `[]` when history < 7 days (documented warm-up; the lane runs fine without clusters — they only elevate candidate priority).

**Rules [C8 — every leg gets real evidence]:**
- Co-appearance leg for a pair: BOTH names in the trending set on ≥3 of the last 5 recorded days.
- Co-movement leg: Pearson over EXCESS daily returns (vs SPY) across the last 20 sessions, requiring **≥15 overlapping observations**, r ≥ 0.6. (No 2-point ±1 correlations.)
- Edge = BOTH legs. Cluster = connected component of size ≥3 where **every member has degree ≥2** (no A–B–C chains held together by one bridge).

- [ ] Failing tests: warm-up (<7 days → []); a genuine 3-name cluster (planted co-appearing days + correlated tapes) detected; a pair failing the co-move leg (uncorrelated tapes) excluded despite co-appearing; the degree-≥2 rule rejecting a 3-chain; <15 overlapping returns → no edge; blob writer appends once per date.
- [ ] RED → implement → GREEN → commit `feat(engine): hype clusters are detected from the tape's own record — no theme is ever hard-coded`

---

### Task 5: wire the lane into `buildBoard`

**Files:** `netlify/functions/lib/engine.ts` + `engine.test.ts`; `shared/engine/types.ts` if a small optional field is needed for the trail kind (see Task 6).

**Steps (verify every anchor by symbol first):**
(a) **Velocity pass** after the dip merge, same shape: candidates with candles, `capUsdM ≥ 20` ($20M liquidity floor — cluster membership is elevation, never eligibility), skip syms with a **constructed dip call** (`constructedDipLongs`, NOT `dipReads` [C9 — Stage 1 already fixed this exact bug for shorts]) and syms that already have a long row (`alreadyLong` pattern). `classifyVelocity` → `velocityCall` → `earningsRisk` override from `earningsSet` → `publishCall(call, capUsdM, { kind: VELOCITY_CATALYST_KIND, side: 'long', reason: read.detail, strength: 50 }, false, VELOCITY_DOOR_CAP[read.door])`.
(b) **Sizing:** `publishCall` gains an optional `sizeCap = 1` (thread it through the ONE signature and update all call sites in the same commit [gpt-oss #5]); `riskPct = base × min(tierFraction, sizeCap)` where tierFraction is 1 for fullTrade and 0.5 for halfTrade — a cap, never a product [the v1 D4 rule, accepted]. UI risk strings derive the label from the fraction (`(quarter size)` / `(half size)`) — extend `fmtRiskPct`'s call sites.
(c) **One direction per chart [C10]:** a live velocity long excludes same-sym SHORT near-misses and observations (extend the same-sym exclusion the observation promotion already has to the near-miss builder), and the dip-over-short demotion loop treats a sized velocity long exactly like a sized dip long (rename its key set to `sizedLaneLongs`, fed by both lanes).
(d) **Cluster elevation:** read `social-history`, run `detectClusters` (fail-soft try/catch → []), `addSource(sym, 'hype-cluster')` for members, priority tier = the sleeve's (4), and stamp cluster membership into the velocity call's catalyst `reason` for narration.
(e) **Fail-soft test:** velocity module import erroring / empty history / cluster throw → deep-compare identical board to a lane-less run.

- [ ] Failing tests: breakout candidate publishes a quarter-size velocity long (riskPct = base × 0.25, grade from calibration as usual); confirmation door → half; velocity long + dip READ that failed dipCall → velocity still publishes [C9]; velocity long + composite short near-miss same sym → near-miss suppressed [C10]; cluster member gains priority (a 181st-place candidate with cluster membership makes the 180 cut); fail-soft deep-compare; graded velocity call accrues `velocity:long:*` setup bucket only.
- [ ] RED → implement → GREEN (+ tsc + build) → commit `feat(engine): velocity reaches the board — quarter-size probes, half-size confirmations, one direction per chart`

---

### Task 6: the trail is LIVE, not decorative [C3]

The spec's falsifier ("first close below the 8-EMA or the 5-session low") must actually move the exit. Today `openTrace`/`paperBook` compare closes against the static published `stop`.

**Files:** `shared/engine/openTrace.ts`, `netlify/functions/lib/paperBook.ts`, `shared/engine/types.ts` (`Prediction.trail?: 'velocity'` — an optional marker, additive), tests for both.

**Mechanism:** velocity rows publish with `trail: 'velocity'`. Each day, for open velocity rows, both consumers recompute `velocityTrail(candles-as-of-that-day)` and use `max(published stop, trail)` as the effective stop — the trail only ever RAISES the exit [C3's directionality]. The published `stop` stays what it was (calibration's close-through grading is untouched — grading still uses the published stop; the trail governs the OPEN-BOOK exit narrative and paper-book exits, which is where the reader's discipline lives). Document this split honestly in both files: grading measures the original thesis; the book trades the trail.

- [ ] Failing tests: a velocity row whose tape closes below the risen trail (but above the original stop) exits in paperBook and reads "trail hit" in openTrace; a non-velocity row is untouched; the trail never lowers below the published stop.
- [ ] RED → implement → GREEN → commit `feat(book): the velocity trail is enforced daily — the falsifier moves, the exit moves with it`

---

### Task 7: replay gate — the named runners [C15]

**Files:** extend `scripts/replay-window.ts` (a `--velocity-probe` mode) + `docs/superpowers/plans/2026-08-11-stage1-replay-results.md` §12.

**Design (strengthened per C15):**
- **Named probes with named windows** — no `biggestRun` auto-detection: AAOI (2026 run — locate its actual window from the candles WITHIN a stated search range and print the dates used), the space cluster (RKLB + two peers, 2026), and the 2025 quantum trio (IONQ, RGTI, QBTS) as the out-of-sample probe. Each probe = one symbol + one date range, hardcoded in the script with a comment saying what it is.
- For EVERY probe and BOTH doors: walk the window day-by-day, record every firing (date, door, entry), simulate the trail exit forward, and report per-runner: entries-in-run positions, exits green/red, doors that never fired.
- **Gate (all must hold):** ≥4 of the 6 named runners fire at least one door inside their run; across all in-run entries, median position ≤ 0.6 of the run and ≤⅓ beyond 0.8; ≥60% of in-run entries exit green via the trail; AND zero entries on a run's single highest close. Report out-of-run firings honestly (they count against nothing but must be listed).
- Also re-run the 21-day window replay (candles re-fetch if the old cache is gone) confirming the equity board is unchanged except velocity rows (the lane is additive; zero-trade days stay 0).
- **If the gate fails: STOP, write it up, the owner decides.** No threshold tuning.

- [ ] Build + probe + write §12 + commit `test(replay): the velocity doors against the runners they were built for` (results committed pass or fail).

---

## Self-Review Notes

- Codex mapping: C3 → Tasks 1+6 (trail maths excludes today; live enforcement). C7 → Task 1 (volume on up-days). C8 → Task 4 (real legs, real samples, degree rule, warm-up). C9 → Task 5a. C10 → Task 5c. C15 → Task 7. C11/D10 sizing → Task 5b cap arithmetic. gpt-oss #1/#5/#7 → Tasks 2/5b/1. All crypto findings (C1,2,4,5,6,12,13,14 + weekend) → Stage 1c requirements in the spec.
- Judgment calls for the controller: the 2R target (spec silent); trail-vs-grading split in Task 6 (grading keeps the published stop so `CALIB_DEF_VERSION` and the hit definition stay untouched — the alternative, grading on the trail, is a hit-definition change and needs its own version bump); the $20M floor; cluster warm-up semantics.
- The lane concentration risk recorded at Stage 1 ship applies here too: three lanes now feed longs. The replay §12 must report the combined lane share of trades.
