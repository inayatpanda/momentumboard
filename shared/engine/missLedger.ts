import type { Candle } from '../types'
import { isCryptoSymbol } from '../symbols'
import type { FunnelTrace } from './funnelTrace'
import { round1, type GateCode } from './types'

// EVERY GATE NOW PAYS FOR WHAT IT BLOCKED.
//
// Stage 3a gave the funnel a record: one row per (name, side) per day, naming
// the gate that ended its run. A record of refusals is only half an answer,
// though — "the dead zone turned down 40 names" says nothing until you know what
// those 40 names went on to do. This module is the other half: ten sessions
// later it walks that day's refusals, measures what each one did against SPY,
// and charges the outcome to the gate that refused it.
//
// The arithmetic is an OBSERVATION and nothing else. Nothing here is read by the
// board, the ledger, the paper or the calibration; the whole module could be
// deleted tomorrow and not one published decision would move. Stage 3c is what
// eventually consumes `cost` vs `saved` to move a gate one notch — and it needs
// this population measured for weeks before it may.
//
// THREE THINGS ARE DELIBERATELY DIFFERENT FROM GRADING, and all three are the
// spec's (§4.3), not shortcuts:
//
//  1. THE BAR IS ±5pp, not the hit bar's +1pp (HIT_EXCESS_MIN, calibration.ts).
//     A hit asks "was this call right?", where a whisker of edge over the tape is
//     a real answer. A MISS asks "should we have been in this at all?" — and a
//     name that beat SPY by 2pp over a fortnight is not an opportunity the engine
//     owes anyone an apology for. Five points is a move a reader would have
//     noticed. The two numbers must never be unified.
//
//  2. THE EXCESS IS STOPLESS. A miss has no stop, because it was never a call and
//     no stop was ever published for it, so there is no level to walk. What this
//     module measures is therefore an UPPER BOUND on the move that was available:
//     a real position in the same name might well have been stopped out of it
//     halfway. That is stated here rather than hidden because a cost number that
//     silently flatters itself is worse than no cost number. (The one thing NOT
//     done about it: calling gradePrediction with an invented stop, which would
//     make up a falsifier the engine never published.)
//
//  3. BOTH SIDES ARE ALWAYS COUNTED. A refusal on the long side is scored long; a
//     refusal on the short side is scored short; and a BARE row — a name trimmed
//     before the composite ever gave it a direction — is scored BOTH ways, since
//     the gate that dropped it denied the reader whichever side turned out to be
//     the right one. A bare row that ran +8pp is therefore a long the engine cost
//     itself AND a short it saved itself, both true at once.
//
// HONEST UNDER-COUNT, on the record: `saved` only ever sees names the trace
// recorded. A gate's saves among names that were never candidates at all are
// invisible to this ledger and always will be — the universe of names nobody
// looked at is unbounded, and counting it would mean inventing a population.
// Read `saved` as "of the names we did consider, how many did this gate keep us
// out of", never as the gate's total defensive value.

/** The CALIBRATED horizon — the same ten sessions `gradePrediction` grades a real
 * call at, so a miss and a hit are measured over the same window or the
 * comparison means nothing. */
export const MISS_HORIZON = 10
/** ±5pp (spec §4.3). See the header: deliberately five times the hit bar. */
export const MISS_EXCESS_MIN = 5
/** Names still in the grading run's candle cache cost nothing. Everything else is
 * one `cachedCandles` call, and a trace day can hold ~180 rows — which under the
 * 25-minute Actions cap is the whole sizing question for this feature. Forty
 * fetches is the ceiling; the population it could not reach is COUNTED as
 * `unchecked` in the day entry, because a truncation nobody can see is exactly
 * the silence Stage 3 exists to end. */
export const MISS_FETCH_BUDGET = 40
/** Per gate, newest winning. The COUNTS are the accounting; examples are for a
 * human asking "like what?" and have no business growing without bound. */
export const MISS_EXAMPLES_PER_GATE = 10
/** ~3 months of session days. */
export const MISS_LEDGER_DAYS_MAX = 60
export const MISS_LEDGER_KEY = 'miss-ledger'

