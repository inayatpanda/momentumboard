# Stage 3a — "the engine says why it said no" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, one task per implementer. **Companion reading: `.superpowers/sdd/stage3-recon.md`** — §1 (funnel snapshot), §10 (booked defects), §0 headline. Read the named section before coding; its file:line map is the ground truth.

**Goal:** Every candidate the engine considers leaves a trace saying where it died (or that it published, and at what size) — persisted daily, additively, with ZERO change to what the board publishes. Plus the `exchangeFor` classification defect fixed. This is the raw material for 3b's miss ledger, 3c's gate accounting, and 3d's wildcard priority; nothing downstream can be built until the engine stops discarding its own reasons.

**Architecture:** `composeCall` returns a discriminated rejection instead of a bare `null` (8 sites, recon §1.2.1); `buildBoard` accumulates `Record<sym, {gate, side?, detail?}>` across its whole flow (not-candidate/trimmed/no-data are engine-side; grade-watchonly comes from `publishCall`'s size decision); one fail-soft write per day to `funnel-trace:${date}` + a bounded `funnel-trace-index`; the already-populated `nearMisses` array persists inside the trace whether or not a side was empty.

**Tech stack:** TypeScript, vitest; no new deps; blob shapes ADDITIVE-ONLY.

## Global Constraints

- **Zero behaviour change to published output**: the board, ledger, near-miss rows, empty-side reasons, alerts and paper are byte-identical for identical inputs. Pin: an engine test drives buildBoard twice (HEAD vs the new code path is not diffable in-test — instead assert the board/ledger blobs match a golden snapshot fixture built BEFORE the change, and that `funnel-trace:*` is the only NEW key written; the implementer records the mechanism chosen).
- Fail-soft per spec §4.5: a trace-write failure must not touch the board (copy the pattern at engine.ts:1930-1943).
- Gate codes: use the CODE's real taxonomy (recon §1.2.1), not the spec's 7-code sketch — spec §4.3's set is a subset; record the mapping in a comment: `not-candidate | trimmed | no-data | dead-zone-core | dead-zone-context | capacity-data | expected-move | entry-wait | entry-chase | entry-reversal | evidence-fail | grade-watchonly | route-blocked | diversity | slot-cut | called-full | called-half | called-shadow | called-watch`. The two dead-zone codes stay DISTINCT (the context-pushed-under case is §4.3's cap evidence). Additions allowed if the code path demands them; removals not.
- `composeCall`'s signature change must not leak outside shared/engine (callers: engine.ts + replay-window + tests — grep first; backtest.ts drives composeCall too, recon §3.x — keep its call compiling with minimal change).
- CALIB_DEF_VERSION/ENGINE_MODEL_VERSION untouched. Suite green (baseline as of HEAD when you start — record it), tsc -b green, no trailer, no push, no deploy (batched at stage end).

---

### Task 1: `composeCall` names its rejection

