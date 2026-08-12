import { describe, it, expect } from 'vitest'
import { technicalStage } from './technicals'
import { emaLast } from './indicators'
import type { Candle } from './types'

const mk = (closes: number[], vols?: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i * 86_400, o: c, h: c * 1.01, l: c * 0.99, c, v: vols?.[i] ?? 1000 }))

describe('technicalStage', () => {
  it('flags a name that has climbed hard as extended/exhausted, not a buy', () => {
    // 60 flat sessions then a relentless 20-session ramp to fresh highs
    const closes = [...Array(60).fill(100) as number[], ...Array.from({ length: 20 }, (_, i) => 100 + i * 3)]
    const t = technicalStage('HOT', mk(closes))!
    expect(['extended', 'exhausted']).toContain(t.stage)
    expect(t.entryQuality).toBe('chase')
    expect(t.rangePos).toBeGreaterThan(0.9)
    expect(t.note.toLowerCase()).toMatch(/chas|fade|reversal risk/)
  })

  it('rewards a based-then-turning name as an early reversal on volume', () => {
    // decline, long base, then a reclaim day on heavy volume
    const decline = Array.from({ length: 30 }, (_, i) => 140 - i * 1.2) // ~140 → 105
    const base = Array.from({ length: 25 }, (_, i) => 104 + Math.sin(i) * 1.5) // coil ~104
    const closes = [...decline, ...base, 108] // reclaim pop
    const vols = [...Array(55).fill(1000) as number[], 2200] // volume surge on the reclaim
    const t = technicalStage('TURN', mk(closes, vols))!
    expect(t.volumeConfirmed).toBe(true)
    expect(['early-reversal', 'basing']).toContain(t.stage)
    expect(['early', 'neutral']).toContain(t.entryQuality)
  })

  it('marks a still-falling oversold name as a knife to wait on', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 200 - i * 4) // straight down
    const vols = [...Array(39).fill(1000) as number[], 1800]
    const t = technicalStage('FALL', mk(closes, vols))!
    expect(t.stage).toBe('falling-knife')
    expect(t.entryQuality).toBe('wait')
  })

  it('returns null without enough history', () => {
    expect(technicalStage('X', mk([1, 2, 3]))).toBeNull()
  })
})

