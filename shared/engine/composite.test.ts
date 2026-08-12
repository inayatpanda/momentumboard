import { describe, expect, it } from 'vitest'
import { CONTEXT_MAX_PTS, DEFAULT_WEIGHTS, LONG_REGIME_MULT, composeCall, coreCompositeOf, setupFamilyOf, type ComposeInput } from './composite'
import { AGGRESSIVE_GATES, MODERATE_GATES } from './catalyst'
import { catalystFactor } from './factors'
import type { FactorName, FactorScore } from './types'

const nullFactors = (): Record<FactorName, FactorScore> => ({
  technical: { score: null, detail: '' },
  momentum: { score: null, detail: '' },
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
    expect(composeCall(base())).toBeNull()
  })

  it('strong long in green regime: side, sane levels, expected move', () => {
    const call = composeCall(base({ factors: longFactors() }))!
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
    expect(composeCall(base({ factors: modest, entryQuality: 'early', stage: 'pullback' }))!.composite).toBeCloseTo(40, 1)
    expect(composeCall(base({ factors: modest, entryQuality: 'early', stage: 'pullback', regime: 'red' }))).toBeNull() // 40×0.55 = 22 < 25
  })

  it('dead zone: |composite| < 25 → null; boundary 25 passes', () => {
    const weak = { ...nullFactors(), technical: { score: 20, detail: 'basing' } }
    expect(composeCall(base({ factors: weak, stage: 'basing', entryQuality: 'neutral' }))).toBeNull()
    const boundary = { ...nullFactors(), technical: { score: 25, detail: 'basing' } }
    expect(composeCall(base({ factors: boundary, stage: 'basing', entryQuality: 'neutral' }))).not.toBeNull()
  })

  it('short from exhaustion in red regime: mirrored levels', () => {
    const shortF = { ...nullFactors(), technical: { score: -84, detail: 'exhausted' }, momentum: { score: -40, detail: '' } }
    const call = composeCall(base({ factors: shortF, regime: 'red', entryQuality: 'chase', stage: 'exhausted' }))!
    expect(call.side).toBe('short')
    //   coreNum = 1.0×(−84) + 0.9×(−40) = −120; coreDen 1.9 → −63.1578…
    //   short in red: ×1.1 → −69.4736… → −69.5 (was −70.9 off the −64.44 core)
    expect(call.composite).toBeCloseTo(-69.5, 1)
    expect(call.stop).toBeGreaterThan(call.entry)
    expect(call.target).toBeLessThan(call.entry)
  })

  it('side-aware gates: no chased longs, no shorts into fresh strength, knives wait', () => {
    expect(composeCall(base({ factors: longFactors(), entryQuality: 'chase', stage: 'extended' }))).toBeNull()
    const shortF = { ...nullFactors(), technical: { score: -60, detail: '' }, momentum: { score: -60, detail: '' } }
    expect(composeCall(base({ factors: shortF, stage: 'pullback', entryQuality: 'early' }))).toBeNull()
    expect(composeCall(base({ factors: longFactors(), entryQuality: 'wait', stage: 'falling-knife' }))).toBeNull()
  })

  it('dead money never makes a call: the expected move is the whole eligibility test', () => {
    // capacity 2 at composite 40 expects 0.4 × 2 = 0.8% over ten sessions. That
    // is inside the spread and the noise — no conviction rescues arithmetic that
    // small, and the flat floor used to admit exactly this name at capacity 6.
    const forty = { ...nullFactors(), technical: { score: 40, detail: 'pullback' } }
    expect(composeCall(base({ factors: forty, capacityPct: 2, stage: 'pullback' }))).toBeNull()
    expect(composeCall(base({ factors: longFactors(), capacityPct: null }))).toBeNull() // capacity unknown → nothing to expect
  })

  it('the floor is the move THIS call expects, not the volatility class the name belongs to', () => {
    // ONE name, capacity 5, three convictions. Under the old flat floor (6) the
    // name was ineligible at every conviction; now its own arithmetic decides.
    const at = (score: number) => ({ ...nullFactors(), technical: { score, detail: 'pullback' } })
    const cap5 = (score: number) => composeCall(base({ factors: at(score), capacityPct: 5, stage: 'pullback' }))
    expect(cap5(45)!.expectedMovePct).toBeCloseTo(2.3, 1) // 0.45 × 5 = 2.25 ≥ 1.5 → a trade
    expect(cap5(30)).not.toBeNull() // 0.30 × 5 = 1.5 — the boundary is inclusive
    expect(cap5(26)).toBeNull() // 0.26 × 5 = 1.3 < 1.5 — same name, thinner conviction, no trade
    // …and the reversal the rethink exists for: a GLW-class 6%-mover with real
    // conviction expects 2.4% and trades, where the flat floor admitted it only
    // by the accident of clearing a volatility threshold.
    expect(composeCall(base({ factors: at(40), capacityPct: 6, stage: 'pullback' }))!.expectedMovePct).toBeCloseTo(2.4, 1)
  })

  it('small caps get the wider stop', () => {
    const small = composeCall(base({ factors: longFactors(), capUsdM: 800 }))!
    expect(small.smallCap).toBe(true)
    expect(small.stop).toBe(96) // 100 − 2×2
  })

  it('missing atr or close → null; note names top factors', () => {
    expect(composeCall(base({ factors: longFactors(), atr: null }))).toBeNull()
    expect(composeCall(base({ factors: longFactors(), lastClose: null }))).toBeNull()
    expect(composeCall(base({ factors: longFactors() }))!.note).toContain('technical')
  })

  it('worldMult 0.85 pushes a marginal long under the dead zone → suppressed', () => {
    // single technical factor → composite == score (the weight cancels, so the
    // re-base cannot move this); green regime ×1.0. Score 28
    // clears the 25 dead zone on its own, but the risk-off long nudge kills it.
    const marginal = { ...nullFactors(), technical: { score: 28, detail: 'basing' } }
    const bull = base({ factors: marginal, stage: 'basing', entryQuality: 'neutral' })
    expect(composeCall(bull)!.composite).toBeCloseTo(28, 1) // passes with no nudge
    expect(composeCall({ ...bull, worldMult: 0.85 })).toBeNull() // 28 × 0.85 = 23.8 < 25
  })

  it('worldMult 1.1 lifts a sub-threshold call over the dead zone → passes', () => {
    const under = { ...nullFactors(), technical: { score: 23, detail: 'basing' } }
    const bull = base({ factors: under, stage: 'basing', entryQuality: 'neutral' })
    expect(composeCall(bull)).toBeNull() // 23 < 25 with no nudge
    const lifted = composeCall({ ...bull, worldMult: 1.1 })! // 23 × 1.1 = 25.3 ≥ 25
    expect(lifted).not.toBeNull()
    expect(lifted.composite).toBeCloseTo(25.3, 1)
    expect(lifted.side).toBe('long') // a positive mult never flips the side
  })

  it('the world nudge scales conviction but leaves the side sign intact', () => {
    const shortF = { ...nullFactors(), technical: { score: -60, detail: 'exhausted' } }
    const bear = base({ factors: shortF, stage: 'exhausted', entryQuality: 'chase' })
    const plain = composeCall(bear)!
    const boosted = composeCall({ ...bear, worldMult: 1.1 })!
    expect(boosted.side).toBe('short')
    expect(Math.abs(boosted.composite)).toBeGreaterThan(Math.abs(plain.composite))
  })

  it('catalyst relaxes the floor by 0.5pp: swing capacity is trailing, the news is today', () => {
    // capacity 5 at composite 26 expects 1.3% — short of the ordinary 1.5 floor,
    // but the name is in play TODAY and its trailing ten-session travel has not
    // caught up to that fact yet. 1.3 ≥ 1.5 − 0.5.
    const marginal = { ...nullFactors(), technical: { score: 26, detail: 'pullback' } }
    const quiet = base({ factors: marginal, capacityPct: 5, stage: 'pullback' })
    expect(composeCall(quiet)).toBeNull() // ordinary name, too little to expect → suppressed
    expect(
      composeCall({ ...quiet, catalyst: { kind: 'news', side: 'long', reason: 'oil spike', strength: 80 } }),
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
      composeCall(base({ factors: at(score), capacityPct, stage: 'pullback', ...over }))
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
      composeCall(base({ factors: forty, capacityPct: 2, stage: 'pullback', catalyst: { kind: 'news', side: 'long', reason: 'x', strength: 90 } })),
    ).toBeNull() // 0.4 × 2 = 0.8 < the relaxed floor 1.0
  })

  it('a catalyst vote can NOT carry a marginal core over the dead zone — a headline is never a thesis', () => {
    // a quiet chart on its own makes no call; under the two-layer composite a
    // strong long catalyst (context) no longer rescues it — the core must
    // clear the gate alone. The catalyst still relaxes the expected-move floor and
    // still tilts conviction on an already-valid call (tested elsewhere).
    const quiet = { ...nullFactors(), technical: { score: 15, detail: 'trending' } }
    expect(composeCall(base({ factors: quiet, stage: 'trending', entryQuality: 'neutral' }))).toBeNull() // 15 < 25
    const withVote = { ...quiet, catalyst: catalystFactor({ kind: 'news', side: 'long', reason: 'beneficiary', strength: 80 }) }
    expect(
      composeCall(base({ factors: withVote, stage: 'trending', entryQuality: 'neutral', catalyst: { kind: 'news', side: 'long', reason: 'beneficiary', strength: 80 } })),
    ).toBeNull()
  })

  it('a short-side catalyst votes down and never flips a clearly-long name', () => {
    const vote = catalystFactor({ kind: 'news', side: 'short', reason: 'sanctioned', strength: 70 })
    expect(vote.score).toBeLessThan(0)
    const bull = { ...longFactors(), catalyst: vote }
    // catalyst drags conviction but the dominant technical keeps it long
    expect(composeCall(base({ factors: bull, catalyst: { kind: 'news', side: 'short', reason: 'sanctioned', strength: 70 } }))!.side).toBe('long')
  })

  it('aggressive gates lower the dead zone and the expected-move floor vs moderate', () => {
    const marginal = { ...nullFactors(), technical: { score: 22, detail: 'basing' } }
    const b = { factors: marginal, stage: 'basing' as const, entryQuality: 'neutral' as const, capacityPct: 5 }
    expect(composeCall(base({ ...b, gates: MODERATE_GATES }))).toBeNull() // 22 < the 25 dead zone
    expect(composeCall(base({ ...b, gates: AGGRESSIVE_GATES }))).not.toBeNull() // 22 ≥ 20, and 0.22 × 5 = 1.1 ≥ 1.0
    // the floor on its own, with the dead zone out of the way: 1.3 clears 1.0, not 1.5
    const clears = { ...nullFactors(), technical: { score: 26, detail: 'basing' } }
    const c = { factors: clears, stage: 'basing' as const, entryQuality: 'neutral' as const, capacityPct: 5 }
    expect(composeCall(base({ ...c, gates: MODERATE_GATES }))).toBeNull() // 1.3 < 1.5
    expect(composeCall(base({ ...c, gates: AGGRESSIVE_GATES }))).not.toBeNull() // 1.3 ≥ 1.0
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
    sector: { score: null, detail: '' },
    seasonality: { score: null, detail: '' },
  })

  it('context alone is never a call, however loud', () => {
    expect(composeCall(base({ factors: loudContext() }))).toBeNull()
  })

  it('context contribution is capped at CONTEXT_MAX_PTS on a valid core', () => {
    const core = composeCall(base({ factors: longFactors() }))!
    const withCtx = composeCall(base({ factors: { ...longFactors(), ...({} as object), social: { score: 60, detail: '' }, channels: { score: 70, detail: '' }, news: { score: 50, detail: '' }, catalyst: { score: 90, detail: '' } } }))!
    // ctx vote mass (0.5·60 + 0.5·70 + 0.5·50 + 0.6·90)/1.9
    //             = (30 + 35 + 25 + 54)/1.9 = 144/1.9 = 75.8 → clamped to +12
    // (was 76 under the old vector — the cap is what makes this pin re-base-proof)
    expect(withCtx.composite).toBeCloseTo(core.composite + CONTEXT_MAX_PTS, 1)
    expect(withCtx.evidence.contextPts).toBe(CONTEXT_MAX_PTS)
  })

  it('a missing context factor never changes the core read — same model for every ticker', () => {
    const bare = composeCall(base({ factors: longFactors() }))!
    const oneCtxNull = { ...longFactors(), news: { score: 0, detail: 'quiet tape' } }
    // news at 0 vs news missing: identical composite — context nulls don't renormalise
    expect(composeCall(base({ factors: oneCtxNull }))!.composite).toBeCloseTo(bare.composite, 1)
  })

  it('hostile context can push a marginal core under the dead zone (eligibility veto) but never flips the side', () => {
    const marginal = { ...nullFactors(), technical: { score: 26, detail: 'basing' } }
    expect(composeCall(base({ factors: marginal, stage: 'basing', entryQuality: 'neutral' }))!.side).toBe('long') // 26 ≥ 25 alone
    const hostile = { ...marginal, channels: { score: -70, detail: 'bears' }, news: { score: -50, detail: 'sour' } }
    // ctx (−0.5·70 − 0.5·50)/1 = −60 → clamped −12 → 26−12 = 14 < 25 → suppressed, NOT shorted
    expect(composeCall(base({ factors: hostile, stage: 'basing', entryQuality: 'neutral' }))).toBeNull()
  })

  it('evidence contract: needs momentum, a confirming leg, and 2 agreeing core families', () => {
    // technical+momentum agree but NO confirming leg (no sector/volume/breadth)
    const bare = composeCall(base({ factors: longFactors() }))!
    expect(bare.evidence.contract).toBe(false)
    expect(bare.evidence.famAgree).toBe(2)
    // volume confirmation supplies the missing leg
    const confirmed = composeCall(base({ factors: longFactors(), volumeConfirmed: true }))!
    expect(confirmed.evidence.contract).toBe(true)
    // sector data also supplies it
    const withSector = composeCall(base({ factors: { ...longFactors(), sector: { score: 20, detail: 'p75' } } }))!
    expect(withSector.evidence.contract).toBe(true)
    expect(withSector.evidence.famAgree).toBe(3)
    // momentum DISAGREES → only 1 family agrees → no contract even with the leg
    const lonely = { ...nullFactors(), technical: { score: 84, detail: '' }, momentum: { score: -20, detail: '' } }
    const call = composeCall(base({ factors: lonely, volumeConfirmed: true }))!
    expect(call.evidence.famAgree).toBe(1)
    expect(call.evidence.contract).toBe(false)
    // unknown regime never passes
    const unknown = composeCall(base({ factors: longFactors(), volumeConfirmed: true, regime: 'unknown' }))!
    expect(unknown.evidence.contract).toBe(false)
  })

  it('coverage reports the core weight actually present', () => {
    // technical 1.0 + momentum 0.9 = 1.9 present, of the core total
    // 1.0 + 0.9 + sector 0.3 + seasonality 0.3 = 2.5 → 1.9/2.5 = 0.76.
    // Sector's demotion RAISES coverage on a two-factor read: the same two
    // factors now account for more of what the core could have been.
    expect(composeCall(base({ factors: longFactors() }))!.evidence.coverage).toBeCloseTo(0.76, 2)
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
    const call = composeCall(base({ factors }))!
    expect(Math.abs(call.composite - core)).toBeLessThanOrEqual(CONTEXT_MAX_PTS)
    // and it reads the names the GATES throw away — that is its whole purpose
    expect(coreCompositeOf(factors, DEFAULT_WEIGHTS, 'red')).not.toBeNull()
    expect(composeCall(base({ factors, capacityPct: 1 }))).toBeNull()
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
    const call = composeCall(base({ factors: longFactors() }))!
    expect(call.setup).toBe('reversal') // base stage is early-reversal
  })
})
