import type { Candle } from '../types'
import { technicalStage, type Stage } from '../technicals'
import { effectiveVelocityStop } from './velocityLane'
import { round1 } from './types'

// THE OPEN BOOK: every live call that hasn't been graded yet, re-checked each
// morning. Two layers, kept deliberately separate:
//   • the WALK — mechanical fact: closes since entry vs the published stop and
//     target (same daily-close basis as grading and the £10k book);
//   • the VERDICT — opinion, in-play calls only: would the engine still take
//     this trade today?
// DISPLAY-ONLY by contract: nothing here ever touches the prediction blobs or
// the grading yardstick — the trace narrates, it never re-writes.
//
// ONE EXCEPTION TO "vs the published stop", AND IT IS DELIBERATE. A row stamped
// `trail: 'velocity'` was published with a stop that is a FALSIFIER, not a level:
// the velocity lane's max(8-EMA, prior-five low), which moves with the tape. For
// those rows the walk re-reads that trail against the tape as of each session and
// compares the close to max(published stop, trail) — so a momentum call that loses
// its trail is reported dead on the day it died, not a fortnight later when a much
// lower published number finally gives way.
//
// THE SPLIT, STATED HONESTLY, because two different numbers now describe one row:
//   • GRADING measures the ORIGINAL THESIS. gradePrediction reads the published
//     `stop` and nothing else, so the calibration contract (CALIB_DEF_VERSION) and
//     the hit definition are untouched by any of this. Grading on the trail would
//     be a hit-definition change and needs its own version bump.
//   • THE BOOKS TRADE THE TRAIL. This trace and the £10k paper book are where the
//     reader's discipline lives — "you would be out of this by now" — and telling a
//     reader to hold a broken momentum name because a stale printed number has not
//     been touched is the failure this exists to prevent.
// A row can therefore read "stopped" here while its formal grade, ten sessions on,
// measures something the trail never had to survive. That is the intended split,
// not a bug; `stop` on every entry is always the PUBLISHED number, and `trailStop`
// carries the level the walk actually enforced.

export type TraceStatus = 'in-play' | 'stopped' | 'target'
export type TraceVerdict = 'still-on' | 'intact' | 'weakening'

export interface OpenTraceEntry {
  id: string
  sym: string
  name?: string // company display name carried from the prediction row
  side: 'long' | 'short'
  callDate: string
  grade: 'A' | 'B' | 'C'
  entry: number
  stop: number // ALWAYS the published stop — the number grading reads
  target: number
  // Trailed rows only (`trail: 'velocity'`): the effective exit the walk enforced
  // on the last session it looked at — the level that fired for a crossed row, the
  // level the row is judged against right now for an open one. Never below `stop`.
  trailStop?: number
  status: TraceStatus
  crossedDate: string | null // daily close that crossed the stop/target
  last: number // latest close
  movePct: number // side-adjusted move from the published entry level
  progressPct: number | null // % of the entry→target distance covered (signed)
  day: number // sessions since the call, entry session = day 1
  gradesInSessions: number // sessions until the 10-session (calibrated) grade can land
  stage: Stage | null
  requalified: boolean // made today's live board again, same side
  verdict: TraceVerdict | null // in-play only; crossed calls speak for themselves
  note: string
}

// A call is graded 10 sessions after its entry session (the calibrated horizon,
// CALIB_DEF_VERSION v3), so an open call lives through days 1..10 of this clock
// before the ledger takes over.
const GRADE_HORIZON = 10

// Stages that contradict the side: holding a long into these means the setup
// that earned the call is gone; a short fighting a turn-up is the mirror.
export const HOSTILE_STAGES: Record<'long' | 'short', Stage[]> = {
  long: ['falling-knife', 'weak', 'exhausted'],
  short: ['early-reversal', 'pullback', 'trending'],
}

/** The opinion layer: would the engine still take this trade today?
 * `still-on` is EARNED, never inferred — only a full re-score (the name made
 * today's board again on the same side) may claim it. Stage and drift can
 * only downgrade. */
export function verdictFor(
  side: 'long' | 'short',
  stage: Stage | null,
  movePct: number,
  requalified: boolean,
): { verdict: TraceVerdict; why: string } {
  if (requalified) return { verdict: 'still-on', why: "re-qualified on today's board — the engine would take it again" }
  if (stage != null && HOSTILE_STAGES[side].includes(stage)) {
    return { verdict: 'weakening', why: `stage turned ${stage} — the setup that earned the call is gone` }
  }
  if (movePct < 0) return { verdict: 'weakening', why: 'drifting against the call, still inside the stop' }
  return { verdict: 'intact', why: stage ? `moving with the call, stage ${stage}` : 'moving with the call' }
}

