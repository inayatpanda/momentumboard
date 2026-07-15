import type { Candle } from '../types'
import { technicalStage, type Stage } from '../technicals'
import { round1 } from './types'

// THE OPEN BOOK: every live call that hasn't been graded yet, re-checked each
// morning. Two layers, kept deliberately separate:
//   • the WALK — mechanical fact: closes since entry vs the published stop and
//     target (same daily-close basis as grading and the £10k book);
//   • the VERDICT — opinion, in-play calls only: would the engine still take
//     this trade today?
// DISPLAY-ONLY by contract: nothing here ever touches the prediction blobs or
// the 5/10-day grading yardstick — the trace narrates, it never re-writes.

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
  stop: number
  target: number
  status: TraceStatus
  crossedDate: string | null // daily close that crossed the stop/target
  last: number // latest close
  movePct: number // side-adjusted move from the published entry level
  progressPct: number | null // % of the entry→target distance covered (signed)
  day: number // sessions since the call, entry session = day 1
  gradesInSessions: number // sessions until the 5-day grade can land
  stage: Stage | null
  requalified: boolean // made today's live board again, same side
  verdict: TraceVerdict | null // in-play only; crossed calls speak for themselves
  note: string
}

// A call is graded 5 sessions after its entry session (calibration.ts), so an
// open call lives through days 1..5 of this clock before the ledger takes over.
const GRADE_HORIZON = 5

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
 * when the candles don't reach the call date (nothing to walk). */
export function traceOpenCall(
  pred: { id: string; sym: string; name?: string; side: 'long' | 'short'; date: string; grade: 'A' | 'B' | 'C'; entry: number; stop: number; target: number },
  candles: Candle[],
  todayLiveKeys: Set<string>,
): OpenTraceEntry | null {
  const dayEpoch = Date.parse(pred.date) / 1000
  if (!Number.isFinite(dayEpoch) || candles.length === 0) return null
  const entryIdx = candles.findIndex(c => c.t >= dayEpoch)
  if (entryIdx === -1) return null

  const long = pred.side === 'long'
  let status: TraceStatus = 'in-play'
  let crossedDate: string | null = null
  for (let i = entryIdx; i < candles.length; i++) {
    const close = candles[i].c
    if (long ? close <= pred.stop : close >= pred.stop) {
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
      v?.why ??
      (status === 'stopped'
        ? 'closed through the stop — dead, awaiting the formal grade'
        : 'target touched on a close — awaiting the formal grade'),
  }
}
