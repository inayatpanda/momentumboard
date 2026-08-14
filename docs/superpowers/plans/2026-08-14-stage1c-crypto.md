# Stage 1c — the Crypto Lane Implementation Plan (containment, then capability)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, one task per implementer. **Companion reading: `.superpowers/sdd/stage1c-recon.md`** — 13 sections, one per blocker, every file:line. Read the named sections before coding.

**Goal:** BTC/ETH/SOL as a genuinely partitioned cohort — own calibration, own clock, own regime, own reference — with the equity engine PROVEN clean of crypto first. The recon found crypto already leaking through 12 unguarded mechanisms (starter watchlist → priority-1 candidates → SPY-graded rows → gate-feedback contamination); Phase A stops that and measures the damage before Phase B builds the lane.

## Ratified design decisions

- **Containment before capability** (recon's sharpest fork): Phase A ships alone, first, as its own deploy.
- **Crypto grades ABSOLUTE** (no benchmark): hit = side-adjusted raw return ≥ +1pp over the horizon, stop close-through unchanged. Rationale: vs-BTC makes BTC ungradeable (0 excess always) and no crypto index has a data source; a 24/7 asset class has no SPY. This DEFINES the crypto partition's outcome basis at birth — it does not change the equity definition; CALIB_DEF_VERSION stays 3, and the crypto partition records its own basis in its own structure (recon §1's namespace options — the plan takes the SEPARATE NAMESPACE: `cryptoCalibration` as a sibling CalibrationState, never touching poolBuckets' 'any' arm; additive, zero equity-read changes).
- **The crypto clock**: horizon = 14 crypto bars (≈10 trading days wall-clock — "momentum clocks matched" means wall-clock, not bar-count); momentum/indicator lookbacks for crypto scale ×7/5 at the factor-input seam (the implementer verifies each indicator's window semantics; document per indicator). Completed bars only: crypto candles drop the partial last bar (cutoff t < today 00:00 UTC) at the fetch seam.
- **Crypto regime**: BTC-USD's own tape through the existing regime machinery (BTC replaces SPY as the regime input for the cohort), computed BEFORE composeCall and fed in — never relabelled after.
- **Cold start, honest**: crypto calibration starts EMPTY (no seed walk in 1c — the weekend replay spine ships for VALIDATION, deep-seeding crypto is a recorded follow-up). All-C at half-size cap for ~50 outcomes is the designed behaviour, stated in the UI copy. `referenceBase` for crypto: absent until its own sweep exists → gradeBaseRate falls back to the crypto partition's own pooled base (the legacy pattern).
- **Shared-learning exclusions** (the recon's contamination list): crypto NEVER feeds gate feedback, the miss ledger (SPY-benchmarked, meaningless for crypto), factor IC, the combined or cohort risk rungs (crypto gets its OWN rung stream via the computeCohortRung shape), the wildcard universe, hypeCluster (already excluded), or the equity scorecard panes (crypto gets its own pane keys, the wildcard four-pane policy as precedent). The funnel trace RECORDS crypto rows (sym-keyed, harmless, auditable).
- **Routing**: levMap-driven trackers (the owner configures real T212 ETNs when ready); until an entry exists a crypto row is paperOnly — the capped-short precedent, labelled honestly. Half-size hard cap (`sizeCap 0.5`) with the earn-out condition: full-rung eligibility only after the crypto rung's own record clears the computeCohortRung promote bar.
- **Board**: crypto rides the main board (cohort-tagged, half-capped, max 1 crypto row per side — the slot rule), UI surfacing deferred to the PWA rebuild.

## Global Constraints

- CALIB_DEF_VERSION / ENGINE_MODEL_VERSION stay 3. Equity blob shapes untouched; `cryptoCalibration` and friends are NEW additive blobs/fields. poolBuckets' parser untouched.
- Phase A is ZERO-behaviour-change for non-crypto rows (golden family + a crypto-off parity walk prove it) and STRICTLY REMOVES crypto from equity surfaces.
- CRYPTO=off seam (the house lever pattern) kills the lane entirely in Phase B; Phase A's guards are unconditional (containment is not optional).
- Suite green from baseline (2,003/144); tsc -b; npm run build where src touched; no trailer; each phase deploys separately, batched within itself.

---

## Phase A — containment (ships first, alone)

### Task A1: the guard at every leak

Per recon §2's twelve-site list: one shared `isCryptoSymbol` predicate (shared/symbols.ts export — the exchangeFor-based one from 3a) applied at each unguarded mechanism: candidate admission (addSource/watchlist ride-through), roster join, the screens, buildBoard's eval loop, gate-feedback attribution, miss-ledger candidacy (belt — the trace rows are already skipped by gate but pin it), wildcard pool (belt over the existing filter), scorecard accrual, IC, risk-rung streams, alerts' sized-row scan (crypto watchlist QUOTES still work — the guard is on ENGINE mechanisms, not on watching prices), replay universes. Each site gets the guard + a pin. The starter watchlist KEEPS BTC/ETH (readers may watch prices); the engine just refuses them as candidates until Phase B.
Commit: `fix(engine): crypto is contained — watched, never graded against a market it doesn't trade in`.

### Task A2: the damage audit + parity proof

The artefact the fork demands: scan production-shaped state (the replay's committed artefacts + a script the controller can run against live D1) for crypto contamination — crypto rows in predictions history, their calibration/IC/gate-ledger contributions, the 12 ETH rows the last walk graded. Report what today's equity calibration was measured WITH (the recon suggests small but nonzero). A CRYPTO-off parity walk arm proving Task A1 changed nothing for equity rows beyond removing crypto ones. Ship evidence appended to the walk-results doc.
Commit: `feat(replay): the contamination audit — what the equity record was measured with`.

**Phase A ships here** (push + deploy + the audit runs against live D1; if live contamination is material, the remediation decision goes to the owner with numbers).

## Phase B — the lane

### Task B1: the partition + the clock
`cryptoCalibration` namespace (sibling state, own blob key, own updateCalibration path keyed by cohort==='crypto'); `gradeCryptoPrediction` (absolute basis, 14-bar horizon, close-through stop, completed-bars input); the crypto candle seam (fetch + partial-bar cutoff + the indicator lookback scaling table). Pins: a crypto row never touches equity state (drive both paths, byte-compare equity blobs); the clock arithmetic (a Saturday call matures 14 bars later); the basis (absolute, both sides).

### Task B2: the lane in buildBoard
Crypto candidates (the 3 symbols, watchlist/config-driven), BTC-regime computation fed into composeCall, the crypto rung stream (own computeCohortRung instance + earn-out), sizeCap 0.5, max-1-per-side, paperOnly-until-levMap routing, voice (cohort-labelled, the cold-start C explanation), the trace recording, all Phase-A guards RELAXED only at the explicitly-built sites (each relaxation named + pinned). CRYPTO=off seam.

### Task B3: the weekend spine + window proof
Replay support: a crypto session spine (the symbol's own bars, not SPY's), BTC/SOL 5y candles fetched into .replay-cache (BTC and SOL are NOT cached — recon correction), a crypto-window walk proving: grading matures on the crypto clock, no equity blob byte moves when the lane runs, the cold-start grade distribution, determinism. Ship evidence.

**Phase B ships here.**

## Self-review notes
- The absolute-basis decision is the plan's biggest judgment; it is recorded with rationale and the alternatives (vs-BTC, index) named as rejected. If the owner later wants ETH/SOL measured vs BTC, the partition's separateness makes that a crypto-only migration.
- Crypto deep-seed (a 2-year crypto walk) is a RECORDED FOLLOW-UP, not in 1c — the cold start is honest and the spine ships in B3 ready for it.
- The PWA session surfaces the cohort visually; nothing here blocks on it.
