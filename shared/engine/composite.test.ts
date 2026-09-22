import { describe, expect, it } from 'vitest'
import { CONTEXT_MAX_PTS, DEFAULT_WEIGHTS, FACTOR_FAMILY, LONG_REGIME_MULT, composeCall, coreCompositeOf, setupFamilyOf, type ComposeInput } from './composite'
import { AGGRESSIVE_GATES, MODERATE_GATES } from './catalyst'
import { catalystFactor } from './factors'
import { bannedTokensIn } from './voice'
import { isRejection, type EngineCall, type FactorName, type FactorScore, type GateCode } from './types'

/** THE PRE-3a SHAPE, kept for the tests written against it. composeCall now
 * returns a named rejection instead of a bare null (types.ts, CallOrRejection);
 * every one of those rejections means precisely what the null meant, and this
 * adapter collapses them back so the suite below goes on asserting the OLD
 * contract unchanged. That is the point: it is the zero-behaviour-change pin for
 * Task 1 — if any rejection had started meaning something else, or any draft had
 * stopped being a draft, these tests would fail. The gate codes themselves are
 * asserted against `composeCall` directly, in their own block at the bottom. */
const drafted = (input: ComposeInput): EngineCall | null => {
  const r = composeCall(input)
  return isRejection(r) ? null : r
}

/** the gate code composeCall refused with — and a loud failure if it did not refuse */
const gateOf = (input: ComposeInput): { gate: GateCode; side: 'long' | 'short' | null; detail?: string } => {
  const r = composeCall(input)
  if (!isRejection(r)) throw new Error(`expected a rejection, got a ${r.side} call at composite ${r.composite}`)
  return { gate: r.gate, side: r.side, detail: r.detail }
}

const nullFactors = (): Record<FactorName, FactorScore> => ({
  technical: { score: null, detail: '' },
  momentum: { score: null, detail: '' },
  bandwidth: { score: null, detail: '' },
  sector: { score: null, detail: '' },
  social: { score: null, detail: '' },
  channels: { score: null, detail: '' },
  insiders: { score: null, detail: '' },
  news: { score: null, detail: '' },
  seasonality: { score: null, detail: '' },
  smartMoney: { score: null, detail: '' },
  catalyst: { score: null, detail: '' },
})

const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  sym: 'TEST',
  factors: nullFactors(),
  weights: DEFAULT_WEIGHTS,
  regime: 'green',
  capacityPct: 10,
  atr: 2,
  lastClose: 100,
  entryQuality: 'early',
  stage: 'early-reversal',
  earningsWithinHorizon: false,
  capUsdM: 50_000,
  ...over,
})

const longFactors = (): Record<FactorName, FactorScore> => ({
  ...nullFactors(),
  technical: { score: 84, detail: 'early-reversal volume-confirmed' },
  momentum: { score: 40, detail: '+10pp' },
})

