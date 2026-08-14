# Stage 3d — the Wildcard Slot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, one task per implementer. **Companion reading: `.superpowers/sdd/stage3-recon.md` §7** (the spec verbatim, the blocked-trade source table, the reuse-verbatim mechanics list — every file:line the tasks need is there).

**Goal:** One experiment slot, quarter-size, that takes a blocked trade and produces the CAUSAL gate evidence the learning loop cannot otherwise get — deterministic selection, one-slot invariant, mandatory post-mortem win or lose, record separable end to end. The owner delegated this lane's design (2026-08-11); the design decisions below are the ratified exercise of that delegation.

## Ratified design (supersedes spec §4.1 where noted)

- **Priority ladder** (p2 re-specified — recon §7.2: the "70+ has zero data" rationale is dead):
  1. The highest-|composite| candidate blocked by EXACTLY ONE gate (the funnel trace knows the gate — 3a solved the recon's "missing: which gate"), preferring the gate with the thinnest miss-ledger evidence (smallest `sidedCost+sidedSaved+unchecked` — an unmeasured gate is exactly what the experiment is for).
  2. A candidate whose `(cohort, side, regime)` rung carries NO sized evidence (cohort-tagged keys are still empty in gen-4 — the genuinely unmeasured slice, replacing the falsified 70+ rung).
  3. An LLM catalyst nominee (catalystBySym) whose near-miss read just missed the dead zone (the two-source join, recon's cheapest rung).
- **Exclusions:** earnings-risk rows NEVER (the engine's coin-flip refusal is not an experiment surface — recon's advice, ratified); unroutable candidates are SKIPPED, not shadowed (a shadow wildcard yields no causal evidence and the slot is scarce — supersedes the spec's "or it runs as a shadow"); route ETPs excluded (`isRouteEtp`).
- **Causal evidence semantics:** a graded wildcard books its outcome into the miss ledger's gate entry as `causal: { n, hits, examples[] }` (additive) — REAL sided outcomes WITH stops, strictly better evidence than the stopless upper bounds. It ALSO counts into `sidedCost/sidedSaved` (it is a sided outcome of that gate's decision — the "strongest trigger" wording realised as: causal outcomes reach eligibility the same day they grade, no 10-session miss-maturation lag). The weighting policy beyond that (should causal count double?) is DEFERRED to the same owner conversation as count-vs-magnitude — noted, not encoded.
- **Cadence:** one live wildcard at a time; a new one only when the previous carries `outcome10` (the outstanding-scan pattern, recon §7.4). No candidate ⇒ no wildcard — an experiment slot, not a quota.
- Voice: `🃏 Wildcard` label; the hypothesis names the gate under test and the evidence gap ("dead-zone-core has 7 priced outcomes; this tests it at composite 23"); the standing warning ("experiments lose more often than the board"); post-mortem on EVERY closure, win or lose.

## Global Constraints

- The wildcard NEVER: counts toward the 3/side caps (post-cut push — the observation-promotion pattern, engine.ts:1774 area), enters risk-ladder rung progression or factor IC (`WILDCARD_CATALYST_KIND` joins `LANE_CATALYST_KINDS`; the ladder streams at engine.ts:447/463-4 gain the kind check — NEW code, recon §7.4), gets leverage (structural: sizeCap 0.25 < 1 — verify the pin exists), publishes without a stop (structural via levelsFor — pin it).
- `sizeCap = 0.25` through the EXISTING publishCall parameter (the velocity-door precedent; a cap, never a multiplier).
- Selection is DETERMINISTIC (spec §5): stable sort with the candidateSyms tiebreak convention; two runs over one day's inputs pick the same wildcard (pinned).
- Accrual: the wildcard is SIZED evidence (riskPct > 0, accrual='sized' — it is reader money); its calibration accrual is normal; ONLY the ladder/IC exclusions above apply.
- Suite green from baseline (1,864/139); tsc -b; npm run build (src copy touched in T2); no trailer; no push/deploy until the stage batch.

### Task 1: the selection lane (pure)

**Files:** shared/engine/wildcardLane.ts (new) + tests.
`selectWildcard(inputs) → { candidate, hypothesis, priority: 1|2|3 } | null` — inputs: the day's funnel-trace rows (gate per sym:side), nearMisses (core/levels-derivable fields), catalystBySym, the miss-ledger gate stats (thinness), calibration (rung-evidence emptiness for p2), the outstanding-wildcard flag, cfg.levMap (routability), and the exclusion sets. Implements the ladder + exclusions + determinism above. Hypothesis text is template-built from numbers (house rule — it reaches the paper).
PINS: each priority rung selects when the higher rungs are empty; exactly-one-gate discrimination (a two-gate row never qualifies); earnings exclusion; unroutable skip; thinnest-gate preference arithmetic; determinism (same inputs twice ⇒ same pick, shuffled input order ⇒ same pick); no candidate ⇒ null; outstanding ⇒ null.
Commit: `feat(engine): the wildcard chooses — one blocked trade, the thinnest gate, deterministically`.

### Task 2: the slot lives in the engine

**Files:** engine.ts (post-cut publish with sizeCap 0.25, WILDCARD_CATALYST_KIND + LANE_CATALYST_KINDS entry, the ladder-stream kind checks at :447/:463-4, the outstanding scan, the unconditional post-mortem predicate, the causal write-back at grading into miss-ledger), shared/engine/catalyst.ts (the kind), missLedger.ts (`causal` additive shape), voice/paper/panel labels (🃏 + hypothesis + warning; the paper line rides the 3b/3c compose seam), tests.
PINS: never in the 3/side cut (a full board still publishes the wildcard); never in rung progression (drive the ladder with a graded wildcard — counters unmoved); never in factor IC; sized accrual normal; causal booking on grade day (both win and loss directions, examples tagged); one-slot enforced across days (outstanding blocks); post-mortem stamped on a WINNING wildcard too; the 🃏 label + warning in the row's voice fields; ZERO behaviour change when no wildcard selects (golden-family guard).
Commit: `feat(engine): the wildcard trades — quarter-size, ladder-blind, post-mortemed win or lose`.

### Task 3: the window proof + ship evidence

Walk the acceptance window with the lane live: record which wildcards it takes (expect few — the slot is weekly-ish), the one-slot invariant holding, determinism (the walk twice ⇒ identical wildcard sequence), causal entries landing in the ledger, and the controlled-diff guard (the ONLY new rows vs a lane-off arm are the wildcards + their causal ledger entries — everything else byte-identical; the lane must not perturb selection for ordinary rows). Append the evidence to the walk-results doc; commit with it.
Commit: `feat(replay): the experiment slot proves itself — deterministic, solitary, causal`.

## Self-review notes
- The trace's `detail` (blocking partner, cut reason) feeds the hypothesis text — populated since 3a T2; priorGate covers shadow-capped attribution if a capped row ever reaches the pool (it shouldn't — capped rows aren't single-gate blocked; pin the exclusion).
- p2's rung-emptiness check reads the SIZED slice (post-3c semantics); as cohort rungs fill with live evidence, p2 naturally retires itself.
- The velocity-sizing experiment idea (recon: "take one velocity row at quarter size for real") is deliberately NOT in the ladder — the velocity flip is the owner's explicit decision gate (Stage 1b ratification) and the wildcard must not route around it.
