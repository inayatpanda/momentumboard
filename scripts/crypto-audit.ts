// THE CONTAMINATION AUDIT — what the equity record was measured with.
// Stage 1c Phase A, Task A2. READ-ONLY, everywhere, always.
//
// Task A1 shut twelve doors. This answers the question A1 could not: how much
// crypto got through BEFORE they shut, and what did it teach on the way. The
// recon (§8.0) found the leak live in two places at once — `ETH-USD` in
// `MIRROR_EXTRAS` so every non-seed replay walked it, and BTC-USD/ETH-USD in the
// shipped starter watchlist so production admitted them at candidate priority 1
// — and the equity numbers on record were therefore measured with crypto in
// them. This script says by how much.
//
// THE HONEST BOUND IS THE POINT, and it is stated in every section rather than
// implied once. A calibration bucket is a pair of integers: a graded crypto row
// incremented `n` (and possibly `hits`) and there is no record inside the blob of
// which row did it. THE INCREMENTS CANNOT BE UN-ATTRIBUTED RETROACTIVELY. What
// this script can do — and does — is replay the SAME arithmetic the grader ran,
// off the rows themselves, and report exactly which buckets took which
// increments. That is an attribution of contribution, not a subtraction: the
// numbers below say "this is what crypto put in", never "remove this and the
// blob is clean", because removing it would also require re-running every
// downstream read that saw the contaminated value on the day it stood.
//
// TWO SOURCES, ONE REPORT.
//   --artefact <path>   a replay run file (`replay-window.ts --out`). Offline,
//                       no store, no credentials. Its `days[].ledger` rows ARE
//                       `predictions:${date}` (the walk reads the blob to build
//                       them) and its `storedOutcome10` is the engine's own
//                       grade, so the artefact answers the same questions live
//                       D1 does over the same shapes.
//   --live              the production store, through the same seam scripts/bg
//                       uses (`configureStoreForScript` → STORE_BACKEND=d1 →
//                       httpD1). Reads only. See `readOnly` below — the store is
//                       wrapped so a write is a thrown error rather than a
//                       regret.
//
// Fail-soft by construction: a blob that is absent, unreadable or the wrong
// shape is REPORTED as such and the rest of the audit continues. An audit that
// dies on the first missing key tells the owner nothing about the other six.

import { readFileSync, writeFileSync } from 'node:fs'
import { bandFor, type CalibrationState, type WeightsState } from '../shared/engine/calibration'
import { capCohortOf, type CapCohortOrUnknown } from '../shared/engine/capClass'
import { ZERO_IS_A_READING, DEFAULT_WEIGHTS } from '../shared/engine/composite'
import { FUNNEL_TRACE_INDEX_KEY, funnelTraceKey } from '../shared/engine/funnelTrace'
import { GATE_STATE_KEY } from '../shared/engine/gateState'
import { MISS_EXCESS_MIN, MISS_FETCH_BUDGET, MISS_LEDGER_KEY, MISS_SKIP_GATES } from '../shared/engine/missLedger'
import { isCryptoSymbol } from '../shared/symbols'
import type { FactorName } from '../shared/engine/types'

// ------------------------------------------------------------------ the row --

/** THE MINIMUM A ROW MUST CARRY to be attributed. Both sources project onto it:
 * a live `Prediction` (netlify/functions/lib/engine.ts) and a walk artefact
 * `Row` (scripts/replay-window.ts). Deliberately structural rather than an
 * import of `Prediction` — the artefact's projection is a strict subset and a
 * shared shape is what lets one set of pure functions audit both. */
export interface AuditRow {
  date: string
  sym: string
  side: 'long' | 'short'
  regime: string
  composite: number
  capUsdM?: number | null
  setup?: string | null
  accrual?: 'sized' | 'shadow' | null
  riskPct?: number | null
  shadow?: boolean
  watchOnly?: boolean
  wildcard?: boolean
  instrument?: string | null
  provenance?: 'seed' | 'live' | 'shadow'
  /** THE ENGINE'S OWN GRADE, as the blob holds it. `null`/absent means the row
   * never graded, and a row that never graded taught nothing — the single most
   * important distinction in this file, and the one a census that read a
   * recomputed outcome would get wrong (the artefact recomputes `outcome10` over
   * the full untruncated tape for rows the walk never reached). */
  outcome10?: { hit: boolean; excessPct: number; stopped: boolean } | null
  /** Present on a live Prediction, absent on an artefact row (the projection
   * drops the factor vector). Absence is why the IC section reports a BOUND
   * rather than a per-factor split. */
  factors?: Partial<Record<FactorName, { score: number | null; silence?: boolean }>> | null
}

const FACTOR_NAMES = Object.keys(DEFAULT_WEIGHTS) as FactorName[]

export const isCryptoRow = (r: AuditRow): boolean => isCryptoSymbol(r.sym)

// -------------------------------------------------------------- 1. history --

