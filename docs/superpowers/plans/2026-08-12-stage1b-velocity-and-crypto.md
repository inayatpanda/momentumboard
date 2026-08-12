# Stage 1b: The Velocity Doors + the Crypto Cohort — Implementation Plan (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can ride a mania it has never heard of, and can trade the three crypto majors, without either capability being able to damage the board that Stage 1 just shipped. Two velocity doors (early = quarter size, confirmation = half size) built from candles we already fetch; hype clusters recognised from the tape's own signature (social co-mention × abnormal-return co-movement), never from a theme list; BTC/ETH/SOL evaluated daily against a BTC-native regime, graded in their own additive calibration cohort, routed to ISA trackers or run as labelled shadows.

**Architecture:** Three new pure modules — `shared/engine/velocityLane.ts` (classify + call constructor + trail, exactly `dipLane.ts`'s shape), `shared/engine/hypeCluster.ts` (co-mention graph → co-movement-confirmed components), `shared/engine/crypto.ts` (universe, BTC regime, tracker routes, learn-cohort) — feed `buildBoard` through the **existing** merge points. Both new lanes publish through the SAME `publishCall` path the dip lane uses, gaining one new argument: a **lane size cap**. Nothing in the composite loop, the dip merge, the dip-over-short demotion, the observation promotion or the near-miss block changes shape; they gain members, not branches.

**Tech Stack:** TypeScript, vitest, Netlify Functions, Yahoo endpoints (free), Netlify Blobs via `AppStore`.

**Spec:** `docs/superpowers/specs/2026-08-11-funnel-and-regret-learning-design.md` §4.1 (Hype/velocity lane bullet — two doors, theme-agnostic cluster detection, `day_gainers` 25→50; Crypto lane bullet — BTC/ETH/SOL, crypto-native regime, own cohort with BTC-relative benchmark, tracker routing, half size, weekend falsifiers), §4.3(c) (`velocity` as a fourth setup family, accrual only), §5 (velocity honesty check as the ship gate). Deferred BY DECISION: setup-bucket *consumption* (Stage 3), a live moving trailing stop on open velocity positions (Stage 2 — see [D7]), per-name expectation-scaled sizing (Stage 2, inherited from Stage 1 [R6]).

**Predecessor:** `docs/superpowers/plans/2026-08-11-stage1-seeing-and-board.md` (shipped; its Global Constraints and task shape are copied here on purpose). Line anchors are as of `de03c26`.

## Global Constraints

- Commits on `main`, imperative style; **NEVER add a Co-Authored-By trailer** (breaks the Netlify pipeline).
- **Do NOT push** until Task 8's replay evidence exists and the owner confirms — push = deploy. Task 8 is a hard ship gate: **if the velocity honesty check fails, the lane does not ship.** No silent threshold-tuning; a failure is written up and taken to the owner.
- Everything fail-soft: any new fetch/module/blob erroring must leave the board **identical to a run without the feature** (deep-compare, not length-compare). `velocityActive` / `cryptoActive` / `clusterActive` each gate EVERY behaviour of their feature, exactly as `sleeveActive` does (engine.ts:560).
- $0 data. No new endpoint of any kind: crypto candles are the same `fetchYahooChart` path (`isYahooSymbol('BTC-USD')` is already true, `cachedCandles` already routes it), the deepened gainers screen is the same single call with `count=50`, and cluster detection reads a blob we write ourselves from data `deps.social()` already returns.
- **Untouched in this stage:** `CALIB_DEF_VERSION` (stays 3), `ENGINE_MODEL_VERSION` (stays 2 — Stage 2 owns the bump), the hit definition, every EXISTING calibration bucket key, `gradeFor`, `bandFor`, `RUNG_RISK_PCT`, the rung ladder's promote/demote arithmetic, factor weights, dead-zone/capacity-floor values, and the whole dip lane (`dipLane.ts` is read-only this stage).
  - **The one sanctioned exception** is the *additive* crypto cohort: new bucket keys `crypto:${side}:${regime}:${band}` that no existing key can collide with, a widened cohort TYPE, and an additive optional benchmark parameter on `gradePrediction`. Existing buckets, the seed, and what a "hit" IS all stay exactly as they are (this is the same reasoning the file already records for the Phase-2 cap cohorts, calibration.ts:26-34 — extend that comment, don't replace it).
- `addSource` keeps the FIRST source for a symbol (engine.ts:600) — never key lane behaviour off the source string; use `velocityReads` / `clusterSet` / `cryptoSet`, the same discipline the sleeve uses [R1].
- Any new engine-owned config field MUST be added to the preserve list in `netlify/functions/config-sync.mts:156-168` or a phone sync wipes it (the levMap/riskAppetite/coreSleeve trap).
- A constant score in a lane's factor record must be excluded from factor-IC, or the lane's P&L silently trains an unrelated factor. The guard in `gradeOutstanding` (engine.ts:385) is currently keyed to ONE literal; Task 1 turns it into a set. This is not optional — it is the exact trap the existing comment warns about.
- Test runner: `npx vitest run <file>` (`npm test` for the suite). Suite green after every task; `npm run build` green before Tasks 6, 7 and 8 are committed.

## Decisions this plan makes where the spec is silent

Marked `[D#]` and referenced from the tasks. The controller ratifies these at review.

- **[D1] When both doors open on the same bar, the EARLY door wins** — i.e. the SMALLER size wins the ambiguity. A bar that is both a fresh 20-session-high breakout and a run-continuation is the most extended shape the lane can see; quarter size is the honest commitment there.
- **[D2] The green-streak cap applies to BOTH doors, not just the confirmation door.** Breaking a 20-session high on the 5th consecutive green day is not "the start" — it is the middle of a blow-off. `greenStreak <= 2` gates both. (The spec only names the rule for the confirmation door; applying it to one door and not the other would let the early door buy exactly the candle the rule exists to refuse.)
- **[D3] The confirmation door's volume leg is turn-scoped** — satisfied when ANY of the last 5 sessions printed RVOL ≥ 2×, not only today. This copies the dip lane's ratified 2026-08-12 volume rule verbatim (dipLane.ts:117-133); a mania's volume lands where the tape chooses to spend it, and the OTHER legs (the pause/reclaim and the green-streak cap) are measured on today and bound the loosening.
- **[D4] Lane size is a CAP, never a factor.** `riskPct = RUNG_RISK_PCT[rung] × min(evidenceTierMult, laneCap)`. A quarter-size early-door call that also grades C-with-contract stays at a quarter, not an eighth. Multiplying tiers would produce sub-noise position sizes and a card the reader cannot act on.
- **[D5] Velocity eligibility is a LIQUIDITY floor, not a theme or cluster gate** — `avgDollarVol20 ≥ $20M`. The spec's principle is theme-agnosticism; making cluster membership a gate would smuggle a theme model back in through the side door. Cluster membership *elevates candidate priority* (which is exactly what the spec asks it to do) and is named in the call's reason, nothing more.
- **[D6] The dip lane outranks the velocity lane on the same name**, and the velocity lane never opens a second long on a name that already has one. A name can satisfy both (a one-day shock 8 sessions ago, then a +15% five-day rally); the dip lane is the older, news-corroborated, evidence-gated lane and it wins.
- **[D7] The published stop IS the falsifier at entry; the moving trail ships as a pure function now and is wired into live positions in Stage 2.** `velocityTrailStop(candles)` is exported and used by (a) the confirmation door's entry stop and (b) Task 8's replay simulation, which is what the ship gate measures. Re-stopping an OPEN position daily touches the alerts/open-book path and belongs with Stage 2's sizing/voice work.
- **[D8] The crypto learn-cohort is derived from the SYMBOL, not from market cap.** No new stored field on `Prediction`, no blob migration, and a crypto row can never be silently pooled into the large/small sleeves by a stray Finnhub cap.
- **[D9] Crypto pools to the COMBINED risk rung.** No fourth ladder: `cohortRungOf` is made lookup-safe and returns the top-level rung for any cohort with no ladder of its own. Crypto is half-size by spec anyway, so a bespoke rung would be machinery with nothing to decide.
- **[D10] Alt (ETH/SOL) calls require the BTC regime to AGREE WITH THE SIDE — long needs green, short needs red; amber blocks alts entirely.** BTC itself may still call in amber. A blocked alt call still publishes as a shadow (still graded) — the cohort has no evidence to spare.
- **[D11] Crypto is capped at ONE row per side**, and its closes are withheld from the correlation gate. BTC/ETH/SOL are one bet; and comparing 7-day-per-week crypto bars against 5-day-per-week equity bars index-wise is arithmetic with no meaning, so `closesOf` returns null for crypto (the gate already documents "no data never blocks").
- **[D12] Momentum for an ALT is measured against BTC** (both 7-day series, honestly aligned) and for BTC against SPY as today, with the window mismatch documented. `momentumFactor` gains an optional benchmark LABEL so the printed evidence never says "vs SPY" when it means "vs BTC".
- **[D13] The route rides a new `Prediction.route` field, not `instrument`.** `instrument` means *leverage* (`{ticker, leverage}`, gated by `leverageAllowed`); a 1× ISA tracker is not leverage and must not borrow the field that unlocks it.
- **[D14] Cluster detection runs in two phases.** Co-mention alone (cheap, no candles) elevates candidate priority BEFORE the 180-candidate cut; the co-movement confirmation runs after `candleMap` exists and is what gets recorded and cited. Elevating on co-mention alone only reorders a cut; calling something a cluster requires both legs, exactly as the spec defines it.
- **[D15] The velocity lane publishes at most 6 calls per run**, highest |composite| first. An unbounded lane on a mania morning would flood the ledger and the shadow budget with one correlated bet.

---

### Task 1: The velocity lane (`velocityLane.ts`)

The lane module, in `dipLane.ts`'s proven shape: a pure classifier, a pure call constructor, structural levels, a composite deliberately inside the calibrated 25-55 bands, nominal evidence placeholders that say so, and a zero-weight factor record.

**Files:**
- Create: `shared/engine/velocityLane.ts`
- Test: `shared/engine/velocityLane.test.ts`
- Modify: `shared/engine/types.ts:14` — widen `SetupFamily` to `'continuation' | 'reversal' | 'fade' | 'velocity'` (ADD, never replace)
- Modify: `shared/engine/catalyst.ts:20-27` — add `export const VELOCITY_CATALYST_KIND = 'velocity'` beside `DIP_CATALYST_KIND`, add it to the `CatalystTag['kind']` union, and add `export const LANE_CATALYST_KINDS = new Set<string>([DIP_CATALYST_KIND, VELOCITY_CATALYST_KIND])`
- Modify: `netlify/functions/lib/engine.ts:385` — the factor-IC guard becomes `if (!LANE_CATALYST_KINDS.has(pred.catalyst?.kind ?? '')) w = updateIcStats(w, pred, o)`
- Test: `netlify/functions/lib/engine.test.ts` — one case pinning IC isolation for a velocity row

**Interfaces:**
- Consumes: `Candle` from `'../types'`; `swingCapacity` from `'../indicators'`; `SMALL_CAP_MAX_USD_M` from `'./capClass'`; `DEFAULT_WEIGHTS` from `'./composite'`; `clamp/round1/round2` + `CallEvidence/EngineCall/FactorName/FactorScore` from `'./types'`. (Identical import set to `dipLane.ts` — verified against dipLane.ts:25-29.)
- Produces:
  - `classifyVelocity(candles: Candle[]): VelocityRead | null` — null iff `< MIN_CANDLES`; `VelocityRead = { door: 'early' | 'confirmation' | null; breakout: boolean; rvol: number | null; runPct: number; upDays: number; greenStreak: number; timingOk: boolean; detail: string }`.
  - `velocityCall(sym: string, candles: Candle[], read: VelocityRead, capUsdM: number | null): EngineCall | null` — null unless `read.door`. Long only, `setup: 'velocity'`, `stage: 'trending'`.
  - `velocityTrailStop(candles: Candle[]): number | null` — `max(8-EMA, 5-session low)`, the "whichever is nearer" falsifier for a long.
  - `velocitySizeMult(door): number` — `0.25` early, `0.5` confirmation.
  - Constants: `MIN_CANDLES 30`, `BREAKOUT_WINDOW 20`, `EARLY_RVOL 3`, `CONF_RVOL 2`, `RUN_WINDOW 5`, `RUN_GAIN_PCT 15`, `RUN_UP_DAYS 3`, `GREEN_STREAK_MAX 2`, `FAST_EMA 8`, `TRAIL_LOW_WINDOW 5`.

- [ ] **Step 1: Write the failing tests**

```ts
// shared/engine/velocityLane.test.ts
import { describe, expect, it } from 'vitest'
import { classifyVelocity, velocityCall, velocitySizeMult, velocityTrailStop } from './velocityLane'
import type { Candle } from '../types'

const mk = (c: number, v = 1_000_000, o = c, h = c, l = c): Candle => ({ t: 0, o, h, l, c, v })
const base = () => Array.from({ length: 40 }, () => mk(100))
/** four green run days on 2.5x volume — the shape both doors are built around */
const run = () => [mk(104, 2_500_000), mk(108, 2_500_000), mk(112, 2_500_000), mk(118, 2_500_000)]

describe('classifyVelocity', () => {
  it('null when under 30 candles', () => expect(classifyVelocity([mk(1)])).toBeNull())

  it('calm tape opens no door', () => {
    const read = classifyVelocity(base())!
    expect(read.door).toBeNull()
    expect(read.breakout).toBe(false)
  })

  it('EARLY door: a 20-session-high break on 3x volume', () => {
    const read = classifyVelocity([...base(), mk(112, 3_500_000)])!
    expect(read.breakout).toBe(true)
    expect(read.rvol).toBeGreaterThanOrEqual(3)
    expect(read.door).toBe('early')
  })

  it('a breakout on thin volume opens nothing', () => {
    expect(classifyVelocity([...base(), mk(112, 1_500_000)])!.door).toBeNull()
  })

  it('CONFIRMATION door: +15% over 5 sessions, entered on the pause that holds the 8-EMA', () => {
    const read = classifyVelocity([...base(), ...run(), mk(117, 1_200_000)])!
    expect(read.runPct).toBeGreaterThanOrEqual(15)
    expect(read.upDays).toBeGreaterThanOrEqual(3)
    expect(read.greenStreak).toBe(0) // today closed below yesterday — that IS the pause
    expect(read.timingOk).toBe(true)
    expect(read.door).toBe('confirmation')
  })

  it('CONFIRMATION door: the reclaim AFTER the pause also qualifies', () => {
    // …runs, loses the 8-EMA on a 106 close, reclaims it today at 112
    const read = classifyVelocity([...base(), ...run(), mk(106, 1_200_000), mk(112, 1_400_000)])!
    expect(read.upDays).toBeGreaterThanOrEqual(3)
    expect(read.greenStreak).toBe(1)
    expect(read.timingOk).toBe(true)
    expect(read.door).toBe('confirmation')
  })

  it('never the Nth green day: a 5th consecutive green close opens NO door', () => {
    const read = classifyVelocity([...base(), ...run(), mk(124, 2_500_000)])!
    expect(read.greenStreak).toBe(5)
    expect(read.timingOk).toBe(false)
    expect(read.door).toBeNull()
  })

  it('…not even on 4x volume through the early door [D2]', () => {
    const read = classifyVelocity([...base(), ...run(), mk(124, 4_000_000)])!
    expect(read.breakout).toBe(true)
    expect(read.rvol!).toBeGreaterThanOrEqual(3)
    expect(read.door).toBeNull() // the blow-off candle is refused by BOTH doors
  })

  it('turn-scoped volume [D3]: the 2x print may sit earlier in the 5-session window', () => {
    // today is a quiet pause; the run days carried the volume
    const read = classifyVelocity([...base(), ...run(), mk(117, 700_000)])!
    expect(read.door).toBe('confirmation')
  })

  it('a run with no 2x session anywhere in the window opens nothing', () => {
    const quietRun = [mk(104), mk(108), mk(112), mk(118)]
    expect(classifyVelocity([...base(), ...quietRun, mk(117)])!.door).toBeNull()
  })

  it('the early door wins when both read true [D1]', () => {
    // a reclaim day that is ALSO a fresh 20-session high on 3x volume.
    // (4.2M, not 3.6M: the run's own 2.5M bars have lifted the 20-session volume
    // baseline to ~1.24M, so 3.6M would land at 2.9x and miss the early door.)
    const cs = [...base(), mk(104, 2_500_000), mk(108, 2_500_000), mk(112, 2_500_000), mk(101, 1_200_000), mk(119, 4_200_000)]
    const read = classifyVelocity(cs)!
    expect(read.breakout).toBe(true)
    expect(read.door).toBe('early')
  })
})

describe('velocityTrailStop', () => {
  it('is the NEARER of the 8-EMA and the 5-session low (the higher, for a long)', () => {
    const cs = [...base(), ...run(), mk(117)]
    const trail = velocityTrailStop(cs)!
    const low5 = Math.min(...cs.slice(-5).map(c => c.l))
    expect(trail).toBeGreaterThanOrEqual(low5)
    expect(trail).toBeLessThan(117)
  })
  it('null when the history cannot carry an 8-EMA', () => expect(velocityTrailStop([mk(1), mk(2)])).toBeNull())
})

describe('velocityCall', () => {
  it('early door: LONG, stop under the BROKEN level, 2R target, composite inside 25-55, quarter size', () => {
    const cs = [...base(), mk(112, 3_500_000)]
    const read = classifyVelocity(cs)!
    const call = velocityCall('AAOI', cs, read, 3_000)!
    expect(call.side).toBe('long')
    expect(call.setup).toBe('velocity')
    expect(call.stage).toBe('trending')
    expect(call.entry).toBe(112)
    expect(call.stop).toBe(100) // the 20-session high that was broken
    expect(call.target).toBe(136) // entry + 2R
    expect(Math.abs(call.composite)).toBeGreaterThanOrEqual(25)
    expect(Math.abs(call.composite)).toBeLessThanOrEqual(55)
    expect(call.evidence.contract).toBe(true)
    expect(call.smallCap).toBe(false) // 3_000 $M is above SMALL_CAP_MAX_USD_M
    expect(velocitySizeMult(read.door!)).toBe(0.25)
  })

  it('confirmation door: the stop is the TRAIL, and the size is a half', () => {
    const cs = [...base(), ...run(), mk(117, 1_200_000)]
    const read = classifyVelocity(cs)!
    const call = velocityCall('IONQ', cs, read, 1_500)!
    expect(call.stop).toBe(Math.round(velocityTrailStop(cs)! * 100) / 100)
    expect(call.stop).toBeLessThan(call.entry)
    expect(call.smallCap).toBe(true)
    expect(velocitySizeMult(read.door!)).toBe(0.5)
  })

  it('returns null when no door is open', () => {
    const cs = base()
    expect(velocityCall('CALM', cs, classifyVelocity(cs)!, null)).toBeNull()
  })

  it('returns null on a degenerate shape (stop at or above entry)', () => {
    // a "breakout" that closes exactly on the level it broke
    const cs = [...base(), mk(100, 3_500_000, 100, 105, 100)]
    const read = { door: 'early' as const, breakout: true, rvol: 3.5, runPct: 0, upDays: 1, greenStreak: 0, timingOk: true, detail: 'x' }
    expect(velocityCall('FLAT', cs, read, null)).toBeNull()
  })

  it('every factor carries weight 0 and only technical has a score — nothing may read a vote that never happened', () => {
    const cs = [...base(), mk(112, 3_500_000)]
    const call = velocityCall('AAOI', cs, classifyVelocity(cs)!, null)!
    const entries = Object.entries(call.factors)
    expect(entries.every(([, f]) => f.weight === 0)).toBe(true)
    expect(entries.filter(([, f]) => f.score != null).map(([n]) => n)).toEqual(['technical'])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run shared/engine/velocityLane.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// shared/engine/velocityLane.ts
// The velocity lane. A name going vertical is a real trade and a bad investment,
// and the engine says both things at once: it takes the trade, small, with a
// falsifier close enough to be felt.
//
// THEME-AGNOSTIC BY CONSTRUCTION. Nothing here knows what a "quantum stock" is.
// A mania is recognised from the tape's own signature — a break of a 20-session
// high paid for in volume, or a measured five-session run — because the theme
// changes every year and a hard-coded list is a model of LAST year's mania.
//
// Two doors into one lane, because the two ways to be wrong are different:
//   EARLY        — the breakout itself. Most breakouts fail, so the commitment is
//                  a QUARTER and the falsifier is the level that was broken.
//   CONFIRMATION — the middle of a run that already exists. More evidence, so a
//                  HALF — but it is only ever entered on a PAUSE, never on the
//                  Nth green candle, which is how a lane like this ends up buying
//                  every blow-off top in the sample.
//
// The lane is deliberately modest: its composite lives inside the calibrated
// 25-55 bands and it grades under its own `velocity` setup family, so §4.3's
// per-setup learning can bury it on evidence if hype-riding is worth nothing.
//
// Pure module: candles in, a read and a call out. No IO, no LLM. The engine loop
// supplies the earnings calendar, the cluster narration and the size cap.

import type { Candle } from '../types'
import { swingCapacity } from '../indicators'
import { SMALL_CAP_MAX_USD_M } from './capClass'
import { DEFAULT_WEIGHTS } from './composite'
import { clamp, round1, round2, type CallEvidence, type EngineCall, type FactorName, type FactorScore } from './types'

/** Below this the signature isn't readable — no verdict at all. */
export const MIN_CANDLES = 30
/** The high the early door breaks, measured over the sessions BEFORE today. */
export const BREAKOUT_WINDOW = 20
/** Early door: relative volume that makes a breakout worth believing. */
export const EARLY_RVOL = 3
/** Confirmation door: the run has to have been paid for at least this loudly. */
export const CONF_RVOL = 2
/** The run window both confirmation tests measure over. */
export const RUN_WINDOW = 5
/** Confirmation trigger A: gain over RUN_WINDOW sessions. */
export const RUN_GAIN_PCT = 15
/** Confirmation trigger B: up-days out of RUN_WINDOW. */
export const RUN_UP_DAYS = 3
/** The entry-timing rule, in one number: never buy the Nth consecutive green
 * day. Applied to BOTH doors [D2] — a 20-session high broken on the fifth green
 * candle is not the start of anything. */
export const GREEN_STREAK_MAX = 2
/** The trailing falsifier's fast average. */
export const FAST_EMA = 8
/** …and its structural leg. */
export const TRAIL_LOW_WINDOW = 5

export type VelocityDoor = 'early' | 'confirmation'

export interface VelocityRead {
  /** Which door is open TODAY, or null. Early wins when both read true [D1]. */
  door: VelocityDoor | null
  /** Today closed above every close of the prior BREAKOUT_WINDOW sessions. */
  breakout: boolean
  /** Today's volume over the trailing 20-session average (excluding today). */
  rvol: number | null
  /** Close-to-close gain over RUN_WINDOW sessions, %. */
  runPct: number
  /** Up-days within RUN_WINDOW. */
  upDays: number
  /** Consecutive green closes ending today. */
  greenStreak: number
  /** The entry-timing rule passed: a pause that holds the 8-EMA, or the reclaim
   * after one, and never the Nth green day. */
  timingOk: boolean
  detail: string
}

/** Standard EMA series, seeded with the SMA of the first `period` values.
 * Entries before the seed are null — an unknown never passes a gate. */
function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null)
  if (values.length < period) return out
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period
  out[period - 1] = e
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    e += k * (values[i] - e)
    out[i] = e
  }
  return out
}

/** Relative volume at bar `i` against the 20 sessions before it. Null when the
 * window is too short to mean anything. */
function rvolAt(candles: Candle[], i: number): number | null {
  const w = candles.slice(Math.max(0, i - BREAKOUT_WINDOW), i).map(c => c.v)
  if (w.length < 5) return null
  const avg = w.reduce((s, v) => s + v, 0) / w.length
  return avg > 0 ? candles[i].v / avg : null
}

/** The falsifier for a long in this lane: the NEARER of the 8-EMA and the
 * TRAIL_LOW_WINDOW low — nearer meaning HIGHER, because a long dies upwards
 * from below. Exported because three callers need the identical number: the
 * confirmation door's entry stop, the replay harness's forward simulation
 * (the ship gate), and — from Stage 2 — the live open-position trail [D7]. */
export function velocityTrailStop(candles: Candle[]): number | null {
  if (candles.length < FAST_EMA) return null
  const ema = emaSeries(candles.map(c => c.c), FAST_EMA)
  const emaNow = ema[ema.length - 1]
  const low = Math.min(...candles.slice(-TRAIL_LOW_WINDOW).map(c => c.l))
  if (emaNow == null) return Number.isFinite(low) ? low : null
  return Math.max(emaNow, low)
}

/** Quarter for the early door, half for the confirmation door. A CAP on the
 * size, never a multiplier applied on top of the evidence tier [D4]. */
export const velocitySizeMult = (door: VelocityDoor): number => (door === 'early' ? 0.25 : 0.5)

const pct = (x: number) => `${round1(x)}%`

/** Read the velocity signature off the tape. null iff the history is too short. */
export function classifyVelocity(candles: Candle[]): VelocityRead | null {
  if (candles.length < MIN_CANDLES) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.c)
  const n = candles.length

  // --- the early door: a break of the 20-session high, PAID for ---
  // The window excludes today on purpose: "breaking the high" means clearing the
  // high the market already made, not the one today is still in the middle of.
  const priorHigh = Math.max(...closes.slice(-(BREAKOUT_WINDOW + 1), -1))
  const breakout = last.c > priorHigh
  const rvol = rvolAt(candles, n - 1)

  // --- the run: how much, how consistently ---
  const runBase = closes[n - 1 - RUN_WINDOW]
  const runPct = runBase > 0 ? round1(((last.c - runBase) / runBase) * 100) : 0
  let upDays = 0
  for (let i = n - RUN_WINDOW; i < n; i++) if (i > 0 && closes[i] > closes[i - 1]) upDays++

  // --- the entry-timing rule, the reason this lane is not a top-buyer ---
  // greenStreak counts consecutive green closes ending today.
  let greenStreak = 0
  for (let i = n - 1; i > 0 && closes[i] > closes[i - 1]; i--) greenStreak++
  const ema = emaSeries(closes, FAST_EMA)
  const emaNow = ema[n - 1]
  const emaPrev = ema[n - 2]
  // A PAUSE: today gave ground (or went nowhere) and still held the 8-EMA.
  const paused = emaNow != null && last.c <= closes[n - 2] && last.c >= emaNow
  // The RECLAIM after one: yesterday closed under the 8-EMA, today closed back over.
  const reclaimed = emaNow != null && emaPrev != null && closes[n - 2] < emaPrev && last.c > emaNow
  const timingOk = (paused || reclaimed) && greenStreak <= GREEN_STREAK_MAX

  // --- volume for the confirmation door is TURN-SCOPED [D3] ---
  // Same reasoning the dip lane ratified on 2026-08-12: the crowd's size shows up
  // where the tape chose to spend it, and demanding it land on TODAY refuses the
  // move for as long as the move lasts. Bounded by the timing rule above, which
  // IS measured on today.
  let runRvol: number | null = null
  for (let i = n - 1; i >= Math.max(0, n - RUN_WINDOW); i--) {
    const r = rvolAt(candles, i)
    if (r != null && (runRvol == null || r > runRvol)) runRvol = r
  }

  const earlyOpen = breakout && rvol != null && rvol >= EARLY_RVOL && greenStreak <= GREEN_STREAK_MAX
  const confirmOpen = (runPct >= RUN_GAIN_PCT || upDays >= RUN_UP_DAYS) && runRvol != null && runRvol >= CONF_RVOL && timingOk
  // [D1] both true → EARLY: the smaller size wins the ambiguity.
  const door: VelocityDoor | null = earlyOpen ? 'early' : confirmOpen ? 'confirmation' : null

  const rvolStr = rvol != null ? `${round1(rvol)}×` : 'unknown'
  const runStr = runRvol != null ? `${round1(runRvol)}×` : 'unknown'
  let detail: string
  if (door === 'early') {
    detail = `early door: broke the ${round2(priorHigh)} 20-session high on ${rvolStr} volume`
  } else if (door === 'confirmation') {
    const trigger = runPct >= RUN_GAIN_PCT ? `+${pct(runPct)} in ${RUN_WINDOW} sessions` : `${upDays} up-days of ${RUN_WINDOW}`
    detail = `confirmation door: ${trigger} on ${runStr} volume · entered on the ${paused ? 'pause holding' : 'reclaim of'} the 8-EMA`
  } else {
    const why: string[] = []
    if (breakout && (rvol == null || rvol < EARLY_RVOL)) why.push(`breakout unpaid (${rvolStr})`)
    if (!breakout) why.push(`${pct(runPct)} over ${RUN_WINDOW}, ${upDays} up-days`)
    if (greenStreak > GREEN_STREAK_MAX) why.push(`${greenStreak} green days running — never the Nth`)
    else if (!paused && !reclaimed) why.push('no pause or reclaim of the 8-EMA yet')
    detail = `no velocity door: ${why.join('; ')}`
  }

  return { door, breakout, rvol, runPct, upDays, greenStreak, timingOk, detail }
}

/** The velocity lane's own long call. Only an OPEN door earns one.
 *
 * Levels are structural, like the dip lane's. The stop is whichever falsifier
 * the door's own thesis names: the early door bought a breakout, so it dies when
 * the broken level goes back; the confirmation door bought a running name at a
 * pause, so it dies at the trail. The target is a plain 2R — the trail is what
 * actually takes a winner out, and pretending to a computed destination on a
 * momentum trade would be a number with nothing behind it. */
export function velocityCall(sym: string, candles: Candle[], read: VelocityRead, capUsdM: number | null): EngineCall | null {
  if (!read.door) return null
  if (candles.length < MIN_CANDLES) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.c)
  const entry = round2(last.c)

  const priorHigh = Math.max(...closes.slice(-(BREAKOUT_WINDOW + 1), -1))
  const trail = velocityTrailStop(candles)
  // Whichever level this door's thesis stands on — and never inside today's
  // range, the one place today's low has to count (the dip lane's ratified
  // stop discipline, applied here for the same reason).
  const structural = read.door === 'early' ? priorHigh : trail
  if (structural == null) return null
  const stop = round2(Math.min(structural, last.l))
  if (stop >= entry) return null
  const target = round2(entry + 2 * (entry - stop))
  if (target <= entry) return null
  // The 1:1 reward-to-risk gate the dip lane needs is STRUCTURALLY satisfied here
  // (a 2R target cannot pay less than the risk), so it is not re-implemented as a
  // branch no test could ever reach.

  const expectedMovePct = round1(((target - entry) / entry) * 100)
  // Inside the calibrated 25-55 bands, and honest about which door: a breakout on
  // volume is thinner evidence than a measured run entered at a pause.
  const composite =
    read.door === 'early'
      ? round1(clamp(25 + ((read.rvol ?? EARLY_RVOL) - EARLY_RVOL) * 4, 25, 45))
      : round1(clamp(30 + read.runPct, 30, 55))
  const smallCap = capUsdM != null && capUsdM < SMALL_CAP_MAX_USD_M

  // A minimal, honest factor record — same construction as the dip lane's: this
  // lane has ONE read and it is technical, so every weight is 0 and the composite
  // above is explicitly NOT a weighted sum. gradeOutstanding must keep these rows
  // out of factor IC (LANE_CATALYST_KINDS), or a constant score trains a factor
  // that never voted.
  const factors = Object.fromEntries(
    (Object.keys(DEFAULT_WEIGHTS) as FactorName[]).map(name => [
      name,
      name === 'technical'
        ? ({ score: read.door === 'early' ? 40 : 50, detail: read.detail, weight: 0 } as FactorScore & { weight: number })
        : ({ score: null, detail: 'velocity lane', weight: 0 } as FactorScore & { weight: number }),
    ]),
  ) as Record<FactorName, FactorScore & { weight: number }>

  const evidence: CallEvidence = {
    // NOMINAL placeholders — this lane has ONE real factor (its own price read).
    // Nothing downstream may read these as a count of independent evidence.
    coverage: 1,
    famAgree: 2,
    contract: true,
    contextPts: 0,
    detail: `${read.detail} · momentum, not quality — sized accordingly`,
  }

  return {
    sym,
    side: 'long',
    composite,
    factors,
    setup: 'velocity',
    evidence,
    expectedMovePct,
    entry,
    stop,
    target,
    capacityPct: swingCapacity(closes) ?? 0,
    smallCap,
    earningsRisk: false, // overridden from the live earnings calendar at integration
    stage: 'trending',
    note: read.detail,
  }
}
```

Plus the three one-line edits:

```ts
// shared/engine/types.ts:14 — ADD a fourth family (spec §4.3c). Widening only:
// every existing value keeps its meaning and setupFamilyOf still returns the
// three it always did — 'velocity' is stamped by the lane itself.
export type SetupFamily = 'continuation' | 'reversal' | 'fade' | 'velocity'
```

```ts
// shared/engine/catalyst.ts, beside DIP_CATALYST_KIND
export const VELOCITY_CATALYST_KIND = 'velocity'
/** The lanes whose factor record carries a CONSTANT placeholder score rather
 * than a measured vote. Their outcomes must never reach updateIcStats: booking
 * them would train the technical factor's IC on a lane's P&L. One set, because
 * the producer (buildBoard) and the guard (gradeOutstanding) cannot see each
 * other and a missing literal would fail silently. */
export const LANE_CATALYST_KINDS = new Set<string>([DIP_CATALYST_KIND, VELOCITY_CATALYST_KIND])
```
…and widen `CatalystTag['kind']` to `… | typeof DIP_CATALYST_KIND | typeof VELOCITY_CATALYST_KIND`.

```ts
// netlify/functions/lib/engine.ts:385
if (!LANE_CATALYST_KINDS.has(pred.catalyst?.kind ?? '')) w = updateIcStats(w, pred, o)
```

- [ ] **Step 4: Engine IC-isolation test** — in `netlify/functions/lib/engine.test.ts`, alongside the existing dip-IC case:

```ts
it('a graded VELOCITY row leaves factor-IC untouched, exactly like a dip row', async () => {
  // seed a prior-day prediction with catalyst.kind 'velocity' and mature candles;
  // run gradeOutstanding; assert weights.ic.technical.nAgree + nDisagree is
  // unchanged, and that the calibration bucket AND setupBuckets['velocity:long:*']
  // DID accrue (only factor-IC is excluded).
})
```

- [ ] **Step 5: Full suite** — `npm test` green. The `SetupFamily` widening compiles everywhere (`horizonOf` takes the union without switching exhaustively; `setupFamilyOf` still returns only the original three; `bySetup` in engine.ts:460 is keyed `Record<string, …>`).

- [ ] **Step 6: Commit**

```bash
git add shared/engine/velocityLane.ts shared/engine/velocityLane.test.ts shared/engine/types.ts shared/engine/catalyst.ts netlify/functions/lib/engine.ts netlify/functions/lib/engine.test.ts
git commit -m "feat(engine): the velocity lane — two doors, and never the Nth green day"
```

---

### Task 2: Hype-cluster detection (`hypeCluster.ts`)

A mania is names talked about together AND moving together. Neither leg alone is a cluster: co-mention alone is a subreddit, co-movement alone is a sector ETF.

**Files:**
- Create: `shared/engine/hypeCluster.ts`
- Test: `shared/engine/hypeCluster.test.ts`
- Modify: `shared/engine/select.ts` — extract and export `pearson(a: number[], b: number[]): number | null`, and have `returnCorrelation` call it (one maths, two consumers — the repo's standing rule)
- Test: `shared/engine/select.test.ts` — one case pinning that `returnCorrelation` is unchanged by the extraction

**Interfaces:**
- Consumes: `pearson` from `'./select'`. Nothing else — no candles fetched here, no IO.
- Produces:
  - `SocialDay = { date: string; syms: string[] }` — the rolling record buildBoard writes (Task 6).
  - `coMentionGroups(history: SocialDay[]): string[][]` — connected components of the co-mention graph, ≥ `CLUSTER_MIN_MEMBERS`, members sorted alphabetically, groups sorted largest-first then alphabetically. **Phase one [D14]: needs no prices, so it can elevate candidate priority before the candidate cut.**
  - `excessReturns(closes: number[], bench: number[], days: number): number[]` — daily returns minus the benchmark's, tail-aligned; `[]` when either series is too short.
  - `detectHypeClusters(history, closesBySym: Map<string, number[]>, benchCloses: number[]): HypeCluster[]` — **phase two**: the same graph with every edge required to also co-MOVE, and every member required to have printed abnormal days. `HypeCluster = { members: string[]; coMentionDays: number; meanCorr: number; detail: string }`.
  - Constants: `CLUSTER_DAYS 7`, `CLUSTER_MIN_MEMBERS 3`, `CO_MENTION_MIN_DAYS 2`, `CO_MOVE_MIN_CORR 0.6`, `CO_MOVE_DAYS 20`, `ABNORMAL_MIN_PCT 4`, `ABNORMAL_MIN_DAYS 2`.

- [ ] **Step 1: Write the failing tests**

```ts
// shared/engine/hypeCluster.test.ts
import { describe, expect, it } from 'vitest'
import { coMentionGroups, detectHypeClusters, excessReturns, type SocialDay } from './hypeCluster'

/** compound a return series into closes from 100 */
const closesOf = (rets: number[], scale = 1) => {
  const out = [100]
  for (const r of rets) out.push(out[out.length - 1] * (1 + r * scale))
  return out
}
const wig = [0.05, -0.02, 0.06, -0.03, 0.07, 0.01, -0.04, 0.08, 0.02, -0.01, 0.05, 0.03, -0.02, 0.06, 0.04, 0.05, -0.03, 0.07, 0.01, 0.06]
const flat = wig.map(() => 0)

const history: SocialDay[] = [
  { date: '2026-08-05', syms: ['AAA', 'BBB', 'ZZZ'] },
  { date: '2026-08-06', syms: ['AAA', 'BBB', 'CCC'] },
  { date: '2026-08-07', syms: ['AAA', 'CCC'] },
  { date: '2026-08-08', syms: ['BBB', 'CCC'] },
  { date: '2026-08-09', syms: ['AAA', 'BBB', 'CCC'] },
]

describe('coMentionGroups', () => {
  it('finds the >=3-name group talked about together across the week', () => {
    expect(coMentionGroups(history)).toEqual([['AAA', 'BBB', 'CCC']])
  })
  it('a name mentioned once with the group is not in it', () => {
    expect(coMentionGroups(history)[0]).not.toContain('ZZZ')
  })
  it('a pair is never a cluster', () => {
    expect(coMentionGroups([{ date: 'd1', syms: ['AAA', 'BBB'] }, { date: 'd2', syms: ['AAA', 'BBB'] }])).toEqual([])
  })
  it('empty/absent history is empty, never a throw', () => expect(coMentionGroups([])).toEqual([]))
})

describe('excessReturns', () => {
  it('is the name\'s daily return minus the benchmark\'s, tail-aligned', () => {
    const ex = excessReturns(closesOf([0.05, 0.02]), closesOf([0.01, 0.01]), 2)
    expect(ex).toHaveLength(2)
    expect(ex[0]).toBeCloseTo(0.04, 6)
  })
  it('too little history returns []', () => expect(excessReturns([100], [100, 101], 5)).toEqual([]))
})

describe('detectHypeClusters', () => {
  const bench = closesOf(flat)
  it('confirms the co-mentioned group when it also co-MOVES abnormally', () => {
    const closes = new Map([
      ['AAA', closesOf(wig)],
      ['BBB', closesOf(wig, 0.9)],
      ['CCC', closesOf(wig, 1.1)],
    ])
    const clusters = detectHypeClusters(history, closes, bench)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].members).toEqual(['AAA', 'BBB', 'CCC'])
    expect(clusters[0].meanCorr).toBeGreaterThan(0.9)
    expect(clusters[0].detail).toMatch(/3 names/)
  })
  it('co-mention WITHOUT co-movement is not a cluster', () => {
    // AAA moves opposite to both others, so its two edges die; BBB and CCC do
    // move together and survive as a PAIR — which is below the floor, so the
    // detector returns nothing. Two names moving together is not a mania.
    const closes = new Map([
      ['AAA', closesOf(wig)],
      ['BBB', closesOf(wig.map(r => -r))],
      ['CCC', closesOf(wig.map(r => -r), 0.9)],
    ])
    expect(detectHypeClusters(history, closes, bench)).toEqual([])
  })
  it('co-movement WITHOUT abnormal size is not a cluster (three quiet trackers)', () => {
    const tame = wig.map(r => r / 20) // < ABNORMAL_MIN_PCT every day
    const closes = new Map([['AAA', closesOf(tame)], ['BBB', closesOf(tame, 0.9)], ['CCC', closesOf(tame, 1.1)]])
    expect(detectHypeClusters(history, closes, bench)).toEqual([])
  })
  it('a member with no candles at all drops out; the rest may still cluster', () => {
    const closes = new Map([['AAA', closesOf(wig)], ['BBB', closesOf(wig, 0.9)]])
    expect(detectHypeClusters(history, closes, bench)).toEqual([]) // only 2 left — below the floor
  })
  it('is deterministic: same inputs, same order, every time', () => {
    const closes = new Map([['CCC', closesOf(wig, 1.1)], ['AAA', closesOf(wig)], ['BBB', closesOf(wig, 0.9)]])
    expect(detectHypeClusters(history, closes, bench)[0].members).toEqual(['AAA', 'BBB', 'CCC'])
  })
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement**

```ts
// shared/engine/hypeCluster.ts
// HYPE CLUSTERS: manias, recognised without ever being named.
//
// IONQ, RGTI and QBTS never shared a clean sector tag, and next year's mania
// will not share one either — that is precisely why the theme lists cannot find
// these trades. What the names DO share is a signature: the crowd talks about
// them together, and they move together, abnormally, inside the same week.
//
// Two legs, both required. Co-mention alone is a subreddit. Co-movement alone is
// a sector ETF. Together, and only together, they are a cluster.
//
// The graph is built from the SOCIAL PULSE the engine already fetches every
// morning (social.ts), accumulated into a rolling week by buildBoard. Nothing
// here does IO and nothing here reads a theme list.
//
// A cluster is not a call and not a score. It ELEVATES candidate priority, so a
// mania's members are inside the evaluation budget on the day it forms, and it
// names itself in a velocity call's reason. Every gate downstream is unchanged.

import { pearson } from './select'

/** The rolling window, in editions. */
export const CLUSTER_DAYS = 7
/** Two names moving together is a pair trade; three is a crowd. */
export const CLUSTER_MIN_MEMBERS = 3
/** Days inside the window two names must BOTH appear on to earn an edge. One
 * shared day is a coincidence of a single headline. */
export const CO_MENTION_MIN_DAYS = 2
/** Correlation of ABNORMAL (excess-of-benchmark) returns that counts as moving
 * together. Deliberately below the board's own redundancy cap (0.75): this is
 * detection, not de-duplication. */
export const CO_MOVE_MIN_CORR = 0.6
/** Sessions the co-movement is measured over. */
export const CO_MOVE_DAYS = 20
/** |excess return| that counts as an abnormal day, %. */
export const ABNORMAL_MIN_PCT = 4
/** …and how many of them a member needs. A mania is loud; a stock that never
 * moved more than the market is not in one, whoever mentions it. */
export const ABNORMAL_MIN_DAYS = 2

/** One edition's social pulse, as buildBoard records it. */
export interface SocialDay {
  date: string
  syms: string[]
}

export interface HypeCluster {
  members: string[]
  /** The strongest pairwise co-mention count inside the cluster. */
  coMentionDays: number
  meanCorr: number
  detail: string
}

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Pairwise co-mention counts over the last CLUSTER_DAYS editions. */
function coMentionCounts(history: SocialDay[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const day of history.slice(-CLUSTER_DAYS)) {
    const syms = [...new Set(day.syms.map(s => s.toUpperCase()))].sort()
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        const k = key(syms[i], syms[j])
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    }
  }
  return counts
}

/** Connected components of an edge list, each sorted alphabetically; components
 * sorted largest-first then alphabetically. Determinism matters: this decides
 * evaluation priority, and a set that reordered day to day would make the
 * engine's own attention unreproducible. */
function components(edges: [string, string][], minSize: number): string[][] {
  const adj = new Map<string, Set<string>>()
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  const seen = new Set<string>()
  const out: string[][] = []
  for (const start of [...adj.keys()].sort()) {
    if (seen.has(start)) continue
    const stack = [start]
    const group: string[] = []
    seen.add(start)
    while (stack.length) {
      const cur = stack.pop()!
      group.push(cur)
      for (const nxt of [...(adj.get(cur) ?? [])].sort()) {
        if (seen.has(nxt)) continue
        seen.add(nxt)
        stack.push(nxt)
      }
    }
    if (group.length >= minSize) out.push(group.sort())
  }
  return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
}

/** PHASE ONE [D14]: who is being talked about together this week. Price-free, so
 * it can run before the candidate cut and put a forming mania's members inside
 * the evaluation budget on the morning it forms. Co-mention alone is NOT a
 * cluster — it only buys a name a look, exactly like every other candidate door. */
export function coMentionGroups(history: SocialDay[]): string[][] {
  const edges: [string, string][] = []
  for (const [k, n] of coMentionCounts(history)) {
    if (n < CO_MENTION_MIN_DAYS) continue
    const [a, b] = k.split('|')
    edges.push([a, b])
  }
  return components(edges, CLUSTER_MIN_MEMBERS)
}

/** Daily returns minus the benchmark's, tail-aligned over the last `days`
 * sessions. Returns [] when either series cannot supply them. */
export function excessReturns(closes: number[], bench: number[], days: number): number[] {
  const rets = (xs: number[]) => {
    const tail = xs.slice(-(days + 1))
    const out: number[] = []
    for (let i = 1; i < tail.length; i++) if (tail[i - 1]) out.push((tail[i] - tail[i - 1]) / tail[i - 1])
    return out
  }
  const a = rets(closes)
  const b = rets(bench)
  const n = Math.min(a.length, b.length)
  if (n < 2) return []
  const xa = a.slice(-n)
  const xb = b.slice(-n)
  return xa.map((x, i) => x - xb[i])
}

/** PHASE TWO: the confirmed cluster — co-mentioned AND co-moving AND abnormal.
 * This is what gets recorded and what a velocity call may cite. */
export function detectHypeClusters(history: SocialDay[], closesBySym: Map<string, number[]>, benchCloses: number[]): HypeCluster[] {
  const excess = new Map<string, number[]>()
  for (const [sym, closes] of closesBySym) {
    const ex = excessReturns(closes, benchCloses, CO_MOVE_DAYS)
    // the member's own hurdle: it has to have actually MOVED, not merely tracked
    // something that did
    const abnormal = ex.filter(r => Math.abs(r) * 100 >= ABNORMAL_MIN_PCT).length
    if (ex.length >= 2 && abnormal >= ABNORMAL_MIN_DAYS) excess.set(sym.toUpperCase(), ex)
  }

  const corrs = new Map<string, number>()
  const edges: [string, string][] = []
  for (const [k, n] of coMentionCounts(history)) {
    if (n < CO_MENTION_MIN_DAYS) continue
    const [a, b] = k.split('|')
    const ea = excess.get(a)
    const eb = excess.get(b)
    if (!ea || !eb) continue
    const len = Math.min(ea.length, eb.length)
    const r = pearson(ea.slice(-len), eb.slice(-len))
    if (r == null || r < CO_MOVE_MIN_CORR) continue
    corrs.set(k, r)
    edges.push([a, b])
  }

  const counts = coMentionCounts(history)
  return components(edges, CLUSTER_MIN_MEMBERS).map(members => {
    const inner: number[] = []
    let coMentionDays = 0
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const k = key(members[i], members[j])
        const r = corrs.get(k)
        if (r != null) inner.push(r)
        coMentionDays = Math.max(coMentionDays, counts.get(k) ?? 0)
      }
    }
    const meanCorr = inner.length ? Math.round((inner.reduce((s, x) => s + x, 0) / inner.length) * 100) / 100 : 0
    return {
      members,
      coMentionDays,
      meanCorr,
      detail: `hype cluster: ${members.length} names (${members.join(', ')}) mentioned together on ${coMentionDays} of the last ${CLUSTER_DAYS} editions and moving together (r ${meanCorr})`,
    }
  })
}
```

And the extraction in `select.ts` (replacing the inline arithmetic at select.ts:29-43, behaviour identical):

```ts
/** Pearson correlation of two equal-length series. Null when either has no
 * variance (a flat series correlates with nothing) or they are too short.
 * Exported because hypeCluster.ts correlates EXCESS RETURNS rather than closes
 * — same maths, different input, and it must not be written twice. */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 2) return null
  const xa = a.slice(-n)
  const xb = b.slice(-n)
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  const ma = mean(xa)
  const mb = mean(xb)
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < n; i++) {
    const da = xa[i] - ma
    const db = xb[i] - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  if (!va || !vb) return null
  return cov / Math.sqrt(va * vb)
}
```
`returnCorrelation` keeps its `CORR_MIN_OVERLAP` guard and then `return pearson(a, b)`.

- [ ] **Step 4: Verify** — both test files green; `npm test` green (the select extraction must not move a single existing assertion).

- [ ] **Step 5: Commit**

```bash
git add shared/engine/hypeCluster.ts shared/engine/hypeCluster.test.ts shared/engine/select.ts shared/engine/select.test.ts
git commit -m "feat(engine): hype clusters — a mania recognised without ever being named"
```

---

### Task 3: The crypto module and the additive cohort

Everything crypto that is pure, plus the smallest possible additive change to the learning surfaces. **No existing bucket key, no existing rung, no existing outcome definition moves.**

**Files:**
- Create: `shared/engine/crypto.ts`
- Test: `shared/engine/crypto.test.ts`
- Modify: `shared/engine/capClass.ts` — add `LearnCohort` / `LearnCohortOrUnknown` types (ADD; `CapCohort` keeps its exact meaning)
- Modify: `shared/engine/calibration.ts` — cohort params widened to `LearnCohortOrUnknown`; `updateCalibration` derives the cohort via `learnCohortOf(pred.sym, pred.capUsdM)`; `gradePrediction`'s benchmark param becomes `Candle[] | null`
- Modify: `shared/engine/riskLadder.ts` — `cohortRungOf` made lookup-safe [D9]; `isRouteEtp` also refuses crypto tracker tickers
- Modify: `shared/engine/factors.ts:41-46` — `momentumFactor` gains an optional benchmark label [D12]
- Modify: `shared/config.ts` — `cryptoMap?: Record<string, string>`, validated
- Modify: `netlify/functions/config-sync.mts:156-168` — preserve `cryptoMap`
- Tests: `shared/engine/calibration.test.ts`, `shared/engine/capClass.test.ts`, `shared/engine/riskLadder.test.ts`, `netlify/functions/lib/config-sync.test.ts`

**Interfaces:**
- Produces (crypto.ts): `CRYPTO_UNIVERSE = ['BTC-USD','ETH-USD','SOL-USD']`; `CRYPTO_BENCHMARK = 'BTC-USD'`; `CRYPTO_SIZE_MULT = 0.5`; `isCryptoSym(sym)`; `isCryptoAlt(sym)`; `DEFAULT_CRYPTO_ROUTES`; `CRYPTO_ROUTE_TICKERS: Set<string>`; `cryptoRoutesWithDefaults(cfg)`; `cryptoRouteFor(sym, routes)`; `cryptoRegime(btcCandles): RegimeColor | 'unknown'`; `btcAgreesWith(side, regime): boolean`; `learnCohortOf(sym, capUsdM): LearnCohortOrUnknown`.
- Produces (calibration.ts): `gradePrediction(pred, candles, benchmark: Candle[] | null, horizon)` — `null` benchmark means **absolute** (benchmark return 0), which with the untouched `HIT_EXCESS_MIN = 1` is exactly the spec's "BTC measures absolute +1pp".

- [ ] **Step 1: Failing tests**

```ts
// shared/engine/crypto.test.ts
import { describe, expect, it } from 'vitest'
import {
  btcAgreesWith, CRYPTO_UNIVERSE, cryptoRegime, cryptoRouteFor, cryptoRoutesWithDefaults,
  DEFAULT_CRYPTO_ROUTES, isCryptoAlt, isCryptoSym, learnCohortOf,
} from './crypto'
import type { Candle } from '../types'

