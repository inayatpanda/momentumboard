import { describe, expect, it } from 'vitest'
import {
  boardFlagRows, foldScan, scanIntradayFlags, scanWindowAt, MAX_FLAGS,
  type FlagCandidate, type IntradayFlagsBlob, type IntradayScan,
} from './intradayFlags'
import { memoryStore } from './store'

const AT = Math.floor(Date.parse('2026-07-16T14:30:00Z') / 1000)

const cand = (over: Partial<FlagCandidate> = {}): FlagCandidate => ({
  sym: 'AAA',
  price: 100,
  ...over,
})

describe('scanIntradayFlags — entry-zone', () => {
  const base = (): FlagCandidate => cand({ watchOnly: true, side: 'long', entry: 100, price: 100.5, rvol: 1.3, changePct: 0.8 })

  it('fires for a watch row at entry, moving through it on volume', () => {
    const [f] = scanIntradayFlags([base()], AT)
    expect(f.kind).toBe('entry-zone')
    expect(f.level).toBe(100)
    expect(f.at).toBe(AT)
    expect(f.detail).toContain('at the door')
  })

  it('blocks when RVOL is under the 1.2 floor', () => {
    expect(scanIntradayFlags([{ ...base(), rvol: 1.1 }], AT)).toHaveLength(0)
  })

  it('blocks when price is more than 1% from entry', () => {
    expect(scanIntradayFlags([{ ...base(), price: 102 }], AT)).toHaveLength(0)
  })

  it('blocks when momentum points the wrong way (long, red day)', () => {
    expect(scanIntradayFlags([{ ...base(), changePct: -0.5 }], AT)).toHaveLength(0)
  })

  it('blocks a published trade — entry-zone is watch rows only', () => {
    expect(scanIntradayFlags([{ ...base(), watchOnly: false, published: true }], AT)).toHaveLength(0)
  })

  it('mirrors for a short: red day is the correct side', () => {
    const short = cand({ watchOnly: true, side: 'short', entry: 100, price: 99.5, rvol: 1.5, changePct: -1 })
    expect(scanIntradayFlags([short], AT)[0]?.kind).toBe('entry-zone')
    expect(scanIntradayFlags([{ ...short, changePct: 1 }], AT)).toHaveLength(0)
  })

  // CONTAINMENT: a near-miss row's "entry" is yesterday's close, not a trigger
  // the engine chose. Flagging one would push the reader "at its entry" for a
  // name the engine explicitly refused to call — on exactly the gates-empty
  // mornings when near misses are the only thing on the board.
  it('a near-miss row NEVER fires an entry-zone flag, while an identical watch row does', () => {
    const watch = base()
    expect(scanIntradayFlags([watch], AT)[0]?.kind).toBe('entry-zone') // the control
    expect(scanIntradayFlags([{ ...watch, nearMiss: true }], AT)).toHaveLength(0)
  })

  it('a near-miss row is refused a second-chance flag too — there was never a first chance', () => {
    const nm = cand({ published: true, nearMiss: true, side: 'long', entry: 100, price: 100.4, sessionHigh: 103, sessionLow: 99 })
    expect(scanIntradayFlags([nm], AT)).toHaveLength(0)
    expect(scanIntradayFlags([{ ...nm, nearMiss: false }], AT)[0]?.kind).toBe('second-chance')
  })
})

describe('boardFlagRows — what the runner may feed the scan', () => {
  it('drops near-miss rows and honours the cap', () => {
    const board = [{ sym: 'A' }, { sym: 'B', nearMiss: true }, { sym: 'C' }]
    expect(boardFlagRows(board, 40).map(r => r.sym)).toEqual(['A', 'C'])
    expect(boardFlagRows(board, 1).map(r => r.sym)).toEqual(['A'])
  })

  it('a board of nothing BUT near misses feeds the scan no engine levels at all', () => {
    expect(boardFlagRows([{ sym: 'A', nearMiss: true as const }, { sym: 'B', nearMiss: true as const }], 40)).toEqual([])
  })
})

