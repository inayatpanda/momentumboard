# Stage 3c — "grades tell the truth again" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, one task per implementer. **Companion reading: `.superpowers/sdd/stage3-recon.md`** §3 (gate feedback — the config reality, the four gates at HEAD), §5 (IC repairs — what's unreachable vs the real live defect), §6 (setup consumption — the ladder, the 23 keys), §8 (provenance partition — shape A ratified below); plus `.superpowers/sdd/progress.md`'s "3c ENTRY CONDITIONS" block (3b's double-booking + clsBefore + window-vs-lifetime notes bind Task 3).

**Goal:** The engine's learning acts on its evidence: sized rows grade against sized history (the provenance partition — the unmasking), setup families earn probability influence at n≥30, the IC loop gets the stability bounds whose absence pinned momentum at 2× and crushed technical to 0.079, and the gates move — bounded, evidenced, announced — starting with the dead zone the miss ledger charged +526pp. Ships with a generation-4 seed measured under all of it.

**THIS STAGE CHANGES PUBLISHED NUMBERS BY DESIGN.** The acceptance gate is a controlled diff: every changed grade/size must be attributable to one of the three sanctioned paths (partition, blend, gate move) — plus the unmasking payoff gate (Task 4).

## Global Constraints

- CALIB_DEF_VERSION stays 3 (nothing here changes the hit definition); ENGINE_MODEL_VERSION stays 3 (the composite function is untouched — scoring inputs and weights bounds change the LOOP, not the model's shape). Blob shapes additive-only; `poolBuckets` parses key parts — **the partition must NOT touch keys** (recon §8.2).
- Ratified shape A: `BucketStat` gains optional `shadowN?/shadowHits?`; absent ⇒ never partitioned ⇒ sized read falls back to pooled — byte-identical on any legacy blob (the `referenceBase` absent-means-legacy pattern). Discriminator (RE-RATIFIED after Task-1 review): **the shadow's CAUSE, not the row's size** — rows shadowed by the three pre-grade causes (lane shadow-first / earningsRisk / unshortable) accrue and price as SHADOW (they are the dilution the walk named); every OTHER row — including grade-null demotions, below-base and watch rows — accrues SIZED (they are the band's own recovery record: sealing them contradicted engine.ts's "earn its way back up" invariant — a sized band under the anchor froze forever while the pooled read recovered). The engine stamps `pred.accrual: 'sized'|'shadow'` at publish (pre-grade, additive field); updateCalibration reads it, legacy fallback riskPct>0. NOTE the consequence for 3b's double-booking: watch outcomes re-enter sized evidence BY DESIGN (they are the recovery path); the one-event-two-levers control lives entirely in Task 3's gate-eligibility marker.
- Grades and probabilities for SIZED rows read sized-only evidence wherever a partition exists; shadow rows keep accruing (they are the velocity flip's record) and are PRICED against the pooled read (a shadow's probability is not reader money). `baseHitRate` gains the same sized mode; `referenceBase` is independent (swept, not pooled) and does not move.
- Gate feedback data hygiene (3b entry conditions, binding): eligibility counts use **sided, non-bare, non-double-booked** ledger rows only — `bare: true` examples excluded; the unsized `called-*` gates (watch/below-base/observation) are marked double-booked and their COST never loosens a gate (one event must not move two levers: their outcomes already steer calibration). Direction-not-magnitude: costs are stopless upper bounds; eligibility is count-based (cost > 2× saved), never pp-sum-based.
- Gate bounds are HARD and testable: deadZone ∈ [20, 25] notch 2.5; minExpectedMovePct ∈ [1.0, 1.5] notch 0.25 (the capacity-floor's living substitute — recon §3.2); CONTEXT_MAX_PTS ∈ [12, 16] notch 2 **with the joint-bound invariant pinned: cap < effective deadZone − 2 at all reachable combinations**; famAgree=2 reportable, immovable. One notch per gate per 20 sessions (predictions-index is the clock); symmetric tightening when saved > 2× cost; every move logged + panel + paper line. A gate whose own attributed evidence is <30 is ineligible — which correctly leaves the context cap frozen until live `dead-zone-context` evidence accrues (its replay zero was an artifact; its live population is unmeasured).
- IC loop bounds: nudges require `nAgree ≥ 20 AND nDisagree ≥ 20` (the minDisagree floor — momentum's 1.8× rested on 15 disagreements); per-factor weight band hardens to `[0.5×base, 1.5×base]`; the zero-is-a-reading table (seasonality, news accrue zero scores; null always skipped) lives beside FACTOR_FAMILY. Lane quarantine (LANE_CATALYST_KINDS) unchanged.
- Setup blend (spec §4.3(c) verbatim): `p = 0.7·p_ladder + 0.3·p_setup` only when the row's `setup:side:band` bucket has **sized n ≥ 30** (the partition applies to setupBuckets too — blending shadow-diluted setup evidence into sized grades would re-import the dilution the partition removes); provisional/nEff semantics documented (nEff stays the ladder's — the blend adjusts p, not evidence mass; state this in code).
- Suite green from recorded baseline (1,698/137); tsc -b; npm run build where src touched; no trailer; no push/deploy until the stage batch.

---

### Task 1: the provenance partition

**Files:** shared/engine/calibration.ts (BucketStat, updateCalibration, poolBuckets/curveFor/baseHitRate/probabilityFor sized modes), engine.ts call sites, tests.
Per recon §8.2-8.3. Sized read = `{n: n−shadowN, hits: hits−shadowHits}` clamped ≥0; a bucket with no sized evidence contributes no sized curve point (the same rule as empty buckets). probabilityFor gains a `population: 'sized'|'pooled'` argument — engine grades sized rows with 'sized', prices shadows/near-miss with 'pooled'. PINS: legacy blob (no sub-counts) → byte-identical reads both populations (the gen-1/2/3 seeds must read exactly as today); a 60/40 sized/shadow fixture → sized read excludes the 40; baseHitRate sized mode consistent; updateCalibration books sub-counts by riskPct.
Commit: `feat(engine): sized rows grade against sized history — the provenance partition`.

### Task 2: IC stability + the setup blend

**Files:** shared/engine/calibration.ts (updateIcStats zero-table, maybeNudgeWeights bounds+minDisagree), shared/engine/composite.ts (ZERO_IS_A_READING beside FACTOR_FAMILY), probabilityFor (the blend), src/lib/api.ts (bySetup client type if absent), tests.
PINS: a factor at nDisagree 15 never nudges however many agreements; the band [0.5×, 1.5×] holds under 500 compounding nudges (a loop test — the walk's failure mode); seasonality zero accrues, social null skips; the blend fires only at sized n≥30 and moves p by exactly 0.3·(p_setup − p_ladder); a velocity row's blend reads `velocity:*` sized evidence only.
Commit: `feat(engine): the loop gets brakes — IC floors, weight bands, and setups that earned a voice`.

### Task 3: gate feedback + the riders

**Files:** new shared/engine/gateState.ts (blob `gate-state`, RiskState-precedent: pure advance function, hard bounds, cadence via session count, `gateOverride` escape hatch mirroring riskRungOverride); engine.ts (effectiveGates(cfg, gateState) feeding buildBoard — the trace already stores the run's gates); missLedger.ts (the eligibility read honouring the hygiene constraints; `alsoGraded`/`doubleBooked` marker on gate lines + bare exclusion — 3b entry condition (a)); the 3a riders: FunnelTraceRow gains `core?` (priority) and `priorGate?` (what revise overwrote — shadow-capped attribution); paper/panel: a gate move renders one line each.
PINS: eligibility arithmetic (30/2×, sided-non-bare-non-doubleBooked only); cadence (a second notch within 20 sessions refused); bounds unreachable-beyond; symmetric tighten; the joint-bound invariant across ALL reachable (deadZone, cap) pairs; override wins; a move writes its log line; ineligible-context-cap-until-evidence.
Commit: `feat(engine): the gates move — bounded, evidenced, announced`.

### Task 4: generation-4 seed + the unmasking gate (execution)

**Binding from Task-1 review:** scripts/replay-window.ts's `enrichFromCalibration` recomputes POOLED — from gen-4 onward that stops matching the board (born-below counts, the §3 rounding check, and the monotonicity gate would measure the wrong curve). Task 4 plumbs the population through the replay's enrichment (sized rows sized) BEFORE running the payoff gate.

Regenerate via the frozen-vector walk (gen-3 mechanism) at `--seed-generation 4` — the walk now books partitioned sub-counts and the new IC rules measure under the bands. Acceptance window re-run with gen-4 installed. **THE PAYOFF GATE:** (a) grade distribution is no longer ≥97% single-grade — B appears where the sized record supports it (walk-results predicted long:green:55-70 sized ≈57% → the partition should surface it); (b) zero monotonicity violations; (c) every changed grade vs the gen-3 acceptance run attributes to partition/blend (gate-state starts empty — no moves yet in the walk unless the walk drives feedback; DECISION: the walk does NOT advance gate-state in seed mode — gates move on live evidence only; pin it); (d) referenceBase re-swept, expected ≈unchanged; (e) suite pins updated (generation floor to 4, committed-seed literals) — the stamped-fixture lesson from gen-2/3 applies.
Commit: `feat(engine): generation 4 — measured under the partition, the brakes, and the blend`.

### Task 5: window proof + controlled-diff evidence (acceptance for the batch)

The walk over the window with everything on vs 3b-HEAD behaviour: a per-row diff of grades/sizes classified into the three sanctioned paths (partition/blend/feedback) — any unclassifiable change FAILS the walk; the histogram + the first gate-eligibility readout (is dead-zone-core eligible on live-shaped data?) recorded as the ship evidence. Plus: the double-booked marker visible in the summary; priorGate populating for shadow-capped rows.
Commit: `feat(replay): every changed grade has a name — the controlled diff proves the batch`.

## Self-review notes
- The dead zone's +526pp evidence justifies ELIGIBILITY machinery, not an immediate move: live attributed outcomes accrue from 3a's deploy (2026-08-13); the first legitimate notch is ~30 attributed outcomes later. The plan builds the mechanism; the evidence arrives on its own clock. State this in the paper line the first time the panel shows an eligible-but-unmoved gate.
- gatesFor presets remain the base; gate-state stores DELTAS from preset so an appetite switch composes sanely (pin: aggressive preset + loosened delta clamps to the hard floor, never below).
- setupBuckets partition wants the same absent-fallback pins as main buckets.
- 3d (wildcard) consumes: gate-state (which gate is hot), the trace's detail/priorGate, miss examples. Nothing here blocks it.