/** THE PARITY SEAM (Stage 3b Task 4), mirroring `FUNNEL_TRACE=off`
 * (funnelTrace.ts) down to the guard on `process`.
 *
 * ONE switch for BOTH of Stage 3b's mechanisms — this ledger and the post-mortem
 * — because they are one feature: the engine measuring its own regret. With
 * `REGRET=off` in the environment the engine behaves exactly as the pre-3b tree
 * did: no `miss-ledger` blob, no `postMortem` field on a graded loser, no
 * sentence ask. Nothing in production ever sets it and no code path reads the
 * answer for a decision; it exists so the window walk can run itself twice and
 * byte-compare every published row with the machinery on and off. A parity claim
 * proved by a copy of the pipeline proves something about the copy.
 *
 * Opt-in and read per call rather than cached at import: a run that sets it
 * after the module loaded must still be honoured, and nothing here is hot. */
export function regretDisabled(): boolean {
  return typeof process !== 'undefined' && process.env?.REGRET === 'off'
}

/** THE ADJUDICATION — which trace rows are even miss candidates.
 *
 * The question a miss asks is "did a gate deny the reader a move they could
 * otherwise have taken?", and that splits the published rows in two rather than
 * the one way the codes suggest:
 *
 *  - `called-full` / `called-half` — SIZED. The reader got the row and got a
 *    size. Whatever it did next is the ledger's business, and it is already
 *    graded there. Never a miss.
 *  - `called-shadow` / `route-blocked` — a SHADOW. Both publish a shadow row
 *    (route-blocked is simply the more specific reason: the row cleared every
 *    gate and an ISA cannot place it). A shadow is an audition the engine
 *    deliberately withheld from the reader, and it grades already, through
 *    gradePrediction, with a real published stop. Charging a gate for a shadow's
 *    move would book the same outcome twice under two different names.
 *  - `shadow-capped` — NOT covered by grading and NOT miss-checked: pickShadow
 *    drops these rows past the per-side budget (or as dedup casualties) and the
 *    row then appears in nothing the reader or the learning loop sees. They are
 *    skipped here because the SHADOW flag, not the cap, is what kept them from
 *    the reader — charging the cap would blame a sampling budget for a decision
 *    made elsewhere. Until the 3a `priorGate` rider lands, this population is
 *    measured by NOTHING; a 3c reader must not assume grading covers it
 *    (3b final review, Important 3).
 *  - `called-wildcard` — the EXPERIMENT SLOT took this exact row (Stage 3d). It
 *    is sized, it is graded, and ten sessions later its REAL outcome is charged
 *    to the gate that had refused it, as `causal` evidence and as one sided
 *    outcome (see `accrueCausalOutcome`). Miss-checking it as well would charge
 *    that same gate a second, stopless copy of the same fortnight — one event,
 *    two levers, and the better measurement drowned by the worse one.
 *  - `crypto-contained` — the engine REFUSED a crypto pair as a candidate (Stage
 *    1c Phase A). Every number in this module is an excess against SPY over ten
 *    SPY sessions, and a seven-day-a-week series does not share that clock or that
 *    benchmark: "the containment gate cost us 12pp" would be a measurement of the
 *    wrong market, charged to a gate that governs equity calls. Refused here, and
 *    refused again by SYMBOL in `missCandidates` — the belt that also covers the
 *    250-day tail of trace rows written before this shipped. */
export const MISS_SKIP_GATES: ReadonlySet<GateCode> = new Set<GateCode>(['called-full', 'called-half', 'called-shadow', 'called-wildcard', 'route-blocked', 'shadow-capped', 'crypto-contained'])

export const missCheckable = (gate: GateCode): boolean => !MISS_SKIP_GATES.has(gate)

