import { describe, expect, it } from 'vitest'
import {
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
import type { SeasonalitySummary } from '../seasonality'

describe('technicalFactor', () => {
  it('scores early-reversal high and boosts volume confirmation', () => {
    expect(technicalFactor({ stage: 'early-reversal', volumeConfirmed: true, rvol: 2.1 }).score).toBe(84) // 70 × 1.2
  })
  it('damps an UNCONFIRMED early reversal — a turn with no volume behind it is a guess', () => {
    const f = technicalFactor({ stage: 'early-reversal', volumeConfirmed: false, rvol: 0.8 })
    expect(f.score).toBe(49) // 70 × 0.7
    expect(f.detail).toContain('unconfirmed')
    // other stages are NOT damped by missing volume
    expect(technicalFactor({ stage: 'pullback', volumeConfirmed: false, rvol: null }).score).toBe(55)
  })
  it('scores exhausted deeply negative and knife as wait (0)', () => {
    expect(technicalFactor({ stage: 'exhausted', volumeConfirmed: false, rvol: null }).score).toBe(-70)
    expect(technicalFactor({ stage: 'falling-knife', volumeConfirmed: true, rvol: 3 }).score).toBe(0)
  })
  it('null read → null score', () => {
    expect(technicalFactor(null).score).toBeNull()
  })
})

describe('momentumFactor', () => {
  const flat = Array.from({ length: 30 }, () => 100)
  it('scores 21d relative strength vs SPY, ×4', () => {
    const up = Array.from({ length: 30 }, (_, i) => (i >= 8 ? 100 * (1 + (0.1 * (i - 8)) / 21) : 100)) // +10% over last 21
    const { score } = momentumFactor(up, flat)
    expect(score).toBeCloseTo(40, 0)
  })
  it('clamps at ±80 and passes null through', () => {
    const rocket = Array.from({ length: 30 }, (_, i) => (i >= 8 ? 100 * (1 + (0.3 * (i - 8)) / 21) : 100))
    expect(momentumFactor(rocket, flat).score).toBe(80)
    expect(momentumFactor(null, flat).score).toBeNull()
    expect(momentumFactor(flat.slice(0, 10), flat).score).toBeNull()
  })
})

describe('sectorFactor', () => {
  it('maps rank percentile to ±40', () => {
    expect(sectorFactor(1).score).toBe(40)
    expect(sectorFactor(0).score).toBe(-40)
    expect(sectorFactor(0.5).score).toBe(0)
    expect(sectorFactor(null).score).toBeNull()
  })
})

describe('socialFactor', () => {
  it('caps at 60 and halves when RSI > 70 (crowded and hot)', () => {
    const row = { redditRank: 1, surgeMultiple: 3, sources: 2 }
    expect(socialFactor(row, 55).score).toBe(60) // 20+24+20=64 → cap 60
    expect(socialFactor(row, 75).score).toBe(30)
    expect(socialFactor(null, 50).score).toBeNull()
  })
})

describe('channelsFactor', () => {
  it('weights stances by channel credibility', () => {
    const cred = (ch: string) => (ch === 'Stocks with Josh' ? 0.9 : 0.3)
    const { score } = channelsFactor(
      [
        { channel: 'Stocks with Josh', stance: 'bull' },
        { channel: 'RandomChannel', stance: 'bear' },
      ],
      cred,
    )
    // (+1×1.8 − 1×0.6) × 18 = 21.6 — the credible bull outweighs the weak bear
    expect(score).toBeCloseTo(21.6, 1)
  })
  it('neutral-only → null', () => {
    expect(channelsFactor([{ channel: 'X', stance: 'neutral' }], () => 0.5).score).toBeNull()
  })
})

describe('insiderFactor', () => {
  it('cluster 45, single buy 20, none 0, unchecked null', () => {
    expect(insiderFactor({ isCluster: true, buyers: ['a', 'b'] }).score).toBe(45)
    expect(insiderFactor({ isCluster: false, buyers: ['a'] }).score).toBe(20)
    expect(insiderFactor(null).score).toBe(0)
    expect(insiderFactor(undefined).score).toBeNull()
  })
})

describe('smartMoneyFactor', () => {
  it('scores a tracked-fund buy +25, an exit −20, and notes the 13F staleness', () => {
    const buy = smartMoneyFactor({ bought: ['Berkshire Hathaway'], exited: [], filedAt: '2026-05-15' })
    expect(buy.score).toBe(25)
    expect(buy.detail).toContain('Berkshire Hathaway')
    expect(buy.detail).toContain('2026-05-15')
    expect(buy.detail).toContain('45d lag')
    expect(smartMoneyFactor({ bought: [], exited: ['Scion Asset Management'], filedAt: '2026-05-15' }).score).toBe(-20)
  })
  it('clamps at ±30 across multiple funds; a mixed signal nets out', () => {
    expect(smartMoneyFactor({ bought: ['A', 'B'], exited: [], filedAt: '2026-05-15' }).score).toBe(30) // 50 → 30
    expect(smartMoneyFactor({ bought: [], exited: ['A', 'B'], filedAt: '2026-05-15' }).score).toBe(-30)
    expect(smartMoneyFactor({ bought: ['A'], exited: ['B'], filedAt: '2026-05-15' }).score).toBe(5) // 25 − 20
  })
  it('no confident match → null (renormalises away, never a fake 0)', () => {
    expect(smartMoneyFactor(null).score).toBeNull()
    expect(smartMoneyFactor({ bought: [], exited: [], filedAt: '' }).score).toBeNull()
  })
})

describe('newsFactor', () => {
  it('reads polarity from headlines', () => {
    expect(newsFactor(['Nvidia beats estimates, shares surge']).score).toBe(40) // net +2, hits 2
    expect(newsFactor(['DOJ probe widens, lawsuit filed']).score).toBe(-40)
    expect(newsFactor([]).score).toBe(0)
  })
})

describe('seasonalityFactor', () => {
  const summary = (reliable: boolean, avgPct: number): SeasonalitySummary => ({
    dow: [],
    months: [{ month: 7, name: 'Jul', n: 4, winRate: 0.75, avgPct }],
    bestMonth: null,
    worstMonth: null,
    strongestDay: null,
    weakestDay: null,
    reliable,
  })
  it('null below the reliability gate; clamps at ±15', () => {
    expect(seasonalityFactor(summary(false, 5), 7).score).toBeNull()
    expect(seasonalityFactor(summary(true, 5), 7).score).toBe(15) // 20 clamped
    expect(seasonalityFactor(summary(true, -1.2), 7).score).toBeCloseTo(-4.8, 1)
    expect(seasonalityFactor(summary(true, 2), 3).score).toBeNull() // no read for March
    expect(seasonalityFactor(null, 7).score).toBeNull()
  })
})
