import type { Candle, SetupKind } from '../../../shared/types'

export interface SignalLogEntry {
  symbol: string
  setup: SetupKind
  price: number
  at: number
  regime?: string | null
  rvol?: number | null
}

export interface SignalScore {
  setup: SetupKind
  n: number
  scored: number // how many had ≥5 sessions of history to score
  win5: number | null
  avg5: number | null
  avg10: number | null
}

/** Scores live signals against what price actually did afterwards. */
export function scoreSignals(log: SignalLogEntry[], candlesBySymbol: Map<string, Candle[]>): SignalScore[] {
  const bySetup = new Map<SetupKind, { f5: number[]; f10: number[]; total: number }>()
  for (const sig of log) {
    const agg = bySetup.get(sig.setup) ?? { f5: [], f10: [], total: 0 }
    agg.total++
    const candles = candlesBySymbol.get(sig.symbol)
    if (candles) {
      // first bar strictly after the signal moment is day+1; day of signal is entryIdx
      let entryIdx = candles.findIndex(c => c.t > sig.at)
      if (entryIdx === -1) entryIdx = candles.length
      entryIdx-- // the bar the signal fired on
      if (entryIdx >= 0) {
        if (entryIdx + 5 < candles.length) agg.f5.push(((candles[entryIdx + 5].c - sig.price) / sig.price) * 100)
        if (entryIdx + 10 < candles.length) agg.f10.push(((candles[entryIdx + 10].c - sig.price) / sig.price) * 100)
      }
    }
    bySetup.set(sig.setup, agg)
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
  return [...bySetup.entries()]
    .map(([setup, a]) => ({
      setup,
      n: a.total,
      scored: a.f5.length,
      win5: a.f5.length ? a.f5.filter(x => x > 0).length / a.f5.length : null,
      avg5: mean(a.f5),
      avg10: mean(a.f10),
    }))
    .sort((a, b) => b.n - a.n)
}