export interface MissExample {
  date: string
  sym: string
  side: 'long' | 'short'
  /** Side-adjusted excess vs SPY over MISS_HORIZON sessions. POSITIVE on a cost
   * (the move the gate refused), NEGATIVE on a save (the loss it dodged) — the
   * sign is what tells the two apart in one bounded list. */
  excessPct: number
  gate: GateCode
  /** True when the row died before a side existed (trimmed/no-candles) and was
   * evaluated BOTH ways — a bare row past the bar mints one cost AND one mirror
   * save for the same gate, so 3c must compute sided-only ratios by excluding
   * these (Task-1 review, Important 2). */
  bare?: boolean
  /** THE TAG (spec §4.1: "tagged `wildcard` so its record stays separable"). Set
   * on the examples inside `causal` and nowhere else, so a human reading a gate's
   * examples back can tell the one row the engine actually TOOK from the dozens
   * it merely measured. */
  wildcard?: true
  /** Did the reader's quarter-size position come good? Present only on a causal
   * example, because it is the only kind that HAD a position: `hit` is
   * gradePrediction's own verdict, over the same ten sessions, with the published
   * stop walked. A miss example has no stop and therefore no such answer. */
  hit?: boolean
}

/** THE CAUSAL COLUMN — the only evidence in this ledger that is not an upper
 * bound (Stage 3d).
 *
 * Everything else here measures what a refused name went on to do WITHOUT a
 * position: no stop was ever published for it, so the excess is what was
 * available rather than what would have been got (rule 2 of the header). The
 * wildcard slot buys the other kind, one row at a time: it takes a trade a gate
 * refused, at a quarter of the rung, with a real stop, and ten sessions later
 * this is where that outcome lands.
 *
 * ADDITIVE and OPTIONAL. Absent means "no experiment has ever graded against this
 * gate", which is the true state of every gate on the day this ships and must
 * never read as "the experiments all failed".
 *
 * The counts are the accounting; `hits` is how many of them the reader would have
 * WON. The pair is deliberately not reduced to a rate here — n is small by
 * construction (one slot, ~weekly) and a "50%" printed off two rows is the kind
 * of number that gets believed. */
export interface MissCausal {
  /** Graded wildcard outcomes charged to this gate. */
  n: number
  /** …of which the reader's position hit. A gate whose refusals keep winning
   * when overridden is the spec's "strongest trigger" for loosening it. */
  hits: number
  /** Newest winning, bounded exactly as the miss examples are. */
  examples: MissExample[]
}

export interface MissGateStat {
  /** Rows this gate refused that then ran ≥ +5pp on the refused side. */
  cost: number
  /** Sum of those excesses — positive by construction. */
  costExcessSum: number
  /** THE HYGIENIC SUB-COUNTS (Stage 3c) — `cost`/`saved` restricted to SIDED
   * rows. A bare row is scored both ways, so it mints one cost and one mirror
   * save for the same gate; counting that pair as two outcomes would let a gate
   * argue with itself. These are what `gateAttribution` reads and the ONLY
   * numbers allowed to move a gate.
   *
   * OPTIONAL, and absent means ZERO rather than "same as cost": a counter written
   * before the split cannot be un-mixed, and the mechanism must not act on
   * evidence it cannot audit. The practical cost is that gate feedback starts
   * from an empty evidence base on the day it ships, which is exactly the plan's
   * "the evidence arrives on its own clock". */
  sidedCost?: number
  sidedSaved?: number
  /** Rows it refused that then fell ≤ −5pp on the refused side. */
  saved: number
  /** Sum of THOSE excesses — negative by construction, so `-savedExcessSum` is
   * the drawdown avoided. Left signed so a reader can never mistake one column
   * for the other. */
  savedExcessSum: number
  /** Rows charged to this gate that the fetch budget (or a failed tape) left
   * UNPRICED — without this a gate that was never measured is indistinguishable
   * from a gate that blocked nothing worth having (Task-1 review, Important 1). */
  unchecked: number
  examples: MissExample[]
  /** THE EXPERIMENT'S OWN RECORD against this gate (Stage 3d) — see MissCausal.
   * Written only by `accrueCausalOutcome`, never by the miss walk. */
  causal?: MissCausal
}

export interface MissDay {
  /** Rows whose ten-session excess was actually measured. */
  checked: number
  /** Rows that were NOT: past the fetch budget, no tape, or a tape too short to
   * mature. All three mean the same thing to a reader of this ledger — "we do not
   * know" — and none of them may be allowed to read as "nothing happened". */
  unchecked: number
  /** Cost events booked (a bare row can contribute at most one). */
  misses: number
}

