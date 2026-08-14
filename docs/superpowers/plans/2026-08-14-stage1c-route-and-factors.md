# Stage 1c-R — the Crypto Route + the Chart-Only Factor Policy

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, one task per implementer. Companion: the shipped lane (engine.ts crypto block ~:3200-3340, shared/engine/cryptoLane.ts, shared/engine/riskLadder.ts mapInstrument) and the final Phase-B branch review's M-1/M-2 findings (.superpowers/sdd/progress.md).

**Goal:** Two owner directives (2026-08-14): (1) crypto rows become genuinely tradeable through a 1× spot-tracker route the owner configures in levMap; (2) a crypto prediction is priced off CHART PARAMETERS and A LITTLE MAJOR NEWS — nothing else.

## Ratified design decisions

- **The factor policy is the owner's sentence, encoded.** The crypto factor table keeps
  `technical` + `momentum` (the chart cores, unchanged) and `news` (the little), and NULLS
  `social` and `channels` (they were live context reads; the directive retires them — the
  reason at the site is the directive itself, quoted and dated). The other five stay the
  nulls they already are. The evidence contract is untouched (its legs are core factors).
- **"A little" is a WEIGHT, "major" is the LEXICON.** News rides at a crypto-specific
  weight of HALF the equity news default, inside the existing context cap (two independent
  bounds). "Major" is enforced by `newsFactor`'s own polarity lexicon — a headline with no
  polarity language scores zero votes and is noise by the factor's own definition; no new
  keyword taxonomy is invented.
- **The name alias is what makes news real.** `titleMatches` regexes `\bBTC\b`, and
  headlines say "Bitcoin" — the crypto news factor is near-dead today. Crypto title
  matching gains the asset names (BTC-USD → bitcoin|btc; ETH-USD → ethereum|ether|eth;
  SOL-USD → solana|sol), word-bounded, case-insensitive. `sol`/`eth` are short — they stay
  word-bounded exactly like the base-ticker match already is, and the alias map lives
  beside CRYPTO_UNIVERSE so a fourth pair cannot be added without one.
- **`CRYPTO_WEIGHTS`, frozen.** The lane stops reading `weights.current` (the equity
  IC-nudged vector — the branch review's M-1). Crypto composites are priced by a frozen
  vector: technical and momentum at their `DEFAULT_WEIGHTS` values, news at half its
  default, every other factor at its default (their scores are null and renormalise away —
  the vector's job is the three live factors' RELATIVE weight). Crypto never feeds IC, so
  there is no learning path this freeze forecloses; it closes the drift where equity IC
  nudges silently re-bucket crypto composites.
- **The 1× route: leverage-free, so size-free.** `LevMap` entries gain `long1x?` /
  `short1x?` (spot tracker / inverse tracker tickers). The `sizedFraction === 1` gate on
  instrument minting exists because 2-3× ETPs are full-conviction instruments; a 1×
  tracker is just the asset, so a crypto row mints its 1× instrument at ANY sized
  fraction. Structure: a new `spotInstrument(side, sym, levMap)` in riskLadder.ts reading
  ONLY the 1x fields (leverage 1); `mapInstrument` itself untouched for the leveraged
  arms but falls through to the 1× fields when no leveraged ticket fires (a full-size
  earn-out row with only a 1× configured still routes). Equity byte-identity is
  structural: no equity levMap entry carries 1x fields, and the engine's fractional-size
  mint call is made ONLY for crypto rows.
- **paperOnly falls out, the voice tells the truth.** The corrected predicate
  (`!instrument`, review I2) needs no change: a 1×-routed crypto row carries an
  instrument, so the label lifts exactly when a route exists. `cryptoVoice`'s route states
  become: no tracker → "paper only — no tracker configured"; 1× configured → no
  paper-only sentence (the instrument names itself on the row; risk stays 0.5× rung —
  the cap is about SIZE, not the label); a SHORT with no `short1x` → paper only via the
  short arm, as today. The "routes when the record earns the full rung" sentence dies —
  it described the levMap-key-without-instrument state this change retires.
- **The owner configures tickers; the engine never invents them.** No ticker is
  hardcoded. The config doc line (README/admin notes wherever levMap is documented)
  states the new fields. Which LSE cETN to use is the owner's instrument decision.
- **Nothing else** (the directive's own words): no catalyst wiring, no seasonality, no
  weekend runs, no alert-scan changes (crypto stays excluded — that guard is about tape
  misreading, not routing), paper book keeps refusing crypto (basis argument unchanged).

## Global Constraints

- Baseline 152 files / 2,206 tests green (`--exclude '**/node_modules/**' --exclude '**/.claude/**'`); tsc -b; npm run build.
- Equity behaviour byte-identical: no equity path reads the new fields; `weights.current` untouched for equity; poolBuckets/CALIB_DEF_VERSION/ENGINE_MODEL_VERSION untouched.
- Every change pinned; the factor-policy pins assert the NULLED factors carry the directive in their detail strings.
- No Co-Authored-By trailer. Push/deploy only as the batch, after review.

### Task R1: the factor policy
**Files:** netlify/functions/lib/engine.ts (crypto factor table + composeCall weights), shared/engine/cryptoLane.ts (CRYPTO_WEIGHTS, the news alias map + crypto title matcher), tests (engine.cryptoLane.test.ts + cryptoLane.test.ts).
Social/channels → `{ score: null, detail: 'owner directive 2026-08-14: chart parameters and a little major news — nothing else' }`-style nulls; news fed by the alias-matched titles at the halved weight inside CRYPTO_WEIGHTS; composeCall gets `weights: CRYPTO_WEIGHTS`. PINS: an alias headline ("Bitcoin surges…") reaches the crypto news factor while missing the equity matcher; a social/channels signal that would have scored moves NOTHING on a crypto row; the frozen vector — an IC-nudged weights.current (technical 0.5×) changes the equity composite and NOT the crypto one on the same morning; news influence bounded (a max-polarity tape moves the crypto composite by ≤ the halved-weight × context-cap bound).

### Task R2: the route
**Files:** shared/engine/riskLadder.ts (LevMap 1x fields + spotInstrument + mapInstrument fall-through), netlify/functions/lib/engine.ts (the crypto mint call), shared/engine/cryptoLane.ts (cryptoVoice route states), tests (riskLadder.test.ts, engine.cryptoLane.test.ts, cryptoLane.test.ts).
PINS: a levMap `{ 'BTC-USD': { long1x: 'X' } }` row mints `{ ticker: 'X', leverage: 1 }` at sizedFraction 0.5, paperOnly false, riskPct unchanged (0.5 × rung — the cap did not move); a short with no short1x stays paperOnly; an equity row with the same-shaped entry behaves byte-identically to today (no 1x fields on equity configs — pin that the equity mint call site is unreached at fractional size); full-size + long2x still prefers the leveraged ticket; full-size + only-1x routes 1×; voice states.

## Self-review notes
- The halved news weight is a starting point the cohort's own calibration will grade —
  the crypto blob buckets by composite band, so if news-tilted composites underperform,
  the record shows it where it can be acted on.
- Retiring social/channels for crypto loses two context reads the equity book keeps; the
  directive is explicit and the site comments carry it, so a future session cannot
  mistake the nulls for missing wiring.
