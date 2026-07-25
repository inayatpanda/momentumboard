// Where is the price NOW, relative to a call's own levels?
//
// The board and the paper both printed entry/stop/target as three static
// numbers, so a reader could not tell whether a setup was still available,
// already extended, or long since invalidated. That gap is worse than it looks:
// `entry` is captured pre-open, so it is the PREVIOUS session's close — by the
// time anyone reads the 06:35 paper the price has often already moved past it.
// Reviewing the first 26 live calls, scoring from that stale entry flattered
// the 5-day average by +1.7pp. This makes the same gap visible on screen
// instead of leaving it assumed.
//
// Distances are expressed IN THE TRADE'S OWN DIRECTION: positive always means
// "your way" / "not yet hit", for longs and shorts alike, so a reader never has
// to remember which way a short's stop sits.

export type CallState =
  | 'live' // between entry and target, stop intact
  | 'extended' // already run far enough that taking it now is chasing
  | 'through-stop' // invalidated
  | 'at-target' // the move asked for has happened

export interface CallLevels {
  side: 'long' | 'short'
  entry: number
  stop: number
  target: number
}

export interface CallStatus {
  price: number
  pctFromEntry: number // + = moved your way since the call was priced
  pctToStop: number // + = stop not yet hit, as % of the CURRENT price
  pctToTarget: number // + = target not yet reached
  r: number // multiples of the ORIGINAL entry→stop risk already travelled
  state: CallState
}

/** Half the original risk already banked means the reward left no longer pays
 * for the risk you would take entering here — the point where following the
 * call becomes chasing it. */
export const EXTENDED_R = 0.5

export function callStatus(call: CallLevels, price: number): CallStatus | null {
  if (!Number.isFinite(price) || price <= 0) return null
  if (!Number.isFinite(call.entry) || call.entry <= 0) return null
  const sign = call.side === 'short' ? -1 : 1
  const pctFromEntry = (sign * (price - call.entry) * 100) / call.entry
  const pctToStop = (sign * (price - call.stop) * 100) / price
  const pctToTarget = (sign * (call.target - price) * 100) / price
  // A zero-width risk (entry === stop) is malformed, not infinitely good: report
  // no progress rather than dividing by zero and calling everything extended.
  const risk = Math.abs(call.entry - call.stop)
  const r = risk > 0 ? (sign * (price - call.entry)) / risk : 0
  const state: CallState =
    pctToStop <= 0 ? 'through-stop' : pctToTarget <= 0 ? 'at-target' : r >= EXTENDED_R ? 'extended' : 'live'
  return { price, pctFromEntry, pctToStop, pctToTarget, r, state }
}