describe('composeCall', () => {
  it('all-null factors → no call', () => {
    expect(drafted(base())).toBeNull()
  })

  it('strong long in green regime: side, sane levels, expected move', () => {
    const call = drafted(base({ factors: longFactors() }))!
    expect(call.side).toBe('long')
    // owner-ordered vector: technical 1.0, momentum 0.9.
    //   coreNum = 1.0×84 + 0.9×40 = 84 + 36 = 120
    //   coreDen = 1.0 + 0.9 = 1.9
    //   120 / 1.9 = 63.1578…, ×1.0 (green, long) → 63.2
    // (was 64.4 when momentum weighed 0.8: 120 − 4 over 1.8)
    expect(call.composite).toBeCloseTo(63.2, 1)
    expect(call.stop).toBeLessThan(call.entry)
    expect(call.target).toBeGreaterThan(call.entry)
    expect(call.stop).toBe(97) // 100 − 1.5×2 (large cap)
    expect(call.expectedMovePct).toBeCloseTo(6.3, 1) // 0.6316 × 10 = 6.3158 → 6.3
  })

  // Unchanged by the re-base BY CONSTRUCTION, not by luck: one core factor means
  // the composite is coreNum/coreDen = w·s/w = s, so its weight cancels entirely.
  it('regime multiplier can push a modest long into the dead zone', () => {
    const modest = { ...nullFactors(), technical: { score: 40, detail: 'pullback' } }
    expect(drafted(base({ factors: modest, entryQuality: 'early', stage: 'pullback' }))!.composite).toBeCloseTo(40, 1)
    expect(drafted(base({ factors: modest, entryQuality: 'early', stage: 'pullback', regime: 'red' }))).toBeNull() // 40×0.55 = 22 < 25
  })

  it('dead zone: |composite| < 25 → null; boundary 25 passes', () => {
    const weak = { ...nullFactors(), technical: { score: 20, detail: 'basing' } }
    expect(drafted(base({ factors: weak, stage: 'basing', entryQuality: 'neutral' }))).toBeNull()
    const boundary = { ...nullFactors(), technical: { score: 25, detail: 'basing' } }
    expect(drafted(base({ factors: boundary, stage: 'basing', entryQuality: 'neutral' }))).not.toBeNull()
  })

  it('short from exhaustion in red regime: mirrored levels', () => {
    const shortF = { ...nullFactors(), technical: { score: -84, detail: 'exhausted' }, momentum: { score: -40, detail: '' } }
    const call = drafted(base({ factors: shortF, regime: 'red', entryQuality: 'chase', stage: 'exhausted' }))!
    expect(call.side).toBe('short')
    //   coreNum = 1.0×(−84) + 0.9×(−40) = −120; coreDen 1.9 → −63.1578…
    //   short in red: ×1.1 → −69.4736… → −69.5 (was −70.9 off the −64.44 core)
    expect(call.composite).toBeCloseTo(-69.5, 1)
    expect(call.stop).toBeGreaterThan(call.entry)
    expect(call.target).toBeLessThan(call.entry)
  })

  it('side-aware gates: no chased longs, no shorts into fresh strength, knives wait', () => {
    expect(drafted(base({ factors: longFactors(), entryQuality: 'chase', stage: 'extended' }))).toBeNull()
    const shortF = { ...nullFactors(), technical: { score: -60, detail: '' }, momentum: { score: -60, detail: '' } }
    expect(drafted(base({ factors: shortF, stage: 'pullback', entryQuality: 'early' }))).toBeNull()
    expect(drafted(base({ factors: longFactors(), entryQuality: 'wait', stage: 'falling-knife' }))).toBeNull()
  })

  it('dead money never makes a call: the expected move is the whole eligibility test', () => {
    // capacity 2 at composite 40 expects 0.4 × 2 = 0.8% over ten sessions. That
    // is inside the spread and the noise — no conviction rescues arithmetic that
    // small, and the flat floor used to admit exactly this name at capacity 6.
    const forty = { ...nullFactors(), technical: { score: 40, detail: 'pullback' } }
    expect(drafted(base({ factors: forty, capacityPct: 2, stage: 'pullback' }))).toBeNull()
    expect(drafted(base({ factors: longFactors(), capacityPct: null }))).toBeNull() // capacity unknown → nothing to expect
  })

  it('the floor is the move THIS call expects, not the volatility class the name belongs to', () => {
    // ONE name, capacity 5, three convictions. Under the old flat floor (6) the
    // name was ineligible at every conviction; now its own arithmetic decides.
    const at = (score: number) => ({ ...nullFactors(), technical: { score, detail: 'pullback' } })
    const cap5 = (score: number) => drafted(base({ factors: at(score), capacityPct: 5, stage: 'pullback' }))
    expect(cap5(45)!.expectedMovePct).toBeCloseTo(2.3, 1) // 0.45 × 5 = 2.25 ≥ 1.5 → a trade
    expect(cap5(30)).not.toBeNull() // 0.30 × 5 = 1.5 — the boundary is inclusive
    expect(cap5(26)).toBeNull() // 0.26 × 5 = 1.3 < 1.5 — same name, thinner conviction, no trade
    // …and the reversal the rethink exists for: a GLW-class 6%-mover with real
    // conviction expects 2.4% and trades, where the flat floor admitted it only
    // by the accident of clearing a volatility threshold.
    expect(drafted(base({ factors: at(40), capacityPct: 6, stage: 'pullback' }))!.expectedMovePct).toBeCloseTo(2.4, 1)
  })

  it('small caps get the wider stop', () => {
    const small = drafted(base({ factors: longFactors(), capUsdM: 800 }))!
    expect(small.smallCap).toBe(true)
    expect(small.stop).toBe(96) // 100 − 2×2
  })

  it('missing atr or close → null; note names top factors', () => {
    expect(drafted(base({ factors: longFactors(), atr: null }))).toBeNull()
    expect(drafted(base({ factors: longFactors(), lastClose: null }))).toBeNull()
    expect(drafted(base({ factors: longFactors() }))!.note).toContain('technical')
  })

  it('worldMult 0.85 pushes a marginal long under the dead zone → suppressed', () => {
    // single technical factor → composite == score (the weight cancels, so the
    // re-base cannot move this); green regime ×1.0. Score 28
    // clears the 25 dead zone on its own, but the risk-off long nudge kills it.
    const marginal = { ...nullFactors(), technical: { score: 28, detail: 'basing' } }
    const bull = base({ factors: marginal, stage: 'basing', entryQuality: 'neutral' })
    expect(drafted(bull)!.composite).toBeCloseTo(28, 1) // passes with no nudge
    expect(drafted({ ...bull, worldMult: 0.85 })).toBeNull() // 28 × 0.85 = 23.8 < 25
  })

  it('worldMult 1.1 lifts a sub-threshold call over the dead zone → passes', () => {
    const under = { ...nullFactors(), technical: { score: 23, detail: 'basing' } }
    const bull = base({ factors: under, stage: 'basing', entryQuality: 'neutral' })
    expect(drafted(bull)).toBeNull() // 23 < 25 with no nudge
    const lifted = drafted({ ...bull, worldMult: 1.1 })! // 23 × 1.1 = 25.3 ≥ 25
    expect(lifted).not.toBeNull()
    expect(lifted.composite).toBeCloseTo(25.3, 1)
    expect(lifted.side).toBe('long') // a positive mult never flips the side
  })

  it('the world nudge scales conviction but leaves the side sign intact', () => {
    const shortF = { ...nullFactors(), technical: { score: -60, detail: 'exhausted' } }
    const bear = base({ factors: shortF, stage: 'exhausted', entryQuality: 'chase' })
    const plain = drafted(bear)!
    const boosted = drafted({ ...bear, worldMult: 1.1 })!
    expect(boosted.side).toBe('short')
    expect(Math.abs(boosted.composite)).toBeGreaterThan(Math.abs(plain.composite))
  })

  it('catalyst relaxes the floor by 0.5pp: swing capacity is trailing, the news is today', () => {
    // capacity 5 at composite 26 expects 1.3% — short of the ordinary 1.5 floor,
    // but the name is in play TODAY and its trailing ten-session travel has not
    // caught up to that fact yet. 1.3 ≥ 1.5 − 0.5.
    const marginal = { ...nullFactors(), technical: { score: 26, detail: 'pullback' } }
    const quiet = base({ factors: marginal, capacityPct: 5, stage: 'pullback' })
    expect(drafted(quiet)).toBeNull() // ordinary name, too little to expect → suppressed
    expect(
      drafted({ ...quiet, catalyst: { kind: 'news', side: 'long', reason: 'oil spike', strength: 80 } }),
    ).not.toBeNull() // same chart, live catalyst → gets a look
  })

  it('the floor is the retired flat one re-expressed at the dead zone — admit-only vs the THREE ordinary floors', () => {
    // The three numbers are not free-hand. AT THE DEAD ZONE the expected-move
    // floor reproduces the flat capacity floors it replaces, exactly:
    //   moderate            0.25 × 6 = 1.5
    //   moderate + catalyst 0.25 × 4 = 1.0
    //   aggressive          0.20 × 5 = 1.0
    // Above the dead zone it loosens monotonically with conviction, so no name
    // those three flat floors admitted is rejected now. THE SLEEVE IS THE
    // EXCEPTION, deliberately: its retired floor of 3 admitted any conviction,
    // so a capacity-4.9 megacap now needs composite ≥ ~31 (150/4.9) instead of
    // 25 — a marginal-conviction calm name must justify a real expected move.
    // That tightening is D5's principle, the near-miss machinery covers the
    // empty-day risk, and the Stage-2 gate replay measures BOTH directions.
    const at = (score: number) => ({ ...nullFactors(), technical: { score, detail: 'pullback' } })
    const call = (score: number, capacityPct: number, over: Partial<ComposeInput> = {}) =>
      drafted(base({ factors: at(score), capacityPct, stage: 'pullback', ...over }))
    expect(call(25, 6)).not.toBeNull() // the old moderate floor, at the dead zone
    expect(call(25, 5.5)).toBeNull() // …and under it, the verdict is the old verdict
    expect(call(25, 4, { catalyst: { kind: 'news', side: 'long', reason: 'x', strength: 80 } })).not.toBeNull() // old catalyst floor 4
    expect(call(20, 5, { gates: AGGRESSIVE_GATES })).not.toBeNull() // old aggressive floor 5, at its own dead zone
    // …and the widening: conviction buys travel. At composite 50 the same 3%
    // traveller expects 1.5% and trades, where the flat 6 rejected it outright.
    expect(call(50, 3)).not.toBeNull()
  })

  it('catalyst buys relief, never a pass: below the relaxed floor it is still suppressed', () => {
    const forty = { ...nullFactors(), technical: { score: 40, detail: 'pullback' } }
    expect(
      drafted(base({ factors: forty, capacityPct: 2, stage: 'pullback', catalyst: { kind: 'news', side: 'long', reason: 'x', strength: 90 } })),
    ).toBeNull() // 0.4 × 2 = 0.8 < the relaxed floor 1.0
  })

  it('a catalyst vote can NOT carry a marginal core over the dead zone — a headline is never a thesis', () => {
    // a quiet chart on its own makes no call; under the two-layer composite a
    // strong long catalyst (context) no longer rescues it — the core must
    // clear the gate alone. The catalyst still relaxes the expected-move floor and
    // still tilts conviction on an already-valid call (tested elsewhere).
    const quiet = { ...nullFactors(), technical: { score: 15, detail: 'trending' } }
    expect(drafted(base({ factors: quiet, stage: 'trending', entryQuality: 'neutral' }))).toBeNull() // 15 < 25
    const withVote = { ...quiet, catalyst: catalystFactor({ kind: 'news', side: 'long', reason: 'beneficiary', strength: 80 }) }
    expect(
      drafted(base({ factors: withVote, stage: 'trending', entryQuality: 'neutral', catalyst: { kind: 'news', side: 'long', reason: 'beneficiary', strength: 80 } })),
    ).toBeNull()
  })

  it('a short-side catalyst votes down and never flips a clearly-long name', () => {
    const vote = catalystFactor({ kind: 'news', side: 'short', reason: 'sanctioned', strength: 70 })
    expect(vote.score).toBeLessThan(0)
    const bull = { ...longFactors(), catalyst: vote }
    // catalyst drags conviction but the dominant technical keeps it long
    expect(drafted(base({ factors: bull, catalyst: { kind: 'news', side: 'short', reason: 'sanctioned', strength: 70 } }))!.side).toBe('long')
  })

  it('aggressive gates lower the dead zone and the expected-move floor vs moderate', () => {
    const marginal = { ...nullFactors(), technical: { score: 22, detail: 'basing' } }
    const b = { factors: marginal, stage: 'basing' as const, entryQuality: 'neutral' as const, capacityPct: 5 }
    expect(drafted(base({ ...b, gates: MODERATE_GATES }))).toBeNull() // 22 < the 25 dead zone
    expect(drafted(base({ ...b, gates: AGGRESSIVE_GATES }))).not.toBeNull() // 22 ≥ 20, and 0.22 × 5 = 1.1 ≥ 1.0
    // the floor on its own, with the dead zone out of the way: 1.3 clears 1.0, not 1.5
    const clears = { ...nullFactors(), technical: { score: 26, detail: 'basing' } }
    const c = { factors: clears, stage: 'basing' as const, entryQuality: 'neutral' as const, capacityPct: 5 }
    expect(drafted(base({ ...c, gates: MODERATE_GATES }))).toBeNull() // 1.3 < 1.5
    expect(drafted(base({ ...c, gates: AGGRESSIVE_GATES }))).not.toBeNull() // 1.3 ≥ 1.0
  })
})

