import { describe, expect, it } from 'vitest'
import { avgDollarVol20, ROSTER_MAX, updateRoster, type RosterCandidate, type RosterEntry } from './roster'
import type { Candle } from '../types'

const cand = (sym: string, over: Partial<RosterCandidate> = {}): RosterCandidate => ({
  sym,
  source: 'screener',
  capUsdM: 10_000,
  capacityPct: 12,
  dollarVol20d: 50e6,
  price: 40,
  ...over,
})

describe('avgDollarVol20', () => {
  it('mean of close×volume over the last 20 bars; null under 20', () => {
    const candles: Candle[] = Array.from({ length: 25 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1_000_000 }))
    expect(avgDollarVol20(candles)).toBe(10_000_000)
    expect(avgDollarVol20(candles.slice(0, 10))).toBeNull()
  })
})

describe('updateRoster', () => {
  it('joins only past every gate: capacity ≥8, $5M dollar-vol, price ≥ $1', () => {
    const { roster, joined } = updateRoster([], [cand('GOOD'), cand('SLOW', { capacityPct: 5 }), cand('THIN', { dollarVol20d: 1e6 }), cand('PENNY', { price: 0.5 })], [], '2026-07-02')
    expect(joined).toEqual(['GOOD'])
    expect(roster.map(r => r.sym)).toEqual(['GOOD'])
  })

  it('drops non-watchlist names that went quiet (>21 days unqualified), never watchlist', () => {
    const stale: RosterEntry[] = [
      { sym: 'OLD', joined: '2026-05-01', source: 'screener', capUsdM: 5000, lastCapacity: 4, lastQualified: '2026-06-01' },
      { sym: 'WATCH', joined: '2026-05-01', source: 'watchlist', capUsdM: 5000, lastCapacity: 4, lastQualified: '2026-06-01' },
    ]
    const { roster, dropped } = updateRoster(stale, [], ['WATCH'], '2026-07-02')
    expect(dropped).toEqual([{ sym: 'OLD', why: 'went quiet' }])
    expect(roster.map(r => r.sym)).toEqual(['WATCH'])
  })

  it('keeps a member alive when fresh data re-qualifies it; drops on liquidity failure', () => {
    const entries: RosterEntry[] = [
      { sym: 'LIVE', joined: '2026-05-01', source: 'screener', capUsdM: 5000, lastCapacity: 9, lastQualified: '2026-06-01' },
      { sym: 'DRY', joined: '2026-05-01', source: 'screener', capUsdM: 5000, lastCapacity: 9, lastQualified: '2026-06-25' },
    ]
    const { roster, dropped } = updateRoster(entries, [cand('LIVE', { capacityPct: 7 }), cand('DRY', { dollarVol20d: 2e6 })], [], '2026-07-02')
    expect(roster.find(r => r.sym === 'LIVE')?.lastQualified).toBe('2026-07-02') // capacity 7 ≥ 6 requalifies
    expect(dropped).toEqual([{ sym: 'DRY', why: 'illiquid' }])
  })

  it('trims to 80 dropping largest caps first, preserving the small-cap quota', () => {
    const bigs = Array.from({ length: 70 }, (_, i) => cand(`BIG${i}`, { capUsdM: 100_000 - i }))
    const smalls = Array.from({ length: 40 }, (_, i) => cand(`SML${i}`, { capUsdM: 500 + i }))
    const { roster } = updateRoster([], [...bigs, ...smalls], [], '2026-07-02')
    expect(roster.length).toBe(ROSTER_MAX)
    const smallCount = roster.filter(r => r.capUsdM != null && r.capUsdM < 2000).length
    expect(smallCount).toBeGreaterThanOrEqual(Math.ceil(ROSTER_MAX / 3))
  })

  it('watchlist symbols are always present even without candidate data', () => {
    const { roster } = updateRoster([], [], ['PLTR.US', 'NVDA'], '2026-07-02')
    expect(roster.map(r => r.sym).sort()).toEqual(['NVDA', 'PLTR.US'])
    expect(roster.every(r => r.source === 'watchlist')).toBe(true)
  })
})
