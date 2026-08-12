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
} from './voice'
import {
  catalystFactor,
  channelsFactor,
  insiderFactor,
  momentumFactor,
  newsFactor,
  seasonalityFactor,
  sectorFactor,
  smartMoneyFactor,
  socialFactor,
  technicalFactor,
} from './factors'
import type { Stage } from '../technicals'
import type { FactorName, FactorScore } from './types'

const STAGES: Stage[] = ['early-reversal', 'basing', 'pullback', 'trending', 'weak', 'extended', 'exhausted', 'falling-knife']

/** Every phrase this module can emit, for the sweep. Built from REAL factor
 * outputs wherever a factor produces them, so the humanisation stays pinned to
 * the detail strings factors.ts actually writes rather than to a hand-typed copy
 * of them that can drift silently. */
const realFactors = (): [FactorName, FactorScore][] => [
  ['technical', technicalFactor({ stage: 'pullback', volumeConfirmed: true, rvol: 1.8, emaStack: { aligned: 'bull' }, volThrust: 1.7 })],
  ['momentum', momentumFactor([...Array(21).fill(100), 118], [...Array(21).fill(100), 103])],
  ['sector', sectorFactor(0.86)],
  ['seasonality', seasonalityFactor({ reliable: true, months: [{ month: 8, name: 'August', avgPct: 3.1, n: 7 }] } as never, 8)],
  ['social', socialFactor({ redditRank: 4, surgeMultiple: 2.4, sources: 3 }, 55)],
  ['channels', channelsFactor([{ channel: 'Stocks with Josh', stance: 'bull' }], () => 1)],
  ['insiders', insiderFactor({ isCluster: true, buyers: ['A', 'B', 'C'] })],
  ['news', newsFactor(['XYZ beats and surges', 'XYZ wins record order'])],
  ['smartMoney', smartMoneyFactor({ bought: ['Duquesne'], exited: [], filedAt: '2026-06-30' })],
  ['catalyst', catalystFactor({ kind: 'earnings', side: 'long', strength: 70, reason: 'raised full-year guidance' })],
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

  it('the ten factor names and the eight stages are all on the list', () => {
    for (const n of ['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'])
      expect(BANNED_TOKENS).toContain(n)
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
  it('translates every real factor output into clean prose', () => {
    for (const [name, f] of realFactors()) {
      const phrase = factorPhrase(name, f)
      expect(phrase, `${name} produced no phrase from ${f.detail}`).toBeTruthy()
      expect(bannedTokensIn(phrase!), `${name}: ${phrase}`).toEqual([])
    }
  })

  it('reads the numbers out of the detail rather than inventing them', () => {
    expect(factorPhrase('momentum', momentumFactor([...Array(21).fill(100), 118], [...Array(21).fill(100), 103]))).toBe(
      '15 points of outperformance against the S&P over the last month',
    )
    expect(factorPhrase('sector', sectorFactor(0.86))).toBe('its industry group among the strongest in the market')
    expect(factorPhrase('insiders', insiderFactor({ isCluster: true, buyers: ['A', 'B', 'C'] }))).toBe(
      "3 of the company's own directors buying together",
    )
    expect(factorPhrase('news', newsFactor(['XYZ beats and surges']))).toBe('1 headline on it reading positive')
  })

  it('a factor with no data, and one whose detail carries no reason, both stay silent', () => {
    expect(factorPhrase('momentum', { score: null, detail: 'insufficient history' })).toBeNull()
    expect(factorPhrase('sector', sectorFactor(0.5))).toBeNull() // a middling rank is a measurement, not a reason
    // the chart factor MINUS the stage: nothing else in the detail → nothing to add
    expect(factorPhrase('technical', technicalFactor({ stage: 'basing', volumeConfirmed: false, rvol: null, emaStack: null, volThrust: null }))).toBeNull()
  })

  it('free text the engine did not write is dropped when it would leak a name', () => {
    // a channel actually called this would otherwise put a factor name in the paper
    const dirty = channelsFactor([{ channel: 'Momentum Weekly', stance: 'bull' }], () => 1)
    expect(factorPhrase('channels', dirty)).toBe('the commentators we follow calling it higher')
    // …and a catalyst whose reason is clean keeps the reason
    expect(factorPhrase('catalyst', catalystFactor({ kind: 'earnings', side: 'long', strength: 70, reason: 'raised full-year guidance' }))).toBe(
      'a live event on it — raised full-year guidance',
    )
    // …while one whose reason is a lane's own read falls back to the bare sentence
    expect(
      factorPhrase('catalyst', catalystFactor({ kind: 'dip', side: 'long', strength: 40, reason: 'dip −14.2% · news: overreaction' })),
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
    // a SHORT's supporting context is negative points — the gate is the magnitude
    const short = composeThesis({ sym: 'NVDA', side: 'short', stage: 'weak', stop: 100, core: null, context, contextPts: -6 })
    expect(short.thesis).toContain('and 1 headline on it reading positive')
  })

  it('a stage the engine could not read still produces a sentence, never a blank', () => {
    const { thesis } = composeThesis({ sym: 'XYZ', side: 'long', stage: null, stop: 9, core: null })
    expect(thesis).toBe('Long XYZ — the chart is not giving a clean read. Wrong if it closes below 9.')
  })

  it('every stage × side × factor combination is clean prose', () => {
    for (const stage of [...STAGES, null]) {
      for (const side of ['long', 'short'] as const) {
        for (const [name, factor] of realFactors()) {
          const { thesis, falsifier } = composeThesis({ sym: 'SYM', side, stage, stop: 12.34, core: { name, factor }, context: { name, factor }, contextPts: 9 })
          expect(bannedTokensIn(thesis), thesis).toEqual([])
          expect(bannedTokensIn(falsifier), falsifier).toEqual([])
          expect(thesis.startsWith(side === 'long' ? 'Long SYM — ' : 'Short SYM — ')).toBe(true)
        }
      }
    }
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
