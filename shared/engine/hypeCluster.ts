// Hype clusters, detected from the tape's own record. NO THEME IS EVER HARD-CODED.
//
// The spec this implements asked for "co-mention clusters", and the data for that
// does not exist: combineSocialPulse returns ONE day's independent trending ranks
// — a list, not a graph. There is no co-mention count anywhere in the pipeline and
// no history to count it over [C8]. Inventing a theme list ("quantum names",
// "drone names") would have been the easy substitute and a lie: it would elevate
// whatever a developer typed in 2026 for as long as the file lives.
//
// So the cluster is DISCOVERED, from two records the engine can actually keep:
//
//   1. Co-appearance — both names in the trending set on >= CO_APPEAR_MIN of the
//      last CO_APPEAR_WINDOW RECORDED days (the `social-history` blob, written
//      once a day by buildBoard). One shared day is a coincidence; three of five
//      is a crowd looking at the same thing.
//   2. Co-movement — Pearson >= CORR_MIN on EXCESS daily returns (each name's
//      return minus SPY's for the SAME date) over the last CORR_WINDOW sessions,
//      requiring >= CORR_MIN_OVERLAP truly overlapping observations, every one of
//      them a single honest session, and the newest of them within
//      MAX_SAMPLE_STALENESS sessions of the index's own newest bar. Excess, not
//      raw, because on a +2% index day every long name "moves together"; that is
//      beta, not a theme. A real sample, because a 2-point correlation is always
//      +/-1 and never evidence. A FRESH sample, because the crowd is naming these
//      names this week and a correlation from two months ago is a different market.
//      And one return per session, because a name that stopped printing bars emits
//      a multi-day compounded move keyed to one date, which is not a session.
//
// An edge needs BOTH legs — the crowd naming them together AND the tape agreeing.
// Either alone is noise: names trend together for calendar reasons (an index
// rebalance, an earnings week), and names co-move for beta reasons.
//
// A cluster is then a connected component of size >= MIN_CLUSTER_SIZE in which
// EVERY member holds MIN_DEGREE edges — the 2-core, computed by stripping
// under-linked names until nothing more can be stripped. A bare A-B-C chain is not
// a cluster: it is one bridge with a name on each end, and elevating all three on
// the strength of B's two relationships would be the graph doing the pretending.
// A pendant hanging off a real triangle loses the pendant and keeps the triangle.
//
// PURE MODULE. Candles in (already fetched, bounded and capped by the caller),
// symbol lists out. No fetching, no blobs, no LLM — cluster detection runs BEFORE
// candidate priority in buildBoard, where `candleMap` does not exist yet, so the
// caller owns the fetch and this file owns only the maths [codex-v2 #1].
//
// Clusters ELEVATE priority; they are never eligibility and never a call. Under
// MIN_HISTORY_DAYS of record the answer is [] — a warm-up with no verdict, which
// costs nothing precisely because nothing downstream depends on a cluster existing.

import type { Candle } from '../types'
import { pearson } from './types'

/** One day's trending record: the date it was taken and the names in it. */
export interface TrendDay {
  date: string // London date, YYYY-MM-DD — the key buildBoard already stamps blobs with
  syms: string[]
}

/** How many days of trending record the `social-history` blob keeps. */
export const TREND_HISTORY_DAYS = 21
/** How many of a day's trending names are recorded. */
export const TREND_DAY_SYMS = 15
/** Under this many RECORDED days there is no verdict at all — the warm-up. */
export const MIN_HISTORY_DAYS = 7
/** The co-appearance leg's window, and how many of those days a pair must share. */
export const CO_APPEAR_WINDOW = 5
export const CO_APPEAR_MIN = 3
/** The co-move leg: sessions looked at, observations required, and the bar. */
export const CORR_WINDOW = 20
export const CORR_MIN_OVERLAP = 15
export const CORR_MIN = 0.6
/** How many CALENDAR days a single return may bridge. Four is the market's own
 * longest routine break — Friday→Monday is three, a Good-Friday or Christmas
 * weekend four — so weekends and shared holidays survive and a halt does not. */
export const MAX_BAR_GAP_DAYS = 4
/** How far behind the index's newest session a co-move sample may end, in index
 * sessions. A name can be quiet for a week; it cannot be a month absent and still
 * be evidence about the week the crowd is naming it. */
export const MAX_SAMPLE_STALENESS = 5
/** A cluster's shape: how many names, and how many edges each of them must hold. */
export const MIN_CLUSTER_SIZE = 3
export const MIN_DEGREE = 2

const norm = (s: string) => s.trim().toUpperCase()