/** BANDWIDTH IS CORE (2026-09-22, ENGINE_MODEL_VERSION 4). Four claims, and the
 * fourth is the one that had to be decided rather than discovered. */
describe('bandwidth joins the core', () => {
  it('is a CORE family at the seeded 0.4 — technical 1.0, momentum 0.9, bandwidth 0.4', () => {
    expect(FACTOR_FAMILY.bandwidth).toBe('core')
    expect(DEFAULT_WEIGHTS.bandwidth).toBe(0.4)
    expect(DEFAULT_WEIGHTS.bandwidth).toBeLessThan(DEFAULT_WEIGHTS.momentum)
    expect(DEFAULT_WEIGHTS.bandwidth).toBeGreaterThan(DEFAULT_WEIGHTS.sector)
  })

  it('moves the composite by exactly its weight over the core denominator', () => {
    // (1.0×84 + 0.9×40 + 0.4×50) / (1.0 + 0.9 + 0.4) = 140 / 2.3 = 60.87
    const call = drafted(base({ factors: { ...longFactors(), bandwidth: { score: 50, detail: 'p100 — the widest of its own year' } } }))!
    expect(call.composite).toBeCloseTo(60.9, 1)
    // …and a null bandwidth renormalises away, leaving the four-core read intact
    expect(drafted(base({ factors: longFactors() }))!.composite).toBeCloseTo(63.2, 1)
  })

  it('cannot create a call on its own — the dead zone still gates it', () => {
    // maximal bandwidth and nothing else: 0.4×50 / 0.4 = 50, which DOES clear the
    // dead zone, so the gate that matters is the one below it
    const alone = { ...nullFactors(), bandwidth: { score: 50, detail: 'p100 — the widest of its own year' } }
    expect(drafted(base({ factors: alone }))!.composite).toBeCloseTo(50, 1)
    // …and a middling width on a chart with nothing behind it dies in the dead zone
    // like any other lonely core read
    const thin = { ...nullFactors(), bandwidth: { score: 20, detail: 'p40' } }
    expect(gateOf(base({ factors: thin }))).toMatchObject({ gate: 'dead-zone-core', side: 'long' })
    // the real production shape: a marginal chart that bandwidth drags UNDER the
    // gate rather than over it — a COILED name sits at the weak end of the study's
    // only stable feature, scores near zero, and dilutes the read
    const marginal = { ...nullFactors(), technical: { score: 26, detail: 'basing' }, momentum: { score: 26, detail: '' } }
    expect(drafted(base({ factors: marginal, stage: 'basing', entryQuality: 'neutral' }))).not.toBeNull()
    expect(gateOf(base({ factors: { ...marginal, bandwidth: { score: 0.5, detail: 'p1 — the tightest of its own year' } }, stage: 'basing', entryQuality: 'neutral' }))).toMatchObject({
      gate: 'dead-zone-core',
    })
  })

  it('COUNTS as an agreeing core family — decided yes, with the caveat stated', () => {
    // It is price-derived, point-in-time and measured, so it counts like sector and
    // seasonality do. The caveat lives beside the contract in composite.ts: its SIGN
    // is borrowed from the same trend the chart read describes, so technical +
    // bandwidth is a weaker corroboration than technical + sector.
    const agreeing = drafted(base({ factors: { ...nullFactors(), technical: { score: 84, detail: '' }, bandwidth: { score: 30, detail: '' } }, volumeConfirmed: true }))!
    expect(agreeing.evidence.famAgree).toBe(2)
    // …and it can only ever ADD a family when it actually agrees
    const opposing = drafted(base({ factors: { ...nullFactors(), technical: { score: 84, detail: '' }, bandwidth: { score: -30, detail: '' } }, volumeConfirmed: true }))!
    expect(opposing.evidence.famAgree).toBe(1)
    expect(opposing.evidence.contract).toBe(false)
  })
})

