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

// Stage 1c phase A. The roster is the engine's hunting ground, and the watchlist
// rides into it UNCONDITIONALLY — which is exactly how BTC-USD/ETH-USD reached
// priority-1 candidacy from the shipped starter list. The reader keeps watching
// the price; the roster refuses the name.
describe('updateRoster contains crypto', () => {
  it('refuses a crypto candidate however well it qualifies', () => {
    const { roster, joined } = updateRoster([], [cand('BTC-USD'), cand('GOOD')], [], '2026-07-02')
    expect(joined).toEqual(['GOOD'])
    expect(roster.map(r => r.sym)).toEqual(['GOOD'])
  })

  it('refuses the watchlist ride-through — the one door with no gate in front of it', () => {
    const { roster } = updateRoster([], [], ['BTC-USD', 'ETH-USD', 'NVDA'], '2026-07-02')
    expect(roster.map(r => r.sym)).toEqual(['NVDA'])
  })

  it('purges a member that joined before the guard existed, and says why', () => {
    const stored: RosterEntry[] = [
      { sym: 'ETH-USD', joined: '2026-05-01', source: 'watchlist', capUsdM: null, lastCapacity: 40, lastQualified: '2026-07-02' },
      { sym: 'NVDA', joined: '2026-05-01', source: 'screener', capUsdM: 5000, lastCapacity: 9, lastQualified: '2026-07-02' },
    ]
    const { roster, dropped } = updateRoster(stored, [], ['ETH-USD'], '2026-07-02')
    expect(roster.map(r => r.sym)).toEqual(['NVDA'])
    expect(dropped).toEqual([{ sym: 'ETH-USD', why: 'crypto — contained until the crypto cohort exists' }])
  })

  it('leaves every equity shape the classifier could confuse for a coin exactly where it was', () => {
    const { roster } = updateRoster([], [cand('BT-A.L'), cand('BRK-B')], [], '2026-07-02')
    expect(roster.map(r => r.sym).sort()).toEqual(['BRK-B', 'BT-A.L'])
  })
})

// The roster sheds the LARGEST caps first when full — but large caps are the
// only names with a leveraged/inverse route on an ISA, so the trim was quietly
// evicting exactly the names the reader can trade. Live on 2026-07-28: not one
// of the 19 tickers ever called had a route, while all 10 routable names had
// been screened out. (user: "I'm ok with leverage as long as it's on T212".)
describe('updateRoster protects routable names', () => {
  const full = (n: number): RosterCandidate[] =>
    Array.from({ length: n }, (_, i) => cand(`S${i}`, { capUsdM: 500 })) // small caps, all qualify

  it('keeps a routable large cap when the roster is over capacity', () => {
    const routable = ['NVDA']
    const cands = [...full(ROSTER_MAX + 5), cand('NVDA', { capUsdM: 3_000_000 })] // the biggest cap present
    const { roster } = updateRoster([], cands, [], '2026-07-02', routable)
    expect(roster.map(r => r.sym)).toContain('NVDA')
    expect(roster.length).toBeLessThanOrEqual(ROSTER_MAX)
  })

  it('still sheds a large cap that has no route', () => {
    const cands = [...full(ROSTER_MAX + 5), cand('IBM', { capUsdM: 3_000_000 })]
    const { roster } = updateRoster([], cands, [], '2026-07-02', ['NVDA'])
    expect(roster.map(r => r.sym)).not.toContain('IBM')
  })

  it('protection is trim-only — a routable name still has to qualify to join', () => {
    const { joined } = updateRoster([], [cand('NVDA', { capacityPct: 2 })], [], '2026-07-02', ['NVDA'])
    expect(joined).toEqual([]) // capacity gate still applies
  })
})
