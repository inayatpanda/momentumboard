import type { PaperBookData } from './api'

export interface PaperBookStats {
  equity: number
  returnPct: number
  maxDrawdownPct: number
  wins: number
  losses: number
  winRate: number | null
  avgWinGBP: number | null
  avgLossGBP: number | null
  profitFactor: number | null
  expectancyGBP: number | null
  exposurePct: number
  turnover: number
}

export function paperBookStats(book: PaperBookData): PaperBookStats {
  const equity = book.history.at(-1)?.equity ?? book.startGBP
  let peak = book.history[0]?.equity ?? book.startGBP
  let maxDrawdownPct = 0
  for (const point of book.history) {
    peak = Math.max(peak, point.equity)
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equity) / peak) * 100)
  }
  const winners = book.closed.filter(t => t.plGBP > 0)
  const losers = book.closed.filter(t => t.plGBP < 0)
  const grossWin = winners.reduce((sum, t) => sum + t.plGBP, 0)
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.plGBP, 0))
  const trades = book.closed.length
  const openCost = book.positions.reduce((sum, p) => sum + Math.abs(p.costGBP), 0)
  const closedCost = book.closed.reduce((sum, p) => sum + Math.abs(p.costGBP), 0)
  return {
    equity,
    returnPct: book.startGBP > 0 ? ((equity - book.startGBP) / book.startGBP) * 100 : 0,
    maxDrawdownPct,
    wins: winners.length,
    losses: losers.length,
    winRate: trades ? winners.length / trades : null,
    avgWinGBP: winners.length ? grossWin / winners.length : null,
    avgLossGBP: losers.length ? grossLoss / losers.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    expectancyGBP: trades ? (grossWin - grossLoss) / trades : null,
    exposurePct: equity > 0 ? (openCost / equity) * 100 : 0,
    turnover: book.startGBP > 0 ? (closedCost + openCost) / book.startGBP : 0,
  }
}
