import type { Candle } from '../../../shared/types'

// Sector rotation via the 11 SPDR sector ETFs: relative strength vs SPY over
// 1w/1m/3m. Where the 1-week rank leads the 1-month rank, money is rotating IN.

export const SECTORS = [
  { sym: 'XLK', name: 'Technology' },
  { sym: 'XLF', name: 'Financials' },
  { sym: 'XLE', name: 'Energy' },
  { sym: 'XLV', name: 'Healthcare' },
  { sym: 'XLI', name: 'Industrials' },
  { sym: 'XLY', name: 'Consumer Disc.' },
  { sym: 'XLP', name: 'Staples' },
  { sym: 'XLU', name: 'Utilities' },
  { sym: 'XLB', name: 'Materials' },
  { sym: 'XLC', name: 'Comm. Services' },
  { sym: 'XLRE', name: 'Real Estate' },
] as const

export function returnOver(candles: Candle[], days: number): number | null {
  if (candles.length <= days) return null
  const end = candles[candles.length - 1].c
  const start = candles[candles.length - 1 - days].c
  return ((end - start) / start) * 100
}

export interface SectorRow {
  sym: string
  name: string
  rs5: number | null // relative strength vs SPY, 5 sessions
  rs21: number | null
  rs63: number | null
  trend: 'in' | 'out' | 'flat' // is short-term RS leading or lagging medium-term?
}

export function computeSectorRows(candlesBySym: Map<string, Candle[]>, spy: Candle[]): SectorRow[] {
  const rows: SectorRow[] = []
  for (const s of SECTORS) {
    const candles = candlesBySym.get(s.sym)
    if (!candles) continue
    const rel = (days: number) => {
      const sec = returnOver(candles, days)
      const idx = returnOver(spy, days)
      return sec != null && idx != null ? Math.round((sec - idx) * 100) / 100 : null
    }
    const rs5 = rel(5)
    const rs21 = rel(21)
    const rs63 = rel(63)
    const trend: SectorRow['trend'] =
      rs5 != null && rs21 != null ? (rs5 - rs21 / 4 > 0.35 ? 'in' : rs5 - rs21 / 4 < -0.35 ? 'out' : 'flat') : 'flat'
    rows.push({ sym: s.sym, name: s.name, rs5, rs21, rs63, trend })
  }
  return rows.sort((a, b) => (b.rs21 ?? -Infinity) - (a.rs21 ?? -Infinity))
}
