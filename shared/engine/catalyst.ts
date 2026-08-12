// A "catalyst" is a market-moving news story or scheduled event (a geopolitical
// shock, a rate decision, an oil spike, a major listing/IPO, an M&A headline)
// that puts a specific name IN PLAY for the next 1-3 sessions. It does two jobs
// in the engine, both bounded and attributable:
//   1. supply — a catalyst name joins the daily candidate pool (engine.ts), so a
//      big liquid beneficiary the momentum scanner would never surface on its
//      own gets a fair look on the day the news actually breaks.
//   2. conviction — catalystFactor (factors.ts) adds a signed, strength-scaled
//      vote to the composite, seeded at a modest weight and left to the IC loop
//      to keep or decay like any other factor.
// It NEVER hands out a call: a catalyst name still faces the dead zone, the
// (relaxed) expected-move floor, the side-aware entry gates and calibration
// grading exactly like everything else. News buys a fair look, not a free pass.

// The tag the DIP LANE stamps on its own rows. One exported constant because the
// PRODUCER (buildBoard's dip merge) and the lane-family membership below must
// agree on the literal forever, and a typo in either would silently train the
// technical factor on the dip lane's P&L.
export const DIP_CATALYST_KIND = 'dip'

// The same, for the VELOCITY LANE (velocityLane.ts): a breakout/washout call
// whose composite is derived from the run itself rather than measured by the
// factor stack.
export const VELOCITY_CATALYST_KIND = 'velocity' as const

export interface CatalystTag {
  kind: 'news' | 'event' | 'ipo' | 'listing' | 'earnings' | typeof DIP_CATALYST_KIND | typeof VELOCITY_CATALYST_KIND
  side: 'long' | 'short' | null // null = "in play", no clean direction — relaxes the gate but casts no vote
  reason: string
  strength: number // 0..100 — how direct/material the catalyst is
}

// THE LANE FAMILY. A lane call is not an ordinary call carrying news: its
// composite is CONSTRUCTED (depth-derived in dipLane, run-derived in
// velocityLane) rather than voted on by the factor stack, so two engine
// behaviours must treat every lane alike:
//   1. factor-IC (gradeOutstanding) skips it — booking a lane's outcome would
//      train the technical factor's IC on a vote the factor never cast.
//   2. the worldTape stamp (publishCall) records mult 1 — the composite loop's
//      worldMult re-score never touched a structural composite, so printing the
//      nudge would advertise an adjustment that was never applied.
// Both used to test the dip literal, which quietly meant "every future lane
// starts out mis-learning until someone remembers this file". Membership is the
// contract now: add a lane's kind here and both behaviours follow it for free.
export const LANE_CATALYST_KINDS: ReadonlySet<string> = new Set([DIP_CATALYST_KIND, VELOCITY_CATALYST_KIND])

// The gates composeCall applies, parameterised by the reader's risk appetite.
// The dead zone and calibration grading still apply, so "aggressive" widens the
// funnel of ideas without turning off the scoring.
//
// ELIGIBILITY IS THE MOVE YOU CAN EXPECT. The old flat capacity floors (6, and a
// relaxed 4 with a catalyst) asked the wrong question — "is this name volatile
// enough?" — and answered it by volatility CLASS, which threw away every megacap
// that travels 5% however much the engine liked it, and waved through a 12%
// swinger the engine barely liked. `minExpectedMovePct` asks the reader's own
// question instead: does THIS call, on THIS name, expect enough move to be worth
// a trade? Expected move is already per-name (conviction × the name's own
// ten-session travel, composite.ts levelsFor), so the test needs no new input.
// A live catalyst still earns relief — composeCall subtracts 0.5pp — for exactly
// the reason it used to earn a lower floor: swing capacity is a TRAILING
// distribution, so on the day the news breaks the name's recent travel hasn't
// caught up to what it is about to do.
export interface Gates {
  deadZone: number // |adj composite| below this → no call
  minExpectedMovePct: number // min expected 10-session move %; a live catalyst relaxes it by 0.5
}

export const MODERATE_GATES: Gates = { deadZone: 25, minExpectedMovePct: 1.5 }
export const AGGRESSIVE_GATES: Gates = { deadZone: 20, minExpectedMovePct: 1.0 }

export const gatesFor = (appetite?: 'moderate' | 'aggressive' | null): Gates =>
  appetite === 'aggressive' ? AGGRESSIVE_GATES : MODERATE_GATES
