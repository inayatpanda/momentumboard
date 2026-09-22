import { describe, expect, it } from 'vitest'
import { discoverPure, type DiscoverPureInput } from './index'
import * as F from './synthetic.fixtures'
import type { Candle } from '../../types'
import { DISCOVERY_TRACE_MAX, type DiscoveryRejectCode, type DiscoveryTraceRow, type UniverseMember } from './types'

type Tape = Candle[]

function world(entries: [string, Tape | null, Partial<UniverseMember>?][], over: Partial<DiscoverPureInput> = {}): DiscoverPureInput {
  const members = new Map<string, UniverseMember>()
  const tapes = new Map<string, Tape>()
  for (const [sym, tape, m] of entries) {
    members.set(sym, F.member({ sym, sector: null, ...m }))
    if (tape) tapes.set(sym, tape)
  }
  return { date: '2026-09-22', members, nominators: new Map(), tapes, spy: F.spyFlat(300), isEtp: () => false, unread: [], ...over }
}

const outcomeOf = (trace: DiscoveryTraceRow[], sym: string) => trace.find(r => r.sym === sym)?.outcome

/** 20 quiet names plus one of every shape the scan is meant to catch — and one
 * of every way a name can fall out of it. */
function mixedUniverse(): [string, Tape | null, Partial<UniverseMember>?][] {
  const rows: [string, Tape | null, Partial<UniverseMember>?][] = []
  for (let i = 0; i < 20; i++) rows.push([`G${String(i).padStart(2, '0')}`, F.tape(F.flatBars(140, 50 + i))])
  rows.push(['BRK1', F.breakoutTape()], ['BRK2', F.breakoutTape()])
  rows.push(['DIP1', F.dipTape()], ['DIP2', F.dipTape()])
  rows.push(['CLX1', F.blowOffTape()], ['CLX2', F.blowOffTape()])
  rows.push(['UNREAD', null])
  rows.push(['NOBARS', null])
  rows.push(['ETPX', F.tape(F.flatBars(140, 30))])
  rows.push(['PENNY', F.tape(F.flatBars(140, 1))])
  rows.push(['THIN', F.tape(F.flatBars(140, 100, 10))])
  rows.push(['SHORT', F.tape(F.flatBars(30, 100))])
  rows.push(['STALE', F.tape(F.flatBars(140, 100), F.LAST_T - 10 * F.DAY)])
  return rows
}

describe('discoverPure', () => {
  const input = world(mixedUniverse(), { unread: ['UNREAD'], isEtp: sym => sym === 'ETPX' })
  const out = discoverPure(input)

  it('scans every name that clears hygiene and nothing else', () => {
    expect(out.stats.scanned).toBe(26) // 20 quiet + 2 breakout + 2 dip + 2 climax
    expect(out.date).toBe('2026-09-22')
  })

  it('selects the planted shapes, each tagged with the lens that found it', () => {
    const picked = new Map(out.candidates.map(c => [c.sym, c.lenses.map(l => l.lens)]))
    expect(picked.get('BRK1')).toContain('breakout')
    expect(picked.get('DIP1')).toContain('dip')
    expect(picked.get('CLX1')).toContain('climax')
    expect(out.stats.selected).toBe(out.candidates.length)
    expect(out.stats.perLens.breakout).toBe(2)
    expect(out.stats.perLens.dip).toBe(2)
    expect(out.stats.perLens.climax).toBe(2)
    expect(out.stats.perLens['rs-leader']).toBe(0)
  })

  it('never keeps more than two readings of one name', () => {
    for (const c of out.candidates) expect(c.lenses.length).toBeLessThanOrEqual(2)
  })

  it('orders candidates by priority, ties by symbol', () => {
    for (let i = 1; i < out.candidates.length; i++) {
      const [a, b] = [out.candidates[i - 1], out.candidates[i]]
      expect(a.priority > b.priority || (a.priority === b.priority && a.sym < b.sym)).toBe(true)
    }
  })

  it('gives every name a one-line reason it was not seen', () => {
    expect(outcomeOf(out.trace, 'UNREAD')).toBe('budget-cut')
    expect(outcomeOf(out.trace, 'NOBARS')).toBe('no-bars')
    expect(outcomeOf(out.trace, 'ETPX')).toBe('etp')
    expect(outcomeOf(out.trace, 'PENNY')).toBe('price-floor')
    expect(outcomeOf(out.trace, 'THIN')).toBe('liquidity-floor')
    expect(outcomeOf(out.trace, 'SHORT')).toBe('too-short')
    expect(outcomeOf(out.trace, 'STALE')).toBe('stale-bars')
    expect(outcomeOf(out.trace, 'G00')).toBe('no-lens')
    expect(out.trace).toHaveLength(input.members.size)
  })

  it('traces the selected first, then the rejects in a fixed order', () => {
    const selectedRows = out.trace.filter(r => r.outcome === 'selected')
    expect(out.trace.slice(0, selectedRows.length).every(r => r.outcome === 'selected')).toBe(true)
    expect(selectedRows.map(r => r.sym)).toEqual(out.candidates.map(c => c.sym))
    expect(selectedRows[0].detail).toMatch(/\d/)
    const codes = out.trace.slice(selectedRows.length).map(r => r.outcome)
    const firstOf = (code: DiscoveryRejectCode) => codes.indexOf(code)
    expect(firstOf('no-lens')).toBe(0)
    expect(firstOf('budget-cut')).toBeGreaterThan(firstOf('no-lens'))
    expect(firstOf('stale-bars')).toBeGreaterThan(firstOf('budget-cut'))
    expect(firstOf('etp')).toBe(codes.length - 1)
    // symbols sorted inside a code
    const quiet = out.trace.filter(r => r.outcome === 'no-lens').map(r => r.sym)
    expect(quiet).toEqual([...quiet].sort())
  })

  it('is deterministic: reversing the universe map changes nothing', () => {
    const shuffled = { ...input, members: new Map([...input.members].reverse()), tapes: new Map([...input.tapes].reverse()) }
    expect(JSON.stringify(discoverPure(shuffled))).toBe(JSON.stringify(out))
  })

  it('bounds the trace even when the universe does not', () => {
    const many: [string, Tape | null][] = []
    for (let i = 0; i < 500; i++) many.push([`Q${String(i).padStart(3, '0')}`, F.tape(F.flatBars(70, 100))])
    const big = discoverPure(world(many))
    expect(big.stats.scanned).toBe(500)
    expect(big.trace).toHaveLength(DISCOVERY_TRACE_MAX)
  })

  it('a nominated name outranks an equal one with no backers', () => {
    const rows: [string, Tape | null, Partial<UniverseMember>?][] = [['AAA', F.breakoutTape()], ['ZZZ', F.breakoutTape()]]
    const nominated = discoverPure(world(rows, { nominators: new Map([['ZZZ', ['nom:social', 'nom:news']]]) }))
    expect(nominated.candidates[0].sym).toBe('ZZZ')
    expect(nominated.candidates[0].priority).toBeGreaterThan(nominated.candidates[1].priority)
  })
})