export interface HistoryAudit {
  /** Dates the scan covered, and how many carried any row at all. */
  datesScanned: number
  datesWithRows: number
  rows: number
  cryptoRows: number
  /** Distinct crypto symbols, and the first/last date each appeared. */
  symbols: { sym: string; n: number; first: string; last: string }[]
  /** The crypto rows, split the way every downstream mechanism splits them. */
  sized: number
  shadow: number
  watchOnly: number
  /** …and the only split that decides whether a row TAUGHT anything. */
  graded: number
  ungraded: number
  hits: number
  stopped: number
  excessSum: number
  /** Every graded crypto row, listed. Small by construction — if it ever is not,
   * the containment was later than anyone thought. */
  gradedRows: {
    date: string
    sym: string
    side: 'long' | 'short'
    regime: string
    composite: number
    setup: string | null
    accrual: 'sized' | 'shadow' | null
    riskPct: number | null
    hit: boolean
    excessPct: number
    stopped: boolean
  }[]
}

/** A row's accrual population, EXACTLY as `updateCalibration` decides it: the
 * stamp when there is one, the shipped `riskPct > 0 ⇒ sized` fallback otherwise. */
export const accrualOf = (r: AuditRow): 'sized' | 'shadow' | 'unstamped' =>
  r.accrual != null ? r.accrual : r.riskPct != null ? (r.riskPct > 0 ? 'sized' : 'shadow') : 'unstamped'

export function auditHistory(all: AuditRow[], datesScanned: number, datesWithRows: number): HistoryAudit {
  const crypto = all.filter(isCryptoRow)
  const bySym = new Map<string, { sym: string; n: number; first: string; last: string }>()
  for (const r of crypto) {
    const sym = r.sym.toUpperCase()
    const cur = bySym.get(sym)
    if (!cur) bySym.set(sym, { sym, n: 1, first: r.date, last: r.date })
    else {
      cur.n++
      if (r.date < cur.first) cur.first = r.date
      if (r.date > cur.last) cur.last = r.date
    }
  }
  const graded = crypto.filter(r => r.outcome10 != null)
  return {
    datesScanned,
    datesWithRows,
    rows: all.length,
    cryptoRows: crypto.length,
    symbols: [...bySym.values()].sort((a, b) => a.sym.localeCompare(b.sym)),
    sized: crypto.filter(r => accrualOf(r) === 'sized').length,
    shadow: crypto.filter(r => accrualOf(r) === 'shadow').length,
    watchOnly: crypto.filter(r => r.watchOnly).length,
    graded: graded.length,
    ungraded: crypto.length - graded.length,
    hits: graded.filter(r => r.outcome10!.hit).length,
    stopped: graded.filter(r => r.outcome10!.stopped).length,
    excessSum: Math.round(graded.reduce((s, r) => s + r.outcome10!.excessPct, 0) * 10) / 10,
    gradedRows: graded.map(r => ({
      date: r.date,
      sym: r.sym.toUpperCase(),
      side: r.side,
      regime: r.regime,
      composite: r.composite,
      setup: r.setup ?? null,
      accrual: r.accrual ?? null,
      riskPct: r.riskPct ?? null,
      hit: r.outcome10!.hit,
      excessPct: r.outcome10!.excessPct,
      stopped: r.outcome10!.stopped,
    })),
  }
}

// ---------------------------------------------------------- 2. calibration --

export interface BucketContribution {
  key: string
  /** What crypto put in. */
  n: number
  hits: number
  shadowN: number
  /** What the bucket holds NOW (null when the blob is absent or has no such key —
   * which is itself a finding: a bucket that took a crypto increment and no
   * longer exists means a generation swap has since replaced the blob, and the
   * contamination went with it). */
  currentN: number | null
  currentHits: number | null
  /** crypto n as a share of the bucket's current n, to 2dp. Null when unknown. */
  sharePct: number | null
}

export interface CalibrationAudit {
  present: boolean
  defVersion: number | null
  seedGeneration: number | null
  referenceBase: number | null
  /** `${cohort}:${side}:${regime}:${band}` or the legacy cohortless tail. */
  buckets: BucketContribution[]
  /** `${setup}:${side}:${band}` — the family curves, which since stage 3c MOVE
   * PUBLISHED PROBABILITY at 30 sized outcomes (`blendSetup`). */
  setupBuckets: BucketContribution[]
  /** `evidence.{seed,live,shadow}` increments. */
  evidence: { source: 'seed' | 'live' | 'shadow'; n: number; hits: number; currentN: number | null; currentHits: number | null }[]
  /** The Brier trail: a graded crypto row was pushed into `newlyGraded` and so
   * into the day's mean. The trail stores means, not rows, so the contribution
   * is a count of rows and the days they landed on — never a subtractable term. */
  brierRows: number
  brierDaysCovered: number
  bound: string
}

/** Replay `updateCalibration`'s key arithmetic, off the row, without touching a
 * blob. The three lines that matter are lifted verbatim from calibration.ts
 * (cohort from cap, band from |composite|, the cohortless tail for an unknown
 * cap) — if they ever diverge the audit is lying, so a test pins the equality
 * against the real `updateCalibration` on a shared fixture. */
export function bucketKeyFor(r: AuditRow): { key: string; cohort: CapCohortOrUnknown; band: string } {
  const cohort = capCohortOf(r.capUsdM)
  const band = bandFor(Math.abs(r.composite))
  const tail = `${r.side}:${r.regime}:${band}`
  return { key: cohort === 'unknown' ? tail : `${cohort}:${tail}`, cohort, band }
}

export const setupKeyFor = (r: AuditRow): string | null => (r.setup ? `${r.setup}:${r.side}:${bandFor(Math.abs(r.composite))}` : null)

