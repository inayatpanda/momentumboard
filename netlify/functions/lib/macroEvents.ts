import type { Candle } from '../../../shared/types'
import { rsi } from '../../../shared/indicators'

// Macro shock sentinel: watches the assets that transmit world events into
// equities (oil, gold, VIX, dollar, natgas). Detects one-day shocks and
// unsustainable stretches; historical analogues turn "how far can it go"
// into measured base rates instead of guesses.

export interface MacroAsset {
  sym: string
  name: string
  shockPct: number // one-day move that counts as a shock
  watch: { up: string; down: string } // who benefits / suffers when it RISES
  etps: string // the user's LSE leveraged/inverse routes
}

export const MACRO_ASSETS: MacroAsset[] = [
  { sym: 'CL=F', name: 'WTI Crude Oil', shockPct: 4, watch: { up: 'XLE, XOM, CVX, OXY, SHEL/BP (LSE); airlines & cruise suffer (JETS, IAG.L, CCL)', down: 'airlines/transport benefit; energy majors suffer' }, etps: 'WisdomTree 3x Crude (3CRL.L) long / 3x Short Crude (3CRS.L)' },
  { sym: 'GC=F', name: 'Gold', shockPct: 2.5, watch: { up: 'GDX miners, fear trade on; risk assets often soft', down: 'risk-on tell; miners suffer' }, etps: '3x Gold (3GOL.L) / 3x Short Gold (3GOS.L)' },
  { sym: '^VIX', name: 'VIX', shockPct: 20, watch: { up: 'risk-off shock: high-beta and small caps hit first; quality/defensives hold', down: 'fear unwinding; risk-on continuation' }, etps: 'inverse index ETPs (e.g. 3x Short S&P, SPXS.L-style) express the fear side' },
  { sym: 'DX-Y.NYB', name: 'US Dollar Index', shockPct: 1.2, watch: { up: 'US multinationals & EM pressured; UK/LSE names with USD revenue gain on GBP terms', down: 'commodities & EM breathe' }, etps: 'currency-hedged exposure matters more than a direct ETP here' },
  { sym: 'NG=F', name: 'Natural Gas', shockPct: 6, watch: { up: 'producers (EQT, AR), UK utilities squeeze', down: 'utilities & industrials relieved' }, etps: '3x Natural Gas (3NGL.L) / short equivalents' },
]

export interface ShockEvent {
  kind: 'shock'
  sym: string
  name: string
  movePct: number
  dir: 'up' | 'down'
}

export interface StretchEvent {
  kind: 'stretch'
  sym: string
  name: string
  zScore: number
  rsi: number
  dir: 'up' | 'down'
}

export type MacroEvent = ShockEvent | StretchEvent

export function detectShock(asset: MacroAsset, candles: Candle[]): ShockEvent | null {
  if (candles.length < 2) return null
  const prev = candles[candles.length - 2].c
  const cur = candles[candles.length - 1].c
  const movePct = ((cur - prev) / prev) * 100
  if (Math.abs(movePct) < asset.shockPct) return null
  return { kind: 'shock', sym: asset.sym, name: asset.name, movePct: Math.round(movePct * 10) / 10, dir: movePct > 0 ? 'up' : 'down' }
}

/** Unsustainable extension: price >2.5σ from its 90-session mean with hot/cold RSI. */
export function detectStretch(asset: MacroAsset, candles: Candle[]): StretchEvent | null {
  if (candles.length < 100) return null
  const closes = candles.map(c => c.c)
  const window = closes.slice(-90)
  const mean = window.reduce((s, x) => s + x, 0) / window.length
  const sd = Math.sqrt(window.reduce((s, x) => s + (x - mean) ** 2, 0) / window.length)
  if (sd === 0) return null
  const z = (closes[closes.length - 1] - mean) / sd
  const r = rsi(closes)
  const lastRsi = r[r.length - 1]
  if (lastRsi == null) return null
  if (z >= 2.5 && lastRsi > 75) return { kind: 'stretch', sym: asset.sym, name: asset.name, zScore: Math.round(z * 10) / 10, rsi: Math.round(lastRsi), dir: 'up' }
  if (z <= -2.5 && lastRsi < 25) return { kind: 'stretch', sym: asset.sym, name: asset.name, zScore: Math.round(z * 10) / 10, rsi: Math.round(lastRsi), dir: 'down' }
  return null
}

export interface Analogues {
  n: number
  median5: number | null // median further move over the next 5 sessions (%)
  p75_5: number | null // 75th percentile — the "reasonable extension" ceiling
  median20: number | null
  maxExt5: number | null // the worst/best case seen
}

/** After every historical day that moved like today, what happened next? */
export function shockAnalogues(candles: Candle[], movePct: number, dir: 'up' | 'down'): Analogues {
  const thresh = Math.abs(movePct) * 0.75 // similar-or-bigger days, same direction
  const fwd5: number[] = []
  const fwd20: number[] = []
  for (let i = 1; i < candles.length - 1; i++) {
    const day = ((candles[i].c - candles[i - 1].c) / candles[i - 1].c) * 100
    if (dir === 'up' ? day >= thresh : day <= -thresh) {
      if (i + 5 < candles.length) fwd5.push(((candles[i + 5].c - candles[i].c) / candles[i].c) * 100)
      if (i + 20 < candles.length) fwd20.push(((candles[i + 20].c - candles[i].c) / candles[i].c) * 100)
    }
  }
  const q = (xs: number[], p: number) => {
    if (!xs.length) return null
    const s = [...xs].sort((a, b) => a - b)
    return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10
  }
  return {
    n: fwd5.length,
    median5: q(fwd5, 0.5),
    p75_5: q(fwd5, dir === 'up' ? 0.75 : 0.25),
    median20: q(fwd20, 0.5),
    maxExt5: fwd5.length ? Math.round((dir === 'up' ? Math.max(...fwd5) : Math.min(...fwd5)) * 10) / 10 : null,
  }
}
