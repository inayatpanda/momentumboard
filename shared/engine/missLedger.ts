import type { Candle } from '../types'
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
 *  - `shadow-capped` — the shadow budget's casualties. Same argument: the row was
 *    a SHADOW before the cap touched it. The decision that kept it away from the
 *    reader was the shadow flag, not the cap, so the cap must not be charged for
 *    a move nobody was going to take.
 *  - `called-watch` / `called-below-base` / `called-observation` — UNSIZED, and
 *    these DO count. The reader saw the row on the board and could not act on it:
 *    zero size, no instrument, no book entry. That is a gate (a thin grade, a
 *    below-base read, a missing ISA route) denying a move, which is precisely
 *    what this ledger measures. They also grade as watch-only predictions, and
 *    that is not a conflict: grading asks "was the read right", the ledger asks
 *    "was the reader denied". Different questions, both worth an answer.
 *
 * Everything else — every ordinary refusal — is a candidate. */
export const MISS_SKIP_GATES: ReadonlySet<GateCode> = new Set<GateCode>(['called-full', 'called-half', 'called-shadow', 'route-blocked', 'shadow-capped'])

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
}

export interface MissGateStat {
  /** Rows this gate refused that then ran ≥ +5pp on the refused side. */
  cost: number
  /** Sum of those excesses — positive by construction. */
  costExcessSum: number
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
  /** |core| from the day's near-miss list where the name appears, else 0 — the
   * only conviction number the trace actually carries. */
  rank: number
}

/** The rows worth spending the budget on, in the order to spend it.
 *
 * SIDED rows first, by conviction descending: a row the composite scored and a
 * gate then turned down is a far more interesting refusal than a name that never
 * got a direction at all, and conviction is the best available proxy for "how
 * close was this to being called". The trace row itself carries no composite —
 * `nearMisses` is the only place the day's conviction survives — so the ordering
 * uses that where it exists and falls back to 0, then to the key, so two runs of
 * one day spend the budget identically. */
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
    out.push({ key, sym, side: row.side ?? null, gate: row.gate, rank: rank.get(sym) ?? 0 })
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
  } else {
    g.saved++
    g.savedExcessSum = round1(g.savedExcessSum + ev.excessPct)
  }
  g.examples = [...g.examples, { ...ev }].slice(-MISS_EXAMPLES_PER_GATE)
  return kind
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

/** One gate's line in the summary — the two columns that argue, and the one that
 * says how much of the argument is missing. */
export interface MissGateLine {
  gate: GateCode
  cost: number
  /** Mean excess of the moves it refused, in pp. null when it has cost nothing. */
  avgCostExcessPct: number | null
  saved: number
  unchecked: number
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
    }))
    // by cost, then by the size of what it cost, then by name so two reads of one
    // ledger never disagree about which gate is worst
    .sort((a, b) => b.cost - a.cost || (b.avgCostExcessPct ?? 0) - (a.avgCostExcessPct ?? 0) || a.gate.localeCompare(b.gate))
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
