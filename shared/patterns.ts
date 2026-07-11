import type { Candle } from './types'

// Classical chart-pattern detection, pure and deterministic. Pivots come from
// a zigzag walk over closes (reversal threshold scaled to the series' own
// volatility), patterns from the shapes the last few pivots draw. Every
// detection carries its direction, whether it has CONFIRMED (neckline/level
// broken) or is still forming, and the level that matters. Conservative by
// design: tolerances are tight enough that "everything is a pattern" never
// happens — a card with no badge is the honest common case.

export interface Pivot {
  idx: number
  price: number
  kind: 'high' | 'low'
}

export type PatternKind =
  | 'head-shoulders'
  | 'inv-head-shoulders'
  | 'double-top'
  | 'double-bottom'
  | 'asc-triangle'
  | 'desc-triangle'

export interface PatternHit {
  kind: PatternKind
  label: string
  direction: 'bullish' | 'bearish'
  status: 'forming' | 'confirmed'
  level: number // the neckline / trigger the status is judged against
  pivots: number[] // candle indices involved — chartable
}

/** Swing pivots via zigzag over closes: a new pivot is booked when price
 * retraces more than `thresholdPct` from the running extreme. */
export function zigzagPivots(closes: number[], thresholdPct: number): Pivot[] {
  if (closes.length < 3) return []
  const pivots: Pivot[] = []
  let dir: 'up' | 'down' | null = null
  let extIdx = 0
  let extPrice = closes[0]
  // bootstrap: track the running min AND max until their spread clears the
  // threshold — the earlier extreme becomes the first pivot, the later one
  // the live leg. No direction is guessed before the data shows one.
  let minIdx = 0
  let maxIdx = 0
  for (let i = 1; i < closes.length && dir === null; i++) {
    if (closes[i] <= closes[minIdx]) minIdx = i
    if (closes[i] >= closes[maxIdx]) maxIdx = i
    const spread = ((closes[maxIdx] - closes[minIdx]) / closes[minIdx]) * 100
    if (spread >= thresholdPct) {
      if (maxIdx > minIdx) {
        pivots.push({ idx: minIdx, price: closes[minIdx], kind: 'low' })
        dir = 'up'
        extIdx = maxIdx
        extPrice = closes[maxIdx]
      } else {
        pivots.push({ idx: maxIdx, price: closes[maxIdx], kind: 'high' })
        dir = 'down'
        extIdx = minIdx
        extPrice = closes[minIdx]
      }
    }
  }
  if (dir === null) return []
  for (let i = extIdx + 1; i < closes.length; i++) {
    const c = closes[i]
    if (dir === 'up') {
      if (c > extPrice) {
        extPrice = c
        extIdx = i
      } else if (((extPrice - c) / extPrice) * 100 >= thresholdPct) {
        pivots.push({ idx: extIdx, price: extPrice, kind: 'high' })
        dir = 'down'
        extPrice = c
        extIdx = i
      }
    } else {
      if (c < extPrice) {
        extPrice = c
        extIdx = i
      } else if (((c - extPrice) / extPrice) * 100 >= thresholdPct) {
        pivots.push({ idx: extIdx, price: extPrice, kind: 'low' })
        dir = 'up'
        extPrice = c
        extIdx = i
      }
    }
  }
  // the still-running extreme is a provisional final pivot
  if (dir) pivots.push({ idx: extIdx, price: extPrice, kind: dir === 'up' ? 'high' : 'low' })
  return pivots
}

const near = (a: number, b: number, tolPct: number) => Math.abs(a - b) / ((a + b) / 2) <= tolPct / 100

/** Detect classical patterns over the last ~120 bars. `volPct` (typical swing
 * size) drives both the zigzag threshold and the similarity tolerances, so
 * placid megacaps and 8%-a-day small caps are judged on their own scales. */