// The two venues keep different calendars, and the scan reads both every
// morning. One "last session" over the pair means the busier venue defines
// today for the quieter one.
describe('staleness is measured against the name own exchange', () => {
  /** US names printing today, UK names printing five calendar days ago — the
   * Easter Tuesday shape: the LSE was shut Good Friday AND Easter Monday, Wall
   * Street only Good Friday. 5 days × 5/7 = 3.57 sessions, past the 3-session
   * limit, so every UK name in the seed was rejected as stale. */
  const ukLag = 5 * F.DAY
  const uk = (sym: string, lastT: number): [string, Candle[], Partial<UniverseMember>] => [
    sym,
    F.tape(F.flatBars(140, 300, 2_000_000), lastT), // 300p × 2M = £6M/day, over the floor
    { exchange: 'LSE', currency: 'GBp' },
  ]

  const rows: [string, Candle[] | null, Partial<UniverseMember>?][] = [
    ['USA', F.tape(F.flatBars(140, 100))],
    ['USB', F.tape(F.flatBars(140, 120))],
    uk('UKA.L', F.LAST_T - ukLag),
    uk('UKB.L', F.LAST_T - ukLag),
    uk('UKSTALE.L', F.LAST_T - ukLag - 10 * F.DAY), // genuinely behind ITS OWN venue
  ]
  const out = discoverPure(world(rows))

  it('a whole venue trading one calendar behind the other is not stale', () => {
    expect(outcomeOf(out.trace, 'UKA.L')).not.toBe('stale-bars')
    expect(outcomeOf(out.trace, 'UKB.L')).not.toBe('stale-bars')
    expect(out.stats.scanned).toBe(4) // 2 US + 2 UK; only the real laggard is out
  })

  it('…but a name behind its OWN venue still is', () => {
    expect(outcomeOf(out.trace, 'UKSTALE.L')).toBe('stale-bars')
  })
})

// The bars layer can serve a cached tape for a name the request budget cut. Such
// a name was READ; calling it 'budget-cut' threw away bars we were holding.
describe('a usable tape always beats the unread list', () => {
  const rows: [string, Candle[] | null, Partial<UniverseMember>?][] = [
    ['HELD', F.dipTape()], // cut by the budget, served from cache
    ['NOTHING', null], // cut by the budget with nothing held
  ]
  const out = discoverPure(world(rows, { unread: ['HELD', 'NOTHING'] }))

  it('a cut name with bars is scanned, not written off', () => {
    expect(outcomeOf(out.trace, 'HELD')).not.toBe('budget-cut')
    expect(out.stats.scanned).toBe(1)
    expect(out.candidates.map(c => c.sym)).toContain('HELD')
  })

  it('…and a cut name with nothing is still budget-cut', () => {
    expect(outcomeOf(out.trace, 'NOTHING')).toBe('budget-cut')
    expect(out.stats.rejects['budget-cut']).toBe(1)
  })
})

describe('discoverPure percentile gates', () => {
  it('finds the leaders in a field of laggards', () => {
    const rows: [string, Tape | null, Partial<UniverseMember>?][] = []
    for (let i = 0; i < 3; i++) rows.push([`LEAD${i}`, F.trendTape()])
    for (let i = 0; i < 27; i++) rows.push([`LAG${String(i).padStart(2, '0')}`, F.weakTape()])
    const out = discoverPure(world(rows))
    const picked = new Map(out.candidates.map(c => [c.sym, c.lenses.map(l => l.lens)]))
    expect(picked.get('LEAD0')).toContain('rs-leader')
    expect(out.stats.perLens['rs-leader']).toBe(3)
    expect(out.stats.perLens.weak).toBe(0) // the laggards ARE the field, so none is bottom-decile
  })

  it('finds the laggards in a field of leaders', () => {
    const rows: [string, Tape | null, Partial<UniverseMember>?][] = []
    for (let i = 0; i < 3; i++) rows.push([`LAG${i}`, F.weakTape()])
    for (let i = 0; i < 27; i++) rows.push([`LEAD${String(i).padStart(2, '0')}`, F.trendTape()])
    const out = discoverPure(world(rows))
    expect(out.candidates.find(c => c.sym === 'LAG0')!.lenses.map(l => l.lens)).toContain('weak')
    expect(out.stats.perLens.weak).toBe(3)
  })
})
