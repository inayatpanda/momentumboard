# Engine review plan — August & September 2026

Written 7 July 2026, the day live grading started (calibration was 100% seeded
replay at the time; first live outcomes land w/c 13 July). This document exists
so we tune on **evidence at agreed dates**, not on impatience in week two.

## Standing rules (apply to every review)

- **The yardstick never moves.** A hit stays "≥1pp excess vs SPY over 5
  sessions, stop never closed through." Changing the definition mid-experiment
  invalidates the record; if it must change, bump `CALIB_DEF_VERSION`, re-run
  `npm run seed-engine`, and note it here.
- **No tuning before the gate counts are met.** Below the stated n, differences
  are noise and acting on them is astrology.
- Every model change ships with: reseed, defVersion bump if bucket semantics
  change, a line in this file (what changed, why, on what evidence).
- Sources of truth: the Ledger page (lifetime line + grade table), `/api/engine`
  (scorecard, calibration, weights history), `paper-months`. Never the runlog
  (known lost-update race).

---

## August review — w/c 3 August 2026

Expected state: ~300–500 graded outcomes (live + shadow), one banked paper-book
month (July), 20+ weight-nudge cycles.

### Checks and gates

1. **Data health.** Lifetime graded count and live base rate vs the seed's
   36.6%. If live base rate differs from seed by >8pp, the replay wasn't
   representative — note it and re-anchor expectations before judging anything
   else.
2. **Grade separation** (Ledger → "By grade"). Gate: ≥30 graded per tier.
   - B > C in both hit rate and avg excess → machinery works, do nothing.
   - B ≤ C → the base-rate-relative thresholds in `gradeFor` need review
     (likely the +5pp B-margin is inside noise; consider widening margins).
3. **Factor IC readout** (`weights.history` + IC stats). For each factor with
   ≥100 live observations: is mean agree-excess negative?
   - Confirm the pruning floor lifts at 200 obs and weights actually decay for
     persistent losers (technical and momentum are the suspects from the seed).
   - If a factor sits negative at 200+ obs but decay is too slow (<20% weight
     loss), raise `NUDGE_STEP` from 0.15 or cut the base weight manually.
4. **Shadow vs live.** If shadows outperform live calls on avg excess over ≥50
   graded each, the suppression logic is subtracting value → revisit the
   `gradeFor`/shadow gate before anything else, because it means the engine's
   self-censorship is miscalibrated.
5. **Paper book (July banked).** Sanity, not performance: did sizing deploy a
   reasonable share of the £10k (target 30–70% at peak)? Did the 8-position cap
   or £200 minimum bind constantly? Adjust caps only if they bound >half the
   days.
6. **Ops debt.** Count Stooq fallback fires and watchdog alerts in the month.
   Repeated Yahoo failures → prioritise a second candle source properly
   (Polygon/EODHD paid tier) instead of the EOD fallback.

---

## September review — w/c 1 September 2026

Expected state: ~600–1,000 graded, two banked months, per-factor obs ≥200 for
the dense factors. This is the **model-shape** review.

### The main event: widen the conviction spread

Diagnosis first: plot the distribution of |composite| across all live calls.
Prediction: heavy clustering in 25–40, starving the 55–70 and 70+ buckets
(which is why A-grades can't earn evidence). Then pick ONE of:

- **(a) Non-linear stretch** above the dead zone, so factor agreement pushes
  composites further out (e.g. `sign(adj) · 25 + (|adj|−25) · k` with k fitted
  so the top decile of calls lands 55+).
- **(b) Finer bands** (25–35 / 35–45 / 45–60 / 60+) so evidence accumulates
  where calls actually live.
- **(c) Agreement bonus**: conviction scales with the COUNT of independent
  factors agreeing, not just the weighted mean (three factors at +40 should
  outrank one factor at +70).

Whichever is chosen: re-run the seed, bump `CALIB_DEF_VERSION` (bucket
semantics change), and note the switch date here so pre/post records aren't
compared naively.

### Also on the September table (each gated on evidence)

- **Per-regime factor weights** — implement only if ≥400 live graded AND each
  regime has ≥100; otherwise defer to October. (Momentum should earn its keep
  in green tape and lose it in red; one weight set wastes that.)
- **News factor** — if its IC after ~150 obs is ≈0 or negative, route headline
  scoring through the existing LLM pipe (cached, deterministic fallback)
  instead of keyword counts.
- **Expected-move honesty** — compare published `expectedMovePct` to realised
  |move| distribution; refit the `min(|adj|/100, 0.8) × capacity` formula if
  it's systematically over/under.
- **Risk ladder** — if the book has positive expectancy across both months and
  the rung is still 0, check the promotion thresholds aren't calibrated to the
  old (epsilon-hit) definition.

### What "success" looks like by end of September

- Grade tiers separate on ≥50 graded per tier.
- Avg excess @5d positive across 100+ live calls (this is the edge metric —
  hit rate alone is allowed to sit in the low 40s given ~2:1 payoffs).
- At least one non-provisional bucket earning ≥ base+12pp — the first honest
  A-grades.
- If instead everything reads flat-to-negative: the honest conclusion is the
  current factor set has no edge on daily bars, and the next move is factor
  research (intraday data, fundamentals) — not threshold-fiddling.