export function detectPatterns(candles: Candle[]): PatternHit[] {
  if (candles.length < 30) return []
  const window = candles.slice(-120)
  const closes = window.map(c => c.c)
  const last = closes[closes.length - 1]

  // volatility scale: median absolute daily change, floored so quiet series
  // don't degenerate into pivot noise
  const dailyMoves = closes.slice(1).map((c, i) => Math.abs((c - closes[i]) / closes[i]) * 100).sort((a, b) => a - b)
  const median = dailyMoves[Math.floor(dailyMoves.length / 2)] || 1
  const threshold = Math.max(2.5, median * 3)
  const tol = Math.max(1.5, median * 1.5)

  const pivots = zigzagPivots(closes, threshold)
  if (pivots.length < 4) return []
  const hits: PatternHit[] = []
  const offset = candles.length - window.length

  const highs = (ps: Pivot[]) => ps.filter(p => p.kind === 'high')
  const lows = (ps: Pivot[]) => ps.filter(p => p.kind === 'low')

  // ---- head & shoulders (and inverse): last 3 same-side pivots, middle extreme
  const tail = pivots.slice(-7)
  const h = highs(tail)
  const l = lows(tail)
  if (h.length >= 3) {
    const [ls, head, rs] = h.slice(-3)
    const troughs = l.filter(p => p.idx > ls.idx && p.idx < rs.idx)
    if (troughs.length >= 2 && head.price > ls.price && head.price > rs.price && near(ls.price, rs.price, tol * 2)) {
      const neckline = Math.min(...troughs.map(t => t.price))
      hits.push({
        kind: 'head-shoulders',
        label: 'Head & shoulders',
        direction: 'bearish',
        status: last < neckline ? 'confirmed' : 'forming',
        level: Math.round(neckline * 100) / 100,
        pivots: [ls, head, rs].map(p => p.idx + offset),
      })
    }
  }
  if (l.length >= 3) {
    const [ls, head, rs] = l.slice(-3)
    const peaks = h.filter(p => p.idx > ls.idx && p.idx < rs.idx)
    if (peaks.length >= 2 && head.price < ls.price && head.price < rs.price && near(ls.price, rs.price, tol * 2)) {
      const neckline = Math.max(...peaks.map(t => t.price))
      hits.push({
        kind: 'inv-head-shoulders',
        label: 'Inverse H&S',
        direction: 'bullish',
        status: last > neckline ? 'confirmed' : 'forming',
        level: Math.round(neckline * 100) / 100,
        pivots: [ls, head, rs].map(p => p.idx + offset),
      })
    }
  }

  // ---- double top / bottom: two similar extremes, no H&S already booked there
  if (!hits.some(x => x.kind === 'head-shoulders') && h.length >= 2) {
    const [a, b] = h.slice(-2)
    const between = l.filter(p => p.idx > a.idx && p.idx < b.idx)
    if (between.length >= 1 && near(a.price, b.price, tol)) {
      const trough = Math.min(...between.map(p => p.price))
      hits.push({
        kind: 'double-top',
        label: 'Double top',
        direction: 'bearish',
        status: last < trough ? 'confirmed' : 'forming',
        level: Math.round(trough * 100) / 100,
        pivots: [a, b].map(p => p.idx + offset),
      })
    }
  }
  if (!hits.some(x => x.kind === 'inv-head-shoulders') && l.length >= 2) {
    const [a, b] = l.slice(-2)
    const between = h.filter(p => p.idx > a.idx && p.idx < b.idx)
    if (between.length >= 1 && near(a.price, b.price, tol)) {
      const peak = Math.max(...between.map(p => p.price))
      hits.push({
        kind: 'double-bottom',
        label: 'Double bottom',
        direction: 'bullish',
        status: last > peak ? 'confirmed' : 'forming',
        level: Math.round(peak * 100) / 100,
        pivots: [a, b].map(p => p.idx + offset),
      })
    }
  }

  // ---- triangles: flat one side, converging other side (last 2 of each)
  if (h.length >= 2 && l.length >= 2) {
    const [h1, h2] = h.slice(-2)
    const [l1, l2] = l.slice(-2)
    const flatTop = near(h1.price, h2.price, tol)
    const flatBottom = near(l1.price, l2.price, tol)
    const risingLows = l2.price > l1.price * (1 + tol / 200)
    const fallingHighs = h2.price < h1.price * (1 - tol / 200)
    if (flatTop && risingLows && !flatBottom) {
      const cap = Math.max(h1.price, h2.price)
      hits.push({
        kind: 'asc-triangle',
        label: 'Ascending triangle',
        direction: 'bullish',
        status: last > cap ? 'confirmed' : 'forming',
        level: Math.round(cap * 100) / 100,
        pivots: [h1, l1, h2, l2].map(p => p.idx + offset).sort((a, b) => a - b),
      })
    } else if (flatBottom && fallingHighs && !flatTop) {
      const floor = Math.min(l1.price, l2.price)
      hits.push({
        kind: 'desc-triangle',
        label: 'Descending triangle',
        direction: 'bearish',
        status: last < floor ? 'confirmed' : 'forming',
        level: Math.round(floor * 100) / 100,
        pivots: [h1, l1, h2, l2].map(p => p.idx + offset).sort((a, b) => a - b),
      })
    }
  }

  return hits
}
