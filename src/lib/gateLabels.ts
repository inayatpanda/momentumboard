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
  'crypto-contained': "crypto — outside this engine's market",
  trimmed: 'cut in the roster trim',
  'no-candles': 'no chart data',
  'no-data': 'no factor could score it',
  'dead-zone-core': 'below the conviction bar',
  'dead-zone-context': 'context pulled it back under the bar',
  'capacity-data': 'missing capacity data — no levels to publish',
  'expected-move': 'expected move too small',
  'entry-wait': 'entry read said wait — too sharp to trust',
  'entry-chase': 'already ran — refused to chase',
  'entry-reversal': 'short into a pullback — refused',
  'evidence-fail': 'failed the minimum evidence contract',
  'dip-refused': 'dip read, but reward:risk too thin to build',
  'grade-watchonly': 'graded, sized to zero',
  'route-blocked': 'no ISA route to place it',
  diversity: "too correlated with what's already on the board",
  'slot-cut': 'lost the last slot',
  'shadow-capped': 'past the shadow budget, dropped',
  'called-full': 'called at full size',
  'called-half': 'called at half size',
  'called-shadow': 'called as a shadow — not a live size',
  'called-watch': 'called watch-only — thin evidence or bumped from a slot',
  'called-below-base': 'called, but rated below the ordinary-candidate rate',
  'called-observation': 'called as an observation — filled an empty side, no ISA route',
  'called-wildcard': 'called as the experiment — quarter size, testing a gate',
} satisfies Record<GateCode, string>
