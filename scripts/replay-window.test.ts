import { describe, expect, it } from 'vitest'
import { DEFAULT_CORE_SLEEVE } from '../shared/engine/coreSleeve'
import {
  MIRROR_EXTRAS,
  REPLAY_UNIVERSE,
  SLEEVE_MIRROR,
  doorsFor,
  sliceBefore,
  sparkClosesFrom,
  summariseBoard,
  synthScreens,
  tradingDays,
} from './replay-window'
import type { Candle } from '../shared/types'

const day = (iso: string, c: number, v = 1_000_000): Candle => ({ t: Date.parse(`${iso}T13:30:00Z`) / 1000, o: c, h: c, l: c, c, v })

describe('SLEEVE_MIRROR', () => {
  // The mirror is a literal copy so the harness can run inside the pre-Stage-1
  // worktree where coreSleeve.ts does not exist. This guards the copy.
  it('covers every DEFAULT_CORE_SLEEVE name', () => {
    expect(DEFAULT_CORE_SLEEVE.filter(s => !SLEEVE_MIRROR.includes(s))).toEqual([])
  })
  it('folds the window tickers into the universe without duplicates', () => {
    expect(REPLAY_UNIVERSE.length).toBe(new Set(REPLAY_UNIVERSE).size)
    for (const s of MIRROR_EXTRAS) expect(REPLAY_UNIVERSE).toContain(s)
    expect(REPLAY_UNIVERSE).toContain('GLW')
  })
})

describe('sliceBefore', () => {
  const bars = [day('2026-07-13', 10), day('2026-07-14', 11), day('2026-07-15', 12)]
  it('keeps only bars that closed strictly before the replayed date', () => {
    expect(sliceBefore(bars, '2026-07-14').map(b => b.c)).toEqual([10])
    expect(sliceBefore(bars, '2026-07-15').map(b => b.c)).toEqual([10, 11])
  })
  it('is empty before the first bar', () => {
    expect(sliceBefore(bars, '2026-07-13')).toEqual([])
  })
})

describe('tradingDays', () => {
  it('takes the window from a real index series, deduped and sorted', () => {
    const index = [day('2026-07-13', 1), day('2026-07-14', 1), day('2026-07-14', 1), day('2026-07-17', 1), day('2026-08-12', 1)]
    expect(tradingDays(index, '2026-07-14', '2026-08-11')).toEqual(['2026-07-14', '2026-07-17'])
  })
})

describe('synthScreens', () => {
  const bars = new Map<string, Candle[]>([
    ['UP', [day('2026-07-13', 100, 10), day('2026-07-14', 110, 10)]], // +10%
    ['DOWN', [day('2026-07-13', 100, 10), day('2026-07-14', 85, 10)]], // -15%
    ['BIG', [day('2026-07-13', 100, 10), day('2026-07-14', 101, 1_000_000)]], // dollar-volume king
    ['SHORTHIST', [day('2026-07-14', 50, 10)]],
  ])
  it('splits gainers, losers and $-volume actives', () => {
    const rows = synthScreens(bars, { includeLosers: true })
    const bySource = (s: string) => rows.filter(r => r.source === s).map(r => r.row.sym)
    expect(bySource('screener:gainers')).toEqual(['UP', 'BIG'])
    expect(bySource('screener:losers')).toEqual(['DOWN'])
    expect(bySource('screener:actives')[0]).toBe('BIG')
  })
  it('withholds the losers screen in baseline mode (day_losers is a Stage-1 addition)', () => {
    expect(synthScreens(bars, { includeLosers: false }).some(r => r.source === 'screener:losers')).toBe(false)
  })
  it('never invents a market cap and skips names with one bar', () => {
    const rows = synthScreens(bars, { includeLosers: true })
    expect(rows.every(r => r.row.capUsdM === null)).toBe(true)
    expect(rows.some(r => r.row.sym === 'SHORTHIST')).toBe(false)
  })
  it('honours the 25-row screen size', () => {
    const many = new Map<string, Candle[]>()
    for (let i = 0; i < 40; i++) many.set(`S${i}`, [day('2026-07-13', 100), day('2026-07-14', 100 + i + 1)])
    expect(synthScreens(many, { includeLosers: true }).filter(r => r.source === 'screener:gainers').length).toBe(25)
  })
})

describe('sparkClosesFrom', () => {
  const long = Array.from({ length: 80 }, (_, i) => day(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, i + 1))
  const bars = new Map<string, Candle[]>([['AAPL', long], ['THIN', long.slice(0, 10)]])
  it('returns the last 63 closes, uppercase-keyed, like parseSpark', () => {
    const m = sparkClosesFrom(bars, ['aapl'])
    expect(m.get('AAPL')!.length).toBe(63)
    expect(m.get('AAPL')![62]).toBe(80)
  })
  it('omits names with too little history — the same fail-soft shape a refused chunk gives', () => {
    const m = sparkClosesFrom(bars, ['AAPL', 'THIN', 'NEVERFETCHED'])
    expect([...m.keys()]).toEqual(['AAPL'])
  })
})

describe('summariseBoard', () => {
  const r = (side: 'long' | 'short', extra: { watchOnly?: boolean; nearMiss?: true } = {}) => ({ side, ...extra })
  it('separates trades, watch and near misses', () => {
    const s = summariseBoard([r('long'), r('long', { watchOnly: true }), r('short', { watchOnly: true, nearMiss: true })])
    expect(s).toMatchObject({ trades: 1, watch: 1, nearMiss: 1, blankSides: 0, tradelessSides: 1, namedNoTrades: false, blankBoard: false })
  })
  it('counts a near-miss-only day as named but tradeless, not blank', () => {
    const s = summariseBoard([r('long', { watchOnly: true, nearMiss: true }), r('short', { watchOnly: true, nearMiss: true })])
    expect(s).toMatchObject({ trades: 0, nearMiss: 2, blankSides: 0, tradelessSides: 2, namedNoTrades: true, blankBoard: false })
  })
  it('flags the genuinely blank board', () => {
    expect(summariseBoard([])).toMatchObject({ blankSides: 2, blankBoard: true, namedNoTrades: false })
  })
})

describe('doorsFor', () => {
  const screens = [
    { row: { sym: 'GLW' }, source: 'screener:losers' },
    { row: { sym: 'GLW' }, source: 'screener:actives' },
    { row: { sym: 'NVDA' }, source: 'screener:gainers' },
  ]
  it('names every door a symbol walked through', () => {
    expect(doorsFor('glw', screens, ['GLW', 'TSLA'], ['AMD'])).toEqual(['screener:losers', 'screener:actives', 'sleeve-top40'])
  })
  it('reports the roster door and no door at all', () => {
    expect(doorsFor('AMD', screens, [], ['AMD'])).toEqual(['roster'])
    expect(doorsFor('ZZZZ', screens, [], [])).toEqual([])
  })
})