describe('two-layer composite: core decides, context colours', () => {
  const loudContext = (): Record<FactorName, FactorScore> => ({
    social: { score: 60, detail: 'reddit hot' },
    channels: { score: 70, detail: '3 bulls' },
    news: { score: 50, detail: 'headlines' },
    catalyst: { score: 90, detail: 'big story' },
    insiders: { score: 45, detail: 'cluster' },
    smartMoney: { score: 30, detail: 'fund added' },
    technical: { score: null, detail: '' },
    momentum: { score: null, detail: '' },
    bandwidth: { score: null, detail: '' },
    sector: { score: null, detail: '' },
    seasonality: { score: null, detail: '' },
  })

  it('context alone is never a call, however loud', () => {
    expect(drafted(base({ factors: loudContext() }))).toBeNull()
  })

  it('context contribution is capped at CONTEXT_MAX_PTS on a valid core', () => {
    const core = drafted(base({ factors: longFactors() }))!
    const withCtx = drafted(base({ factors: { ...longFactors(), ...({} as object), social: { score: 60, detail: '' }, channels: { score: 70, detail: '' }, news: { score: 50, detail: '' }, catalyst: { score: 90, detail: '' } } }))!
    // ctx vote mass (0.5·60 + 0.5·70 + 0.5·50 + 0.6·90)/1.9
    //             = (30 + 35 + 25 + 54)/1.9 = 144/1.9 = 75.8 → clamped to +12
    // (was 76 under the old vector — the cap is what makes this pin re-base-proof)
    expect(withCtx.composite).toBeCloseTo(core.composite + CONTEXT_MAX_PTS, 1)
    expect(withCtx.evidence.contextPts).toBe(CONTEXT_MAX_PTS)
  })

  it('…and the cap the RUN was judged against wins, so gate feedback moves it without touching the constant', () => {
    const factors = { ...longFactors(), social: { score: 60, detail: '' }, channels: { score: 70, detail: '' }, news: { score: 50, detail: '' }, catalyst: { score: 90, detail: '' } }
    const core = drafted(base({ factors: longFactors() }))!
    const moved = drafted(base({ factors, gates: { ...MODERATE_GATES, contextMaxPts: 16 } }))!
    expect(moved.evidence.contextPts).toBe(16)
    expect(moved.composite).toBeCloseTo(core.composite + 16, 1)
    // absent means the module default — the reason nothing moved before a gate did
    expect(drafted(base({ factors, gates: { ...MODERATE_GATES } }))!.evidence.contextPts).toBe(CONTEXT_MAX_PTS)
  })

  it('a missing context factor never changes the core read — same model for every ticker', () => {
    const bare = drafted(base({ factors: longFactors() }))!
    const oneCtxNull = { ...longFactors(), news: { score: 0, detail: 'quiet tape' } }
    // news at 0 vs news missing: identical composite — context nulls don't renormalise
    expect(drafted(base({ factors: oneCtxNull }))!.composite).toBeCloseTo(bare.composite, 1)
  })

  /** THE SILENCE FLAG IS INVISIBLE TO SCORING [stage 3c task 2 fix wave].
   * `FactorScore.silence` marks a zero the LEARNING LOOP must skip (a news
   * polarity tie — see factors.ts). Nothing in the composite may read it: a
   * flagged zero and a bare zero are the same 0 to every weight, every cap and
   * every gate, and the only difference on the call is that the flag rides
   * through onto `call.factors` so a stored Prediction still carries it. */
  it('a flagged (silent) zero composes byte-identically to a bare zero — and the flag survives onto the call', () => {
    const bareZero = { ...longFactors(), news: { score: 0, detail: '2 headline(s), polarity +0' } }
    const flagged = { ...longFactors(), news: { score: 0, detail: '2 headline(s), polarity +0', silence: true as const } }
    const a = drafted(base({ factors: bareZero }))!
    const b = drafted(base({ factors: flagged }))!
    expect({ ...b, factors: a.factors }).toEqual(a) // everything but the factor table is identical
    expect(b.factors.news.silence).toBe(true)
    expect(a.factors.news.silence).toBeUndefined()
    expect(coreCompositeOf(flagged, DEFAULT_WEIGHTS, 'green')).toBe(coreCompositeOf(bareZero, DEFAULT_WEIGHTS, 'green'))
  })

  it('hostile context can push a marginal core under the dead zone (eligibility veto) but never flips the side', () => {
    const marginal = { ...nullFactors(), technical: { score: 26, detail: 'basing' } }
    expect(drafted(base({ factors: marginal, stage: 'basing', entryQuality: 'neutral' }))!.side).toBe('long') // 26 ≥ 25 alone
    const hostile = { ...marginal, channels: { score: -70, detail: 'bears' }, news: { score: -50, detail: 'sour' } }
    // ctx (−0.5·70 − 0.5·50)/1 = −60 → clamped −12 → 26−12 = 14 < 25 → suppressed, NOT shorted
    expect(drafted(base({ factors: hostile, stage: 'basing', entryQuality: 'neutral' }))).toBeNull()
  })

  it('evidence contract: needs momentum, a confirming leg, and 2 agreeing core families', () => {
    // technical+momentum agree but NO confirming leg (no sector/volume/breadth)
    const bare = drafted(base({ factors: longFactors() }))!
    expect(bare.evidence.contract).toBe(false)
    expect(bare.evidence.famAgree).toBe(2)
    // volume confirmation supplies the missing leg
    const confirmed = drafted(base({ factors: longFactors(), volumeConfirmed: true }))!
    expect(confirmed.evidence.contract).toBe(true)
    // sector data also supplies it
    const withSector = drafted(base({ factors: { ...longFactors(), sector: { score: 20, detail: 'p75' } } }))!
    expect(withSector.evidence.contract).toBe(true)
    expect(withSector.evidence.famAgree).toBe(3)
    // momentum DISAGREES → only 1 family agrees → no contract even with the leg
    const lonely = { ...nullFactors(), technical: { score: 84, detail: '' }, momentum: { score: -20, detail: '' } }
    const call = drafted(base({ factors: lonely, volumeConfirmed: true }))!
    expect(call.evidence.famAgree).toBe(1)
    expect(call.evidence.contract).toBe(false)
    // unknown regime never passes
    const unknown = drafted(base({ factors: longFactors(), volumeConfirmed: true, regime: 'unknown' }))!
    expect(unknown.evidence.contract).toBe(false)
  })

  it('coverage reports the core weight actually present', () => {
    // technical 1.0 + momentum 0.9 = 1.9 present, of the core total
    // 1.0 + 0.9 + bandwidth 0.4 + sector 0.3 + seasonality 0.3 = 2.9 →
    // 1.9/2.9 = 0.66. It was 0.76 over a four-factor core: a fifth core factor
    // LOWERS coverage on a two-factor read, which is the honest direction — the
    // same two factors now account for less of what the core could have been.
    expect(drafted(base({ factors: longFactors() }))!.evidence.coverage).toBeCloseTo(0.66, 2)
  })

  it('coreCompositeOf is composeCall\'s core read with every gate removed', () => {
    // the SAME arithmetic the published call stands on: core-only, regime-scaled,
    // no context, no dead zone, no expected-move floor, no entry gate.
    const factors = longFactors()
    const core = coreCompositeOf(factors, DEFAULT_WEIGHTS, 'green')!
    // (1.0×84 + 0.9×40) / 1.9 × 1.0 = 120/1.9 = 63.157… — the literal vector,
    // spelled out, so a future re-base fails this test instead of following it
    expect(core).toBeCloseTo(((1.0 * 84 + 0.9 * 40) / 1.9) * LONG_REGIME_MULT.green, 1)
    // a call that clears every gate reports the same core, plus the capped context
    const call = drafted(base({ factors }))!
    expect(Math.abs(call.composite - core)).toBeLessThanOrEqual(CONTEXT_MAX_PTS)
    // and it reads the names the GATES throw away — that is its whole purpose
    expect(coreCompositeOf(factors, DEFAULT_WEIGHTS, 'red')).not.toBeNull()
    expect(drafted(base({ factors, capacityPct: 1 }))).toBeNull()
    // regime scales it by side
    expect(coreCompositeOf(factors, DEFAULT_WEIGHTS, 'red')!).toBeLessThan(core)
    // no core data at all → nothing honest to say
    expect(coreCompositeOf(nullFactors(), DEFAULT_WEIGHTS, 'green')).toBeNull()
    // context factors alone are never a core read
    const ctxOnly = { ...nullFactors(), news: { score: 90, detail: '' } }
    expect(coreCompositeOf(ctxOnly, DEFAULT_WEIGHTS, 'green')).toBeNull()
  })

  it('setup family stamps: trend longs continue, dip longs reverse, weak shorts continue, stretched shorts fade', () => {
    expect(setupFamilyOf('long', 'trending')).toBe('continuation')
    expect(setupFamilyOf('long', 'basing')).toBe('continuation')
    expect(setupFamilyOf('long', 'pullback')).toBe('reversal')
    expect(setupFamilyOf('long', 'early-reversal')).toBe('reversal')
    expect(setupFamilyOf('short', 'weak')).toBe('continuation')
    expect(setupFamilyOf('short', 'extended')).toBe('fade')
    expect(setupFamilyOf('short', 'exhausted')).toBe('fade')
    expect(setupFamilyOf('long', null)).toBeNull()
    const call = drafted(base({ factors: longFactors() }))!
    expect(call.setup).toBe('reversal') // base stage is early-reversal
  })
})

