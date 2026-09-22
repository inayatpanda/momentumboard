import { describe, expect, it } from 'vitest'
import {
  BANNED_TOKENS,
  CONTEXT_MIN_PTS,
  STAGE_PHRASE,
  bannedTokensIn,
  composeThesis,
  dipThesis,
  factorPhrase,
  fixedFalsifier,
  stagePhrase,
  trailFalsifier,
  velocityThesis,
  wildcardThesis,
  WILDCARD_LABEL,
  WILDCARD_WARNING,
} from './voice'
import {
  catalystFactor,
  channelsFactor,
  bandwidthFactor,
  insiderFactor,
  momentumFactor,
  newsFactor,
  seasonalityFactor,
  sectorFactor,
  smartMoneyFactor,
  socialFactor,
  technicalFactor,
} from './factors'
import { DEFAULT_WEIGHTS } from './composite'
import type { Stage } from '../technicals'
import type { FactorName, FactorScore } from './types'

const STAGES: Stage[] = ['early-reversal', 'basing', 'pullback', 'trending', 'weak', 'extended', 'exhausted', 'falling-knife']

/** 200 closes drifting at `drift` whose bands BLOW OUT over the last 30 bars — a
 * real `bandwidthFactor` reading rather than a hand-typed detail string. */
const widened = (drift: number) => Array.from({ length: 200 }, (_, i) => 100 * (1 + drift * i) + (i < 170 ? 0.05 : 6) * Math.sin(i))

/** Every phrase this module can emit, for the sweep. Built from REAL factor
 * outputs wherever a factor produces them, so the humanisation stays pinned to
 * the detail strings factors.ts actually writes rather than to a hand-typed copy
 * of them that can drift silently. */
const realFactors = (): [FactorName, FactorScore][] => [
  ['technical', technicalFactor({ stage: 'pullback', volumeConfirmed: true, rvol: 1.8, emaStack: { aligned: 'bull' }, volThrust: 1.7 })],
  ['momentum', momentumFactor([...Array(21).fill(100), 118], [...Array(21).fill(100), 103])],
  ['bandwidth', bandwidthFactor(widened(0.004))],
  ['sector', sectorFactor(0.86)],
  ['seasonality', seasonalityFactor({ reliable: true, months: [{ month: 8, name: 'August', avgPct: 3.1, n: 7 }] } as never, 8)],
  ['social', socialFactor({ redditRank: 4, surgeMultiple: 2.4, sources: 3 }, 55)],
  ['channels', channelsFactor([{ channel: 'Stocks with Josh', stance: 'bull' }], () => 1)],
  ['insiders', insiderFactor({ isCluster: true, buyers: ['A', 'B', 'C'] })],
  ['news', newsFactor(['XYZ beats and surges', 'XYZ wins record order'])],
  ['smartMoney', smartMoneyFactor({ bought: ['Duquesne'], exited: [], filedAt: '2026-06-30' })],
  ['catalyst', catalystFactor({ kind: 'earnings', side: 'long', strength: 70, reason: 'raised full-year guidance' })],
]

/** …and the SAME factors on the other side of the tape. The sweep used to vary
 * stage and side while every factor stayed bullish, so every phrase's negative
 * branch — the seasonal month that loses money, the fund that sold, the week the
 * crowd left — went unexercised. Both defects this file was rewritten for lived
 * in that gap: a `+` prefixed onto an already-signed number (only reachable on a
 * POSITIVE seasonal average, so the sweep never printed it) and a bullish volume
 * clause on a SHORT (only reachable when the sign of the call and the sign of the
 * factor disagree). Sign is now a dimension of the cross-product. */