/** The evidence counter a row books into — `updateCalibration`'s own expression. */
export const evidenceSourceOf = (r: AuditRow): 'seed' | 'live' | 'shadow' => r.provenance ?? (r.shadow ? 'shadow' : 'live')

const share = (n: number, cur: number | null) => (cur && cur > 0 ? Math.round((n / cur) * 10000) / 100 : null)

export function auditCalibration(cryptoGraded: AuditRow[], cal: CalibrationState | null, brierDays: number): CalibrationAudit {
  const buckets = new Map<string, { n: number; hits: number; shadowN: number }>()
  const setups = new Map<string, { n: number; hits: number; shadowN: number }>()
  const evidence = new Map<'seed' | 'live' | 'shadow', { n: number; hits: number }>()
  const bump = (m: Map<string, { n: number; hits: number; shadowN: number }>, key: string, hit: boolean, unsized: boolean) => {
    const cur = m.get(key) ?? { n: 0, hits: 0, shadowN: 0 }
    m.set(key, { n: cur.n + 1, hits: cur.hits + (hit ? 1 : 0), shadowN: cur.shadowN + (unsized ? 1 : 0) })
  }
  for (const r of cryptoGraded) {
    const hit = r.outcome10!.hit
    const unsized = accrualOf(r) === 'shadow'
    bump(buckets, bucketKeyFor(r).key, hit, unsized)
    const sk = setupKeyFor(r)
    if (sk) bump(setups, sk, hit, unsized)
    const src = evidenceSourceOf(r)
    const cur = evidence.get(src) ?? { n: 0, hits: 0 }
    evidence.set(src, { n: cur.n + 1, hits: cur.hits + (hit ? 1 : 0) })
  }
  const project = (m: Map<string, { n: number; hits: number; shadowN: number }>, store: Record<string, { n: number; hits: number }> | undefined): BucketContribution[] =>
    [...m.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .map(([key, v]) => {
        const cur = store?.[key] ?? null
        return { key, n: v.n, hits: v.hits, shadowN: v.shadowN, currentN: cur?.n ?? null, currentHits: cur?.hits ?? null, sharePct: share(v.n, cur?.n ?? null) }
      })
  return {
    present: cal != null,
    defVersion: cal?.defVersion ?? null,
    seedGeneration: cal?.seedGeneration ?? null,
    referenceBase: cal?.referenceBase ?? null,
    buckets: project(buckets, cal?.buckets),
    setupBuckets: project(setups, cal?.setupBuckets),
    evidence: [...evidence.entries()].map(([source, v]) => ({
      source,
      n: v.n,
      hits: v.hits,
      currentN: cal?.evidence?.[source]?.n ?? null,
      currentHits: cal?.evidence?.[source]?.hits ?? null,
    })),
    brierRows: cryptoGraded.length,
    brierDaysCovered: brierDays,
    bound:
      'A bucket is two integers. These are the increments crypto made, recomputed from the rows by the grader’s own key arithmetic — NOT a subtraction. ' +
      'They cannot be un-attributed: every read struck against the bucket while the increment stood (a grade, a published probability, a setup blend) already happened.',
  }
}

// ------------------------------------------------------------------- 3. IC --

export interface IcAudit {
  present: boolean
  /** Exact when the rows carry their factor vector; a bound when they do not. */
  exact: boolean
  gradedRows: number
  /** `state.gradedSinceNudge` moves once per graded row, whatever it voted. */
  gradedSinceNudge: { crypto: number; current: number | null }
  factors: { name: string; nAgree: number; sumAgree: number; nDisagree: number; sumDisagree: number; currentNAgree: number | null; currentNDisagree: number | null }[]
  bound: string
}

/** Replay `updateIcStats`'s admission test, factor by factor: a null score is a
 * silence, and a ZERO is a silence too unless this factor's zero is a reading
 * (`ZERO_IS_A_READING`, composite.ts) and the reading did not veto itself. */
export function auditIc(cryptoGraded: AuditRow[], w: WeightsState | null): IcAudit {
  const haveFactors = cryptoGraded.some(r => r.factors != null)
  const acc = new Map<string, { nAgree: number; sumAgree: number; nDisagree: number; sumDisagree: number }>()
  if (haveFactors) {
    for (const r of cryptoGraded) {
      if (!r.factors) continue
      for (const name of FACTOR_NAMES) {
        const f = r.factors[name]
        if (!f || f.score == null) continue
        if (f.score === 0 && (f.silence || !ZERO_IS_A_READING[name])) continue
        const agree = f.score > 0 === (r.side === 'long')
        const cur = acc.get(name) ?? { nAgree: 0, sumAgree: 0, nDisagree: 0, sumDisagree: 0 }
        if (agree) {
          cur.nAgree++
          cur.sumAgree += r.outcome10!.excessPct
        } else {
          cur.nDisagree++
          cur.sumDisagree += r.outcome10!.excessPct
        }
        acc.set(name, cur)
      }
    }
  }
  return {
    present: w != null,
    exact: haveFactors,
    gradedRows: cryptoGraded.length,
    gradedSinceNudge: { crypto: cryptoGraded.length, current: w?.gradedSinceNudge ?? null },
    factors: [...acc.entries()]
      .sort((a, b) => b[1].nAgree + b[1].nDisagree - (a[1].nAgree + a[1].nDisagree))
      .map(([name, v]) => ({
        name,
        nAgree: v.nAgree,
        sumAgree: Math.round(v.sumAgree * 10) / 10,
        nDisagree: v.nDisagree,
        sumDisagree: Math.round(v.sumDisagree * 10) / 10,
        currentNAgree: w?.ic?.[name as FactorName]?.nAgree ?? null,
        currentNDisagree: w?.ic?.[name as FactorName]?.nDisagree ?? null,
      })),
    bound: haveFactors
      ? 'Exact: every graded crypto row carried its factor vector, so each column below is the increment that row cast, replayed by updateIcStats’ own admission test. Un-attributable for the same reason the buckets are — an IC column is four running numbers, and every nudge that read them has already run.'
      : `Bounded, not exact: the rows in this source carry no factor vector, so the per-factor split is unrecoverable. The bound is ${cryptoGraded.length} graded crypto row(s) × at most ${FACTOR_NAMES.length} factor columns, and gradedSinceNudge moved by exactly ${cryptoGraded.length} — a nudge fires every 15, so these rows advanced the nudge clock by ${cryptoGraded.length}/15 of a step whatever they voted.`,
  }
}

// --------------------------------------------------------- 4. the ladder --

export interface LadderAudit {
  /** Rows that reached `allOutcomes` — the combined risk stream (engine.ts's
   * `!shadow && !watchOnly && !wildcard` filter over graded rows). */
  inStream: number
  hits: number
  /** …and the cohort counter each one advanced. Crypto has no cap, so in
   * practice this is always `unknown` → the COMBINED rung. */
  byCohort: Record<string, number>
  rows: { date: string; sym: string; side: string; hit: boolean; excessPct: number; cohort: CapCohortOrUnknown }[]
  bound: string
}

export function auditLadder(cryptoGraded: AuditRow[]): LadderAudit {
  const inStream = cryptoGraded.filter(r => !r.shadow && !r.watchOnly && !r.wildcard)
  const byCohort: Record<string, number> = {}
  for (const r of inStream) {
    const c = capCohortOf(r.capUsdM)
    byCohort[c] = (byCohort[c] ?? 0) + 1
  }
  return {
    inStream: inStream.length,
    hits: inStream.filter(r => r.outcome10!.hit).length,
    byCohort,
    rows: inStream.map(r => ({ date: r.date, sym: r.sym.toUpperCase(), side: r.side, hit: r.outcome10!.hit, excessPct: r.outcome10!.excessPct, cohort: capCohortOf(r.capUsdM) })),
    bound:
      'The ladder reads a rolling window (last 60, decided on the last 20 and the last 25), so a crypto outcome in the stream did not merely add to a total — it OCCUPIED A SLOT in the window that decided a rung. ' +
      'Whether a rung move flips without it is a counterfactual this script does not run; what it can say is how many of the deciding slots were crypto.',
  }
}

// ------------------------------------------------------- 5. the gate ledger --

export interface GateCandidate {
  date: string
  key: string
  gate: string
  /** 'proven' when the gate's stored `unchecked` counter is ZERO — a gate that
   * never left a row unpriced cannot have left THIS one unpriced, so the charge
   * is a fact rather than an upper bound. 'unknown' when the gate carries
   * unchecked rows (the 40-fetch budget), 'unknown' when there is no ledger. */
  priced: 'proven' | 'unknown'
  /** The refused side's own ten-session excess, when the same (date, side) also
   * reached the ledger and graded. `missExcess` mirrors `gradePrediction` line
   * for line minus the stop walk, so the two are commensurable — which is what
   * lets a refusal be classified without re-fetching a candle. */
  excessPct: number | null
  /** What that excess bought the gate: a `cost` event (≥ +5pp on the refused
   * side), a `saved` event (≤ −5pp), `neither` (inside the band — it still moved
   * the gate's `checked` population), or `unknown`. */
  charge: 'cost' | 'saved' | 'neither' | 'unknown'
}

export interface GateAudit {
  present: boolean
  /** Crypto trace rows on days the miss ledger has MEASURED — each one a
   * candidate the miss walk would have priced and charged to the gate that
   * refused it. */
  candidates: GateCandidate[]
  byGate: Record<string, number>
  /** The subset whose charge is PROVEN, split by what it bought. These are the
   * numbers that are actually inside `sidedCost`/`sidedSaved` — the only two
   * columns allowed to move a published threshold. */
  provenCharges: { cost: number; saved: number; neither: number }
  /** Crypto rows still visible in the stored ledger's bounded `examples` — a
   * PROVEN lower bound, since examples are capped and pruned. */
  provenExamples: { gate: string; date: string; sym: string; side: string; excessPct: number }[]
  /** Crypto trace rows the miss walk skipped by construction (a publication —
   * `MISS_SKIP_GATES` — or a day that never matured). Reported so the candidate
   * count cannot be read as "every crypto trace row". */
  skippedPublished: number
  skippedUnmatured: number
  /** `gate-state`: has feedback ever MOVED a threshold? Contaminated evidence
   * that never moved a constant is a different — and much smaller — finding than
   * contaminated evidence that did. */
  gateStateMoves: { gate: string; date: string; from: number; to: number; why?: string }[] | null
  bound: string
}

/** One day's funnel trace, reduced to what the audit reads. Both sources project
 * onto it: the artefact's `days[].trace` and the live `funnel-trace:${date}`. */
export interface TraceLike {
  date: string
  rows: Record<string, { gate: string; side?: string }>
}

export function auditGates(
  traces: TraceLike[],
  measuredDays: Set<string>,
  ledger: { gates?: Record<string, { unchecked?: number; examples?: { date?: string; sym?: string; side?: string; excessPct?: number }[] }> } | null,
  gateState: unknown,
  /** Graded crypto rows, so a refusal on the same (date, side) can be classified
   * rather than merely counted. Optional — an empty list simply leaves every
   * charge `unknown`. */
  cryptoGraded: AuditRow[] = [],
): GateAudit {
  const excessAt = new Map(cryptoGraded.map(r => [`${r.date}:${r.sym.toUpperCase()}:${r.side}`, r.outcome10!.excessPct]))
  const candidates: GateCandidate[] = []
  const byGate: Record<string, number> = {}
  const provenCharges = { cost: 0, saved: 0, neither: 0 }
  let skippedPublished = 0
  let skippedUnmatured = 0
  for (const t of traces) {
    for (const [key, row] of Object.entries(t.rows ?? {})) {
      const [sym, side] = key.split(':')
      if (!isCryptoSymbol(sym)) continue
      if (MISS_SKIP_GATES.has(row.gate as never)) {
        skippedPublished++
        continue
      }
      if (!measuredDays.has(t.date)) {
        skippedUnmatured++
        continue
      }
      const stat = ledger?.gates?.[row.gate]
      const priced: GateCandidate['priced'] = stat && (stat.unchecked ?? 0) === 0 ? 'proven' : 'unknown'
      const excessPct = excessAt.get(`${t.date}:${sym.toUpperCase()}:${side ?? row.side ?? ''}`) ?? null
      const charge: GateCandidate['charge'] =
        excessPct == null ? 'unknown' : excessPct >= MISS_EXCESS_MIN ? 'cost' : excessPct <= -MISS_EXCESS_MIN ? 'saved' : 'neither'
      if (priced === 'proven' && charge !== 'unknown') provenCharges[charge]++
      candidates.push({ date: t.date, key, gate: row.gate, priced, excessPct, charge })
      byGate[row.gate] = (byGate[row.gate] ?? 0) + 1
    }
  }
  const provenExamples: GateAudit['provenExamples'] = []
  for (const [gate, stat] of Object.entries(ledger?.gates ?? {})) {
    for (const ex of stat?.examples ?? []) {
      if (ex?.sym && isCryptoSymbol(ex.sym)) provenExamples.push({ gate, date: ex.date ?? '?', sym: ex.sym, side: ex.side ?? '?', excessPct: ex.excessPct ?? 0 })
    }
  }
  const gs = gateState as { gates?: Record<string, { history?: { date: string; from: number; to: number; why?: string }[] }> } | null
  const moves = gs?.gates
    ? Object.entries(gs.gates).flatMap(([gate, g]) => (g?.history ?? []).map(h => ({ gate, date: h.date, from: h.from, to: h.to, why: h.why })))
    : null
  return {
    present: ledger != null || traces.length > 0,
    candidates: candidates.sort((a, b) => a.date.localeCompare(b.date)),
    byGate,
    provenCharges,
    provenExamples,
    skippedPublished,
    skippedUnmatured,
    gateStateMoves: moves,
    bound:
      `UPPER BOUND from the trace: every crypto refusal on a measured day is a candidate, and the ${MISS_FETCH_BUDGET}-fetch daily budget may have left some unpriced (the ledger books those as \`unchecked\`). ` +
      'PROVEN where the gate’s own `unchecked` counter is zero — a gate that never left a row unpriced did not leave this one unpriced either — and classified against the ±' +
      `${MISS_EXCESS_MIN}pp band off the row’s own graded excess. The per-gate counters are LIFETIME and never pruned, so whatever landed is in \`sidedCost\`/\`sidedSaved\` permanently, and those two are the only numbers allowed to move a gate.`,
  }
}

// ------------------------------------------------------------- the report --

export interface CryptoAuditReport {
  source: { kind: 'artefact' | 'live'; ref: string; window: { from: string | null; to: string | null } }
  at: string
  history: HistoryAudit
  calibration: CalibrationAudit
  ic: IcAudit
  ladder: LadderAudit
  gates: GateAudit
  notes: string[]
}

const pct = (x: number | null) => (x == null ? '   —  ' : `${x.toFixed(2)}%`.padStart(6))

export function renderReport(r: CryptoAuditReport): string {
  const L: string[] = []
  const h = r.history
  L.push('')
  L.push('╔══════════════════════════════════════════════════════════════════════════════╗')
  L.push('║  CRYPTO CONTAMINATION AUDIT — what the equity record was measured with      ║')
  L.push('╚══════════════════════════════════════════════════════════════════════════════╝')
  L.push(`source: ${r.source.kind} · ${r.source.ref}`)
  L.push(`window: ${r.source.window.from ?? '?'} … ${r.source.window.to ?? '?'} · ${h.datesScanned} date(s) scanned, ${h.datesWithRows} with rows · run at ${r.at}`)
  L.push('')
  L.push('── 1. HISTORY ────────────────────────────────────────────────────────────────')
  L.push(`rows ${h.rows} · crypto ${h.cryptoRows} (${h.rows ? ((h.cryptoRows / h.rows) * 100).toFixed(2) : '0.00'}%) · symbols ${h.symbols.map(s => `${s.sym}×${s.n} [${s.first}…${s.last}]`).join(', ') || '—'}`)
  L.push(`crypto split: sized ${h.sized} · shadow ${h.shadow} · watch-only ${h.watchOnly}`)
  L.push(`crypto grading: GRADED ${h.graded} (taught) · ungraded ${h.ungraded} (taught nothing) · hits ${h.hits} · stopped ${h.stopped} · Σexcess ${h.excessSum}pp`)
  if (h.gradedRows.length) {
    L.push('')
    L.push('  date        sym       side  regime  comp   setup         accrual  risk%  outcome')
    for (const g of h.gradedRows)
      L.push(
        `  ${g.date}  ${g.sym.padEnd(9)} ${g.side.padEnd(5)} ${g.regime.padEnd(7)} ${String(g.composite).padStart(5)}  ${(g.setup ?? '—').padEnd(13)} ${(g.accrual ?? '—').padEnd(8)} ${String(g.riskPct ?? '—').padStart(5)}  ${g.hit ? 'HIT ' : 'miss'} ${g.excessPct > 0 ? '+' : ''}${g.excessPct}pp${g.stopped ? ' (stopped)' : ''}`,
      )
  }
  L.push('')
  L.push('── 2. CALIBRATION ────────────────────────────────────────────────────────────')
  const c = r.calibration
  L.push(c.present ? `blob present · defVersion ${c.defVersion} · seedGeneration ${c.seedGeneration} · referenceBase ${c.referenceBase ?? '—'}` : 'blob ABSENT — increments below are what crypto contributed to whatever blob stood at the time')
  if (!c.buckets.length) L.push('  no crypto row ever booked a bucket.')
  for (const b of c.buckets) L.push(`  bucket  ${b.key.padEnd(30)} +${b.n}n/+${b.hits}h${b.shadowN ? ` (${b.shadowN} shadow)` : ''}  →  now ${b.currentN ?? '—'}n/${b.currentHits ?? '—'}h  crypto share ${pct(b.sharePct)}`)
  for (const b of c.setupBuckets) L.push(`  setup   ${b.key.padEnd(30)} +${b.n}n/+${b.hits}h  →  now ${b.currentN ?? '—'}n/${b.currentHits ?? '—'}h  crypto share ${pct(b.sharePct)}`)
  for (const e of c.evidence) L.push(`  evidence.${e.source.padEnd(24)} +${e.n}n/+${e.hits}h  →  now ${e.currentN ?? '—'}n/${e.currentHits ?? '—'}h  crypto share ${pct(share(e.n, e.currentN))}`)
  L.push(`  brier: ${c.brierRows} crypto row(s) inside the daily means over ${c.brierDaysCovered} recorded day(s) — a mean is not a subtractable term`)
  L.push(`  BOUND: ${c.bound}`)
  L.push('')
  L.push('── 3. FACTOR IC ──────────────────────────────────────────────────────────────')
  L.push(`${r.ic.present ? 'weights blob present' : 'weights blob ABSENT'} · ${r.ic.exact ? 'EXACT (rows carry their factor vector)' : 'BOUNDED (no factor vector on these rows)'} · gradedSinceNudge +${r.ic.gradedSinceNudge.crypto} (now ${r.ic.gradedSinceNudge.current ?? '—'})`)
  for (const f of r.ic.factors)
    L.push(`  ${f.name.padEnd(16)} agree +${f.nAgree} (Σ${f.sumAgree}pp) · disagree +${f.nDisagree} (Σ${f.sumDisagree}pp)  →  now ${f.currentNAgree ?? '—'}/${f.currentNDisagree ?? '—'}`)
  L.push(`  BOUND: ${r.ic.bound}`)
  L.push('')
  L.push('── 4. RISK LADDER ────────────────────────────────────────────────────────────')
  L.push(`crypto outcomes in the combined stream: ${r.ladder.inStream} (${r.ladder.hits} hit) · by cohort ${JSON.stringify(r.ladder.byCohort)}`)
  for (const row of r.ladder.rows) L.push(`  ${row.date}  ${row.sym.padEnd(9)} ${row.side.padEnd(5)} ${row.hit ? 'HIT ' : 'miss'} ${row.excessPct > 0 ? '+' : ''}${row.excessPct}pp → cohort ${row.cohort}`)
  L.push(`  BOUND: ${r.ladder.bound}`)
  L.push('')
  L.push('── 5. GATE LEDGER ────────────────────────────────────────────────────────────')
  L.push(`crypto refusals on measured days: ${r.gates.candidates.length} · by gate ${JSON.stringify(r.gates.byGate)}`)
  L.push(`skipped by construction: ${r.gates.skippedPublished} published (MISS_SKIP_GATES) · ${r.gates.skippedUnmatured} on days the ledger never measured`)
  L.push(`PROVEN charges (gate’s own unchecked === 0): ${r.gates.provenCharges.cost} cost · ${r.gates.provenCharges.saved} saved · ${r.gates.provenCharges.neither} inside the band`)
  for (const cand of r.gates.candidates)
    L.push(`  ${cand.date}  ${cand.key.padEnd(18)} → ${cand.gate.padEnd(16)} ${cand.priced === 'proven' ? 'PRICED' : 'unknown'}  ${cand.excessPct == null ? '' : `${cand.excessPct > 0 ? '+' : ''}${cand.excessPct}pp → ${cand.charge}`}`)
  L.push(`proven in the stored ledger's examples: ${r.gates.provenExamples.length}`)
  for (const e of r.gates.provenExamples) L.push(`  ${e.date}  ${e.sym} ${e.side} ${e.excessPct > 0 ? '+' : ''}${e.excessPct}pp charged to ${e.gate}`)
  L.push(
    r.gates.gateStateMoves == null
      ? 'gate-state: ABSENT — feedback has never moved a published threshold, so the contaminated evidence has not yet changed a constant'
      : `gate-state: ${r.gates.gateStateMoves.length} threshold move(s) on record${r.gates.gateStateMoves.map(m => ` · ${m.date} ${m.gate} ${m.from}→${m.to}`).join('')}`,
  )
  L.push(`  BOUND: ${r.gates.bound}`)
  if (r.notes.length) {
    L.push('')
    L.push('── NOTES ─────────────────────────────────────────────────────────────────────')
    for (const n of r.notes) L.push(`  · ${n}`)
  }
  L.push('')
  return L.join('\n')
}

// ------------------------------------------------------------- the sources --

/** The walk artefact's row projection → `AuditRow`. `storedOutcome10` is
 * preferred WHENEVER THE KEY EXISTS, including when it is null: null is the
 * walk's own statement that the engine never graded the row, and the sibling
 * `outcome10` is a harness recomputation over the untruncated tape that the
 * engine never saw. Reading the recomputed one would credit calibration with
 * increments that were never made. */
export function rowsFromArtefact(run: {
  from?: string
  to?: string
  days?: { date: string; ledger?: Record<string, unknown>[] }[]
}): { rows: AuditRow[]; dates: number; datesWithRows: number } {
  const rows: AuditRow[] = []
  let datesWithRows = 0
  for (const d of run.days ?? []) {
    const ledger = d.ledger ?? []
    if (ledger.length) datesWithRows++
    for (const raw of ledger) {
      const r = raw as Record<string, unknown>
      const stored = 'storedOutcome10' in r ? (r.storedOutcome10 as AuditRow['outcome10']) : (r.outcome10 as AuditRow['outcome10'])
      rows.push({
        date: d.date,
        sym: String(r.sym ?? ''),
        side: r.side === 'short' ? 'short' : 'long',
        regime: String(r.regime ?? 'unknown'),
        composite: Number(r.composite ?? 0),
        capUsdM: (r.capUsdM as number | null | undefined) ?? null,
        setup: (r.setup as string | null | undefined) ?? null,
        accrual: (r.accrual as AuditRow['accrual']) ?? null,
        riskPct: typeof r.riskPct === 'number' ? r.riskPct : null,
        shadow: !!r.shadow,
        watchOnly: !!r.watchOnly,
        wildcard: r.wildcard != null,
        instrument: (r.instrument as string | null | undefined) ?? null,
        outcome10: stored ?? null,
      })
    }
  }
  return { rows, dates: (run.days ?? []).length, datesWithRows }
}

/** Every store key this audit touches, named once. Nothing else is read, and
 * NOTHING is written — see `readOnly`. */
export const AUDIT_KEYS = {
  index: 'predictions-index',
  predictions: (date: string) => `predictions:${date}`,
  calibration: 'engine-calibration',
  weights: 'engine-weights',
  traceIndex: FUNNEL_TRACE_INDEX_KEY,
  trace: funnelTraceKey,
  missLedger: MISS_LEDGER_KEY,
  gateState: GATE_STATE_KEY,
} as const

/** THE READ-ONLY WRAPPER. The audit is run against production by a human on the
 * day the phase ships; "it only reads" must be a property of the object, not of
 * my care. Every write path throws before it reaches a backend. */
export function readOnly<S extends { read<T>(key: string): Promise<T | null> }>(store: S): { read<T>(key: string): Promise<T | null>; write(key: string): Promise<never> } {
  return {
    read: <T,>(key: string) => store.read<T>(key),
    write: (key: string) => Promise.reject(new Error(`BLOCKED: crypto-audit is READ-ONLY and tried to write '${key}'`)),
  }
}

// ------------------------------------------------------------------- main --

const arg = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/** Fail-soft read: a missing/typeless/broken blob becomes null AND a note,
 * never an exception that ends the audit. */
const soft = async <T,>(label: string, notes: string[], fn: () => Promise<T | null>): Promise<T | null> => {
  try {
    const v = await fn()
    if (v == null) notes.push(`${label}: absent`)
    return v
  } catch (e) {
    notes.push(`${label}: UNREADABLE (${e instanceof Error ? e.message : String(e)})`)
    return null
  }
}

export async function main(): Promise<void> {
  const artefactPath = process.argv.includes('--artefact') ? arg('artefact') : null
  const jsonOut = process.argv.includes('--json') ? arg('json') : null
  const notes: string[] = []
  let report: CryptoAuditReport

  if (artefactPath) {
    const run = JSON.parse(readFileSync(artefactPath, 'utf8')) as {
      from?: string
      to?: string
      days?: { date: string; ledger?: Record<string, unknown>[]; trace?: { rows?: Record<string, { gate: string }> } }[]
      calibrationFinal?: CalibrationState | null
      missLedgerFinal?: { gates?: Record<string, never>; days?: Record<string, unknown> } | null
      gateStateFinal?: unknown
      watchlist?: string[]
    }
    const { rows, dates, datesWithRows } = rowsFromArtefact(run)
    const cal = run.calibrationFinal ?? null
    const ml = run.missLedgerFinal ?? null
    const measured = new Set(Object.keys(ml?.days ?? {}))
    const traces: TraceLike[] = (run.days ?? []).map(d => ({ date: d.date, rows: (d.trace?.rows ?? {}) as TraceLike['rows'] }))
    const crypto = rows.filter(isCryptoRow)
    const gradedCrypto = crypto.filter(r => r.outcome10 != null)
    notes.push('The artefact carries no factor vectors and no weights blob, so the IC section is a BOUND. Run --live for the exact per-factor split.')
    if (run.watchlist?.length) notes.push(`This artefact's walk ran with --watchlist ${run.watchlist.join(',')}.`)
    report = {
      source: { kind: 'artefact', ref: artefactPath, window: { from: run.from ?? null, to: run.to ?? null } },
      at: new Date().toISOString(),
      history: auditHistory(rows, dates, datesWithRows),
      calibration: auditCalibration(gradedCrypto, cal, cal?.brier?.length ?? 0),
      ic: auditIc(gradedCrypto, null),
      ladder: auditLadder(gradedCrypto),
      gates: auditGates(traces, measured, ml, run.gateStateFinal ?? null, gradedCrypto),
      notes,
    }
  } else {
    // LIVE. The backend is selected before a single key is touched — the same
    // rule scripts/bg/ works under, for the same reason: an audit that silently
    // read an empty in-memory store would report "no contamination" with total
    // confidence and be wrong.
    const { configureStoreForScript } = await import('./lib/configureStore')
    const { appStore } = await import('../netlify/functions/lib/storeProvider')
    const backend = await configureStoreForScript()
    const store = readOnly(appStore)
    const maxDays = Number(arg('days', '250')) || 250
    const index = (await soft('predictions-index', notes, () => store.read<string[]>(AUDIT_KEYS.index))) ?? []
    const dates = index.slice(-maxDays)
    const rows: AuditRow[] = []
    let datesWithRows = 0
    for (const date of dates) {
      const preds = await soft(`predictions:${date}`, notes, () => store.read<Record<string, unknown>[]>(AUDIT_KEYS.predictions(date)))
      if (!preds?.length) continue
      datesWithRows++
      for (const p of preds)
        rows.push({
          date,
          sym: String(p.sym ?? ''),
          side: p.side === 'short' ? 'short' : 'long',
          regime: String(p.regime ?? 'unknown'),
          composite: Number(p.composite ?? 0),
          capUsdM: (p.capUsdM as number | null | undefined) ?? null,
          setup: (p.setup as string | null | undefined) ?? null,
          accrual: (p.accrual as AuditRow['accrual']) ?? null,
          riskPct: typeof p.riskPct === 'number' ? p.riskPct : null,
          shadow: !!p.shadow,
          watchOnly: !!p.watchOnly,
          wildcard: p.wildcard != null,
          instrument: (p.instrument as string | null | undefined) ?? null,
          provenance: p.provenance as AuditRow['provenance'],
          outcome10: (p.outcome10 as AuditRow['outcome10']) ?? null,
          factors: (p.factors as AuditRow['factors']) ?? null,
        })
    }
    const cal = await soft('engine-calibration', notes, () => store.read<CalibrationState>(AUDIT_KEYS.calibration))
    const weights = await soft('engine-weights', notes, () => store.read<WeightsState>(AUDIT_KEYS.weights))
    const ml = await soft('miss-ledger', notes, () => store.read<{ gates?: Record<string, never>; days?: Record<string, unknown> }>(AUDIT_KEYS.missLedger))
    const gateState = await soft('gate-state', notes, () => store.read<unknown>(AUDIT_KEYS.gateState))
    const traceIndex = (await soft('funnel-trace-index', notes, () => store.read<string[]>(AUDIT_KEYS.traceIndex))) ?? []
    const traces: TraceLike[] = []
    for (const date of traceIndex.slice(-maxDays)) {
      const t = await soft(`funnel-trace:${date}`, notes, () => store.read<{ rows?: Record<string, { gate: string }> }>(AUDIT_KEYS.trace(date)))
      if (t) traces.push({ date, rows: (t.rows ?? {}) as TraceLike['rows'] })
    }
    const crypto = rows.filter(isCryptoRow)
    const gradedCrypto = crypto.filter(r => r.outcome10 != null)
    notes.push(`store backend: ${backend} · READ-ONLY (writes throw)`)
    report = {
      source: { kind: 'live', ref: `store=${backend}`, window: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null } },
      at: new Date().toISOString(),
      history: auditHistory(rows, dates.length, datesWithRows),
      calibration: auditCalibration(gradedCrypto, cal, cal?.brier?.length ?? 0),
      ic: auditIc(gradedCrypto, weights),
      ladder: auditLadder(gradedCrypto),
      gates: auditGates(traces, new Set(Object.keys(ml?.days ?? {})), ml, gateState, gradedCrypto),
      notes,
    }
  }

  console.log(renderReport(report))
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2))
    console.log(`json → ${jsonOut}`)
  }
}

// tsx runs this file directly; vitest imports it for the pure functions above.
if (process.argv[1]?.includes('crypto-audit'))
  main().catch(e => {
    console.error('crypto-audit failed:', e)
    process.exit(1)
  })