// THE VOICE (voice.ts). The board's narration used to be `${factorName}:
// ${detail}` — the machine's own field names, in front of a reader. Every
// composite call now carries two plain-English sentences instead, and `note`
// keeps the breakdown as the evidence line beneath.
describe('composeCall — every call says what it believes and what would prove it wrong', () => {
  it('leads with the stage and the strongest contributor arguing FOR the side', () => {
    const call = drafted(base({ factors: longFactors() }))!
    expect(call.thesis).toBe('Long TEST — the chart is turning up off its low with volume behind it. Wrong if it closes below 97.')
    expect(call.falsifier).toBe('Wrong if it closes below 97.')
    expect(call.falsifier).toContain(String(call.stop)) // the level it actually published
    expect(bannedTokensIn(call.thesis!)).toEqual([])
  })

  it('…while `note` is untouched: the evidence line still names the factors', () => {
    const call = drafted(base({ factors: longFactors() }))!
    expect(call.note).toBe('technical: early-reversal volume-confirmed · momentum: +10pp')
  })

  it('a short is falsified ABOVE its stop', () => {
    const call = drafted(
      base({ stage: 'weak', entryQuality: 'neutral', factors: { ...nullFactors(), technical: { score: -84, detail: 'below every average' }, momentum: { score: -40, detail: '-10pp' } } }),
    )!
    expect(call.side).toBe('short')
    expect(call.thesis).toBe(`Short TEST — the chart is broken with 10 points of underperformance against the S&P over the last month. Wrong if it closes above ${call.stop}.`)
  })

  it('context is quoted only when the capped context layer actually moved the number', () => {
    // news 50 × weight 0.5 over a 1.9 core denominator = +13.2pt, capped at 12
    const loud = drafted(base({ factors: { ...longFactors(), news: { score: 50, detail: '3 headline(s), polarity +2' } } }))!
    expect(loud.evidence.contextPts).toBe(CONTEXT_MAX_PTS)
    expect(loud.thesis).toContain(', and 3 headlines on it reading positive.')
    // …and a whisper (seasonality is CORE, insiders at 0.4 × 8 = 3.2pt / 1.9 = 1.7pt) is not
    const quiet = drafted(base({ factors: { ...longFactors(), insiders: { score: 8, detail: 'insider buying' } } }))!
    expect(Math.abs(quiet.evidence.contextPts)).toBeLessThan(4)
    expect(quiet.thesis).not.toContain('director')
  })

  it('a contributor whose detail humanises to nothing is skipped, never printed hollow', () => {
    // technical outranks momentum, but 'basing' alone carries no confirmation to
    // report — so the sentence takes momentum's clause rather than an empty one
    const call = drafted(
      base({ stage: 'basing', factors: { ...nullFactors(), technical: { score: 84, detail: 'basing' }, momentum: { score: 40, detail: '21d RS vs SPY +10pp' } } }),
    )!
    expect(call.thesis).toBe('Long TEST — the chart has built a base with 10 points of outperformance against the S&P over the last month. Wrong if it closes below 97.')
  })
})