const bearFactors = (): [FactorName, FactorScore][] => [
  ['technical', technicalFactor({ stage: 'weak', volumeConfirmed: true, rvol: 2.4, emaStack: { aligned: 'bear' }, volThrust: 0.5 })],
  // …and the other bearish branch of the chart factor: a turn nothing paid for
  ['technical', technicalFactor({ stage: 'early-reversal', volumeConfirmed: false, rvol: null, emaStack: null, volThrust: null })],
  ['momentum', momentumFactor([...Array(21).fill(100), 88], [...Array(21).fill(100), 103])],
  ['bandwidth', bandwidthFactor(widened(-0.002))],
  ['sector', sectorFactor(0.18)],
  ['seasonality', seasonalityFactor({ reliable: true, months: [{ month: 8, name: 'August', avgPct: -3.1, n: 7 }] } as never, 8)],
  ['channels', channelsFactor([{ channel: 'Stocks with Josh', stance: 'bear' }], () => 1)],
  ['news', newsFactor(['XYZ misses and plunges', 'XYZ hit by a lawsuit'])],
  ['smartMoney', smartMoneyFactor({ bought: [], exited: ['Duquesne'], filedAt: '2026-06-30' })],
  ['catalyst', catalystFactor({ kind: 'earnings', side: 'short', strength: 70, reason: 'cut full-year guidance' })],
]

describe('the banned-token rule — the machine never speaks to the reader', () => {
  it('catches a factor name, a stage enum and a field name, whole-word and case-blind', () => {
    expect(bannedTokensIn('technical: pullback, every timeframe pointing up')).toEqual(expect.arrayContaining(['technical', 'pullback']))
    expect(bannedTokensIn('Momentum is fine')).toContain('momentum')
    expect(bannedTokensIn('its expectedMovePct is 6')).toContain('expectedMovePct')
  })

  it('…and does NOT catch ordinary prose that merely contains a banned token', () => {
    // the exact reason the phrases below are worded the way they are
    expect(bannedTokensIn('weakness has been bought all week')).toEqual([])
    expect(bannedTokensIn('it has pulled back into support')).toEqual([])
    expect(bannedTokensIn('the trend is intact')).toEqual([])
    expect(bannedTokensIn('the chart has built a base')).toEqual([])
  })

  it('anything shaped like an identifier is a leak whether or not it is listed', () => {
    expect(bannedTokensIn('the row carries someUnlistedField today')).toEqual(['someUnlistedField'])
  })

  it('EVERY factor name and the eight stages are all on the list', () => {
    // read off DEFAULT_WEIGHTS rather than typed out, so a factor added to the
    // vector without being added to the ban list fails HERE rather than by
    // appearing in a reader's sentence
    for (const n of Object.keys(DEFAULT_WEIGHTS)) expect(BANNED_TOKENS).toContain(n)
    for (const s of STAGES) expect(BANNED_TOKENS).toContain(s)
  })
})

describe('STAGE_PHRASE — all eight stages have a human sentence', () => {
  it('every stage is translated, and none of them says its own enum value', () => {
    expect(Object.keys(STAGE_PHRASE).sort()).toEqual([...STAGES].sort())
    for (const s of STAGES) {
      const phrase = STAGE_PHRASE[s]
      expect(phrase.length).toBeGreaterThan(8)
      expect(bannedTokensIn(phrase)).toEqual([]) // …which also proves it never echoes the enum
    }
  })

  it('a chart with no stage read says so instead of falling silent', () => {
    expect(stagePhrase(null)).toBe('the chart is not giving a clean read')
    expect(bannedTokensIn(stagePhrase(null))).toEqual([])
  })
})