**Files:** shared/engine/composite.ts (the 8 nulls at :201/208/215/216/230/232/233/234 per recon — re-locate at HEAD), shared/engine/types.ts if the rejection type lives there; callers: netlify/functions/lib/engine.ts, shared/engine/backtest.ts, scripts/replay-window.ts (compile-only), tests.
**Interfaces — produces:** `composeCall(...): CallDraft | CallRejection` where `CallRejection = { rejected: true, gate: GateCode, side: 'long'|'short'|null, detail?: string }` (or an equivalent the codebase's idiom prefers — a second return value / a result union; implementer picks ONE and documents why; every existing caller that checked `null` now checks `.rejected` or narrows). `GateCode` exported from one place.
**Steps:** failing tests per rejection site (drive composeCall directly with inputs that die at each of the 8 sites — recon names the condition for each; the two dead-zones distinguished); implement; all callers updated; suite green; commit `feat(engine): composeCall says which gate said no — a name for every null`.

### Task 2: the daily funnel trace

**Files:** netlify/functions/lib/engine.ts (buildBoard accumulation + the fail-soft write), a small `shared/engine/funnelTrace.ts` for the shape + helpers, engine tests.
**Interfaces — consumes:** Task 1's GateCode. **Produces:** `funnel-trace:${date}` blob `{ date, gates: <the run's Gates values>, rows: Record<rowKey, { gate: GateCode, side?: 'long'|'short', source?: string, detail?: string }> — rowKey = `SYM:side` once a side exists, bare `SYM` for side-free gates (trimmed/no-candles); RATIFIED after Task-2 review: one-row-per-sym lost the sized long behind a demoted short, nearMisses: <the existing array, verbatim>, emptySides }` + `funnel-trace-index` (mirror predictions-index, `.slice(-250)` — recon §1.2.4). Accumulation covers: not-candidate is NOT recorded per-sym (unbounded universe — record only counts: `{ notCandidate: number }`), trimmed (the slice(0,180) cut + roster trim, per-sym), no-data (candleMap miss, per-sym), every composeCall rejection (per-sym+side), route-blocked/diversity/slot-cut (engine-side sets, recon §1.1 rows 9-10 + the console-only evidence at :1548), and called-* outcomes from publishCall's size decision (recon §1.2.5 — publishCall reports back or the caller records; implementer picks, documents).
**Steps:** failing test: a fixture day produces a trace naming every fixture candidate's fate, board blobs byte-match the golden fixture, trace write failure → board still publishes (inject a throwing store wrapper); implement; commit `feat(engine): the funnel leaves a trace — every candidate's fate, written daily`.

### Task 3: `exchangeFor` classifies by suffix, not by dash (recon §10)

**Files:** shared/symbols.ts:5 area; consumers to verify unchanged-or-fixed: useAlerts/useMarketData (hooks), netlify/functions/lib/news.ts:60/78, insiders.ts:30/163, TickerDetail.tsx:159, hypeCluster/isCryptoSymbol in replay-window (Task-2 Stage-2b shipped its own guard — UNIFY: replay's isCryptoSymbol should now delegate to the fixed exchangeFor; keep its test).
**The fix:** dot-suffix wins first (`.L` → LSE, etc.); crypto = quote-currency suffix (`-(USD|USDT|GBP|EUR|BTC)$` per the Stage-2b review note) — `BT-A.L` → LSE, `ETH-USD` → CRYPTO, `BRK-B` → US. Test the trio + the existing consumers' behaviour (BT-A.L gets LSE market hours in useAlerts; crypto news path no longer fires for it).
**Steps:** failing tests; fix; grep every exchangeFor caller and assert-or-adjust; suite; commit `fix(engine): a dash is not a coin — exchangeFor reads the suffix before the dash`.

### Task 4: replay parity + the golden-window proof

**Files:** scripts/replay-window.ts (surface the trace in walk diagnostics — additive field), one replay test.
**Purpose:** the acceptance instrument for 3b/3c: run the July-14→Aug-11 window at HEAD and assert (a) boards identical to a pre-3a run (the golden fixture from Task 2 extended to the window level — or a fresh diff-run pair, implementer's call, documented), (b) every day's trace rows + counts are present and internally consistent (every scored (sym,side) accounted for exactly once; called-* rows match the board+ledger rows the READER gets — shadow-cap casualties carry their own code, published watch rows read called-*).
**Steps:** failing test on the fixture walk; implement; run the real window locally and RECORD the gate histogram in the task report (first real funnel-trace data — 3b's baseline); commit `feat(replay): the walk carries the trace — and proves the board never noticed`.

## Self-review notes
- The spec's `grade-watchonly` and `called-*` live in publishCall, not composeCall — Task 2 owns that seam (recon §1.2.5).
- Near-misses persist VERBATIM inside the trace rather than gaining gate codes retroactively — they already carry stage/factors; 3b decides what more it needs.
- The wildcard's "highest-value blocked trade" (3d) will read `route-blocked`/`slot-cut`/`diversity` rows — those codes must carry enough detail (`detail`: the blocking correlation partner / the winning slot sym) — Task 2's shape includes `detail?` for exactly this; implementers populate where the info is already in scope, never compute new signals.
