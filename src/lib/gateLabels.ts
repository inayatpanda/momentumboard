// GATE_LABELS (plan Task 14): a short human phrase for every gate the engine
// can refuse or publish a call through. `refusals` and (later) journey/ledger
// pages carry the raw GateCode — a reader never sees the code itself, only
// this phrase. `satisfies Record<GateCode, string>` is the compile-time net:
// a future gate code with no entry here is a TYPE error, not a silent blank
// row. Semantics for each phrase come straight from the doc comment on
// GateCode itself (shared/engine/types.ts:90-183) — read that before editing
// a phrase, so the label stays honest to what the code actually means.

import type { GateCode } from '../../shared/engine/types'

export const GATE_LABELS = {
  'not-candidate': "never made the day's list",
  // NEUTRAL ABOUT THE LANE, deliberately (crypto-v2 wave, finding 9). "outside
  // this engine's market" was written in Phase A, when the engine refused every
  // coin outright and it was true. The lane merged; this gate now fires for
  // three different reasons — the lever is off, the pair is outside the
  // partition's universe, or the reader has not watchlisted a pair the lane
  // DOES serve — and the trace detail printed straight after this label says
  // which. A label claiming the engine has no crypto market contradicts its own
  // next sentence. This one is true of all three.
  'crypto-contained': 'not included in the crypto scan',
  trimmed: 'not selected for today’s scan',
  'no-candles': 'no chart data',
  'no-data': 'not enough information to score it',
  'dead-zone-core': 'score below the required level',
  'dead-zone-context': 'market conditions lowered the score',
  'capacity-data': 'missing price data for a trade plan',
  'expected-move': 'expected move too small',
  'entry-wait': 'price moving too sharply; waiting',
  'entry-chase': 'price has already moved too far',
  'entry-reversal': 'falling-price idea conflicts with a possible recovery',
  'evidence-fail': 'not enough supporting information',
  'dip-refused': 'potential gain too small for the risk',
  'grade-watchonly': 'rated, but no trade planned',
  'route-blocked': 'no suitable ISA investment',
  diversity: "too similar to other selected stocks",
  'slot-cut': 'other ideas ranked higher',
  'shadow-capped': 'test limit reached or idea already being tested',
  'called-full': 'published with full planned allocation',
  'called-half': 'published with half planned allocation',
  'called-shadow': 'practice idea only',
  'called-watch': 'watching only: limited evidence or space',
  'called-below-base': 'watching: estimated success below its usual level',
  'called-observation': 'watching only: no suitable ISA investment',
  'called-wildcard': 'experimental idea: quarter allocation to test a rule',
} satisfies Record<GateCode, string>
