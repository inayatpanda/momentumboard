import { describe, it, expect } from 'vitest'
import { computeStats, exposureWarnings, tradePnl, type Trade } from './journal'

const DAY = 86_400
const NOW = 1_782_950_000

const trade = (over: Partial<Trade> = {}): Trade => ({
  id: 't1',
  symbol: 'AAPL',
  direction: 'long',
  instrument: 'stock',
  leverage: 1,
  riskClass: 'normal',
  playbook: 'R',
  fromSuggestion: false,
  units: 10,
  entryPrice: 100,
  stop: 95,
  positionValue: 1000,
  thesis: 'base reclaim',
  openedAt: NOW - DAY,
  ...over,
})

describe('tradePnl', () => {
  it('is pct change times position value (instrument prices embed leverage)', () => {
    expect(tradePnl(trade({ exitPrice: 110 }))).toBeCloseTo(100, 6) // +10% on £1000
    expect(tradePnl(trade({ exitPrice: 95 }))).toBeCloseTo(-50, 6)
    expect(tradePnl(trade())).toBeNull() // still open
  })
})

describe('computeStats', () => {
  const closed = [
    trade({ id: 'a', exitPrice: 110, closedAt: NOW, playbook: 'R' }), // +100
    trade({ id: 'b', exitPrice: 95, closedAt: NOW, playbook: 'R' }), // -50
    trade({ id: 'c', exitPrice: 120, closedAt: NOW, playbook: 'B' }), // +200
    trade({ id: 'd' }), // open — excluded
  ]
  it('aggregates realized pnl, win rate, avg win/loss and per-playbook expectancy', () => {
    const s = computeStats(closed)
    expect(s.closedCount).toBe(3)
    expect(s.realizedPnl).toBeCloseTo(250)
    expect(s.winRate).toBeCloseTo(2 / 3)
    expect(s.avgWin).toBeCloseTo(150)
    expect(s.avgLoss).toBeCloseTo(-50)
    expect(s.byPlaybook.R.expectancy).toBeCloseTo(25) // (100-50)/2
    expect(s.byPlaybook.B.expectancy).toBeCloseTo(200)
  })
  it('handles the empty journal', () => {
    const s = computeStats([])
    expect(s.closedCount).toBe(0)
    expect(s.winRate).toBeNull()
  })
})

describe('exposureWarnings (capital 5000)', () => {
  it('flags a position above the 20% cap', () => {
    const w = exposureWarnings([trade({ positionValue: 1500 })], 5000, NOW)
    expect(w.some(x => x.code === 'position-cap')).toBe(true)
  })
  it('flags leveraged ETP exposure above 30%', () => {
    const open = [
      trade({ id: 'x', instrument: 'etp', leverage: 3, positionValue: 900 }),
      trade({ id: 'y', instrument: 'etp', leverage: 2, positionValue: 700 }),
    ]
    const w = exposureWarnings(open, 5000, NOW)
    expect(w.some(x => x.code === 'leveraged-cap')).toBe(true)
  })
  it('flags risk-per-trade above 2% (1% speculative)', () => {
    // 10% stop distance on £1500 = £150 risk > £100
    const w = exposureWarnings([trade({ positionValue: 1000, entryPrice: 100, stop: 88 })], 5000, NOW)
    expect(w.some(x => x.code === 'risk-per-trade')).toBe(true)
    const w2 = exposureWarnings([trade({ riskClass: 'speculative', positionValue: 1000, entryPrice: 100, stop: 94 })], 5000, NOW)
    expect(w2.some(x => x.code === 'risk-per-trade')).toBe(true) // £60 > £50 speculative cap
  })
  it('warns on leveraged ETPs held beyond 5 trading days and reminds about ISA', () => {
    const old = trade({ instrument: 'etp', leverage: 3, openedAt: NOW - 9 * DAY, positionValue: 500 })
    const w = exposureWarnings([old], 5000, NOW)
    expect(w.some(x => x.code === 'etp-decay')).toBe(true)
    expect(w.some(x => x.code === 'isa-check')).toBe(true)
  })
  it('stays quiet inside all limits', () => {
    expect(exposureWarnings([trade({ positionValue: 800 })], 5000, NOW)).toHaveLength(0)
  })
})
