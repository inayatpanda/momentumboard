import type { Candle } from '../types'
import { DIP_CATALYST_KIND } from './catalyst'
import { DIP_WINDOW, dipWindowLow } from './dipLane'
import { effectiveVelocityStop } from './velocityLane'
import { round2, type PredOutcome } from './types'

// EVERY LOSER EXPLAINS ITSELF.
//
// A graded loss says how much was lost and nothing about WHY, so the ledger has
// spent its whole life reading "−6.6pp" and leaving the reader — and the engine —
// to guess between four completely different failures: the stop did its job, the
// structure the call was built on gave way, the tape took everybody down, or the
// name simply went the other way. Those four want four different fixes, and
// pooling them under "it lost" is why no gate has ever been able to learn from a
// bad fortnight.
//
// This module is the deterministic floor: a class and a plain sentence, computed
// from data already in scope where the loser becomes known, for EVERY graded
// loser — sized, watch, shadow alike, because a shadow's failure is exactly the
// audition the shadow was published to run. No fetch, no LLM, no I/O. Stage 3b
// Task 3 adds ONE budgeted LLM sentence on top for the paper's sized losers, and
// it may only ever add: the class below stands whatever the model says, except
// for the one upgrade path named at the bottom of this comment.
//
// THE CLASSES ARE NOT DISJOINT — THAT IS THE WHOLE PROBLEM (recon §4.1). The
// spec's four names describe overlapping events: a stopped row has usually also
// broken its structure (the falsifier IS the stop the alerts watch, spec §4.2),
// and a stopped row can perfectly well have beaten SPY on the way down. So the
// order below is not a formality, it is the definition, and it is pinned by test:
//
//   1. stopped ....... `o.stopped` — the published falsifier fired. The engine
//                      said what would prove it wrong, the tape did that, and no
//                      other reading of the row may speak over it.
//   2. thesis-break .. the row carried a STRUCTURAL level ABOVE its stop and lost
//                      it while the stop itself held. Only two such levels exist
//                      today, and both are recomputed from the tape rather than
//                      parsed out of prose: the velocity lane's ratcheted trail
//                      (`effectiveVelocityStop`) and the dip lane's dip-window
//                      low. A row that carries neither can NEVER read
//                      thesis-break — inventing a level the engine never
//                      published would be the one dishonest class here.
//   3. market-drag ... excess ≥ 0: it lost the BAR (the hit needs +1pp, and this
//                      row did not get there) while still beating the tape. The
//                      detail says so, because "we were right and the market
//                      wasn't in the mood" is a different lesson from "we were
//                      wrong", and only one of them argues for changing a gate.
//   4. adverse-move .. the fallback, with the raw numbers, and honest about being
//                      a fallback: nothing broke, we were simply on the wrong
//                      side of the move.
//
// `news-reversal` is DELIBERATELY UNREACHABLE from here. Reading a catalyst's
// tone as of ten sessions later needs a fresh news call on a name that may no
// longer be a candidate — an I/O question this pure module has no business
// answering, and a guess it must never make from the stale `catalyst.reason` it
// happens to carry. Task 3's budgeted LLM pass is its ONLY door, and only when
// the model affirms a tone flip; every failure, every overflow, leaves the
// deterministic class standing.

/** The five names, in precedence order. `news-reversal` sits where the spec puts
 * it (recon §4.1) and is assigned only by the LLM pass — see the header.
 *
 * …and a SIXTH that is not in the precedence at all: `won`. Stage 3d's wildcard
 * slot is post-mortemed on EVERY closure, win or lose (spec §4.1), because an
 * experiment whose successes go unexamined is not an experiment — the whole
 * point of overriding a gate is to find out what happened, and "it worked" is
 * half of what can happen. `classifyLoser` cannot say that: handed a winner its
 * total order would return `market-drag` — "beat the tape and still missed the
 * bar" — about a row that cleared the bar, which is simply false. So the winning
 * branch is its own name, assigned by `classifyOutcome` below and by nothing
 * else. No ordinary row can reach it: the caller still stamps winners with
 * nothing at all, exactly as it always has. */
export const POSTMORTEM_CLASSES = ['stopped', 'thesis-break', 'market-drag', 'news-reversal', 'adverse-move', 'won'] as const
export type PostMortemClass = (typeof POSTMORTEM_CLASSES)[number]

/** The CALIBRATED horizon, and the same window `gradePrediction` walked to decide
 * `o.stopped` — entry session inclusive, ten sessions on. A post-mortem that
 * looked at a different window could contradict the outcome it is explaining. */
export const POSTMORTEM_HORIZON = 10