// The EMA stack answers a question the SMA read cannot: are the timeframes
// AGREEING? A price above its 20-day SMA says one thing; price > 8 > 21 > 50
// says every horizon is pointing the same way. Nothing consumes these yet —
// this task only makes the read see them.
describe('technicalStage — the EMA stack', () => {
  const rising = Array.from({ length: 80 }, (_, i) => 100 + i)
  const falling = Array.from({ length: 80 }, (_, i) => 200 - i)
  const flat = Array(80).fill(100) as number[]
  /** A sharp V: the short EMAs have turned up and stacked, but the 50 has NOT —
   *  e21 (159.82) still sits UNDER e50 (160.83). The chain breaks at the last
   *  link, which is exactly what 'mixed' is for. */
  const turningUp = [...Array.from({ length: 65 }, (_, i) => 200 - i), ...Array.from({ length: 15 }, (_, i) => 135 + (i + 1) * 3)]

  it('reads bull when price > e8 > e21 > e50, strictly', () => {
    const t = technicalStage('UP', mk(rising))!
    expect(t.emaStack.e8).toBe(175.5)
    expect(t.emaStack.e21).toBe(169)
    expect(t.emaStack.e50).toBe(154.5)
    expect(t.price).toBe(179)
    expect(t.emaStack.aligned).toBe('bull')
  })

  it('reads bear when price < e8 < e21 < e50, strictly', () => {
    const t = technicalStage('DOWN', mk(falling))!
    expect(t.emaStack.e8).toBe(124.5)
    expect(t.emaStack.e21).toBe(131)
    expect(t.emaStack.e50).toBe(145.5)
    expect(t.emaStack.aligned).toBe('bear')
  })

  it('reads mixed on a flat tape — the ordering must be STRICT, ties are not alignment', () => {
    const t = technicalStage('FLAT', mk(flat))!
    expect(t.emaStack).toEqual({ e8: 100, e21: 100, e50: 100, aligned: 'mixed' })
  })

  it('reads mixed when the short EMAs have stacked but the 50 has not turned', () => {
    const t = technicalStage('TURN', mk(turningUp))!
    expect(t.emaStack.e8).toBe(169.85)
    expect(t.emaStack.e21).toBe(159.82)
    expect(t.emaStack.e50).toBe(160.83)
    expect(t.emaStack.e21!).toBeLessThan(t.emaStack.e50!) // the broken link
    expect(t.emaStack.aligned).toBe('mixed')
  })

  it('aligned is null the moment any leg is unknown — 40 candles cannot seed the 50', () => {
    const t = technicalStage('SHORT', mk(Array.from({ length: 40 }, (_, i) => 100 + i)))!
    expect(t.emaStack.e8).toBe(135.5)
    expect(t.emaStack.e21).toBe(129)
    expect(t.emaStack.e50).toBeNull()
    expect(t.emaStack.aligned).toBeNull() // NOT 'mixed' — an unknown is not a verdict
  })

  it('the price leg is judged on the PRINTED price — a sub-cent edge is not an alignment', () => {
    // The last leg of the chain used to compare the RAW close against a rounded
    // e8, so a close a fifth of a cent above the printed EMA read as 'bull' while
    // the card showed the two numbers as equal. Build exactly that tape: adding a
    // close moves the EMA by k(c − e) with k = 2/9, so raw e8 − close =
    // (1 − k)(prevE8 − close) — solve for the close that leaves the gap at 0.004,
    // then shift the whole series (an EMA is affine: every leg and every gap
    // survives a shift) until that close lands 0.0005 above a whole cent.
    const K = 2 / 9
    const closeFor = (head: number[]) => emaLast(head, 8)! - 0.004 / (1 - K)
    const head = Array.from({ length: 79 }, (_, i) => 50 + i * 0.4)
    const rawClose = closeFor(head)
    const shift = Math.floor(rawClose * 100) / 100 + 0.0005 - rawClose
    const shifted = head.map(c => c + shift)
    const price = closeFor(shifted)

    const t = technicalStage('HAIR', mk([...shifted, price]))!
    expect(t.price).toBe(price)
    expect(t.emaStack.e8).toBe(Math.round(price * 100) / 100) // price and e8 print the SAME number
    expect(price).toBeGreaterThan(t.emaStack.e8!) // …while the raw close is a whisker above it
    expect(t.emaStack.e8!).toBeGreaterThan(t.emaStack.e21!) // every other link of the chain holds
    expect(t.emaStack.e21!).toBeGreaterThan(t.emaStack.e50!)
    expect(t.emaStack.aligned).toBe('mixed') // so only the invisible leg could have made it 'bull'
  })
})

// rvol is one session against a 20-day average. volThrust is FIVE sessions
// against the twenty before them: whether participation is building over the
// swing horizon, not whether today was loud.
describe('technicalStage — volume thrust', () => {
  const closes = Array.from({ length: 40 }, () => 100)
  /** vols laid out so the two windows are exactly controllable: the last five
   *  sessions are `recent`, the twenty before them are the base. */
  const withVols = (recent: number[], base: number) => mk(closes, [...Array(15).fill(1000) as number[], ...Array(20).fill(base) as number[], ...recent])

  it('is > 1 when the last five sessions expand on the twenty before them', () => {
    expect(technicalStage('X', withVols([2000, 2000, 2000, 2000, 2000], 1000))!.volThrust).toBe(2)
  })

  it('is < 1 when participation is drying up', () => {
    expect(technicalStage('X', withVols([400, 400, 400, 400, 400], 1000))!.volThrust).toBe(0.4)
  })

  it('is a mean-over-mean ratio, rounded to 2dp', () => {
    // (1100+1200+1300+1400+1234)/5 = 1246.8 → 1246.8/1000 = 1.2468 → 1.25
    expect(technicalStage('X', withVols([1100, 1200, 1300, 1400, 1234], 1000))!.volThrust).toBe(1.25)
  })

  it('is null when the base window carries no volume at all — a ratio on nothing is not a number', () => {
    expect(technicalStage('X', withVols([2000, 2000, 2000, 2000, 2000], 0))!.volThrust).toBeNull()
  })

  it('is NOT rvol: today can be quiet while the five-day thrust is loud', () => {
    // today prints 800 against a ~1260 average (rvol 0.6) but the five-session
    // window means 2000 against the twenty before it: (2300×4 + 800)/5 = 2000
    const t = technicalStage('X', withVols([2300, 2300, 2300, 2300, 800], 1000))!
    expect(t.rvol).toBeLessThan(1.3)
    expect(t.volumeConfirmed).toBe(false)
    expect(t.volThrust).toBe(2)
  })
})
