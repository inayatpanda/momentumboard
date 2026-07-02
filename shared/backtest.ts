import type { Candle, SetupKind } from './types'
import { detectSetups } from './setups'

export interface BacktestSignal {
  setup: SetupKind
  index: number
  price: number
  fwd: { d5: number | null; d10: number | null; d20: number | null }
}

export interface BacktestSummary {
  setup: SetupKind
  n: number
  win5: number | null // fraction of signals positive after 5 bars
  avg5: number | null // mean % return after 5 bars
  avg10: number | null
  avg20: number | null
}

const HORIZONS = [5, 10, 20] as const

/** Replay history: at each bar, detect setup ADDITIONS exactly as the live
 * engine would have seen them, then measure forward returns. Honest caveats:
 * daily closes only, no costs/slippage, RVOL is full-day (fraction 1). */
export function runBacktest(candles: Candle[]): { signals: BacktestSignal[]; summary: BacktestSummary[] } {
  const signals: BacktestSignal[] = []
  const vols = candles.map(c => c.v)
  let prevSetups: SetupKind[] = []

  for (let i = 45; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const priorVols = vols.slice(Math.max(0, i - 30), i)
    const avgVol = priorVols.length >= 5 ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length : null
    const rvol = avgVol ? vols[i] / avgVol : null
    const current = detectSetups(window, rvol)
    for (const s of current.filter(x => !prevSetups.includes(x))) {
      const price = candles[i].c
      const fwdAt = (h: number) => (i + h < candles.length ? ((candles[i + h].c - price) / price) * 100 : null)
      signals.push({ setup: s, index: i, price, fwd: { d5: fwdAt(5), d10: fwdAt(10), d20: fwdAt(20) } })
    }
    prevSetups = current
  }

  const bySetup = new Map<SetupKind, BacktestSignal[]>()
  for (const sig of signals) {
    const arr = bySetup.get(sig.setup) ?? []
    arr.push(sig)
    bySetup.set(sig.setup, arr)
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
  const summary: BacktestSummary[] = [...bySetup.entries()].map(([setup, sigs]) => {
    const at = (h: (typeof HORIZONS)[number]) => sigs.map(s => s.fwd[`d${h}` as const]).filter((x): x is number => x != null)
    const f5 = at(5)
    return {
      setup,
      n: sigs.length,
      win5: f5.length ? f5.filter(x => x > 0).length / f5.length : null,
      avg5: mean(f5),
      avg10: mean(at(10)),
      avg20: mean(at(20)),
    }
  })
  summary.sort((a, b) => b.n - a.n)
  return { signals, summary }
}