describe('factorPhrase — one clause per factor, from that factor\'s own detail', () => {
  it('translates every real factor output into clean prose — in BOTH directions', () => {
    for (const side of ['long', 'short'] as const) {
      for (const [name, f] of [...realFactors(), ...bearFactors()]) {
        const phrase = factorPhrase(name, f, side)
        expect(phrase, `${name} (${side}) produced no phrase from ${f.detail}`).toBeTruthy()
        expect(bannedTokensIn(phrase!), `${name}: ${phrase}`).toEqual([])
        expect(phrase!, `${name} (${side}) doubled a sign: ${phrase}`).not.toMatch(/\+\+|--/)
      }
    }
  })

  it('the bands speak only at the wide end — a middling width is a measurement, not a reason', () => {
    // p95 of its own 120 sessions: the study's better-performing end, and the copy
    // reports an association and stops short of any mechanism
    expect(factorPhrase('bandwidth', bandwidthFactor(widened(0.004)), 'long')).toBe(
      "bands at the 95th percentile of their own year — wide bands have carried the better forward record in the engine's walk over the last ~300 sessions",
    )
    // …and the same SHAPE of sentence on a short, because the bands have no side
    // of their own
    expect(factorPhrase('bandwidth', bandwidthFactor(widened(-0.002)), 'short')).toBe(
      "bands at the 94th percentile of their own year — wide bands have carried the better forward record in the engine's walk over the last ~300 sessions",
    )
    // a width sitting mid-distribution says nothing rather than saying it hollowly
    expect(factorPhrase('bandwidth', { score: 27, detail: 'Bollinger width p54 of its own 120 sessions (bandwidth 0.54), signed by a 50-EMA rising 2% over 20 sessions' }, 'long')).toBeNull()
    // …and so does a coiled one: this factor's weak end is not a reason either way
    expect(factorPhrase('bandwidth', { score: 2, detail: 'Bollinger width p4 of its own 120 sessions (bandwidth 0.04), signed by a 50-EMA rising 2% over 20 sessions' }, 'long')).toBeNull()
    // a null factor never speaks at all
    expect(factorPhrase('bandwidth', bandwidthFactor(null), 'long')).toBeNull()
  })

  it('reads the numbers out of the detail rather than inventing them', () => {
    expect(factorPhrase('momentum', momentumFactor([...Array(21).fill(100), 118], [...Array(21).fill(100), 103]), 'long')).toBe(
      '15 points of outperformance against the S&P over the last month',
    )
    expect(factorPhrase('sector', sectorFactor(0.86), 'long')).toBe('its industry group among the strongest in the market')
    expect(factorPhrase('insiders', insiderFactor({ isCluster: true, buyers: ['A', 'B', 'C'] }), 'long')).toBe(
      "3 of the company's own directors buying together",
    )
    expect(factorPhrase('news', newsFactor(['XYZ beats and surges']), 'long')).toBe('1 headline on it reading positive')
  })

  // THE DOUBLE PLUS. seasonalityFactor writes its own sign into the detail
  // (`August avg +3.1% over 7 yrs`), so a phrase that prefixes another one prints
  // "averaging ++3.1%". Both signs are pinned VERBATIM here — this was the one
  // factor whose output the phrase tests never spelt out, which is why a defect
  // visible in the string escaped a suite that only asked whether it was clean.
  it('the seasonal average carries exactly one sign, whichever way the month runs', () => {
    const up = seasonalityFactor({ reliable: true, months: [{ month: 8, name: 'August', avgPct: 3.1, n: 7 }] } as never, 8)
    expect(up.detail).toBe('August avg +3.1% over 7 yrs') // the sign is ALREADY in the capture
    expect(factorPhrase('seasonality', up, 'long')).toBe('August averaging +3.1% here over 7 years')
    const down = seasonalityFactor({ reliable: true, months: [{ month: 8, name: 'August', avgPct: -3.1, n: 7 }] } as never, 8)
    expect(down.detail).toBe('August avg -3.1% over 7 yrs')
    expect(factorPhrase('seasonality', down, 'short')).toBe('August averaging -3.1% here over 7 years')
  })

  // THE BULLISH CLAUSE ON A SHORT. factors.ts is explicit that heavy volume into
  // weakness is usually capitulation and gives it ZERO weight on a short (the
  // ×1.2 amplifier is `volumeConfirmed && base > 0`). A thesis that cites it as a
  // reason to be short states a belief the engine measured and rejected.
  it('a SHORT is never told there is volume behind it', () => {
    // the reachable tape: a broken chart, timeframes disagreeing, today paid for
    const f = technicalFactor({ stage: 'weak', volumeConfirmed: true, rvol: 2.4, emaStack: { aligned: 'mixed' }, volThrust: null })
    expect(f.detail).toContain('volume-confirmed')
    const short = factorPhrase('technical', f, 'short')!
    expect(short).not.toContain('volume behind it')
    expect(short).toContain('does not count in a short') // …the honest accounting, said out loud
    // the same tape on a long, where the engine DOES count it, is unchanged
    expect(factorPhrase('technical', f, 'long')).toBe('volume behind it')
  })

  it('…and the week the crowd arrived is reported on a short without reading bullish', () => {
    const f = technicalFactor({ stage: 'weak', volumeConfirmed: false, rvol: null, emaStack: null, volThrust: 1.8 })
    expect(f.detail).toContain('a week of building participation')
    expect(factorPhrase('technical', f, 'long')).toBe('a week of the crowd arriving')
    expect(factorPhrase('technical', f, 'short')).toBe('a heavy week') // counted, but not cheered
  })

  it('a factor with no data, and one whose detail carries no reason, both stay silent', () => {
    expect(factorPhrase('momentum', { score: null, detail: 'insufficient history' }, 'long')).toBeNull()
    expect(factorPhrase('sector', sectorFactor(0.5), 'long')).toBeNull() // a middling rank is a measurement, not a reason
    // the chart factor MINUS the stage: nothing else in the detail → nothing to add
    expect(factorPhrase('technical', technicalFactor({ stage: 'basing', volumeConfirmed: false, rvol: null, emaStack: null, volThrust: null }), 'long')).toBeNull()
    // …and the insider factor's own negative branch is `no insider buying`, whose
    // phrase must be silence and not the buying claim the substring suggests
    expect(factorPhrase('insiders', insiderFactor(null), 'long')).toBeNull()
  })

  it('free text the engine did not write is dropped when it would leak a name', () => {
    // a channel actually called this would otherwise put a factor name in the paper
    const dirty = channelsFactor([{ channel: 'Momentum Weekly', stance: 'bull' }], () => 1)
    expect(factorPhrase('channels', dirty, 'long')).toBe('the commentators we follow calling it higher')
    // …and a catalyst whose reason is clean keeps the reason
    expect(factorPhrase('catalyst', catalystFactor({ kind: 'earnings', side: 'long', strength: 70, reason: 'raised full-year guidance' }), 'long')).toBe(
      'a live event on it — raised full-year guidance',
    )
    // …while one whose reason is a lane's own read falls back to the bare sentence
    expect(
      factorPhrase('catalyst', catalystFactor({ kind: 'dip', side: 'long', strength: 40, reason: 'dip −14.2% · news: overreaction' }), 'long'),
    ).toBe('a live event on it today')
  })
})