/** `gates` is SPARSE — a code appears once it has something to say. Reading it as
 * a full Record<GateCode, …> would invent zeros for gates that never fired. */
export interface MissLedger {
  gates: Partial<Record<GateCode, MissGateStat>>
  days: Record<string, MissDay>
}

export const emptyMissLedger = (): MissLedger => ({ gates: {}, days: {} })

/** Fail-soft read of the stored blob: anything that is not the shape becomes an
 * empty ledger rather than an exception inside the grading pass. */
export function normaliseMissLedger(raw: unknown): MissLedger {
  const l = (raw ?? null) as Partial<MissLedger> | null
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null)
  return {
    gates: (obj(l?.gates) as MissLedger['gates']) ?? {},
    days: (obj(l?.days) as MissLedger['days']) ?? {},
  }
}

/** THE ENTRY BASIS, MIRRORED FROM `gradePrediction` (calibration.ts) LINE FOR
 * LINE — the entry session's OPEN for both the name and SPY, the close ten
 * sessions on, side-adjusted, rounded at the same place with the sign applied
 * INSIDE the rounding. If these two ever diverge, a miss and a hit stop being
 * commensurable and every cost/saved comparison downstream is measuring two
 * different things. A test pins the equality on a shared fixture, on both sides.
 *
 * The one deliberate difference: no stop walk. See the header — a miss has no
 * stop, so this excess is an upper bound on what was available. */
export function missExcess(candles: Candle[], spy: Candle[], entryDateISO: string): { long: number; short: number } | null {
  const dayEpoch = Date.parse(entryDateISO) / 1000
  if (!Number.isFinite(dayEpoch)) return null
  const entryIdx = candles.findIndex(c => c.t >= dayEpoch)
  if (entryIdx === -1 || entryIdx + MISS_HORIZON >= candles.length) return null
  const spyIdx = spy.findIndex(c => c.t >= dayEpoch)
  if (spyIdx === -1 || spyIdx + MISS_HORIZON >= spy.length) return null

  const base = candles[entryIdx].o
  const spyBase = spy[spyIdx].o
  if (!(base > 0) || !(spyBase > 0)) return null
  const rawPct = ((candles[entryIdx + MISS_HORIZON].c - base) / base) * 100
  const spyPct = ((spy[spyIdx + MISS_HORIZON].c - spyBase) / spyBase) * 100
  if (!Number.isFinite(rawPct) || !Number.isFinite(spyPct)) return null
  // `round1(sign * (raw - spy))`, once per side — NOT `-long`. JS rounds halves
  // toward +∞, so round1(-x) is not always -round1(x), and the whole point of
  // this function is to be the same number gradePrediction would have produced.
  return { long: round1(rawPct - spyPct), short: round1(-1 * (rawPct - spyPct)) }
}

export interface MissCandidate {
  /** The trace's own row key — `SYM:side`, or a bare `SYM`. */
  key: string
  sym: string
  /** null for a bare row: scored BOTH ways (see the header). */
  side: 'long' | 'short' | null
  gate: GateCode
  /** |core| — the row's OWN stored conviction where it has one (the 3a rider),
   * else the day's near-miss list, else 0. */
  rank: number
}

/** The rows worth spending the budget on, in the order to spend it.
 *
 * SIDED rows first, by conviction descending: a row the composite scored and a
 * gate then turned down is a far more interesting refusal than a name that never
 * got a direction at all, and conviction is the best available proxy for "how
 * close was this to being called".
 *
 * THE ROW'S OWN `core` LEADS (the Stage-3a rider, funnelTrace.ts). `nearMisses`
 * used to be the only place a day's conviction survived, and it drops every name
 * with an earnings print inside the horizon or without printable levels — so the
 * refusals the ledger most wanted to price ranked 0 and starved behind the
 * tiebreak. The near-miss list stays as the fallback for rows written before the
 * rider (and for the side-free gates, which never had a composite), then 0, then
 * the rotating key spin, so two runs of one day still spend the budget
 * identically. */
