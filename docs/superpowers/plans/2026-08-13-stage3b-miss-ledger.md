# Stage 3b — "the engine measures its own regret" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, one task per implementer. **Companion reading: `.superpowers/sdd/stage3-recon.md`** §2 (miss detection — the spec verbatim, the data table, the economics) and §4 (post-mortems — the hook at engine.ts:432-434, the classification non-disjointness, the LLM budget reality). Read the named section before coding.

**Goal:** The engine detects its own misses (+10 sessions, charged to the gate that refused them), accrues a per-gate cost/saved ledger, and writes a deterministic post-mortem onto every graded loser — with one budgeted LLM sentence for the paper's sized losers. NO gate moves yet (that's 3c, and it needs this ledger's data); nothing here changes a single published decision.

**Architecture:** Both mechanisms live inside `gradeOutstanding`'s existing daily pass. Miss detection reads `funnel-trace:${date}` from ~10 sessions ago (via `funnel-trace-index`), evaluates the not-called rows' 10-session excess vs SPY under the SAME entry basis as `gradePrediction`, and accrues `miss-ledger` (additive blob). Post-mortems write an additive `postMortem` field onto the `Prediction` row at the exact point the loser is known (engine.ts:434), riding the existing store.write for free; the scorecard loop gains a `byPostMortem` roll-up.

## Global Constraints

- **Zero change to published trading decisions**: board/ledger/grades/sizes byte-identical. Misses and post-mortems are OBSERVATIONS. (Post-mortem adds a field to Prediction rows — additive; the golden-hash test from 3a covers the board; assert ledger rows only GAIN the field.)
- Fail-soft (spec §4.5): no trace found / SPY missing / fetch failures → skip quietly with a counter, never throw, never block grading.
- The miss bar is **±5pp excess** (spec §4.3) vs the hit bar's +1pp — deliberately different; say so in code comments. Both sides always counted: a sided row is evaluated on its own side; a bare row (trimmed/no-candles) is evaluated BOTH ways and can be a miss on either.
- Miss entry basis mirrors `gradePrediction`'s exactly (entry session's OPEN — read calibration.ts:409-413 and mirror; a miss has no stop, so its excess is STOPLESS — an upper bound, stated honestly in the ledger comment). Do NOT call gradePrediction with a fake stop.
- Fetch economics (recon §2.2): names still in today's candleMap are free; others cost `cachedCandles`. Hard budget `MISS_FETCH_BUDGET = 40`/day, priority: sided rows by |composite| desc, then bare rows; population skipped for budget is COUNTED in the ledger day entry as `unchecked` (silent truncation is the enemy).
- LLM: `POSTMORTEM_LLM_BUDGET = 3`/day (the DIP_NEWS_BUDGET precedent, recon §4.4(b)), sized reader-facing losers only, newest first; overflow and every failure fall back to the deterministic line; never a second attempt same run.
- `dead-zone-context`'s replay zero is an ARTIFACT (ledger note in progress.md) — nothing in 3b may treat replay gate-frequencies as live priors.
- CALIB_DEF_VERSION/ENGINE_MODEL_VERSION untouched; blob shapes additive-only; suite green from the recorded baseline; tsc -b green; no trailer; no push/deploy (batched at stage end).

---

### Task 1: miss detection + the ledger