describe('composeThesis — the composite call says what it believes', () => {
  const core = { name: 'technical' as FactorName, factor: technicalFactor({ stage: 'pullback', volumeConfirmed: true, rvol: 1.8, emaStack: { aligned: 'bull' }, volThrust: null }) }
  const context = { name: 'news' as FactorName, factor: newsFactor(['XYZ beats and surges']) }

  it('the full template: side, symbol, stage, core reason, and the falsifier', () => {
    const { thesis, falsifier } = composeThesis({ sym: 'ABBV', side: 'long', stage: 'pullback', stop: 182.4, core })
    expect(thesis).toBe('Long ABBV — it has pulled back into support with every timeframe pointing the same way and volume behind it. Wrong if it closes below 182.4.')
    expect(falsifier).toBe('Wrong if it closes below 182.4.')
    expect(thesis.endsWith(falsifier)).toBe(true) // the two can never drift apart
  })

  it('a short says "above" — the falsifier carries the direction, not just the level', () => {
    const { thesis, falsifier } = composeThesis({ sym: 'NVDA', side: 'short', stage: 'weak', stop: 178.2, core: null })
    expect(thesis).toBe('Short NVDA — the chart is broken. Wrong if it closes above 178.2.')
    expect(falsifier).toBe(fixedFalsifier('short', 178.2))
  })

  it('context is quoted only when the capped context layer actually moved the number', () => {
    const under = composeThesis({ sym: 'ABBV', side: 'long', stage: 'pullback', stop: 90, core, context, contextPts: CONTEXT_MIN_PTS - 0.1 })
    expect(under.thesis).not.toContain('headline')
    const over = composeThesis({ sym: 'ABBV', side: 'long', stage: 'pullback', stop: 90, core, context, contextPts: CONTEXT_MIN_PTS })
    expect(over.thesis).toContain(', and 1 headline on it reading positive.')
    // a SHORT's supporting context is negative points — the magnitude AND the sign
    const short = composeThesis({ sym: 'NVDA', side: 'short', stage: 'weak', stop: 100, core: null, context, contextPts: -6 })
    expect(short.thesis).toContain('and 1 headline on it reading positive')
  })

  // …and the other half of the stated intent: context is quoted because it moved
  // the number TOWARD this call. Points of the wrong sign moved it away, and a
  // thesis that cites them tells the reader the case was helped by evidence that
  // argued against it.
  it('context that pushed the OTHER way is not quoted, however big it is', () => {
    const long = composeThesis({ sym: 'ABBV', side: 'long', stage: 'pullback', stop: 90, core, context, contextPts: -9 })
    expect(long.thesis).not.toContain('headline')
    const short = composeThesis({ sym: 'NVDA', side: 'short', stage: 'weak', stop: 100, core: null, context, contextPts: 9 })
    expect(short.thesis).not.toContain('headline')
  })

  it('a stage the engine could not read still produces a sentence, never a blank', () => {
    const { thesis } = composeThesis({ sym: 'XYZ', side: 'long', stage: null, stop: 9, core: null })
    expect(thesis).toBe('Long XYZ — the chart is not giving a clean read. Wrong if it closes below 9.')
  })

  // THE SWEEP, and the dimension it was missing. Stage × side × factor now runs
  // over the bearish branch of every factor as well as the bullish one, and the
  // context points are signed to AGREE with the side so the second clause is
  // actually exercised on a short. Two assertions beyond cleanliness: the prose
  // never doubles a sign (`++3.1%`), and it always opens with its own side.
  it('every stage × side × factor combination, in both signs, is clean prose', () => {
    for (const stage of [...STAGES, null]) {
      for (const side of ['long', 'short'] as const) {
        for (const [name, factor] of [...realFactors(), ...bearFactors()]) {
          const contextPts = side === 'long' ? 9 : -9 // context that supports THIS call
          const { thesis, falsifier } = composeThesis({ sym: 'SYM', side, stage, stop: 12.34, core: { name, factor }, context: { name, factor }, contextPts })
          expect(bannedTokensIn(thesis), thesis).toEqual([])
          expect(bannedTokensIn(falsifier), falsifier).toEqual([])
          expect(thesis, `doubled sign: ${thesis}`).not.toMatch(/\+\+|--/)
          expect(thesis.startsWith(side === 'long' ? 'Long SYM — ' : 'Short SYM — ')).toBe(true)
        }
      }
    }
  })

  // The reviewer's reachable tape, end to end: a broken chart whose timeframes
  // disagree and whose fall was volume-paid, published as a SHORT.
  it('a short thesis never claims volume is behind it', () => {
    const paidFall = { name: 'technical' as FactorName, factor: technicalFactor({ stage: 'weak', volumeConfirmed: true, rvol: 2.4, emaStack: { aligned: 'mixed' }, volThrust: null }) }
    const { thesis } = composeThesis({ sym: 'NVDA', side: 'short', stage: 'weak', stop: 178.2, core: paidFall })
    expect(thesis).toBe(
      'Short NVDA — the chart is broken with heavy volume into the weakness, which the engine does not count in a short\'s favour. Wrong if it closes above 178.2.',
    )
    expect(thesis).not.toContain('volume behind it')
  })
})