const mk = (c: number): Candle => ({ t: 0, o: c, h: c, l: c, c, v: 1 })
/** a 250-bar series ending in a steady climb / slide */
const ramp = (from: number, to: number, n = 260) => Array.from({ length: n }, (_, i) => mk(from + ((to - from) * i) / (n - 1)))

describe('the universe', () => {
  it('is exactly the three majors', () => expect(CRYPTO_UNIVERSE).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']))
  it('knows its own', () => {
    expect(isCryptoSym('btc-usd')).toBe(true)
    expect(isCryptoSym('DOGE-USD')).toBe(false) // out of scope by spec §7
    expect(isCryptoAlt('BTC-USD')).toBe(false)
    expect(isCryptoAlt('SOL-USD')).toBe(true)
  })
})

describe('cryptoRegime', () => {
  it('green when BTC is above a rising 50/200 stack', () => expect(cryptoRegime(ramp(20_000, 80_000))).toBe('green'))
  it('red when BTC is below a falling stack', () => expect(cryptoRegime(ramp(80_000, 20_000))).toBe('red'))
  it('unknown without 200 bars — an unknown never passes a gate', () => expect(cryptoRegime(ramp(1, 2, 120))).toBe('unknown'))
})

describe('btcAgreesWith [D10]', () => {
  it('a long alt needs green, a short alt needs red, amber blocks both', () => {
    expect(btcAgreesWith('long', 'green')).toBe(true)
    expect(btcAgreesWith('long', 'amber')).toBe(false)
    expect(btcAgreesWith('short', 'red')).toBe(true)
    expect(btcAgreesWith('short', 'amber')).toBe(false)
    expect(btcAgreesWith('long', 'unknown')).toBe(false)
  })
})

describe('routes', () => {
  it('unions config over the defaults, never replaces them (the stale-blob trap)', () => {
    const r = cryptoRoutesWithDefaults({ 'SOL-USD': 'solx.l' })
    expect(r['BTC-USD']).toBe(DEFAULT_CRYPTO_ROUTES['BTC-USD'])
    expect(r['SOL-USD']).toBe('SOLX.L')
  })
  it('an unrouted major returns null — it will run as a labelled shadow', () => {
    expect(cryptoRouteFor('SOL-USD', DEFAULT_CRYPTO_ROUTES)).toBeNull()
    expect(cryptoRouteFor('BTC-USD', DEFAULT_CRYPTO_ROUTES)).toBe('BITP.L')
  })
})

describe('learnCohortOf [D8]', () => {
  it('reads the SYMBOL for crypto and the cap for everything else', () => {
    expect(learnCohortOf('ETH-USD', null)).toBe('crypto')
    expect(learnCohortOf('ETH-USD', 500_000)).toBe('crypto') // a stray cap can never re-sleeve it
    expect(learnCohortOf('GLW', 35_000)).toBe('large')
    expect(learnCohortOf('NRGV', 300)).toBe('small')
    expect(learnCohortOf('XYZ', null)).toBe('unknown')
  })
})
```

```ts
// additions to shared/engine/calibration.test.ts
it('a crypto grade books into its OWN bucket and leaves every equity bucket untouched', () => {
  const state = { buckets: { 'large:long:green:40-55': { n: 20, hits: 9 } }, brier: [] } as CalibrationState
  updateCalibration(state, { sym: 'ETH-USD', side: 'long', regime: 'green', composite: 45, capUsdM: null }, hitOutcome)
  expect(state.buckets['crypto:long:green:40-55']).toEqual({ n: 1, hits: 1 })
  expect(state.buckets['large:long:green:40-55']).toEqual({ n: 20, hits: 9 })
  expect(state.buckets['long:green:40-55']).toBeUndefined() // NOT pooled into the legacy cohortless key
})

it('probabilityFor reads the crypto rungs and falls through to the pooled rungs while thin', () => {
  // crypto bucket with n < MIN_BUCKET_N → rung 3/4 (pooled, includes the seed), provisional as usual
})

it('CALIB_DEF_VERSION is unchanged by the crypto cohort', () => expect(CALIB_DEF_VERSION).toBe(3))

it('gradePrediction with a NULL benchmark measures the move absolutely (+1pp is the hit bar)', () => {
  // BTC-shaped candles up 1.5% over 10 bars, benchmark null → excessPct 1.5, hit true;
  // up 0.5% → hit false. And spyPct is 0, documented as "no benchmark".
})

it('gradePrediction against BTC candles measures an alt\'s excess over BTC', () => {
  // ETH +8%, BTC +3% over the same 10 bars → excessPct 5
})
```

```ts
// additions to shared/engine/riskLadder.test.ts
it('cohortRungOf returns the COMBINED rung for a cohort with no ladder of its own [D9]', () => {
  const risk = { ...initRisk('2026-08-12'), rung: 2 as const }
  risk.cohorts!.large.rung = 0
  expect(cohortRungOf(risk, 'crypto')).toBe(2)
  expect(cohortRungOf(risk, 'large')).toBe(0)
  expect(cohortRungOf(risk, 'unknown')).toBe(2)
})
it('a crypto TRACKER is a route, never an underlying', () => {
  expect(isRouteEtp('BITP.L', {})).toBe(true)
  expect(isRouteEtp('GLW', {})).toBe(false)
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement `crypto.ts`**

```ts
// shared/engine/crypto.ts
// THE CRYPTO LANE'S FACTS. Three majors, one regime, one benchmark, one route
// table — and nothing bespoke in the signal logic: crypto rides the SAME
// continuation/dip/velocity mechanics as everything else (spec §4.1). What is
// different is the yardstick, and that is the whole reason it gets its own
// calibration cohort:
//   · an ALT is judged against BTC, because "SOL was up 6% while BTC was up 9%"
//     is a losing trade wearing a green number;
//   · BTC is judged absolutely (+1pp, the untouched HIT_EXCESS_MIN), because it
//     has no benchmark and pretending SPY is one would grade it against a market
//     that was closed for two of the ten sessions.
//
// Weekends: crypto prints 7 bars a week. The engine publishes an edition every
// day (the daily-paper cron is `* * *`), so a crypto falsifier is checked on
// every edition, including Saturdays, with no scheduling change — Task 7 pins
// that behaviour rather than adding machinery for it.
//
// A "10-session" outcome therefore means 10 CALENDAR days for crypto and ~14 for
// equities. That difference is real, it is why the cohort is separate, and it is
// NOT a change to what a hit is — CALIB_DEF_VERSION does not move.

import type { Candle, RegimeColor } from '../types'
import { capCohortOf, type LearnCohortOrUnknown } from './capClass'

/** Majors only. Alts, DeFi and memecoins are out of scope (spec §7). */
export const CRYPTO_UNIVERSE = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const
/** The cohort's own benchmark: every alt is measured against this. */
export const CRYPTO_BENCHMARK = 'BTC-USD'
/** Half size until the cohort's buckets prove out (spec §4.1). A CAP, like every
 * other lane cap [D4] — it can only ever make a position smaller. */
export const CRYPTO_SIZE_MULT = 0.5
/** BTC's own trend structure, the crypto tape. */
export const BTC_FAST_EMA = 50
export const BTC_SLOW_EMA = 200

const upper = (s: string) => s.toUpperCase()
export const isCryptoSym = (sym: string): boolean => (CRYPTO_UNIVERSE as readonly string[]).includes(upper(sym))
export const isCryptoAlt = (sym: string): boolean => isCryptoSym(sym) && upper(sym) !== CRYPTO_BENCHMARK

/** The ISA-eligible 1× trackers seen in the owner's 2026-07-25 T212 catalogue
 * pull. SOL has no tracker we know of, and that absence is deliberate: an
 * unroutable major runs as a LABELLED SHADOW rather than pretending the reader
 * can buy it. Overridable via config.cryptoMap (unioned, never replaced), and
 * live routability is re-verified against the catalogue during Task 7. */
export const DEFAULT_CRYPTO_ROUTES: Record<string, string> = {
  'BTC-USD': 'BITP.L',
  'ETH-USD': 'ETHC.L',
}

/** Every ticker that is a crypto ROUTE. Route instruments must never re-enter as
 * underlyings — the same rule (and the same failure mode) as the leveraged ETPs:
 * a held tracker circling back in as a "candidate" would hand calibration a
 * duplicate of the thing it already tracks. */
export const CRYPTO_ROUTE_TICKERS = new Set(Object.values(DEFAULT_CRYPTO_ROUTES).map(upper))

/** Config routes UNIONED over the defaults — the withDefaults pattern, for the
 * same reason coreSleeve uses it: a phone that syncs a config blob without this
 * field must never be able to un-route the lane. */
export function cryptoRoutesWithDefaults(cfg: Record<string, string> | undefined | null): Record<string, string> {
  const out = { ...DEFAULT_CRYPTO_ROUTES }
  for (const [sym, ticker] of Object.entries(cfg ?? {})) {
    if (typeof ticker !== 'string' || !ticker) continue
    out[upper(sym)] = upper(ticker)
  }
  return out
}

export const cryptoRouteFor = (sym: string, routes: Record<string, string>): string | null => routes[upper(sym)] ?? null

function emaLast(values: number[], period: number): number | null {
  if (values.length < period) return null
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) e += k * (values[i] - e)
  return e
}

/** THE CRYPTO TAPE, read off BTC alone and independent of the equity regime
 * (spec §4.1): green when BTC is above a bullishly stacked 50/200, red when it
 * is below a bearishly stacked one, amber in between, unknown without enough
 * history. This string is the regime component of every crypto calibration
 * bucket key — which is exactly why it must never be the equity regime: pooling
 * "green" the S&P and "green" bitcoin into one bucket would be two markets
 * wearing one label. */
export function cryptoRegime(btcCandles: Candle[] | null): RegimeColor | 'unknown' {
  if (!btcCandles || btcCandles.length < BTC_SLOW_EMA) return 'unknown'
  const closes = btcCandles.map(c => c.c)
  const fast = emaLast(closes, BTC_FAST_EMA)
  const slow = emaLast(closes, BTC_SLOW_EMA)
  const last = closes[closes.length - 1]
  if (fast == null || slow == null) return 'unknown'
  if (last > fast && fast > slow) return 'green'
  if (last < fast && fast < slow) return 'red'
  return 'amber'
}

/** [D10] An ALT only trades with the crypto tape: long needs green, short needs
 * red. Amber and unknown block alts outright — BTC itself may still call there.
 * A blocked alt still PUBLISHES, as a shadow, because a cohort this young cannot
 * afford to throw away evidence. */
export const btcAgreesWith = (side: 'long' | 'short', regime: RegimeColor | 'unknown'): boolean =>
  side === 'long' ? regime === 'green' : regime === 'red'

/** [D8] The cohort a graded call LEARNS in. Crypto is read off the SYMBOL, so no
 * stray market-cap lookup can ever file bitcoin under large-cap equities, and no
 * new field has to be stored on a Prediction (or migrated onto the old ones). */
export function learnCohortOf(sym: string | undefined, capUsdM: number | null | undefined): LearnCohortOrUnknown {
  if (sym && isCryptoSym(sym)) return 'crypto'
  return capCohortOf(capUsdM)
}
```

Then the additive edits:

```ts
// shared/engine/capClass.ts — ADD below CapCohortOrUnknown
/** The cohorts the engine LEARNS in. `crypto` is a cap-free cohort added in
 * Stage 1b: BTC/ETH/SOL have no market cap in any free source, and — more to the
 * point — they are judged against a different benchmark (crypto.ts), so pooling
 * them with equities would corrupt both. ADDITIVE: `CapCohort` keeps its exact
 * meaning, every existing bucket key is untouched, and CALIB_DEF_VERSION does
 * not move (the cohort changes the KEY SPACE, never what a hit is — the same
 * reasoning already recorded for the Phase-2 cap cohorts). */
export type LearnCohort = CapCohort | 'crypto'
export type LearnCohortOrUnknown = LearnCohort | 'unknown'
```

```ts
// shared/engine/calibration.ts
// 1. poolBuckets + probabilityFor: `cohort: CapCohort | 'any'` → `LearnCohort | 'any'`,
//    `cohort: CapCohortOrUnknown = 'unknown'` → `LearnCohortOrUnknown = 'unknown'`.
//    The body needs NO change: the key comparison is already string equality.
// 2. updateCalibration's pred param gains `sym?: string`, and the cohort line becomes:
const cohort = learnCohortOf(pred.sym, pred.capUsdM)
// 3. gradePrediction's benchmark becomes nullable:
export function gradePrediction(
  pred: { date: string; side: 'long' | 'short'; priceAtPrediction: number; stop: number },
  candles: Candle[],
  benchmark: Candle[] | null,
  horizon: 5 | 10 | 21,
): PredOutcome | null {
  // …entryIdx unchanged…
  // A NULL benchmark means the call is judged ABSOLUTELY — the crypto cohort's
  // BTC case (spec §4.1: "BTC measures absolute +1pp"). HIT_EXCESS_MIN is
  // untouched, so the +1pp bar is the same bar every other call clears; only the
  // thing subtracted from the move is different, and for BTC there is nothing
  // honest to subtract. `spyPct` stays in the record as 0 with the benchmark
  // named in the caller's log — the field is schema, not a claim about SPY.
  let spyPct = 0
  if (benchmark) {
    const spyIdx = benchmark.findIndex(c => c.t >= dayEpoch)
    if (spyIdx === -1 || spyIdx + horizon >= benchmark.length) return null
    const spyBase = benchmark[spyIdx].o
    spyPct = ((benchmark[spyIdx + horizon].c - spyBase) / spyBase) * 100
  }
  // …the rest unchanged…
}
```

```ts
// shared/engine/riskLadder.ts
/** The rung a call of the given cohort trades at. A cohort WITH its own ladder
 * reads it; everything else — unknown caps, and the crypto cohort, which has no
 * ladder by design [D9] — pools to the combined (top-level) rung. Lookup-safe on
 * purpose: the cohort type is wider than the `cohorts` map, and indexing it
 * blindly would throw the moment a new cohort appeared. */
export function cohortRungOf(state: RiskState, cohort: LearnCohortOrUnknown): number {
  const ladder = cohort !== 'unknown' && state.cohorts ? (state.cohorts as Partial<Record<string, CohortRung>>)[cohort] : undefined
  return ladder ? ladder.rung : state.rung
}

// …and in isRouteEtp, after the digit-prefix check:
if (CRYPTO_ROUTE_TICKERS.has(s)) return true
```

```ts
// shared/engine/factors.ts:41 — the label, so the printed evidence never lies [D12]
export function momentumFactor(closes: number[] | null, benchCloses: number[] | null, benchLabel = 'SPY'): FactorScore {
  // …unchanged…
  return { score: round1(clamp(rs * 4, -80, 80)), detail: `21d RS vs ${benchLabel} ${rs >= 0 ? '+' : ''}${round1(rs)}pp` }
}
```

`shared/config.ts`: add `cryptoMap?: Record<string, string>` next to `levMap` (line 18) and validate it exactly as `levMap` is validated (≤10 entries, keys and values `.toUpperCase().slice(0, 12)`, values matched against `/^[A-Z0-9.\-]{1,12}$/`, emit only when non-empty). `config-sync.mts:168`: `cryptoMap: cfg.cryptoMap ?? stored?.cryptoMap`, with a preservation test copied from the `coreSleeve` case.

- [ ] **Step 4: Verify** — all four test files green; `npm test` green; `npm run build` clean (the widened cohort type touches `gradeOutstanding`'s `Record<CapCohortOrUnknown, number>` — leave that map on `CapCohortOrUnknown`, since crypto deliberately does NOT get a ladder tally [D9]).

- [ ] **Step 5: Commit**

```bash
git add shared/engine/crypto.ts shared/engine/crypto.test.ts shared/engine/capClass.ts shared/engine/calibration.ts shared/engine/calibration.test.ts shared/engine/riskLadder.ts shared/engine/riskLadder.test.ts shared/engine/factors.ts shared/config.ts netlify/functions/config-sync.mts netlify/functions/lib/config-sync.test.ts
git commit -m "feat(engine): the crypto cohort — its own tape, its own benchmark, nobody else's buckets"
```

---

### Task 4: `day_gainers` 25 → 50

The spec's one-line discovery deepening: same single call, twice the rows.

**Files:**
- Modify: `netlify/functions/lib/screener.ts:15-39` (`parseScreen` limit param, `fetchScreen` count param)
- Modify: `netlify/functions/lib/engine.ts:194-201` (pass 50 for gainers only)
- Modify: `scripts/replay-window.ts` (`synthScreens` gainers count, so the harness keeps parity with production)
- Test: `netlify/functions/lib/screener.test.ts`, `netlify/functions/lib/engine.screens.test.ts`

**Interfaces:**
- `parseScreen(json: unknown, limit = 25): ScreenRow[]`; `fetchScreen(kind, fetchFn = fetch, count = 25)` — count rides BOTH the URL and the slice, so a server that ignores `count` cannot smuggle extra rows past the parser.

- [ ] **Step 1: Failing tests**

```ts
// netlify/functions/lib/screener.test.ts
it('parseScreen honours an explicit limit and still defaults to 25', () => {
  const json = { finance: { result: [{ quotes: Array.from({ length: 60 }, (_, i) => ({ symbol: `S${i}` })) }] } }
  expect(parseScreen(json)).toHaveLength(25)
  expect(parseScreen(json, 50)).toHaveLength(50)
})
it('fetchScreen asks for the count it will keep', async () => {
  let url = ''
  const fetchFn = (async (u: string) => { url = u; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
  await fetchScreen('day_gainers', fetchFn, 50)
  expect(url).toContain('count=50')
})
```

```ts
// netlify/functions/lib/engine.screens.test.ts — extend the existing case
it('asks for 50 gainers and 25 of everything else', async () => {
  await defaultDeps({}).screens()
  const calls = (fetchScreen as ReturnType<typeof vi.fn>).mock.calls
  expect(calls.find(c => c[0] === 'day_gainers')?.[2]).toBe(50)
  expect(calls.find(c => c[0] === 'day_losers')?.[2] ?? 25).toBe(25)
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement** — in `defaultDeps.screens`:

```ts
// 50 gainers, 25 of the rest: the same single call per screen, but the
// mania names the velocity lane exists for live in rows 26-50 on the day
// they start (spec §4.1). Cheap, and bounded by the 180-candidate cut.
const kinds = [
  ['day_gainers', 'screener:gainers', 50],
  ['day_losers', 'screener:losers', 25],
  ['most_actives', 'screener:actives', 25],
  ['small_cap_gainers', 'screener:smallcap', 25],
] as const
const results = await Promise.all(kinds.map(async ([kind, source, count]) => (await fetchScreen(kind, undefined, count)).map(row => ({ row, source }))))
```

(`fetchScreen`'s second parameter is `fetchFn`; pass `undefined` to keep the default.)

- [ ] **Step 4: Full suite** — `npm test` green (watch any fixture asserting a 25-row gainers screen).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/screener.ts netlify/functions/lib/screener.test.ts netlify/functions/lib/engine.ts netlify/functions/lib/engine.screens.test.ts scripts/replay-window.ts
git commit -m "feat(engine): fifty gainers — the manias start below row 25"
```

---

### Task 5: Lane size caps + the size copy that tells the truth

Before any lane can be wired in, `publishCall` needs a way to say "at most a quarter" — and the UI needs to stop calling everything under full size "half".

**Files:**
- Modify: `netlify/functions/lib/engine.ts:862` (`publishCall` signature + riskPct line 952)
- Modify: `src/components/EngineBoard.tsx:65,110`; `src/components/TodaysCalls.tsx:93`
- Modify: `src/lib/format.ts` — add `sizeLabel(riskPct: number, riskRung: number): string`
- Tests: `netlify/functions/lib/engine.test.ts`, `src/lib/format.test.ts`, `src/components/EngineBoard.test.tsx`

**Interfaces:**
- `publishCall(call, capUsdM, cat, forceShadow = false, sizeCap = 1)` — `riskPct = round(RUNG_RISK_PCT[rung] × min(tierMult, sizeCap), 3)` where `tierMult` is 1 (full), 0.5 (half) or 0 (watch/shadow). **A cap, never a product [D4].**
- `sizeLabel(riskPct, riskRung): '' | 'half size' | 'quarter size'` — derived from the fraction of the rung's full risk, so the label can never disagree with the number beside it (the existing `halfSize` comment's own principle, extended).

- [ ] **Step 1: Failing tests**

```ts
// src/lib/format.test.ts
it('names the size from the fraction of the rung, not from a stored flag', () => {
  expect(sizeLabel(RUNG_RISK_PCT[0], 0)).toBe('')
  expect(sizeLabel(RUNG_RISK_PCT[0] / 2, 0)).toBe('half size')
  expect(sizeLabel(RUNG_RISK_PCT[0] / 4, 0)).toBe('quarter size')
  expect(sizeLabel(0, 0)).toBe('')
})
```

```ts
// netlify/functions/lib/engine.test.ts
it('a lane size cap CAPS the evidence tier and never compounds with it [D4]', async () => {
  // a call published with sizeCap 0.25 that grades C-with-contract (tier 0.5)
  // lands at a QUARTER of the rung, not an eighth; and one that grades A/B on the
  // full contract also lands at a quarter.
})
it('sizeCap 1 leaves every existing row byte-identical', async () => {
  // deep-compare a full board built before/after the parameter exists — the
  // default path must be arithmetically unchanged.
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement**

```ts
// engine.ts — publishCall
const publishCall = (call: EngineCall, capUsdM: number | null, cat: CatalystTag | null, forceShadow = false, sizeCap = 1) => {
  // …unchanged through watchOnly…
  // Sizing in three tiers (ratified 2026-08-11) and, from Stage 1b, a LANE CAP on
  // top. The cap is a MINIMUM, never a multiplier [D4]: the velocity lane's early
  // door is a quarter because most breakouts fail, and a quarter-size call that
  // also happens to grade C-with-contract is still a quarter — multiplying the two
  // would produce an eighth of a rung, which is not a position, it is a rounding
  // error with a stop attached.
  const tierMult = fullTrade ? 1 : halfTrade ? 0.5 : 0
  const sizeMult = Math.min(tierMult, sizeCap)
  // …
  riskPct: shadow || watchOnly ? 0 : Math.round(RUNG_RISK_PCT[rung] * sizeMult * 1000) / 1000,
```

```ts
// src/lib/format.ts
/** What fraction of its rung a row is actually risking, in the reader's words.
 * Derived from the number on the card rather than stored beside it, so the words
 * and the figure can never drift — and it must distinguish a QUARTER (the
 * velocity lane's early door) from a HALF, because a card that calls both "half
 * size" is quietly telling the reader to bet twice what the engine said. */
export function sizeLabel(riskPct: number, riskRung: number): string {
  const full = RUNG_RISK_PCT[riskRung]
  if (!full || riskPct <= 0) return ''
  const frac = riskPct / full
  if (frac >= 0.95) return ''
  if (frac <= 0.3) return 'quarter size'
  return 'half size'
}
```

UI: `EngineBoard.tsx:65` — replace `halfSize` with `const size = sizeLabel(p.riskPct, p.riskRung)` and line 110's ``${halfSize ? ' (half size)' : ''}`` with ``${size ? ` (${size})` : ''}``. Same substitution in `TodaysCalls.tsx:93`. Update the neighbouring comments to say "full, half or quarter".

- [ ] **Step 4: Full suite + `npm run build`** — green.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/engine.ts netlify/functions/lib/engine.test.ts src/lib/format.ts src/lib/format.test.ts src/components/EngineBoard.tsx src/components/TodaysCalls.tsx src/components/EngineBoard.test.tsx
git commit -m "feat(board): lane size caps — a quarter is a quarter, and the card says so"
```

---

### Task 6: Wire the velocity lane and the clusters into `buildBoard`

**Files:**
- Modify: `netlify/functions/lib/engine.ts` — social-history write + cluster phases (~604, ~687, ~696-706), velocity pass (after the dip pass ~749), velocity merge (after the dip merge ~1151), the lane-long demotion set (~1283), `EmptySideReason`
- Modify: `shared/engine/types.ts` — `EmptySideReason` gains `'velocity-lane'`
- Modify: `src/lib/format.ts:43` — `emptySideLine` copy for the new reason
- Test: `netlify/functions/lib/engine.test.ts`

**Interfaces:**
- New blob `social-history`: `SocialDay[]`, last `CLUSTER_DAYS` entries, written from `social.map(s => s.sym)` (≤15/day, bounded by `combineSocialPulse`). Fail-soft both ways: a read failure = no clusters, a write failure = the board still publishes.
- New blob `hype-clusters`: `{ date, clusters: HypeCluster[] }` — narration and the next morning's diagnostics; nothing reads it back into a gate.
- `candidatePriority` renumbered: holding 0, watchlist 1, roster 2, catalyst 3, sleeve 4, **cluster 5**, channel 6, theme/rotation 7, social 8, else 9.
- Velocity eligibility [D5]: `avgDollarVol20(candles) >= VELOCITY_MIN_DOLLAR_VOL` (20_000_000), NOT in `dipReads` [D6], candles present.

- [ ] **Step 1: Failing tests** (written concretely in the file's existing stub-all-deps harness style):

```ts
it('a breakout on 3x volume publishes a QUARTER-size velocity long tagged as such', async () => {
  // AAOI-shaped tape via deps.candles + a gainers screen row; assert the published row has
  // setup 'velocity', catalyst.kind 'velocity', side 'long', riskPct === RUNG_RISK_PCT[rung]/4.
})
it('the confirmation door publishes at HALF size and stops at the trail', async () => {
  // run + pause tape; assert riskPct === RUNG_RISK_PCT[rung]/2 and stop === velocityTrailStop(candles).
})
it('an illiquid micro-cap breakout is never a velocity call [D5]', async () => {
  // identical tape, volume × price under $20M/day → no velocity row at all.
})
it('the dip lane wins a name both lanes read [D6]', async () => {
  // a tape that triggers a holding dip AND a 5-day run; assert exactly one long row, setup 'reversal'.
})
it('the velocity lane never opens a second long on a name that already has one', async () => {
  // a composite long + an open velocity door → one row.
})
it('a sized velocity long demotes a live composite SHORT on the same name, and the empty-side copy says velocity', async () => {
  // assert the short row is shadow:true and emptySides.short === 'velocity-lane' when that was the only short.
})
it('at most VELOCITY_MAX_CALLS velocity rows publish, highest composite first [D15]', async () => {
  // 9 breakout tapes → 6 rows, and they are the 6 largest composites.
})
it('cluster members are elevated into the evaluation budget before the 180-cut [D14]', async () => {
  // 200 candidates, three co-mentioned names ranked last by every other door;
  // assert deps.candles was asked for all three.
})
it('a confirmed cluster is recorded and named in its members\' velocity reasons', async () => {
  // assert the hype-clusters blob and that a velocity row's catalyst.reason contains 'hype cluster'.
})
it('a social-history read failure leaves the board deep-equal to a cluster-less run', async () => {
  // store.read('social-history') throws → deep-compare against a run with no history at all.
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement, in this order:**

(a) **Social history + phase-one clusters**, right after the `social` fetch resolves (~line 604), BEFORE `addSource` runs for the other doors:

```ts
// The rolling week the cluster detector reads. Written from the social pulse the
// engine already fetches — no new source, no new call. Fail-soft in both
// directions: a read fault means no clusters today, a write fault means
// tomorrow's window is one day shorter. Neither may touch the board.
let socialHistory: SocialDay[] = []
try {
  const prior = ((await store.read<SocialDay[]>('social-history')) ?? []).filter(d => d.date !== today)
  socialHistory = [...prior, { date: today, syms: social.map(s => s.sym.toUpperCase()) }].slice(-CLUSTER_DAYS)
  await store.write('social-history', socialHistory)
} catch {
  socialHistory = []
}
// PHASE ONE [D14]: who is being talked about together. Price-free, so it can run
// here — before the candidate cut — and put a forming mania's members inside the
// evaluation budget on the morning it forms. This is elevation, not a verdict.
const clusterSet = new Set(coMentionGroups(socialHistory).flat())
```

…and the door itself, added just BEFORE the sleeve door (~686) so `addSource`'s first-source rule leaves every earlier attribution intact:

```ts
for (const sym of clusterSet) addSource(sym, 'cluster')
```

…with `candidatePriority` gaining `if (clusterSet.has(sym)) return 5` after the sleeve line and the rest renumbered.

(b) **The velocity pass**, immediately after the dip pass (~749), so `dipReads` already exists:

```ts
// Velocity lane: a name going vertical. Read AFTER the dip pass because the dip
// lane owns any name both lanes can see [D6] — it is the older lane, it has a
// news read behind it, and two longs on one chart is not a board.
// Eligibility is LIQUIDITY, not theme and not cluster membership [D5]: the whole
// point of this lane is that it does not know what the mania is about.
const velocityReads = new Map<string, VelocityRead>()
for (const sym of candidateSyms) {
  const candles = candleMap.get(sym)
  if (!candles || dipReads.has(sym)) continue
  if ((avgDollarVol20(candles) ?? 0) < VELOCITY_MIN_DOLLAR_VOL) continue
  const read = classifyVelocity(candles)
  if (read?.door) velocityReads.set(sym, read)
}
```

(c) **Phase-two clusters**, after `candleMap` and `spyCloses` exist (beside the velocity pass):

```ts
// PHASE TWO: co-mention CONFIRMED by abnormal co-movement — the definition the
// spec actually gives. Recorded for narration and diagnostics; it gates nothing.
const closesForCluster = new Map([...candleMap].filter(([s]) => clusterSet.has(s)).map(([s, cs]) => [s, cs.map(c => c.c)]))
const clusters = detectHypeClusters(socialHistory, closesForCluster, spyCloses)
const clusterOf = new Map<string, HypeCluster>()
for (const c of clusters) for (const m of c.members) clusterOf.set(m, c)
if (clusters.length) console.log('BOARD: hype clusters —', clusters.map(c => c.members.join('+')).join(' · '))
await store.write('hype-clusters', { date: today, clusters }).catch(() => {})
```

(d) **The velocity merge**, after the dip merge's `publishCall` loop (~1151):

```ts
// ---- the velocity lane's own calls, merged into the same board ----
// After the dip merge on purpose: a name that already has a long — ordinary or
// dip — keeps it, one row per name per side, exactly as the dip lane does.
// Everything downstream (calibration, grade, shadow rules, routing) is the SAME
// publishCall path; the only thing this lane adds is a size CAP [D4].
const longSyms = new Set(board.filter(b => b.side === 'long').map(b => b.sym.toUpperCase()))
const velocityCalls: { sym: string; read: VelocityRead; call: EngineCall; capUsdM: number | null }[] = []
for (const [sym, read] of velocityReads) {
  if (longSyms.has(sym.toUpperCase())) continue
  const candles = candleMap.get(sym)
  if (!candles) continue
  const capUsdM = sources.get(sym)?.capUsdM ?? null
  const raw = velocityCall(sym, candles, read, capUsdM)
  if (!raw) continue
  velocityCalls.push({ sym, read, call: { ...raw, earningsRisk: earningsSet.has(baseSym(sym)) }, capUsdM })
}
const constructedVelocityLongs = new Set<string>()
for (const { sym, read, call, capUsdM } of velocityCalls
  .sort((a, b) => Math.abs(b.call.composite) - Math.abs(a.call.composite))
  .slice(0, VELOCITY_MAX_CALLS)) {
  const cluster = clusterOf.get(sym.toUpperCase())
  const reason = cluster ? `${read.detail} · ${cluster.detail}` : read.detail
  publishCall(call, capUsdM, { kind: VELOCITY_CATALYST_KIND, side: 'long', reason, strength: 40 }, false, velocitySizeMult(read.door!))
  constructedVelocityLongs.add(sym.toUpperCase())
}
```

(e) **The lane-over-short demotion** (~1283) generalises from dip to lane. The block's logic is unchanged; only the membership test and the recorded reason widen:

```ts
const sizedLaneLongs = new Map<string, EmptySideReason>() // sym → which lane took the row
for (const b of board) {
  if (b.side !== 'long' || b.shadow || b.watchOnly) continue
  const sym = b.sym.toUpperCase()
  if (constructedDipLongs.has(sym)) sizedLaneLongs.set(sym, 'dip-lane')
  else if (constructedVelocityLongs.has(sym)) sizedLaneLongs.set(sym, 'velocity-lane')
}
```
…the demotion loop keys off `sizedLaneLongs.has(sym)`, records `laneDemotedShorts.set(row.id, sizedLaneLongs.get(sym)!)`, and the empty-side branch (~1420) reads that map instead of the boolean set. The structural-news release stays keyed to the dip lane alone — the velocity lane has no news read and nothing to be released by.

(f) `EmptySideReason` gains `'velocity-lane'` with a comment matching the existing three, and `emptySideLine` gains:
```ts
if (reason === 'velocity-lane') return `Nothing tradeable on the ${side} side today — a velocity long outranked the shorts we had.`
```

(g) Constants, exported from `velocityLane.ts` so the lane owns its own numbers: `VELOCITY_MIN_DOLLAR_VOL = 20_000_000`, `VELOCITY_MAX_CALLS = 6`.

- [ ] **Step 4: Full suite + `npm run build`** — green.

- [ ] **Step 5: Dry-run** — `npx tsx scripts/engine-dry-run.ts`: velocity rows appear or don't, no crash, runtime within a few seconds of yesterday's.

- [ ] **Step 6: Commit**

```bash
git add -A shared netlify/functions/lib src/lib
git commit -m "feat(engine): the velocity doors reach the board, clusters buy their members a look"
```

---

### Task 7: Wire the crypto lane into `buildBoard` and `gradeOutstanding`

Three names, evaluated like the sleeve, judged on their own tape, routed or shadowed honestly.

**Files:**
- Modify: `netlify/functions/lib/engine.ts` — crypto door + `cryptoActive` (~560-570), breadth exclusion (757), cap-budget exclusion (728), earnings guard (1015), momentum benchmark (989), regime override + route + alt agreement in `publishCall` (862-961), roster exclusion (779), evalRows append (836), per-side cap + correlation exclusion (1201-1240), grading benchmark (367-405)
- Modify: `shared/engine/types.ts` — `Prediction.route?: { ticker: string; kind: 'tracker' }` [D13]
- Modify: `src/components/EngineBoard.tsx`, `src/components/TodaysCalls.tsx` — print the route
- Test: `netlify/functions/lib/engine.test.ts`

**Interfaces:**
- No new `EngineDeps` member: `deps.candles('BTC-USD')` already routes through `cachedCandles` → `fetchYahooChart` (`isYahooSymbol` is true for dashed symbols). `cryptoActive = btcCandles != null && cryptoTape !== 'unknown'` gates every crypto behaviour.
- `publishCall` gains no further parameters: it reads `isCryptoSym(call.sym)` for the regime override, the route and the size cap, keeping one publication path.

- [ ] **Step 1: Failing tests**

```ts
it('BTC/ETH/SOL are evaluated every day without joining the roster', async () => {
  // assert deps.candles was asked for all three and the written engine-roster contains none of them.
})
it('a crypto call is graded in the crypto cohort under the BTC tape, not the equity regime', async () => {
  // equity regime red, BTC tape green → the published row's regime is 'green' and the
  // bucket written on grading is 'crypto:long:green:<band>'.
})
it('an ETH long in an amber BTC tape publishes as a SHADOW [D10]', async () => {
  // …and still enters the ledger, so the cohort learns from the veto.
})
it('BTC prints its ISA tracker; SOL prints no route and runs as a labelled shadow', async () => {
  // assert row.route.ticker === 'BITP.L' for BTC and that the SOL row is shadow with
  // 'no ISA route' in its note.
})
it('a crypto row is half size at most [D4]', async () => {
  // even graded A on a full contract: riskPct === RUNG_RISK_PCT[rung]/2.
})
it('crypto never pollutes the equity regime read', async () => {
  // three crypto names above their 50-SMA on a day the equities are not → breadth
  // (and therefore the refined regime) is identical to a crypto-less run.
})
it('at most one crypto row per side [D11]', async () => {
  // BTC+ETH+SOL all actionable long → one trade row, the others demoted to watch.
})
it('an earnings row for the ticker BTC can never shadow a bitcoin call', async () => {
  // earningsSyms returns {'BTC'} → the BTC-USD row is NOT earnings-shadowed.
})
it('an alt is graded against BTC and BTC absolutely', async () => {
  // ETH +8% vs BTC +3% → excessPct 5; BTC +1.5% with no benchmark → hit true.
})
it('WEEKEND: a Saturday edition traces an open crypto call against Saturday\'s bar', async () => {
  // nowSec on a Saturday, an open BTC call from Thursday, crypto candles carrying
  // Fri+Sat bars → traceOpenIdeas returns an entry whose last close is Saturday's.
})
it('BTC candles missing leaves the board deep-equal to a crypto-less run', async () => {
  // deps.candles('BTC-USD') → null → cryptoActive false → deep-compare.
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement**

(a) **The tape and the door**, beside the sleeve block (~560):

```ts
// The crypto majors: three names evaluated every day, sleeve-style — permanent
// candidates that never join the roster. Their tape is BTC's own 50/200
// structure, read independently of the equity regime (crypto.ts): the S&P being
// green says nothing about bitcoin, and pooling the two words into one bucket
// key would be two markets wearing one label.
// cryptoActive gates EVERY crypto behaviour below, so a Yahoo hiccup on BTC runs
// exactly like a crypto-less engine.
const btcCandles = await deps.candles(CRYPTO_BENCHMARK).catch(() => null)
const cryptoTape = cryptoRegime(btcCandles)
const cryptoActive = cryptoTape !== 'unknown'
const cryptoSet = new Set(cryptoActive ? (CRYPTO_UNIVERSE as readonly string[]) : [])
const cryptoRoutes = cryptoRoutesWithDefaults(cfg.cryptoMap)
const btcCloses = btcCandles?.map(c => c.c) ?? []
for (const sym of cryptoSet) addSource(sym, 'crypto')
```
…placed with the sleeve door (before it, so a crypto symbol can never be stamped 'sleeve'), `candidatePriority` gains `if (cryptoSet.has(sym)) return 4` alongside the sleeve (same tier: both are standing universes).

(b) **Four exclusions, each one a bug if it is missed:**

```ts
// 1. cap budget (728): a Finnhub profile2 on BTC-USD returns nothing and would
//    burn one of fifteen slots a discovery name needs.
const noCapAll = candidateSyms.filter(s => sources.get(s)!.capUsdM == null && candleMap.has(s) && !isCryptoSym(s))
// 2. breadth (757): crypto prints 7 bars a week and is not the equity market's
//    breadth. Feeding it in would move the refined REGIME — the calibration
//    bucket key for every equity call on the board.
const breadth = breadthAbove50([...candleMap].filter(([s]) => !isCryptoSym(s)).map(([, cs]) => cs.map(c => c.c)))
// 3. roster (779): permanent candidates, never members — same rule as the sleeve.
const rosterCandidates = candidates.filter(c => !isCryptoSym(c.sym) && !(sleeveSet.has(c.sym) && sources.get(c.sym)?.source === 'sleeve'))
// 4. evalRows (836): appended like sleeve names so they are scored every day.
...candidateSyms.filter(sym => cryptoSet.has(sym) && candleMap.has(sym)).map(sym => ({ sym, capUsdM: null })),
```

(c) **Factors and gates in the compose loop** (~987-1024):

```ts
// An ALT's relative strength is measured against BTC, not SPY [D12]: "SOL +6%
// while BTC +9%" is a losing trade wearing a green number, and SPY's five-day
// week cannot be index-aligned with a seven-day one anyway.
momentum: isCryptoAlt(entry.sym)
  ? momentumFactor(closes, btcCloses, 'BTC')
  : momentumFactor(closes, spyCloses),
// …and in composeInput:
// 'BTC' is a plausible equity ticker; matching a crypto symbol against the
// earnings calendar by base ticker would shadow every bitcoin call the engine
// ever made, forever, for a print that has nothing to do with it.
earningsWithinHorizon: !isCryptoSym(entry.sym) && earningsSet.has(baseSym(entry.sym)),
```

(d) **`publishCall`** — three additions, no new branches in the flow:

```ts
// The bucket key's regime comes from the tape the call actually ran on.
const rowRegime = isCryptoSym(call.sym) && cryptoActive ? cryptoTape : regime
const cohort = learnCohortOf(call.sym, capUsdM)
const { p, provisional } = probabilityFor(calibration, call.side, rowRegime, Math.abs(call.composite), cohort)
// …
// An ISA cannot hold a coin. A crypto call is placeable only through a 1x
// tracker, so an unrouted major (SOL today) is exactly as untakeable as an
// unroutable short — and gets the same treatment: a SHADOW that still grades,
// labelled, rather than a row pretending to be a trade. Note this generalises
// the existing shorts-only test: a LONG can now be unroutable too.
const trackerTicker = isCryptoSym(call.sym) ? cryptoRouteFor(call.sym, cryptoRoutes) : null
const unroutableCrypto = isCryptoSym(call.sym) && !trackerTicker
const unshortable = call.side === 'short' && !(shortRoute?.short2x || shortRoute?.short3x)
// …fold unroutableCrypto into `belowBase`'s negation and into `shadow`, beside unshortable…
// [D10] an alt whose tape disagrees with its side publishes, as a shadow, so the
// cohort still learns what disagreeing with BTC costs.
const altBlocked = isCryptoAlt(call.sym) && cryptoActive && !btcAgreesWith(call.side, cryptoTape)
// …and the size cap: crypto is half at most until its buckets prove out.
const laneCap = Math.min(sizeCap, isCryptoSym(call.sym) ? CRYPTO_SIZE_MULT : 1)
// …on the pushed row:
regime: rowRegime,
route: trackerTicker ? { ticker: trackerTicker, kind: 'tracker' as const } : undefined,
```
`altBlocked` and `unroutableCrypto` join the `shadow` disjunction; the note for an unrouted major gains ` · no ISA route — observation only`, matching the wording the observation promotion already uses.

(e) **One crypto row per side [D11]**, applied to the actionable pools before each `pickDiverseSide`, reusing `demoteToWatch` so the surplus rows fall THROUGH to watch rather than off the board:

```ts
/** BTC, ETH and SOL are one bet. The correlation gate cannot say so — see the
 * closesOf exclusion below — so the cap is explicit. */
const capCryptoSide = (pool: Prediction[]) => {
  const crypto = pool.filter(b => isCryptoSym(b.sym)).sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))
  const surplus = crypto.slice(1)
  demoteToWatch(surplus, new Set())
  return pool.filter(b => !surplus.some(s => s.id === b.id))
}
```
…and in `pickDiverseSide`'s closure: `sym => (isCryptoSym(sym) ? 'crypto' : symToSector.get(baseSym(sym)) ?? primaryThemeOf(sym))` for the group, with `sym => (isCryptoSym(sym) ? null : candleMap.get(sym)?.map(c => c.c) ?? null)` for the closes — correlating a 7-bar week against a 5-bar week index-wise is arithmetic with no meaning, and "no data never blocks" is the gate's documented behaviour.

(f) **Grading** (`gradeOutstanding`, ~362-405):

```ts
// The yardstick a crypto call is actually judged by (crypto.ts): an alt against
// BTC, BTC against nothing. Equities are untouched — they keep SPY, the same
// hit definition and the same buckets they have always had.
const benchFor = async (sym: string): Promise<Candle[] | null | 'skip'> => {
  if (!isCryptoSym(sym)) return spy
  if (!isCryptoAlt(sym)) return null // absolute, +1pp — HIT_EXCESS_MIN unchanged
  const btc = await getCandles(CRYPTO_BENCHMARK)
  return btc ?? 'skip' // no benchmark, no verdict: an alt is never graded absolutely by accident
}
```
…used for all three horizons on that prediction; `'skip'` leaves the row pending. `updateCalibration(calibration, pred, o)` already receives the whole `pred`, so `learnCohortOf` picks up the symbol with no call-site change. `newByCohort` / `allOutcomes` keep `capCohortOf(pred.capUsdM)` — crypto counts in the COMBINED stream and neither cap sleeve [D9].

(g) **UI**: `Prediction.route` printed beside the instrument line — `route ? ` · via ${route.ticker}` : ''` — in both `EngineBoard.tsx` and `TodaysCalls.tsx`.

- [ ] **Step 4: Full suite + `npm run build`** — green.

- [ ] **Step 5: Live routability check (manual, required by the spec).** With the owner's T212 catalogue: confirm `BITP.L` and `ETHC.L` are ISA-eligible and currently tradeable, and search for a SOL tracker. Record the result in the Task 8 results doc. If a ticker is dead, correct `DEFAULT_CRYPTO_ROUTES` — do NOT leave a route the reader cannot place.

- [ ] **Step 6: Commit**

```bash
git add -A shared netlify/functions/lib src
git commit -m "feat(engine): BTC, ETH and SOL — their own tape, their own cohort, their own route"
```

---

### Task 8: The ship gate — velocity honesty check + window re-run

**The lane does not ship if the entries land at the tops.** This is the spec's §5 criterion 6, and it is a stop, not a report.

**Files:**
- Modify: `scripts/replay-window.ts` — a `--velocity-check` mode
- Test: `scripts/replay-window.test.ts` — the new pure helpers
- Create: `docs/superpowers/plans/2026-08-12-stage1b-replay-results.md`

**Design:**
- **Probe names**, in three groups matching the spec: `AAOI`; the space cluster `RKLB, ASTS, LUNR`; the 2025 quantum names `IONQ, RGTI, QBTS` (an out-of-window probe — the whole point is that the lane was not built on them).
- **The run window is DERIVED FROM THE CANDLES, never hard-coded.** `biggestRun(candles, window = 60)` returns `{ startIdx, peakIdx, gainPct }` — the largest close-to-close gain over any `window`-session span in the last two years, with `startIdx` walked back to the swing low that began it. Inventing dates would be inventing the very thing the test is supposed to measure.
- **Simulation.** Walk each probe's candles bar by bar; at each bar `i`, call `classifyVelocity(candles.slice(0, i + 1))`; when a door opens and no position is open, enter at that bar's close with `velocityCall`'s stop; then walk forward exiting at the first close below `velocityTrailStop(candles.slice(0, j + 1))` (recomputed daily — this is the trail the lane promises [D7]), or at the published stop, whichever triggers first.
- **Acceptance criteria** (all reported, pass or fail):
  1. **Sees them at all.** ≥1 door fires inside the derived run for every probe GROUP (AAOI, space, quantum). A lane that cannot see the manias it exists for is not shipping.
  2. **Entries are not tops.** For every entry inside a run: `position = (entryIdx − startIdx) / (peakIdx − startIdx)`. Require **median position ≤ 0.6** and **≤ 1/3 of entries above 0.8**.
  3. **The trail pays.** ≥ 60% of in-run entries exit green, and the median trade return across all probe entries is > 0.
  4. **The refusals are real.** Report every bar where a door was CLOSED by the green-streak rule together with what the next five sessions did — the honest cost of the entry-timing rule, and the number that tells the owner whether the rule is too tight.
- **Plus the Stage 1 window, re-run** (`--from 2026-07-14 --to 2026-08-11`) against Stage 1's own five criteria, to prove 1b did not regress the board it inherited: blank boards still 0, grade distribution, win5/avg5, and the new rows' share of the board.

- [ ] **Step 1: Implement the pure helpers with tests first** — `biggestRun`, `simulateVelocity(candles, fromIdx, toIdx)` returning `{ entries: { idx: number; date: string; door: string; entry: number; exitIdx: number; exit: number; retPct: number; position: number }[] }`. These are unit-tested in `scripts/replay-window.test.ts` against synthetic ramps (a clean 40% run: entry position < 0.5, exit green; a sawtooth: no entries survive).

- [ ] **Step 2: Wire `--velocity-check`** — warms the probe symbols into the same disk cache, runs the simulation, prints a per-name table and the four criteria.

- [ ] **Step 3: Run it.** `npx vite-node scripts/replay-window.ts -- --velocity-check --out .replay-cache/velocity.json`

- [ ] **Step 4: Run the window replay** on the new tree; compare against the Stage 1 results doc's numbers (the baseline there is `730521d`; the comparison here is Stage 1 `69ced4c` → Stage 1b HEAD, and the Stage 1 tree can be re-run from a worktree if the numbers need regenerating on identical bars — use `REPLAY_CACHE_DIR` so both runs read the SAME candles).

- [ ] **Step 5: Write `docs/superpowers/plans/2026-08-12-stage1b-replay-results.md`** in the Stage 1 results doc's format: how the replay works, what is approximated, each criterion with its number, and a one-line verdict. Where a criterion fails, write it up as a failure and STOP — no threshold tuning. Include the T212 routability check from Task 7 Step 5.

- [ ] **Step 6: Commit. No push.**

```bash
git add scripts/replay-window.ts scripts/replay-window.test.ts docs/superpowers/plans/2026-08-12-stage1b-replay-results.md
git commit -m "test(replay): the velocity honesty check — entries inside the run, or the lane does not ship"
```

---

## Self-Review Notes

### Spec coverage map

| Spec clause (§4.1 velocity / crypto, §4.3c, §5) | Where it lands |
| --- | --- |
| Early door: 20-session-high break, RVOL ≥ 3× | Task 1 — `classifyVelocity`, `BREAKOUT_WINDOW`/`EARLY_RVOL`, window excludes today |
| Early door: quarter size, stop under the breakout level | Task 1 (`velocitySizeMult`, `structural = priorHigh`) + Task 5 (the cap mechanism) |
| Confirmation door: +15%/5 sessions **or** 3-of-5 up days on ≥2× volume | Task 1 — `RUN_GAIN_PCT` / `RUN_UP_DAYS` / `CONF_RVOL`, turn-scoped [D3] |
| Never buy the Nth green day; enter on the pause holding the 8-EMA or the reclaim | Task 1 — `timingOk` = (paused ∨ reclaimed) ∧ `greenStreak ≤ 2`, applied to both doors [D2] |
| Confirmation door: half size | Task 1 + Task 5 |
| Tight trailing falsifier: first close below the 8-EMA or the 5-session low, whichever is nearer | Task 1 — `velocityTrailStop` = max(8-EMA, 5-session low); entry stop for the confirmation door, simulated daily in Task 8; live re-stopping deferred [D7] |
| Setup family `velocity`, per-setup calibration accrual | Task 1 — `SetupFamily` widened; `updateCalibration` books `velocity:${side}:${band}` with no further change (consumption stays Stage 3) |
| Labelled momentum-not-quality | Task 1 — `evidence.detail`; Task 6 — `catalyst.kind 'velocity'` |
| `day_gainers` 25 → 50, same single call | Task 4 |
| Cluster detection: social co-mention **and** abnormal return co-movement, ≥3 names, rolling week | Task 2 — `coMentionGroups` / `detectHypeClusters`; Task 6 — the `social-history` blob that makes "rolling week" exist at all |
| Theme tags only a hint; the static list earns no special trust | Nothing in either new module reads `themes.ts`. The theme door keeps its existing, unchanged candidate role |
| Cluster members get elevated candidate priority | Task 6 — priority tier 5, phase one [D14] |
| Crypto universe BTC/ETH/SOL only | Task 3 — `CRYPTO_UNIVERSE`; alts explicitly out of scope |
| Evaluated daily sleeve-style | Task 7 — permanent candidates, `evalRows` append, never rostered |
| BTC-native regime from BTC's own 50/200; alts require BTC agreement | Task 3 `cryptoRegime` / `btcAgreesWith` [D10]; Task 7 wiring |
| Own cohort, alts vs BTC, BTC absolute +1pp, additive, `CALIB_DEF_VERSION` untouched | Task 3 — `LearnCohort`, `learnCohortOf` [D8], nullable benchmark; the version constant is pinned by a test |
| Routing like levMap, to BITP.L / ETHC.L, unroutable → labelled shadow | Task 3 `DEFAULT_CRYPTO_ROUTES` + `cryptoRoutesWithDefaults`; Task 7 `route` field [D13] and the generalised unroutable-long shadow; live catalogue check in Task 7 Step 5 |
| Half size initially | Task 3 `CRYPTO_SIZE_MULT`, applied as a cap in Task 7 |
| Weekend falsifier checks on every edition | Task 7 — satisfied by construction (daily cron, symbol-agnostic `traceOpenIdeas`) and PINNED by a Saturday test rather than new machinery |
| §5 velocity honesty check over AAOI + space + 2025 quantum | Task 8, as a hard ship gate |
| Reuse existing lane mechanics, no bespoke crypto indicators | Crypto adds no signal code: it rides `composeCall`, `dipLane` and `velocityLane` unchanged |

### Judgment calls the controller should look at hardest

1. **The 10-session horizon means 10 calendar days for crypto and ~14 for equities.** Crypto prints seven bars a week. I did NOT change the hit definition or bump `CALIB_DEF_VERSION` — the cohort is separate precisely so the two clocks never share a bucket — but the crypto cohort's probabilities are answering a slightly different question from the equity cohort's, and it is worth saying out loud rather than discovering later. The alternative (grading crypto on 14 bars) would have made "10 sessions" mean two different bar counts in one function, which is worse.
2. **`PredOutcome.spyPct` is 0 for a BTC call.** The field name becomes a small lie for the crypto cohort. I kept the schema rather than adding a benchmark field to every stored outcome; the caller logs which benchmark it used. If the controller prefers honesty over schema stability here, the change is a one-line rename with a migration on every stored outcome — my judgment is that it is not worth it.
3. **[D1] early-over-confirmation precedence.** I chose "when both doors read true, take the smaller size". The opposite (confirmation wins, half size) is defensible — more evidence, bigger bet — but it means the most extended bars get the biggest positions, which is the failure mode this lane is most likely to have.
4. **[D5] liquidity, not cluster membership, as the velocity gate.** This is the decision most likely to be argued with: it means the lane can fire on a liquid name in no cluster at all. I think that is right — the spec's own principle is that the theme is unknowable in advance, and a cluster gate is a theme model with extra steps — but it does make the lane wider than a strict reading of the spec's "discovery" bullet.
5. **[D10] amber blocks alts entirely.** A stricter reading than "require BTC-regime agreement" strictly needs; it means ETH and SOL will be silent for long stretches. Given the cohort starts with zero buckets and half size, I would rather it be silent than noisy.
6. **The velocity lane inherits the dip lane's nominal evidence placeholders** (`coverage: 1, famAgree: 2, contract: true`). Consistent with the shipped lane, and the code says NOMINAL in capitals — but it does mean a velocity call always passes the evidence contract, so its size is decided by grade alone. If Stage 2 makes the contract mean more, both lanes need revisiting together.
7. **`social-history` is a new blob written from data we already fetch**, and it is the only way the spec's "rolling week" can exist — `combineSocialPulse` returns today's top 15 and nothing is persisted anywhere today. It takes ~7 days from deploy before cluster detection can find anything, which is worth knowing before judging the first week's output.
8. **Cluster detection uses SPY as the abnormality benchmark for every member**, including any crypto name that ever appeared in the social pulse. Given clusters are elevation-only and cite nothing else, I judged a per-member benchmark unnecessary here; it would matter if a cluster ever gated anything.

### Things in the current code that make part of the spec awkward (found while reading, all handled above)

- `cohortRungOf` would **throw** the moment the cohort type widened (`state.cohorts['crypto'].rung`). Fixed in Task 3 rather than by giving crypto a ladder it has nothing to decide with.
- The factor-IC guard is keyed to ONE literal (`DIP_CATALYST_KIND`), and the velocity lane carries the same constant technical placeholder — the exact trap the existing comment warns about. Turned into a set in Task 1.
- `capCohortOf(pred.capUsdM)` drives calibration AND the risk ladder; crypto has no cap anywhere, so it would silently pool into `unknown`. Hence the symbol-derived cohort [D8].
- `earningsSet.has(baseSym('BTC-USD'))` tests the string `'BTC'` — one colliding ticker in the Finnhub calendar would shadow every bitcoin call the engine ever made.
- `breadthAbove50` is fed from every candle in `candleMap`, and breadth feeds `refineRegime`, which is the **bucket key** for every equity call — three crypto series would have quietly moved the equity regime.
- `pickDiverse`'s correlation gate would have compared 7-bar crypto weeks against 5-bar equity weeks index-wise: numbers with no meaning, silently skipping real rows.
- `publishCall`'s route test is shorts-only (`unshortable`); an unroutable crypto LONG has no equivalent, so the concept had to be generalised.
- `instrument` means leverage and is gated by `leverageAllowed`; a 1× ISA tracker cannot borrow it without unlocking things it must not unlock — hence `Prediction.route` [D13].
- The UI derives "(half size)" from `riskPct < full`, so the first quarter-size row would have printed "half size" — a card telling the reader to bet twice what the engine said (Task 5).
- There is **no social history of any kind** in the repo; the spec's "rolling week" co-mention could not be computed at all until Task 6 writes one.
- `momentumFactor`'s detail string hard-codes "vs SPY", so benchmarking an alt against BTC would have printed a false evidence line.
