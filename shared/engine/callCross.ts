import { round2 } from './types'
import { WILDCARD_MARK } from './voice'

// INTRADAY LEVEL WATCH: the published stop/target is HARD execution advice,
// but the formal grade is daily-CLOSE based (a wick through the stop is
// survivable for the track record). So a touch earns an immediate heads-up
// worded as execution advice — it must never claim the call is graded; the
// morning paper owns that verdict. Pure decision core only: the 5-minute
// runner feeds it open calls, live prices and the persisted fired keys.

export type CrossKind = 'stop' | 'target'

export interface OpenCallLevels {
  id: string
  sym: string
  side: 'long' | 'short'
  stop: number
  target: number
  /** THE EXPERIMENT SLOT'S RECORD (`Prediction['wildcard']`, types.ts), read for
   * one thing only: the ping has to say WHICH ROW it is about.
   *
   * This is the most execution-shaped sentence the engine ever sends — "execution
   * says exit" — and a wildcard is sized, unshadowed and not watch-only, so it
   * pings exactly like a conviction call and SHOULD: a quarter of the rung is
   * still the reader's money and a stop touch is still a stop touch. What must not
   * happen is that instruction arriving with nothing on it to say the row is a
   * trade the engine's own gates refused, taken at quarter size on purpose. The
   * GATING is untouched by this field; only the wording is. */
  wildcard?: { gate: string }
}

export interface CrossAlert {
  key: string // `${prediction id}:${kind}` — the once-only unit
  sym: string
  kind: CrossKind
  text: string
}

// Fired keys outlive the ~10-session open window with room to spare, so a
// crossed call can never re-fire after a prune; anything older belongs to a
// call already graded and is dead weight.
export const FIRED_RETENTION_SEC = 15 * 86_400

// penny names need the extra places or the level and the print read identical
const fmt = (x: number) => String(Math.abs(x) >= 1 ? round2(x) : Math.round(x * 10_000) / 10_000)

/** Open calls + live prices + already-fired keys → alerts to send now + the
 * fired map to persist. Touch means AT the level too — a hard stop executes
 * on the touch, not a tick through. Stop beats target when both would read
 * crossed, same precedence as the open-book walk (openTrace.ts). */
export function checkCallCrossings(
  calls: OpenCallLevels[],
  prices: ReadonlyMap<string, number>,
  firedBefore: Record<string, number>,
  nowSec: number,
): { alerts: CrossAlert[]; fired: Record<string, number> } {
  // rebuilt rather than mutated: a malformed persisted map (non-numeric
  // values) heals itself here instead of poisoning every later run
  const fired: Record<string, number> = {}
  for (const [k, at] of Object.entries(firedBefore ?? {})) {
    if (typeof at === 'number' && Number.isFinite(at) && nowSec - at < FIRED_RETENTION_SEC) fired[k] = at
  }

  const alerts: CrossAlert[] = []
  for (const c of calls) {
    const price = prices.get(c.sym)
    if (price == null || !Number.isFinite(price)) continue
    const long = c.side === 'long'
    const kind: CrossKind | null = (long ? price <= c.stop : price >= c.stop)
      ? 'stop'
      : (long ? price >= c.target : price <= c.target)
        ? 'target'
        : null
    if (!kind) continue
    const key = `${c.id}:${kind}`
    if (key in fired) continue // once per (call, level), across runs
    fired[key] = nowSec
    // the mark leads the row, and one clause names what it is — on BOTH pings,
    // because the target ping is the one a reader is likeliest to read as skill
    const mark = c.wildcard ? `${WILDCARD_MARK} ` : ''
    const tail = c.wildcard ? " This one is the experiment — quarter size, on a trade the engine's own gates refused." : ''
    alerts.push({
      key,
      sym: c.sym,
      kind,
      text:
        kind === 'stop'
          ? `⛔ ${mark}${c.sym} ${c.side} — stop ${fmt(c.stop)} touched (now ${fmt(price)}). Execution says exit; the formal close-based grade lands with the morning paper.${tail}`
          : `🎯 ${mark}${c.sym} ${c.side} — target ${fmt(c.target)} reached (now ${fmt(price)}).${tail}`,
    })
  }
  return { alerts, fired }
}