export interface PostMortem {
  cls: PostMortemClass
  /** One plain sentence: the level, the day it went, and the numbers. Written to
   * be read by a human in the ledger without opening anything else. */
  detail: string
  /** When the class was decided (grading time), not when the row was called. */
  at: number
  /** THE PAPER'S SENTENCE (netlify/functions/lib/postMortemLlm.ts) — one plain
   * line bought for the run's sized losers, at most POSTMORTEM_LLM_BUDGET of
   * them. ADDITIVE and always optional: `detail` above is the floor and stands
   * whatever happens here. */
  sentence?: string
  /** Set only by the news-reversal upgrade: the deterministic class it replaced,
   * so the roll-up's consumers can recover the stopped population without
   * regexing prose (Task-3 review). */
  clsBefore?: PostMortemClass
  /** WHY there is no sentence, when there is none — 'llm' wrote one, 'budget'
   * means the row was past the run's cap and was never asked, 'failed' means it
   * was asked and nothing usable came back. Absent means neither happened (the
   * provider chain was already down, or the pass never ran at all). A silence
   * with no cause recorded is exactly what Stage 3 exists to end. */
  via?: 'llm' | 'budget' | 'failed'
}

/** Everything the classification reads off a `Prediction`, and nothing else —
 * structural so the tests can state a row in four lines and so this module never
 * grows a dependency on the full prediction shape. */
export interface PostMortemRow {
  side: 'long' | 'short'
  date: string
  /** The PUBLISHED stop — the number grading measured (calibration.ts). */
  stop: number
  /** Stamped by the velocity lane only: this row's falsifier is a live trail. */
  trail?: 'velocity'
  catalyst?: { kind: string; reason: string } | null
}

const isoDay = (tSec: number) => new Date(tSec * 1000).toISOString().slice(0, 10)
const signed = (x: number) => (x > 0 ? `+${x}` : `${x}`)

/** The grading window on this tape, or null when the tape cannot reach the call.
 * Resolved exactly the way `gradePrediction` resolves it (first candle at or
 * after the call date); the tail is clamped rather than refused, so a short tape
 * degrades to a shorter walk instead of losing the class entirely. */
function windowOf(pred: PostMortemRow, candles: Candle[]): { entryIdx: number; lastIdx: number } | null {
  const dayEpoch = Date.parse(pred.date) / 1000
  if (!Number.isFinite(dayEpoch) || candles.length === 0) return null
  const entryIdx = candles.findIndex(c => c.t >= dayEpoch)
  if (entryIdx === -1) return null
  return { entryIdx, lastIdx: Math.min(candles.length - 1, entryIdx + POSTMORTEM_HORIZON) }
}

/** First session in the window whose CLOSE is through `level` on this row's side,
 * or -1. Close-based, like grading: a wick through a level is survivable noise
 * (calibration.ts), and a post-mortem that fired on wicks would name days the
 * grade never counted. */
function breachIdx(candles: Candle[], from: number, to: number, side: 'long' | 'short', level: number): number {
  for (let i = from; i <= to; i++) if (side === 'long' ? candles[i].c <= level : candles[i].c >= level) return i
  return -1
}

export interface StructuralBreak {
  /** The level that gave way — always strictly above (long) the published stop. */
  level: number
  /** Index into `candles` of the session it went. */
  idx: number
  /** What the level is called in the row's own language. */
  name: string
}

/** The row's structural level, and whether it broke inside the window while the
 * published stop held.
 *
 * ONLY TWO LEVELS QUALIFY, and both are recomputed from the tape:
 *
 *  - VELOCITY (`trail: 'velocity'`): the lane's ratcheted trail, re-drawn session
 *    by session exactly as `openTrace` re-draws it, floored at the published
 *    stop. LONG ONLY, by construction — `effectiveVelocityStop` takes a running
 *    max, which on a short would loosen forever (velocityLane.ts).
 *  - DIP (`catalyst.kind === 'dip'`): the dip-window low as it stood on the
 *    PUBLICATION session — the bar BEFORE `pred.date`. The engine publishes
 *    pre-open from bars strictly before the entry session (calibration.ts's
 *    entry-open note; velocityLane.ts's "drawn from the session BEFORE"), so
 *    the published stop is `min(dipWindowLow(bars ≤ entryIdx−1), low[entryIdx−1])`.
 *    Recomputing on the ENTRY basis instead would re-include the very bar whose
 *    low set the stop — suppressing every true dip thesis-break and inventing
 *    levels the card never carried (Task-2 review, Critical).
 *
 * Returns null the moment the level does not exist, does not sit above the stop,
 * or never gave way. The bar for claiming "the thesis broke" is a level the row
 * actually carried. */