const isoDay = (tSec: number) => new Date(tSec * 1000).toISOString().slice(0, 10)

/** Walk one open call through the daily closes since its entry session.
 * Stop checked before target on each close, matching the £10k book; the walk
 * includes the entry session itself, matching gradePrediction. Returns null
 * when the candles don't reach the call date (nothing to walk).
 *
 * A `trail: 'velocity'` row is walked against its LIVE trail instead of a static
 * stop (see the header): each session's close is compared to the trail as the tape
 * had drawn it by that session, floored at the published stop. Every other row —
 * composite, dip, anything future — is compared to the published stop exactly as
 * before, and must be: a trailed exit on a row whose stop is a fixed level would be
 * a fabricated one. */
export function traceOpenCall(
  pred: {
    id: string
    sym: string
    name?: string
    side: 'long' | 'short'
    date: string
    grade: 'A' | 'B' | 'C'
    entry: number
    stop: number
    target: number
    trail?: 'velocity'
  },
  candles: Candle[],
  todayLiveKeys: Set<string>,
): OpenTraceEntry | null {
  const dayEpoch = Date.parse(pred.date) / 1000
  if (!Number.isFinite(dayEpoch) || candles.length === 0) return null
  const entryIdx = candles.findIndex(c => c.t >= dayEpoch)
  if (entryIdx === -1) return null

  const long = pred.side === 'long'
  const trailed = pred.trail === 'velocity'
  let status: TraceStatus = 'in-play'
  let crossedDate: string | null = null
  // The exit level the LAST walked session was judged against. Starts at the
  // published stop, which is also where it stays for every untrailed row.
  let exitLevel = pred.stop
  for (let i = entryIdx; i < candles.length; i++) {
    const close = candles[i].c
    // "as of that day" = the tape through this session's close, the same basis the
    // lane published from — so on the entry session the trail IS the published stop.
    // No rounding needed on the way out: the helper returns one of its two inputs
    // verbatim, and both were rounded to the penny where they were made.
    exitLevel = trailed ? effectiveVelocityStop(pred.stop, candles.slice(0, i + 1)) : pred.stop
    if (long ? close <= exitLevel : close >= exitLevel) {
      status = 'stopped'
      crossedDate = isoDay(candles[i].t)
      break
    }
    if (long ? close >= pred.target : close <= pred.target) {
      status = 'target'
      crossedDate = isoDay(candles[i].t)
      break
    }
  }
  // Raised above the published stop = the tape moved the falsifier, and the reader
  // is owed that number by name. Equal to it = the ordinary stop did the work.
  const trailRaised = trailed && exitLevel > pred.stop

  const last = candles[candles.length - 1].c
  const sign = long ? 1 : -1
  const movePct = pred.entry > 0 ? round1(sign * ((last - pred.entry) / pred.entry) * 100) : 0
  const span = pred.target - pred.entry // signed: negative for shorts, so progress stays +ve when winning
  const progressPct = span !== 0 ? Math.round(((last - pred.entry) / span) * 100) : null
  const day = candles.length - entryIdx // entry session = day 1
  const gradesInSessions = Math.max(0, GRADE_HORIZON + 1 - day)

  const read = technicalStage(pred.sym, candles)
  const requalified = todayLiveKeys.has(`${pred.sym}:${pred.side}`)
  const v = status === 'in-play' ? verdictFor(pred.side, read?.stage ?? null, movePct, requalified) : null

  return {
    id: pred.id,
    sym: pred.sym,
    name: pred.name,
    side: pred.side,
    callDate: pred.date,
    grade: pred.grade,
    entry: pred.entry,
    stop: pred.stop,
    target: pred.target,
    trailStop: trailed ? exitLevel : undefined,
    status,
    crossedDate,
    last,
    movePct,
    progressPct,
    day,
    gradesInSessions,
    stage: read?.stage ?? null,
    requalified,
    verdict: v?.verdict ?? null,
    note:
      // An in-play trailed row says where the falsifier now sits: that level, not
      // the published one, is what the reader is holding this position against.
      (v ? (trailRaised ? `${v.why} · trail at ${exitLevel}` : v.why) : null) ??
      (status === 'stopped'
        ? trailRaised
          ? `closed through the velocity trail at ${exitLevel} — trail hit; the falsifier had risen from the published ${pred.stop} stop, which still governs the formal grade`
          : 'closed through the stop — dead, awaiting the formal grade'
        : 'target touched on a close — awaiting the formal grade'),
  }
}