describe('scanIntradayFlags — second-chance', () => {
  const base = (): FlagCandidate => cand({ published: true, side: 'long', entry: 100, price: 100.4, sessionHigh: 103, sessionLow: 99 })

  it('fires for a published trade back at entry after ranging ≥2% away', () => {
    const [f] = scanIntradayFlags([base()], AT)
    expect(f.kind).toBe('second-chance')
    expect(f.detail).toContain('missed at the open')
  })

  it('blocks when the session never ranged 2% away', () => {
    expect(scanIntradayFlags([{ ...base(), sessionHigh: 101, sessionLow: 99.5 }], AT)).toHaveLength(0)
  })

  it('blocks a watch row — second-chance is published trades only', () => {
    expect(scanIntradayFlags([{ ...base(), published: false, watchOnly: true, rvol: 2 }], AT)).toHaveLength(0)
  })

  it('blocks when the session range is unknown', () => {
    expect(scanIntradayFlags([{ ...base(), sessionHigh: null, sessionLow: null }], AT)).toHaveLength(0)
  })
})

describe('scanIntradayFlags — breakout', () => {
  const base = (): FlagCandidate => cand({ stage: 'basing', price: 105, high20: 104, rvol: 2.4 })

  it('fires for a basing name clearing its 20-session high on ≥2x volume', () => {
    const [f] = scanIntradayFlags([base()], AT)
    expect(f.kind).toBe('breakout')
    expect(f.level).toBe(104)
    expect(f.detail).toContain('triggering now')
  })

  it('blocks a non-basing stage', () => {
    expect(scanIntradayFlags([{ ...base(), stage: 'trending' }], AT)).toHaveLength(0)
  })

  it('blocks when RVOL is under 2', () => {
    expect(scanIntradayFlags([{ ...base(), rvol: 1.9 }], AT)).toHaveLength(0)
  })

  it('blocks when price has not exceeded the 20-session high', () => {
    expect(scanIntradayFlags([{ ...base(), price: 104 }], AT)).toHaveLength(0)
  })
})

describe('scanIntradayFlags — dedup, cap and ordering', () => {
  it('one flag per symbol, keeping the most compelling kind', () => {
    // AAA qualifies for BOTH breakout and entry-zone — breakout must win
    const both = cand({
      sym: 'AAA', price: 105, stage: 'basing', high20: 104, rvol: 2.4,
      watchOnly: true, side: 'long', entry: 105, changePct: 1,
    })
    const out = scanIntradayFlags([both], AT)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('breakout')
  })

  it('caps at three and orders breakout → second-chance → entry-zone', () => {
    const cs: FlagCandidate[] = [
      cand({ sym: 'ZONE', watchOnly: true, side: 'long', entry: 100, price: 100.2, rvol: 1.3, changePct: 1 }),
      cand({ sym: 'BRK', stage: 'basing', price: 50, high20: 49, rvol: 3 }),
      cand({ sym: 'SEC', published: true, side: 'long', entry: 20, price: 20.05, sessionHigh: 20.8, sessionLow: 19.4 }),
      cand({ sym: 'BRK2', stage: 'basing', price: 80, high20: 79, rvol: 2.2 }),
    ]
    const out = scanIntradayFlags(cs, AT)
    expect(out).toHaveLength(MAX_FLAGS)
    expect(out.map(f => f.kind)).toEqual(['breakout', 'breakout', 'second-chance'])
    expect(out.some(f => f.sym === 'ZONE')).toBe(false) // the weakest kind is dropped by the cap
  })

  it('skips candidates with a non-positive or non-finite price', () => {
    expect(scanIntradayFlags([cand({ price: 0, stage: 'basing', high20: -1, rvol: 3 })], AT)).toHaveLength(0)
    expect(scanIntradayFlags([cand({ price: NaN, stage: 'basing', high20: 1, rvol: 3 })], AT)).toHaveLength(0)
  })
})