**Files:** shared/engine/missLedger.ts (new: shapes + pure helpers), netlify/functions/lib/engine.ts (the gradeOutstanding hook), tests both sides.
**Produces:**
- `missExcess(candles, spy, entryDateISO): { long: number, short: number } | null` — pure; 10-session, stopless, gradePrediction-mirrored entry basis.
- Blob `miss-ledger`: `{ gates: Record<GateCode, { cost: number, costExcessSum: number, saved: number, savedExcessSum: number, examples: {date,sym,side,excessPct,gate}[] }>, days: Record<date, { checked: number, unchecked: number, misses: number }> }` — examples bounded 10/gate (newest win); days bounded `.slice`-style to 60 entries.
- The hook: inside gradeOutstanding after grading (recon §4.3 flow), resolve the trace date ~10 sessions back via `funnel-trace-index` + SPY's own session count (not calendar days — mirror how grading finds session distance), read `funnel-trace:${d}`, skip rows whose gate is called-* or shadow-capped (they were published or capped shadows — not "not called"... EXCEPT called-watch/below-base/observation: an unsized row the reader could not act on IS a miss candidate; adjudicate: unsized called-* rows count, sized called-full/half do not, called-shadow does not (it grades already); document), evaluate under the budget, accrue: excess beyond +5pp on the row's blockable side = `cost` (a miss); the same evaluation showing the gate PREVENTED a loser (excess ≤ −5pp on the side it blocked) = `saved`. A `disabled: true` trace day → skip with `unchecked` = -1 sentinel? No: skip the day entirely and record nothing (the tombstone means no data, not zero refusals).
**Tests:** both sides; bare-row both-ways; budget truncation counted; gate attribution (the miss charges the ROW's gate); called-full rows never miss-checked; tombstone day skipped; no-trace no-op; ledger bounds; entry-basis equality with gradePrediction on a shared fixture.
Commit: `feat(engine): the miss ledger — every gate now pays for what it blocked`.

### Task 2: deterministic post-mortems + the roll-up

**Files:** shared/engine/postMortem.ts (new, pure), netlify/functions/lib/engine.ts:432-434 hook + scorecard loop, shared/engine/types.ts (additive `postMortem?: { cls: 'stopped'|'thesis-break'|'market-drag'|'news-reversal'|'adverse-move', detail: string, at: number }` on Prediction).
**The pinned total order** (spec's four classes are non-disjoint — recon §4.1; this order IS the test): `stopped` (o.stopped) → `thesis-break` (not stopped, but the row's structural level broke: velocity trail / dip low — only where the row carries one; detail names it) → `market-drag` (excess ≥ 0: lost the bar, beat the tape) → `adverse-move` (fallback; `news-reversal` is assigned ONLY by Task 3's LLM pass when it affirms a tone flip, never deterministically). Applied to EVERY graded loser (sized, watch, shadow — the class is free); rides store.write at :466.
**Roll-up:** scorecard gains `byPostMortem: Record<'{setup}:{regime}:{cls}', number>` over the same 30-date loop (additive field; client type extended).
**Tests:** precedence total order (a stopped row that also beat the tape reads stopped, not market-drag); every-loser coverage; winners untouched; roll-up arithmetic; ledger rows only GAIN the field (byte-compare sans postMortem).
Commit: `feat(engine): every loser explains itself — deterministic post-mortems, rolled up by setup and regime`.

### Task 3: the paper's sentence + surfacing

**Files:** netlify/functions/lib/engine.ts (or a small postMortemLlm.ts) for the budgeted LLM pass; report-compose data path (expose `postMortems` for sized losers + `missLedger` summary in the compose data JSON — find where board/scorecard already enter `buildDataJson` and ride the same seam, DROPPED-to-fit LAST like previousEditions); netlify/functions/engine.mts (serve miss-ledger summary + byPostMortem); src/lib/api.ts types + one LeanPanel/EnginePanel line ("misses this month: N · worst gate: X").
**LLM:** one plain sentence per sized loser (budget 3/day): prompt carries the deterministic class + thesis + falsifier + the numbers; a response that names a tone flip upgrades cls to `news-reversal` (the ONLY path to that class); every failure → the deterministic line stands; overflow labelled like dipNews's `'budget'`.
**Tests:** budget honoured; fail-soft; upgrade path; compose JSON carries the fields; api shape.
Commit: `feat(engine): the paper says why it lost — one budgeted sentence over a deterministic floor`.

### Task 4: the window proof (acceptance)

**Files:** scripts/replay-window.ts (drive miss detection + post-mortems in the walk — the trace is already in the walk since 3a T4), one test + the evidence run.
**Acceptance over 2026-07-14 → 2026-08-11:** (a) published output byte-identical (extend the 3a parity mechanism to cover the new fields being absent when disabled / additive when on); (b) invariants: no called-full/half row is ever a miss; every graded loser carries a postMortem; precedence holds on every real loser; (c) RECORD the first real miss-ledger (which gates cost most — GLW-class dips should surface if any occurred in-window) and the postMortem histogram in the report — 3c's gate-feedback baseline.
Commit: `feat(replay): the walk measures regret — miss ledger and post-mortems proven over the window`.

## Self-review notes
- "Saved" accounting only sees names the trace recorded — a gate's saves among never-candidates are invisible; stated in the ledger comment (honest under-count).
- The 10-sessions-back resolution uses SPY session distance, not the index position (the index can have gaps — weekends/holidays are absent, but an outage day would shift positions).
- news-reversal via LLM-only keeps the deterministic floor honest — the spec's fail-soft line is the design, not a compromise.
- 3c consumes: miss-ledger per-gate cost/saved (gate feedback), byPostMortem (how the engine loses), both additive and already bounded.
