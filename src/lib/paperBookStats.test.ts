import { describe, expect, it } from 'vitest'
import type { PaperBookData, PaperBookTrade } from './api'
import { paperBookStats } from './paperBookStats'

const trade = (plGBP: number, costGBP = 1_000): PaperBookTrade => ({
  sym: 'AAA', side: 'long', grade: 'B', openedDate: '2026-08-01', entry: 10, stop: 9, target: 12,
  qty: 100, costGBP, closedDate: '2026-08-04', exit: 11, plGBP, plPct: plGBP / 10, reason: 'horizon',
})
const book = (over: Partial<PaperBookData> = {}): PaperBookData => ({
  month: '2026-08', startGBP: 10_000, cash: 8_000, positions: [], closed: [],
  history: [{ date: '1', equity: 10_000 }, { date: '2', equity: 11_000 }, { date: '3', equity: 9_900 }, { date: '4', equity: 10_500 }],
  ...over,
})

describe('paperBookStats', () => {
  it('computes return, drawdown, profit factor and expectancy', () => {
    const s = paperBookStats(book({ closed: [trade(300), trade(-100), trade(200)] }))
    expect(s.returnPct).toBe(5)
    expect(s.maxDrawdownPct).toBe(10)
    expect(s.winRate).toBeCloseTo(2 / 3)
    expect(s.profitFactor).toBe(5)
    expect(s.expectancyGBP).toBeCloseTo(400 / 3)
  })

  it('reports current exposure and handles an empty record honestly', () => {
    const s = paperBookStats(book({ positions: [{ sym: 'AAA', side: 'long', grade: 'A', openedDate: 'x', entry: 10, stop: 9, target: 12, qty: 200, costGBP: 2_000 }] }))
    expect(s.exposurePct).toBeCloseTo(2000 / 10500 * 100)
    expect(s.winRate).toBeNull()
    expect(s.profitFactor).toBeNull()
    expect(s.expectancyGBP).toBeNull()
  })
})