describe('dipThesis — depth, the hold, and what the story said', () => {
  it('the template, with each of the three news reads', () => {
    expect(dipThesis({ sym: 'GLW', dropPct: 14.23, stop: 42.1 }).thesis).toBe('Long GLW — hit 14.2% and holding. Wrong if it closes below 42.1.')
    expect(dipThesis({ sym: 'GLW', dropPct: 14.2, stop: 42.1, news: 'transient' }).thesis).toBe(
      'Long GLW — hit 14.2% and holding, and the story behind the fall reads like an overreaction. Wrong if it closes below 42.1.',
    )
    expect(dipThesis({ sym: 'GLW', dropPct: 14.2, stop: 42.1, news: 'structural' }).thesis).toContain('something actually broke')
    // unchecked is not evidence either way and must not be dressed as one
    expect(dipThesis({ sym: 'GLW', dropPct: 14.2, stop: 42.1, news: 'unclear' }).thesis).toBe(dipThesis({ sym: 'GLW', dropPct: 14.2, stop: 42.1 }).thesis)
  })

  it('is clean whatever the read', () => {
    for (const news of ['transient', 'structural', 'unclear', null] as const) {
      const { thesis, falsifier } = dipThesis({ sym: 'GLW', dropPct: 12, stop: 42.1, news })
      expect(bannedTokensIn(thesis), thesis).toEqual([])
      expect(falsifier).toBe('Wrong if it closes below 42.1.')
      expect(thesis.endsWith(falsifier)).toBe(true)
    }
  })
})