export function missCandidates(trace: FunnelTrace): MissCandidate[] {
  const rank = new Map<string, number>()
  for (const nm of trace.nearMisses ?? []) {
    const s = nm.sym.toUpperCase()
    rank.set(s, Math.max(rank.get(s) ?? 0, Math.abs(nm.core)))
  }
  const out: MissCandidate[] = []
  for (const [key, row] of Object.entries(trace.rows ?? {})) {
    if (!row || !missCheckable(row.gate)) continue
    const sym = key.split(':')[0]
    // …and the same refusal read off the NAME (Stage 1c Phase A). The gate skip
    // above covers rows the containment guard wrote; this covers the ones it did
    // not — a crypto refusal recorded under `dead-zone-core` before the guard
    // shipped, and the trace index is 250 days deep. Both layers, because the
    // cost of a miss here is a stopless SPY excess charged to an equity gate.
    if (isCryptoSymbol(sym)) continue
    const own = typeof row.core === 'number' && Number.isFinite(row.core) ? Math.abs(row.core) : null
    out.push({ key, sym, side: row.side ?? null, gate: row.gate, rank: own ?? rank.get(sym) ?? 0 })
  }
  // The rank-0 tiebreak rotates with the trace date: a stable alphabetical
  // order would measure the same early-alphabet names every day and starve the
  // rest forever (Task-1 review). Deterministic per day, different across days.
  const spin = (k: string) => {
    let h = 0
    const seed = `${trace.date}:${k}`
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
    return h
  }
  out.sort((a, b) => (a.side ? 0 : 1) - (b.side ? 0 : 1) || b.rank - a.rank || spin(a.key) - spin(b.key))
  return out
}

/** Books one (row, side) evaluation. Returns which column it landed in, or null
 * when the move was inside the ±5pp bar and the gate owes nothing either way. */
export function accrueMissEvent(ledger: MissLedger, ev: MissExample): 'cost' | 'saved' | null {
  const kind = ev.excessPct >= MISS_EXCESS_MIN ? 'cost' : ev.excessPct <= -MISS_EXCESS_MIN ? 'saved' : null
  if (!kind) return null
  const g = (ledger.gates[ev.gate] ??= { cost: 0, costExcessSum: 0, saved: 0, savedExcessSum: 0, unchecked: 0, examples: [] })
  if (kind === 'cost') {
    g.cost++
    g.costExcessSum = round1(g.costExcessSum + ev.excessPct)
    if (!ev.bare) g.sidedCost = (g.sidedCost ?? 0) + 1
  } else {
    g.saved++
    g.savedExcessSum = round1(g.savedExcessSum + ev.excessPct)
    if (!ev.bare) g.sidedSaved = (g.sidedSaved ?? 0) + 1
  }
  g.examples = [...g.examples, { ...ev }].slice(-MISS_EXAMPLES_PER_GATE)
  return kind
}

/** BOOKS ONE GRADED WILDCARD against the gate it overrode (Stage 3d).
 *
 * The one place causal evidence enters this ledger, and it does two things at
 * once, deliberately:
 *
 *  1. `causal` — the separable record: n, hits, and a bounded tail of tagged
 *     examples. Nothing else in the ledger can be read as causal, and nothing
 *     here can be mistaken for the stopless columns beside it.
 *  2. `sidedCost` / `sidedSaved` — the HYGIENIC counts `gateAttribution` reads
 *     and the only numbers allowed to move a gate. A wildcard that HIT is a
 *     sided cost: the gate refused a trade that then paid, with a stop, at a
 *     size the reader carried. One that did not is a sided save. This is what
 *     "the strongest trigger for §4.3's bounded loosening" means mechanically —
 *     a causal outcome reaches eligibility on the day it grades, with no
 *     ten-session miss-maturation lag behind it.
 *
 * What it deliberately does NOT touch is `cost` / `saved` / `costExcessSum` /
 * `savedExcessSum`. Those are the STOPLESS population and its mean excess: a
 * ±5pp bar over a fortnight nobody was in. This outcome was measured at the hit
 * bar with the published stop walked, so folding it in would corrupt
 * `avgCostExcessPct` with a number computed a different way, and the summary line
 * would quietly stop meaning one thing. The consequence is stated rather than
 * hidden: `sidedCost` may exceed `cost` on a gate the slot has visited, and that
 * inequality is the causal column showing through.
 *
 * A gate that has never been heard of is minted here exactly as `accrueUnchecked`
 * mints one — the slot can perfectly well be the first thing that ever charged
 * it. */