/** The UTC day a daily bar belongs to. Bars from one provider carry one stamping
 * convention (midnight, or the session close), and every convention lands inside
 * the session's own UTC day — so this is the join key for two series fetched
 * separately, and the reason the overlap count below is a count of real sessions. */
const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)

/** Calendar days between two `dayOf` keys. Both parse as UTC midnight, so this is
 * exact integer arithmetic and not a timezone question. */
const gapDays = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000

interface Day {
  date: string
  syms: Set<string>
}

/** The blob, made safe to reason about: junk entries dropped, symbols normalised,
 * ONE entry per date, oldest first. The dedupe is not paranoia about the writer — it
 * is what makes "three of the last five days" a count of days rather than a count of
 * rows.
 *
 * Which row wins, precisely: the LAST one in blob order for that date, because the
 * later `byDate.set` overwrites the earlier. The writer (recordTrendDay) refuses to
 * append a second row for a date it already holds, so in practice the surviving row
 * IS the day's first recording — but that is the writer's discipline, not something
 * this function restores. If two rows for one date ever do reach the blob (two runs
 * racing, a hand-edit, a restored snapshot), the last of them is the one read [review]. */
function normaliseHistory(history: TrendDay[] | null | undefined): Day[] {
  const byDate = new Map<string, Set<string>>()
  for (const d of history ?? []) {
    if (!d || typeof d.date !== 'string' || !d.date || !Array.isArray(d.syms)) continue
    byDate.set(
      d.date,
      new Set(
        d.syms
          .filter((s): s is string => typeof s === 'string')
          .map(norm)
          .filter(Boolean),
      ),
    )
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([date, syms]) => ({ date, syms }))
}

/** Daily returns keyed by the date of the LATER bar — the stamp both series are
 * joined on. One bar per day (last wins), so a duplicated session cannot print a
 * 0% return and dilute the correlation.
 *
 * A return that bridges MORE than MAX_BAR_GAP_DAYS calendar days is not a return and
 * is dropped. A name missing bars — a halt, a suspension, a provider hole — otherwise
 * emits ONE compounded multi-session move stamped with a single date, gets correlated
 * against SPY's one-day return for that date as though the two were comparable, and
 * counts as one of the CORR_MIN_OVERLAP observations the leg is supposed to require
 * [review]. Weekends and shared holidays sit inside the bound and survive. */
function returnsByDate(candles: Candle[] | null | undefined): Map<string, number> {
  const byDay = new Map<string, number>()
  for (const c of [...(candles ?? [])].filter(c => c && Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t)) {
    byDay.set(dayOf(c.t), c.c)
  }
  const days = [...byDay.keys()] // ascending: insertion followed sorted t
  const out = new Map<string, number>()
  for (let i = 1; i < days.length; i++) {
    if (gapDays(days[i - 1], days[i]) > MAX_BAR_GAP_DAYS) continue
    const prev = byDay.get(days[i - 1])!
    if (prev > 0) out.set(days[i], (byDay.get(days[i])! - prev) / prev)
  }
  return out
}

/** Excess return vs the index, per date. A session the index has no return for is
 * DROPPED rather than treated as a 0% index day: an unpriced benchmark is not a
 * flat benchmark, and pretending otherwise smuggles beta back into the leg. */
function excessByDate(candles: Candle[], spyRets: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [date, r] of returnsByDate(candles)) {
    const s = spyRets.get(date)
    if (s == null) continue
    out.set(date, r - s)
  }
  return out
}

/** The pairs that clear the co-appearance leg inside the window. */
function coAppearingPairs(window: Day[]): [string, string][] {
  const daysOf = new Map<string, number>()
  for (const d of window) for (const s of d.syms) daysOf.set(s, (daysOf.get(s) ?? 0) + 1)
  // A name that did not trend on CO_APPEAR_MIN days of its own cannot share that
  // many with anyone — checking it first keeps the pair loop small.
  const regulars = [...daysOf.entries()]
    .filter(([, n]) => n >= CO_APPEAR_MIN)
    .map(([s]) => s)
    .sort()
  const pairs: [string, string][] = []
  for (let i = 0; i < regulars.length; i++) {
    for (let j = i + 1; j < regulars.length; j++) {
      const [a, b] = [regulars[i], regulars[j]]
      if (window.filter(d => d.syms.has(a) && d.syms.has(b)).length >= CO_APPEAR_MIN) pairs.push([a, b])
    }
  }
  return pairs
}

/** Every symbol already in a co-appearing pair — the ONLY names whose candles a
 * cluster check needs, so the caller can bound its fetch to exactly this list
 * (and cap it) instead of fetching the whole trending record [codex-v2 #1]. */