describe('velocityThesis — the door, what paid for it, and a falsifier that MOVES', () => {
  it('both doors, and the trail sentence that says the level ratchets', () => {
    expect(velocityThesis({ sym: 'NVDA', door: 'early', stop: 98.4, paidMult: 3.42 }).thesis).toBe(
      'Long NVDA — the first paid break of its 20-session high on 3.4x its usual volume. Wrong on the first close below the trail (98.4 today, and it ratchets).',
    )
    expect(velocityThesis({ sym: 'NVDA', door: 'confirmation', stop: 98.4, paidMult: 2.1 }).thesis).toBe(
      'Long NVDA — an established run that has paused without breaking on a 2.1x up-day. Wrong on the first close below the trail (98.4 today, and it ratchets).',
    )
    expect(velocityThesis({ sym: 'NVDA', door: 'early', stop: 98.4, paidMult: 3 }).falsifier).toBe(trailFalsifier(98.4))
  })

  it('an unmeasurable baseline never becomes "0x" — the sentence stays honest', () => {
    expect(velocityThesis({ sym: 'NVDA', door: 'early', stop: 98.4, paidMult: null }).thesis).toContain('on the volume that paid for it')
  })

  it('is clean on both doors', () => {
    for (const door of ['early', 'confirmation'] as const) {
      const { thesis, falsifier } = velocityThesis({ sym: 'NVDA', door, stop: 98.4, paidMult: 3 })
      expect(bannedTokensIn(thesis), thesis).toEqual([])
      expect(bannedTokensIn(falsifier), falsifier).toEqual([])
      expect(thesis.endsWith(falsifier)).toBe(true)
    }
  })
})

describe('wildcardThesis — the experiment says what it is, every time', () => {
  const hypothesis = 'dead-zone-core has 7 priced outcomes and 40 unpriced in the miss ledger, none of them causal; this takes the long it blocked, core read 23.1, for one real outcome with a stop.'

  it('carries the label, the hypothesis VERBATIM, the standing warning and the falsifier', () => {
    const { thesis, falsifier } = wildcardThesis({ sym: 'GLW', side: 'long', stop: 42.1, hypothesis })
    expect(thesis).toBe(`${WILDCARD_LABEL} · Long GLW — quarter size, testing a gate: ${hypothesis} ${WILDCARD_WARNING} ${fixedFalsifier('long', 42.1)}`)
    expect(falsifier).toBe(fixedFalsifier('long', 42.1))
    expect(thesis.endsWith(falsifier)).toBe(true)
  })

  it('the WARNING is unconditional — there is no shape of row that omits it', () => {
    for (const side of ['long', 'short'] as const) {
      const { thesis } = wildcardThesis({ sym: 'GLW', side, stop: side === 'long' ? 42.1 : 61.4, hypothesis: 'x.' })
      expect(thesis).toContain(WILDCARD_WARNING)
      expect(thesis).toContain(WILDCARD_LABEL)
    }
  })

  it('is clean — the sentence reaches the paper and the DOM like every other one here', () => {
    const { thesis, falsifier } = wildcardThesis({ sym: 'GLW', side: 'short', stop: 61.4, hypothesis })
    expect(bannedTokensIn(thesis), thesis).toEqual([])
    expect(bannedTokensIn(falsifier), falsifier).toEqual([])
  })
})

describe('safe() strips markup and prompt-steering characters', () => {
  it('a hostile catalyst reason reaches the thesis as words, never as markup', () => {
    // The thesis rides into the journalist LLM prompt as well as the DOM —
    // angle brackets, backticks, quotes and braces have no legitimate place in
    // a headline-derived reason (DeepSeek cross-check, 2026-08-12).
    const phrase = factorPhrase('catalyst', { score: 60, detail: 'news: "><script>alert(1)</script> beats `guidance` (60)' }, 'long')
    expect(phrase ?? '').not.toMatch(/[<>`"{}]/)
  })
})