export function accrueCausalOutcome(ledger: MissLedger, ev: MissExample & { hit: boolean }): void {
  const g = (ledger.gates[ev.gate] ??= { cost: 0, costExcessSum: 0, saved: 0, savedExcessSum: 0, unchecked: 0, examples: [] })
  const c = (g.causal ??= { n: 0, hits: 0, examples: [] })
  c.n++
  if (ev.hit) c.hits++
  c.examples = [...c.examples, { ...ev, wildcard: true as const }].slice(-MISS_EXAMPLES_PER_GATE)
  if (ev.hit) g.sidedCost = (g.sidedCost ?? 0) + 1
  else g.sidedSaved = (g.sidedSaved ?? 0) + 1
}

/** An unpriced row still charges its gate's `unchecked` column — a gate that
 * was never measured must never read as a gate that cost nothing. */
export function accrueUnchecked(ledger: MissLedger, gate: GateCode): void {
  const g = (ledger.gates[gate] ??= { cost: 0, costExcessSum: 0, saved: 0, savedExcessSum: 0, unchecked: 0, examples: [] })
  g.unchecked = (g.unchecked ?? 0) + 1
}

/** Records the day's coverage and prunes to the newest MISS_LEDGER_DAYS_MAX.
 * Pruning is safe against double-counting only because the caller always works
 * the NEWEST matured trace day (see the hook in engine.ts): a day old enough to
 * be pruned is a day that can never be selected again. */
export function recordMissDay(ledger: MissLedger, date: string, day: MissDay): MissLedger {
  ledger.days[date] = day
  const dates = Object.keys(ledger.days).sort()
  for (const d of dates.slice(0, Math.max(0, dates.length - MISS_LEDGER_DAYS_MAX))) delete ledger.days[d]
  return ledger
}

/** THE TRACE DAY TO WORK: the newest one with a full MISS_HORIZON of SPY sessions
 * after it.
 *
 * SESSIONS, not calendar days, and read off SPY's own series exactly the way
 * grading finds its distance — the index skips weekends and holidays already,
 * but an outage day would shift every position in it, so counting entries would
 * silently mis-date the whole ledger. */
export function maturedTraceDate(index: readonly string[], spy: Candle[], horizon = MISS_HORIZON): string | null {
  let best: string | null = null
  let bestIdx = -1
  for (const d of index) {
    const epoch = Date.parse(d) / 1000
    if (!Number.isFinite(epoch)) continue
    const idx = spy.findIndex(c => c.t >= epoch)
    if (idx === -1 || idx + horizon >= spy.length) continue
    if (idx > bestIdx) {
      bestIdx = idx
      best = d
    }
  }
  return best
}

/** THE DOUBLE-BOOKED GATES (3b entry condition (a), binding on 3c).
 *
 * These three publish a ZERO-SIZE row: the reader gets it, and its outcome is
 * GRADED into calibration like any other — the Stage-3c partition deliberately
 * accrues them as SIZED evidence, because a band under its anchor recovers
 * through exactly these rows. They are also miss-checkable, so the same +51pp
 * event both lifts its calibration bucket and charges its gate. One event must
 * not move two levers, and calibration already has it, so the gate lever lets it
 * go: their counters are REPORTED (the marker is on every summary line) and are
 * evidence for NOTHING.
 *
 * The exclusion is SYMMETRIC — neither their cost nor their saves may move a
 * gate. Letting a double-booked save tighten while its cost may not loosen would
 * make the same population argue in one direction only, which is a bias with a
 * rationale rather than a rule. */
export const DOUBLE_BOOKED_GATES: ReadonlySet<GateCode> = new Set<GateCode>(['called-watch', 'called-below-base', 'called-observation'])

/** One gate's line in the summary — the two columns that argue, and the one that
 * says how much of the argument is missing. */