describe('scanWindowAt — London-clock windows', () => {
  it('flags ~1h after the US open (15:30 London, summer BST)', () => {
    expect(scanWindowAt(Date.parse('2026-07-16T14:30:00Z'))).toBe('london-open') // 15:30 BST
    expect(scanWindowAt(Date.parse('2026-07-16T14:40:00Z'))).toBe('london-open') // 15:40 BST
  })

  it('flags ~1h before the US close (19:30 London, summer BST)', () => {
    expect(scanWindowAt(Date.parse('2026-07-16T18:30:00Z'))).toBe('power-hour') // 19:30 BST
  })

  it('resolves DST correctly — winter GMT has no offset', () => {
    expect(scanWindowAt(Date.parse('2026-01-15T15:30:00Z'))).toBe('london-open') // 15:30 GMT
    expect(scanWindowAt(Date.parse('2026-01-15T19:30:00Z'))).toBe('power-hour') // 19:30 GMT
  })

  it('is null outside the two windows', () => {
    expect(scanWindowAt(Date.parse('2026-07-16T11:00:00Z'))).toBeNull() // midday London
    expect(scanWindowAt(Date.parse('2026-07-16T14:29:00Z'))).toBeNull() // 15:29 — a minute early
    expect(scanWindowAt(Date.parse('2026-07-16T14:46:00Z'))).toBeNull() // 15:46 — past the slot
  })

  it('never scans at the weekend', () => {
    expect(scanWindowAt(Date.parse('2026-07-18T14:30:00Z'))).toBeNull() // Saturday
    expect(scanWindowAt(Date.parse('2026-07-19T18:30:00Z'))).toBeNull() // Sunday
  })
})

describe('foldScan — blob lifecycle', () => {
  const flag = { sym: 'AAA', kind: 'breakout' as const, price: 105, level: 104, detail: 'x', at: AT }
  const scan = (window: IntradayScan['window'], flags = [flag]): IntradayScan => ({ at: AT, window, flags })

  it('starts a fresh blob when there is no prior', () => {
    const { blob, accepted } = foldScan(null, '2026-07-16', scan('london-open'))
    expect(accepted).toBe(true)
    expect(blob.date).toBe('2026-07-16')
    expect(blob.scans).toHaveLength(1)
  })

  it('rejects a second scan from the same window, leaving the blob untouched', () => {
    const first = foldScan(null, '2026-07-16', scan('london-open')).blob
    const { blob, accepted } = foldScan(first, '2026-07-16', scan('london-open', []))
    expect(accepted).toBe(false)
    expect(blob).toBe(first)
  })

  it('keeps BOTH windows, newest scan first', () => {
    const first = foldScan(null, '2026-07-16', scan('london-open')).blob
    const { blob, accepted } = foldScan(first, '2026-07-16', scan('power-hour'))
    expect(accepted).toBe(true)
    expect(blob.scans.map(s => s.window)).toEqual(['power-hour', 'london-open'])
  })

  it('resets on a new date', () => {
    const yesterday: IntradayFlagsBlob = { date: '2026-07-15', scans: [scan('london-open'), scan('power-hour')], pushedAt: 1 }
    const { blob } = foldScan(yesterday, '2026-07-16', scan('london-open'))
    expect(blob.date).toBe('2026-07-16')
    expect(blob.scans).toHaveLength(1)
    expect(blob.pushedAt).toBeUndefined()
  })

  it('round-trips through the blob store across the two windows', async () => {
    const store = memoryStore()
    const key = 'intraday-flags'

    const a = foldScan(await store.read<IntradayFlagsBlob>(key), '2026-07-16', scan('london-open'))
    expect(a.accepted).toBe(true)
    await store.write(key, a.blob)

    const b = foldScan(await store.read<IntradayFlagsBlob>(key), '2026-07-16', scan('power-hour'))
    expect(b.accepted).toBe(true)
    await store.write(key, b.blob)

    const persisted = await store.read<IntradayFlagsBlob>(key)
    expect(persisted?.scans.map(s => s.window)).toEqual(['power-hour', 'london-open'])

    // a third run in an already-swept window is a no-op
    const c = foldScan(persisted, '2026-07-16', scan('london-open', []))
    expect(c.accepted).toBe(false)
  })
})