export function clusterCandidates(history: TrendDay[] | null | undefined): string[] {
  const days = normaliseHistory(history)
  if (days.length < MIN_HISTORY_DAYS) return []
  const out = new Set<string>()
  for (const [a, b] of coAppearingPairs(days.slice(-CO_APPEAR_WINDOW))) {
    out.add(a)
    out.add(b)
  }
  return [...out].sort()
}

/** The clusters today's record supports: sorted symbol lists, biggest first.
 *
 * `candlesBySym` and `spyCandles` are the caller's own bounded fetch (see
 * clusterCandidates) — a name with no tape simply forms no edges, which is the
 * honest reading of "we don't know" and can only ever cost elevation. */
export function detectClusters(
  history: TrendDay[] | null | undefined,
  candlesBySym: Map<string, Candle[]> | null | undefined,
  spyCandles: Candle[] | null | undefined,
): string[][] {
  const days = normaliseHistory(history)
  if (days.length < MIN_HISTORY_DAYS) return []
  const spyRets = returnsByDate(spyCandles)
  if (!spyRets.size) return [] // no benchmark → no excess → no co-move leg → no edges

  // The index tape is fetched on THIS run, so its newest session is the market's
  // "now" and it is the only clock this pure module has. Every co-move sample must
  // reach within MAX_SAMPLE_STALENESS sessions of it.
  const spyDates = [...spyRets.keys()].sort()
  const freshest = spyDates[Math.max(0, spyDates.length - 1 - MAX_SAMPLE_STALENESS)]

  const pairs = coAppearingPairs(days.slice(-CO_APPEAR_WINDOW))
  if (!pairs.length) return []

  // Symbol keys are matched normalised, so a caller keying its map off a raw feed
  // never silently loses a tape.
  const tapes = new Map<string, Candle[]>()
  for (const [k, v] of candlesBySym ?? []) if (typeof k === 'string' && v?.length) tapes.set(norm(k), v)
  const excess = new Map<string, Map<string, number>>()
  const excessOf = (sym: string): Map<string, number> | null => {
    if (!excess.has(sym)) {
      const tape = tapes.get(sym)
      excess.set(sym, tape ? excessByDate(tape, spyRets) : new Map())
    }
    const e = excess.get(sym)!
    return e.size ? e : null
  }

  const adj = new Map<string, Set<string>>()
  for (const [a, b] of pairs) {
    const ea = excessOf(a)
    const eb = excessOf(b)
    if (!ea || !eb) continue
    // DATED alignment: the sample is the dates BOTH names priced, and the overlap
    // rule counts those. Tail-position pairing would have handed two series from
    // different date ranges a full-length sample of nonsense [codex-v2 #1].
    const shared = [...ea.keys()]
      .filter(d => eb.has(d))
      .sort()
      .slice(-CORR_WINDOW)
    if (shared.length < CORR_MIN_OVERLAP) continue
    // RECENCY: a long sample is not the same thing as a CURRENT one. Two delisted or
    // long-halted tapes still share twenty dated sessions with each other, and their
    // correlation over that stretch is real — about a market two months gone. The
    // co-appearance leg is measured on this week's trending record, so the co-move
    // leg has to be measured on a tape that is still printing, or the edge is two
    // unrelated facts stapled together [review].
    if (shared[shared.length - 1] < freshest) continue
    const r = pearson(
      shared.map(d => ea.get(d)!),
      shared.map(d => eb.get(d)!),
    )
    if (r == null || r < CORR_MIN) continue
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }

  // The 2-core: strip every name holding under MIN_DEGREE edges and repeat, because
  // stripping one name can under-link its neighbour. A chain dissolves entirely; a
  // triangle with a pendant loses the pendant and survives.
  const alive = new Set(adj.keys())
  for (let changed = true; changed; ) {
    changed = false
    for (const sym of [...alive]) {
      if ([...adj.get(sym)!].filter(s => alive.has(s)).length < MIN_DEGREE) {
        alive.delete(sym)
        changed = true
      }
    }
  }

  const seen = new Set<string>()
  const clusters: string[][] = []
  for (const start of [...alive].sort()) {
    if (seen.has(start)) continue
    const comp: string[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      for (const nb of adj.get(cur)!) {
        if (alive.has(nb) && !seen.has(nb)) {
          seen.add(nb)
          stack.push(nb)
        }
      }
    }
    if (comp.length >= MIN_CLUSTER_SIZE) clusters.push(comp.sort())
  }
  // Deterministic order — biggest crowd first, then alphabetical. Downstream
  // elevation must not depend on Map iteration order.
  return clusters.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