export interface MissGateLine {
  gate: GateCode
  cost: number
  /** Mean excess of the moves it refused, in pp. null when it has cost nothing. */
  avgCostExcessPct: number | null
  saved: number
  unchecked: number
  /** Present (true) only on the three gates above — the marker that says "these
   * numbers are already counted somewhere else". Absent on every other gate, so
   * the shape of an ordinary line never changed. */
  doubleBooked?: true
  /** THE CAUSAL COLUMN (Stage 3d), when the experiment slot has ever graded
   * against this gate: how many quarter-size overrides it has taken and how many
   * of them the reader would have won. Absent otherwise — a gate no experiment
   * has visited says nothing rather than printing a confident 0/0, and every
   * ordinary line is byte-identical to what it always was. */
  causal?: { n: number; hits: number }
}

/** THE ELIGIBILITY READ (Stage 3c, gateState.ts consumes it). Per gate: the
 * hygienic counts that may move it, and the marker that says they may not.
 *
 * Hygiene, all three rules from the plan's global constraints:
 *  - SIDED only — bare mirror rows are excluded (see the sub-counts above);
 *  - DOUBLE-BOOKED gates carry the marker and are refused in both directions;
 *  - `unchecked` never counts as evidence either way. It travels anyway, because
 *    a gate with 200 unpriced refusals and 3 priced ones is a gate nobody has
 *    measured, and a reader of this row must be able to see that. */
export interface GateAttribution {
  gate: GateCode
  cost: number
  saved: number
  /** cost + saved: outcomes ATTRIBUTED to this gate. Refusals whose ten-session
   * excess landed inside the ±5pp bar were measured and attributed to neither
   * column — the ledger has never stored them per gate, and inventing them here
   * would loosen the ≥30 bar with numbers nobody counted. */
  n: number
  unchecked: number
  doubleBooked: boolean
}

export function gateAttribution(raw: unknown): GateAttribution[] {
  const l = normaliseMissLedger(raw)
  return (Object.entries(l.gates) as [GateCode, MissGateStat][]).map(([gate, g]) => {
    const cost = g?.sidedCost ?? 0
    const saved = g?.sidedSaved ?? 0
    return { gate, cost, saved, n: cost + saved, unchecked: g?.unchecked ?? 0, doubleBooked: DOUBLE_BOOKED_GATES.has(gate) }
  })
}

/** THE BOUNDED READ — what a panel line and a paragraph of the paper may say
 * about the ledger, and nothing more. */
export interface MissLedgerSummary {
  /** Trace days measured (the retained window, MISS_LEDGER_DAYS_MAX). */
  days: number
  /** Refusals priced, and refusals we could not price, over those days. */
  checked: number
  unchecked: number
  /** Cost events booked over those days. */
  misses: number
  /** Worst gates by cost. Their counters are LIFETIME — see `note`. */
  topGates: MissGateLine[]
  /** The caveat, in words, because both halves of it are load-bearing: an
   * unmeasured gate is not a costless one, and the excesses are stopless upper
   * bounds. Every surface prints this or prints nothing. */
  note: string
}

/** The stored blob → the summary. Null when nothing has ever been measured, so a
 * surface says NOTHING rather than announcing a confident zero.
 *
 * TWO WINDOWS, deliberately, and the summary is explicit about which is which:
 * `days`/`checked`/`unchecked`/`misses` are the retained day window (60 days,
 * pruned), while the per-gate counters accumulate from the first day ever
 * measured and are never pruned — pruning them would quietly delete the evidence
 * Stage 3c is accruing. */