// STAGE 3a TASK 1. Eight rejection sites, eight names. Until now they were one
// word — `null` — and the funnel could never say which gate had done the
// refusing, so a name that died on the expected-move floor and a name that died
// because a headline dragged it back under the dead zone were the same event in
// the record. One test per site, driving composeCall directly at that site's own
// condition, asserting the code AND the side the core was arguing for.
describe('composeCall names the gate that said no', () => {
  it('no core factor scored at all → no-data, and no side to claim', () => {
    // context has no vote on direction, so a rejection here cannot name one
    expect(gateOf(base())).toMatchObject({ gate: 'no-data', side: null })
    expect(gateOf(base({ factors: { ...nullFactors(), news: { score: 90, detail: 'loud' } } }))).toMatchObject({ gate: 'no-data', side: null })
  })

  it('the core alone under the dead zone → dead-zone-core', () => {
    const weak = { ...nullFactors(), technical: { score: 20, detail: 'basing' } }
    expect(gateOf(base({ factors: weak, stage: 'basing', entryQuality: 'neutral' }))).toMatchObject({ gate: 'dead-zone-core', side: 'long' })
    // …and on the short side, where the raw score clears 25 and the regime
    // multiplier is what actually kills it: shorting a green tape stays penal.
    const modest = { ...nullFactors(), technical: { score: -30, detail: 'weak' } }
    expect(gateOf(base({ factors: modest, regime: 'green', stage: 'weak', entryQuality: 'neutral' }))).toMatchObject({ gate: 'dead-zone-core', side: 'short' }) // −30 × 0.7 = −21 < 25
  })

  it('the core cleared the gate and CONTEXT pushed it back under → dead-zone-context, a different code on purpose', () => {
    const marginal = { ...nullFactors(), technical: { score: 26, detail: 'basing' } }
    expect(drafted(base({ factors: marginal, stage: 'basing', entryQuality: 'neutral' }))).not.toBeNull() // 26 ≥ 25 on its own
    const hostile = { ...marginal, channels: { score: -70, detail: 'bears' }, news: { score: -50, detail: 'sour' } }
    const r = gateOf(base({ factors: hostile, stage: 'basing', entryQuality: 'neutral' }))
    // 26 − 12 (the capped context layer) = 14 < 25. THIS is the row that measures
    // what CONTEXT_MAX_PTS costs — pooling it with dead-zone-core would erase it.
    expect(r).toMatchObject({ gate: 'dead-zone-context', side: 'long' })
    expect(r.detail).toContain('-12')
  })

  it('no levels to publish → capacity-data, whichever of the three is missing', () => {
    expect(gateOf(base({ factors: longFactors(), atr: null }))).toMatchObject({ gate: 'capacity-data', side: 'long' })
    expect(gateOf(base({ factors: longFactors(), lastClose: null }))).toMatchObject({ gate: 'capacity-data', side: 'long' })
    expect(gateOf(base({ factors: longFactors(), capacityPct: null })).detail).toContain('capacity')
  })

  it('the move this call expects is under the floor → expected-move', () => {
    const forty = { ...nullFactors(), technical: { score: 40, detail: 'pullback' } }
    const r = gateOf(base({ factors: forty, capacityPct: 2, stage: 'pullback' }))
    expect(r).toMatchObject({ gate: 'expected-move', side: 'long' }) // 0.4 × 2 = 0.8 < 1.5
    expect(r.detail).toContain('0.8')
  })

  it('the entry read says wait → entry-wait, on either side', () => {
    expect(gateOf(base({ factors: longFactors(), entryQuality: 'wait', stage: 'falling-knife' }))).toMatchObject({ gate: 'entry-wait', side: 'long' })
    const shortF = { ...nullFactors(), technical: { score: -84, detail: '' }, momentum: { score: -40, detail: '' } }
    expect(gateOf(base({ factors: shortF, entryQuality: 'wait', stage: 'falling-knife' }))).toMatchObject({ gate: 'entry-wait', side: 'short' })
  })

  it('a long into a chase → entry-chase (and a SHORT into a chase is not this gate)', () => {
    expect(gateOf(base({ factors: longFactors(), entryQuality: 'chase', stage: 'extended' }))).toMatchObject({ gate: 'entry-chase', side: 'long' })
    const shortF = { ...nullFactors(), technical: { score: -84, detail: 'exhausted' }, momentum: { score: -40, detail: '' } }
    expect(drafted(base({ factors: shortF, regime: 'red', entryQuality: 'chase', stage: 'exhausted' }))).not.toBeNull()
  })

  it('a short into a pullback or an early reversal → entry-reversal', () => {
    const shortF = { ...nullFactors(), technical: { score: -60, detail: '' }, momentum: { score: -60, detail: '' } }
    expect(gateOf(base({ factors: shortF, stage: 'pullback', entryQuality: 'early' }))).toMatchObject({ gate: 'entry-reversal', side: 'short' })
    expect(gateOf(base({ factors: shortF, stage: 'early-reversal', entryQuality: 'early' }))).toMatchObject({ gate: 'entry-reversal', side: 'short' })
  })

  it('a rejection is never mistaken for a draft, and a draft never for a rejection', () => {
    expect(isRejection(composeCall(base()))).toBe(true)
    expect(isRejection(composeCall(base({ factors: longFactors() })))).toBe(false)
  })

  // THE ZERO-BEHAVIOUR-CHANGE PIN. This object was captured from composeCall at
  // 8af0bd3, BEFORE the return shape changed, and was pasted verbatim. A passing
  // call must still hand back exactly this and nothing else — no `rejected` key,
  // no reordered evidence, no drifted level. Naming the noes may not touch a yes.
  //
  // TWO FIELDS MOVED ON 2026-09-22, and only because the CORE ITSELF did: adding
  // `bandwidth` to FACTOR_FAMILY puts a fifth weight in the core denominator
  // coverage is measured against (0.76 → 0.66, and the sentence built from it),
  // and puts a fifth entry in `factors`. THE COMPOSITE DID NOT MOVE — 63.2 then,
  // 63.2 now — because a null factor renormalises away: that number is the pin
  // that matters and it is untouched.
  it('a call that clears every gate returns the pre-3a draft, unchanged', () => {
    const r = composeCall(base({ factors: longFactors() }))
    expect(isRejection(r)).toBe(false)
    expect(r).toEqual({
      sym: 'TEST',
      side: 'long',
      composite: 63.2,
      setup: 'reversal',
      evidence: { coverage: 0.66, famAgree: 2, contract: false, contextPts: 0, detail: 'core coverage 66% · 2 core families agree · context +0pt' },
      factors: {
        technical: { score: 84, detail: 'early-reversal volume-confirmed', weight: 1 },
        momentum: { score: 40, detail: '+10pp', weight: 0.9 },
        bandwidth: { score: null, detail: '', weight: 0.4 },
        sector: { score: null, detail: '', weight: 0.3 },
        social: { score: null, detail: '', weight: 0.5 },
        channels: { score: null, detail: '', weight: 0.5 },
        insiders: { score: null, detail: '', weight: 0.4 },
        news: { score: null, detail: '', weight: 0.5 },
        seasonality: { score: null, detail: '', weight: 0.3 },
        smartMoney: { score: null, detail: '', weight: 0.3 },
        catalyst: { score: null, detail: '', weight: 0.6 },
      },
      expectedMovePct: 6.3,
      entry: 100,
      stop: 97,
      target: 106.3,
      capacityPct: 10,
      smallCap: false,
      earningsRisk: false,
      stage: 'early-reversal',
      note: 'technical: early-reversal volume-confirmed · momentum: +10pp',
      thesis: 'Long TEST — the chart is turning up off its low with volume behind it. Wrong if it closes below 97.',
      falsifier: 'Wrong if it closes below 97.',
    })
    expect(Object.keys(r as object)).not.toContain('rejected')
  })
})
