export interface Trade {
  id: string
  symbol: string
  direction: 'long' | 'short' // short = expressed via an inverse ETP
  instrument: 'stock' | 'etp'
  leverage: number // 1 for stock; the ETP's factor otherwise (info + exposure buckets, NOT pnl)
  riskClass: 'normal' | 'speculative'
  playbook: 'R' | 'B' | 'A' | 'S'
  fromSuggestion: boolean
  units: number
  entryPrice: number
  stop: number
  positionValue: number // £ actually invested
  thesis: string
  openedAt: number
  closedAt?: number
  exitPrice?: number
  notes?: string
}

export interface JournalStats {
  closedCount: number
  realizedPnl: number
  winRate: number | null
  avgWin: number | null
  avgLoss: number | null
  byPlaybook: Record<string, { n: number; totalPnl: number; expectancy: number }>
}

export interface ExposureWarning {
  code: 'position-cap' | 'leveraged-cap' | 'risk-per-trade' | 'etp-decay' | 'isa-check'
  message: string
  symbol?: string
}

/** The user logs the INSTRUMENT's own prices, so an inverse/leveraged ETP's
 * price move already embeds direction and leverage. */
export function tradePnl(t: Trade): number | null {
  if (t.exitPrice == null) return null
  return ((t.exitPrice - t.entryPrice) / t.entryPrice) * t.positionValue
}

export function computeStats(trades: Trade[]): JournalStats {
  const closed = trades.filter(t => t.exitPrice != null)
  const pnls = closed.map(t => tradePnl(t)!)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p <= 0)
  const byPlaybook: JournalStats['byPlaybook'] = {}
  closed.forEach((t, i) => {
    const b = (byPlaybook[t.playbook] ??= { n: 0, totalPnl: 0, expectancy: 0 })
    b.n++
    b.totalPnl += pnls[i]
  })
  for (const b of Object.values(byPlaybook)) b.expectancy = b.totalPnl / b.n
  return {
    closedCount: closed.length,
    realizedPnl: pnls.reduce((s, p) => s + p, 0),
    winRate: closed.length ? wins.length / closed.length : null,
    avgWin: wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : null,
    avgLoss: losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : null,
    byPlaybook,
  }
}

const POSITION_CAP_PCT = 20
const LEVERAGED_CAP_PCT = 30
const RISK_PCT = 2
const ETP_MAX_DAYS = 7 // ~5 trading days

export function exposureWarnings(openTrades: Trade[], capital: number, nowSec: number): ExposureWarning[] {
  const out: ExposureWarning[] = []
  const open = openTrades.filter(t => t.exitPrice == null)

  for (const t of open) {
    if (t.positionValue > (capital * POSITION_CAP_PCT) / 100) {
      out.push({ code: 'position-cap', symbol: t.symbol, message: `${t.symbol}: £${t.positionValue.toFixed(0)} exceeds the ${POSITION_CAP_PCT}% position cap (£${((capital * POSITION_CAP_PCT) / 100).toFixed(0)}).` })
    }
    const riskToStop = (Math.abs(t.entryPrice - t.stop) / t.entryPrice) * t.positionValue
    const limit = (capital * (t.riskClass === 'speculative' ? RISK_PCT / 2 : RISK_PCT)) / 100
    if (riskToStop > limit) {
      out.push({ code: 'risk-per-trade', symbol: t.symbol, message: `${t.symbol}: £${riskToStop.toFixed(0)} at risk to the stop — above the £${limit.toFixed(0)} (${t.riskClass === 'speculative' ? '1% speculative' : '2%'}) limit.` })
    }
    if (t.instrument === 'etp' && t.leverage > 1 && nowSec - t.openedAt > ETP_MAX_DAYS * 86_400) {
      out.push({ code: 'etp-decay', symbol: t.symbol, message: `${t.symbol}: leveraged ETP held ${Math.floor((nowSec - t.openedAt) / 86_400)} days — daily-reset decay compounds; the playbook caps holds at ~5 trading days.` })
    }
  }

  const leveraged = open.filter(t => t.instrument === 'etp' && t.leverage > 1)
  const leveragedValue = leveraged.reduce((s, t) => s + t.positionValue, 0)
  if (leveragedValue > (capital * LEVERAGED_CAP_PCT) / 100) {
    out.push({ code: 'leveraged-cap', message: `Leveraged ETP exposure £${leveragedValue.toFixed(0)} exceeds the ${LEVERAGED_CAP_PCT}% cap (£${((capital * LEVERAGED_CAP_PCT) / 100).toFixed(0)}).` })
  }
  if (open.some(t => t.instrument === 'etp')) {
    out.push({ code: 'isa-check', message: 'ETP position(s) open — verify each product’s ISA eligibility on Trading 212.' })
  }
  return out
}
