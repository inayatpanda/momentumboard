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
// (relaxed) capacity gate, the side-aware entry gates and calibration grading
// exactly like everything else. News buys a name a fair look, not a free pass.

// The tag the DIP LANE stamps on its own rows. One exported constant because two
// places must agree on it forever and neither can see the other: the PRODUCER
// (buildBoard's dip merge) and the factor-IC GUARD in gradeOutstanding, which
// keeps the lane's constant technical placeholder out of the IC loop. A typo in
// either literal would silently train the technical factor on the dip lane's P&L.
export const DIP_CATALYST_KIND = 'dip'

export interface CatalystTag {
  kind: 'news' | 'event' | 'ipo' | 'listing' | 'earnings' | typeof DIP_CATALYST_KIND
  side: 'long' | 'short' | null // null = "in play", no clean direction — relaxes the gate but casts no vote
  reason: string
  strength: number // 0..100 — how direct/material the catalyst is
}

// The gates composeCall applies, parameterised by the reader's risk appetite.
// A catalyst name gets a LOWER capacity floor on purpose: swing-capacity is a
// TRAILING distribution, so on the very day a catalyst breaks the name's recent
// volatility hasn't caught up yet — the ordinary floor would reject the exact
// names the news is about. The dead zone and calibration grading still apply, so
// "aggressive" widens the funnel of ideas without turning off the scoring.
export interface Gates {
  deadZone: number // |adj composite| below this → no call
  capacityFloor: number // min swing-capacity % for an ordinary name
  catalystCapacityFloor: number // min swing-capacity % for a name carrying a live catalyst
}

export const MODERATE_GATES: Gates = { deadZone: 25, capacityFloor: 6, catalystCapacityFloor: 4 }
export const AGGRESSIVE_GATES: Gates = { deadZone: 20, capacityFloor: 5, catalystCapacityFloor: 3 }

export const gatesFor = (appetite?: 'moderate' | 'aggressive' | null): Gates =>
  appetite === 'aggressive' ? AGGRESSIVE_GATES : MODERATE_GATES