export function structuralBreak(pred: PostMortemRow, candles: Candle[], entryIdx: number, lastIdx: number): StructuralBreak | null {
  if (pred.trail === 'velocity') {
    if (pred.side !== 'long') return null
    for (let i = entryIdx; i <= lastIdx; i++) {
      // the ratchet as the tape had drawn it BY that session — the same call
      // openTrace makes, so the two narratives can never name different levels
      const level = effectiveVelocityStop(pred.stop, candles.slice(0, i + 1), entryIdx)
      if (level > pred.stop && candles[i].c <= level) return { level: round2(level), idx: i, name: 'velocity trail' }
    }
    return null
  }
  if (pred.catalyst?.kind === DIP_CATALYST_KIND && pred.side === 'long') {
    // the low as of the PUBLICATION session: dipWindowLow reads the DIP_WINDOW
    // sessions before the last candle handed in, and publication is entryIdx−1,
    // so the slice ends BEFORE the entry bar. The published stop is round2ed
    // (dipLane.ts), so compare rounded-to-rounded or a sub-penny sliver reads
    // as a "level" one rounding step above the stop.
    if (entryIdx <= DIP_WINDOW) return null
    const low = dipWindowLow(candles.slice(0, entryIdx))
    if (low == null || !(round2(low) > pred.stop)) return null
    const idx = breachIdx(candles, entryIdx, lastIdx, 'long', low)
    return idx === -1 ? null : { level: round2(low), idx, name: 'dip low' }
  }
  return null
}

/** THE PINNED TOTAL ORDER (see the header). Pure, total, and never throws: every
 * loser gets a class, including one whose tape has gone missing.
 *
 * Meaningful only for `o.hit === false` — the caller gates on that. Handed a
 * winner it would still answer, and the answer would be nonsense, so it is not
 * called for one. */
export function classifyLoser(pred: PostMortemRow, o: PredOutcome, candles: Candle[]): { cls: PostMortemClass; detail: string } {
  const w = windowOf(pred, candles)
  const nums = `${signed(o.rawPct)}% vs SPY ${signed(o.spyPct)}%, excess ${signed(o.excessPct)}pp`
  const when = (idx: number) => (w ? `on ${isoDay(candles[idx].t)} (session ${idx - w.entryIdx + 1})` : '')

  if (o.stopped) {
    const idx = w ? breachIdx(candles, w.entryIdx, w.lastIdx, pred.side, pred.stop) : -1
    const day = idx === -1 ? 'inside the ten sessions' : when(idx)
    return { cls: 'stopped', detail: `closed through the ${pred.stop} stop ${day} — ${nums}` }
  }

  const broke = w ? structuralBreak(pred, candles, w.entryIdx, w.lastIdx) : null
  if (broke) {
    return {
      cls: 'thesis-break',
      detail: `held the ${pred.stop} stop but closed under the ${broke.level} ${broke.name} ${when(broke.idx)} — ${nums}`,
    }
  }

  // excess ≥ 0 on a row that was never stopped: the call was not wrong about the
  // name, it was short of the +1pp bar a hit is defined by (HIT_EXCESS_MIN).
  if (o.excessPct >= 0) {
    return { cls: 'market-drag', detail: `beat the tape by ${o.excessPct}pp and still missed the bar — ${nums}` }
  }

  return { cls: 'adverse-move', detail: `no level broke — it simply went the other way: ${nums}` }
}

/** THE UNCONDITIONAL READ — a class for a closure whichever way it went.
 *
 * `classifyLoser` above is the engine's ordinary hook and stays loser-only:
 * winners get no post-mortem, no LLM sentence, and no row in the how-we-lose
 * roll-up. The ONE population that is examined either way is the wildcard slot
 * (spec §4.1: "mandatory post-mortem win or lose"), and this is the predicate it
 * uses — the same site in the grading pass, a different question.
 *
 * A winner's line is the numbers and the fact the stop held, and NOTHING about
 * why: the honest thing an outcome can say about a hypothesis it confirmed is
 * that it confirmed it. Whether one causal win should move a gate is the miss
 * ledger's arithmetic (`accrueCausalOutcome`), not a sentence's. */
export function classifyOutcome(pred: PostMortemRow, o: PredOutcome, candles: Candle[]): { cls: PostMortemClass; detail: string } {
  if (!o.hit) return classifyLoser(pred, o, candles)
  const nums = `${signed(o.rawPct)}% vs SPY ${signed(o.spyPct)}%, excess ${signed(o.excessPct)}pp`
  return { cls: 'won', detail: `cleared the bar with the ${pred.stop} stop ${o.stopped ? 'hit on the way' : 'never touched'} — ${nums}` }
}

/** The scorecard's key: setup family × regime × class, exactly the aggregation the
 * spec asks for ("so the engine knows HOW it loses"). A row with no setup read is
 * counted under `unknown` rather than dropped — a population that vanishes from
 * the roll-up is the silence Stage 3 exists to end.
 *
 * `'won'` is the one class that never reaches this key: the roll-up is HOW THE
 * ENGINE LOSES, and a win is not one of the ways. The caller (engine.ts's
 * scorecard pass) holds that exclusion rather than this function, because the
 * key is also what a reader of a single row's post-mortem would build, and a
 * winning wildcard genuinely has a class — it simply has no place in this
 * particular sum. Its record lives in the miss ledger's causal column. */
export const postMortemKey = (setup: string | null | undefined, regime: string, cls: PostMortemClass): string => `${setup || 'unknown'}:${regime}:${cls}`
