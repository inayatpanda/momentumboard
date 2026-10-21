import type { Prediction } from './types'
import type { Candle } from '../types'
import { sessionUtcHours } from '../rvol'
import { completedLabCandles, type StrategyLabRecord } from './strategyLab'

export const BOARD_AUDIT_EXECUTION = 'published-board-close-stop-costs-v1'
const DAY = 86_400
const bounds = (t: number) => {
  const day = Math.floor(t / DAY) * DAY, hours = sessionUtcHours('US', day)
  return { open: day + hours.open * 3600, close: day + hours.close * 3600 }
}
/** Retrospective execution audit of ORIGINAL published, sized board calls.
 * Uses the saved horizon and daily-close invalidation; target is not a take-profit
 * because the board's probability contract is benchmark excess without a close-stop.
 * It does not alter historical forecast probabilities or their original grades. */
export function publishedAuditRecord(p: Prediction, candles: Candle[] | null, now: number, benchmark?: Candle[]): StrategyLabRecord | null {
  if (!Number.isFinite(p.availableAt) || p.availableAt! > now || p.shadow || p.watchOnly || p.observation || p.nearMiss || !(p.riskPct > 0) ||
      p.cohort === 'crypto' || p.sym.endsWith('.L') || p.sym.endsWith('-USD') || p.forecast?.definition !== 'benchmark-excess-no-close-stop-v1' ||
      !Number.isFinite(p.stop) || p.stop <= 0 || !Number.isFinite(p.entry) || p.entry <= 0 ||
      (p.campaignId != null && p.campaignId !== p.id)) return null
  const horizon = p.forecast.horizonSessions
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 63) return null
  const record: StrategyLabRecord = {
    id: `board-audit:${p.id}`, sym: p.sym, sleeve: 'composite-control', side: p.side, state: 'setup', score: 0,
    entry: p.entry, stop: p.stop, target: p.target, detectedAt: p.detectedAt ?? p.availableAt!, availableAt: p.availableAt!,
    reasons: ['Retrospective execution audit of the original sized board publication.'], risks: [], dataGaps: [],
    metrics: { sourcePredictionId: p.id },
    forecast: { definition: p.forecast.definition, modelVersion: `published-board-${p.modelVersion ?? 'unknown'}-audit-v1`, horizonSessions: horizon,
      label: 'Published board: next-open entry, daily-close stop, horizon close, estimated costs', calibratedN: 0, provisional: true },
  }
  const tape = completedLabCandles(candles ?? [], now, p.sym)
  const start = tape.findIndex(c => bounds(c.t).open > p.availableAt!)
  // Require a pre-publication reference so a truncated feed cannot silently
  // start this trade months later. Stock-price gaps remain real execution risk.
  if (start < 1 || p.availableAt! - bounds(tape[start - 1].t).close > 7 * DAY || start + horizon > tape.length) return record
  if (benchmark) {
    const marketWindow = completedLabCandles(benchmark, now, 'SPY').filter(c => bounds(c.t).open > p.availableAt!).slice(0, horizon)
    if (marketWindow.length !== horizon || marketWindow.some((c, i) => Math.floor(c.t / DAY) !== Math.floor(tape[start + i].t / DAY))) return record
  }
  const end = start + horizon - 1, long = p.side === 'long'
  const open = tape[start].o, entry = open * (long ? 1.001 : .999)
  const fields = { horizonEndAt: bounds(tape[end].t).close, executionStartAt: bounds(tape[start].t).open, executionVersion: BOARD_AUDIT_EXECUTION }
  if (long ? open <= p.stop : open >= p.stop) {
    record.outcome = { entry: open, exit: open, firstBarrier: 'none', targetHit: false, stopHit: false, returnPct: 0, sessions: 0, executionStatus: 'cancelled-gap', ...fields }
    return record
  }
  let exitIndex = end, stopped = false
  for (let i = start; i <= end; i++) if (long ? tape[i].c <= p.stop : tape[i].c >= p.stop) { exitIndex = i; stopped = true; break }
  const exit = tape[exitIndex].c * (long ? .999 : 1.001)
  record.outcome = { entry, exit, firstBarrier: stopped ? 'stop' : 'none', targetHit: false, stopHit: stopped,
    returnPct: (long ? exit - entry : entry - exit) / entry * 100, sessions: exitIndex - start + 1, executionStatus: 'filled', ...fields }
  return record
}
