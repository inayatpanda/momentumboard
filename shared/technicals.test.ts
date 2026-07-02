import { describe, it, expect } from 'vitest'
import { technicalStage } from './technicals'
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