export function missLedgerSummary(raw: unknown, topN = 3): MissLedgerSummary | null {
  const l = normaliseMissLedger(raw)
  const days = Object.values(l.days)
  const gates = Object.entries(l.gates) as [GateCode, MissGateStat][]
  if (!days.length && !gates.length) return null
  const sum = (pick: (d: MissDay) => number) => days.reduce((s, d) => s + (Number.isFinite(pick(d)) ? pick(d) : 0), 0)
  const checked = sum(d => d.checked)
  const unchecked = sum(d => d.unchecked)
  const topGates = gates
    .map(([gate, g]) => ({
      gate,
      cost: g.cost ?? 0,
      avgCostExcessPct: g.cost ? round1((g.costExcessSum ?? 0) / g.cost) : null,
      saved: g.saved ?? 0,
      unchecked: g.unchecked ?? 0,
      // …and whether this gate's numbers are already counted elsewhere
      ...(DOUBLE_BOOKED_GATES.has(gate) ? { doubleBooked: true as const } : {}),
      // …and what the experiment slot has actually TAKEN against it (Stage 3d).
      // Only when there is something to say: `n` of 0 is a gate no wildcard has
      // ever tested, and a surface printing "0 causal" would read as a verdict.
      ...(g.causal?.n ? { causal: { n: g.causal.n, hits: g.causal.hits ?? 0 } } : {}),
    }))
    // by cost, then by the size of what it cost, THEN by unchecked — so on a
    // day where every gate shows cost 0, the gate with 40 unpriced refusals
    // outranks an alphabetically-early gate that was fully measured at zero
    // (Task-3 review, Minor 8) — then by name so two reads never disagree
    .sort((a, b) => b.cost - a.cost || (b.avgCostExcessPct ?? 0) - (a.avgCostExcessPct ?? 0) || b.unchecked - a.unchecked || a.gate.localeCompare(b.gate))
    .slice(0, Math.max(0, topN))
  return {
    days: days.length,
    checked,
    unchecked,
    misses: sum(d => d.misses),
    topGates,
    note: `${unchecked} of ${checked + unchecked} refusals went unpriced — an unmeasured gate is not a costless one; excesses are stopless upper bounds.`,
  }
}

export interface MissIo {
  /** Is this name already in the grading run's candle cache? Free names never
   * touch the budget. */
  isFree: (sym: string) => boolean
  candles: (sym: string) => Promise<Candle[] | null>
}

/** Walks ONE trace day and accrues it into the ledger, in place.
 *
 * A `disabled` trace is the tombstone Stage 3a added (funnelTrace.ts): the
 * recorder was stubbed off, so the day holds NO DATA. It is skipped entirely —
 * not recorded as a day with zero refusals, which is what an empty rows map would
 * otherwise say, and a lie the ledger would carry forever. */
export async function accrueMissDay(ledger: MissLedger, trace: FunnelTrace, spy: Candle[], io: MissIo, budget = MISS_FETCH_BUDGET): Promise<MissLedger> {
  if (trace?.disabled) return ledger
  let fetches = 0
  let checked = 0
  let unchecked = 0
  let misses = 0
  for (const cand of missCandidates(trace)) {
    const free = io.isFree(cand.sym)
    if (!free && fetches >= budget) {
      unchecked++
      accrueUnchecked(ledger, cand.gate)
      continue
    }
    let candles: Candle[] | null = null
    try {
      // counted before the await: a fetch that failed still cost the call
      if (!free) fetches++
      candles = await io.candles(cand.sym)
    } catch {
      candles = null
    }
    const ex = candles ? missExcess(candles, spy, trace.date) : null
    if (!ex) {
      unchecked++
      accrueUnchecked(ledger, cand.gate)
      continue
    }
    checked++
    for (const side of cand.side ? ([cand.side] as const) : (['long', 'short'] as const)) {
      if (accrueMissEvent(ledger, { date: trace.date, sym: cand.sym, side, excessPct: ex[side], gate: cand.gate, ...(cand.side ? {} : { bare: true }) }) === 'cost') misses++
    }
  }
  return recordMissDay(ledger, trace.date, { checked, unchecked, misses })
}

/** THE REGRET SURFACE'S READ (PWA rebuild): missLedgerSummary's exact maths and
 * ordering — same code path, so the two can never disagree — but each top gate
 * keeps its named examples and the default topN widens. The summary stays the
 * paper's and the legacy panel's read, untouched. */
export function missLedgerExamples(raw: unknown, topN = 8): (Omit<MissLedgerSummary, 'topGates'> & { topGates: (MissGateLine & { examples: MissExample[] })[] }) | null {
  const summary = missLedgerSummary(raw, topN)
  if (!summary) return null
  const l = normaliseMissLedger(raw)
  return {
    ...summary,
    topGates: summary.topGates.map(g => ({ ...g, examples: l.gates[g.gate]?.examples ?? [] })),
  }
}
