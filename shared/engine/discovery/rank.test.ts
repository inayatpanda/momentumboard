import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyHygiene, percentileRanks, priorityFor, quotesInPence, scaleDollarVol, selectCandidates, sessionsBetween, unusualRatio, PERCENTILE_FIELDS } from './rank'
import * as F from './synthetic.fixtures'
import { HYGIENE, LENS_TOP_N, type Features, type LensHit, type LensId, type UniverseMember } from './types'

const f = (sym: string, over: Partial<Features> = {}) => F.features({ sym, ...over })

describe('percentileRanks', () => {
  it('ranks 0–1 and spreads a clean field evenly', () => {
    const p = percentileRanks([f('A', { rsSpy20: 1 }), f('B', { rsSpy20: 2 }), f('C', { rsSpy20: 3 }), f('D', { rsSpy20: 4 })])
    expect(p.get('A')!.rsSpy20).toBe(0.125)
    expect(p.get('B')!.rsSpy20).toBe(0.375)
    expect(p.get('C')!.rsSpy20).toBe(0.625)
    expect(p.get('D')!.rsSpy20).toBe(0.875)
  })
  it('averages ties — equal moves cannot be ordered by luck', () => {
    const p = percentileRanks([f('A', { rsSpy20: 1 }), f('B', { rsSpy20: 1 }), f('C', { rsSpy20: 2 })])
    expect(p.get('A')!.rsSpy20).toBe(p.get('B')!.rsSpy20)
    expect(p.get('A')!.rsSpy20).toBeCloseTo(1 / 3, 4)
    expect(p.get('C')!.rsSpy20).toBeCloseTo(5 / 6, 4)
  })
  it('a missing feature sits mid-field, not at either end', () => {
    const p = percentileRanks([f('A', { rsSpy20: null }), f('B', { rsSpy20: -5 }), f('C', { rsSpy20: 5 })])
    expect(p.get('A')!.rsSpy20).toBe(0.5)
    expect(p.get('B')!.rsSpy20).toBe(0.25)
  })
  it('every field of every name lands inside 0–1', () => {
    const rows = [f('A', { ret1: -9 }), f('B'), f('C', { rvol: 12, dollarVol20: null }), f('D', { rsSpy60: -40 })]
    for (const p of percentileRanks(rows).values()) {
      for (const v of Object.values(p)) {
        expect(v).toBeGreaterThan(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
  it('a lone name is mid-field by definition', () => {
    expect(percentileRanks([f('A')]).get('A')!.rsSpy20).toBe(0.5)
  })

  // A percentile is a sort over the whole universe, every run. Six of the nine
  // fields this used to rank were dereferenced by no lens anywhere — paid for
  // every morning, read by nobody. The two lists are held equal by reading the
  // lens source, so neither a wasted sort nor a lens reading an unranked field
  // (which would silently see 0.5 for every name) can land again.
  it('ranks exactly the fields the lenses read — no wasted sorts, no unranked reads', () => {
    const src = readFileSync(join(__dirname, 'lenses.ts'), 'utf8')
    const read = new Set([...src.matchAll(/\bp\.([A-Za-z0-9_]+)/g)].map(m => m[1]))
    expect([...read].sort()).toEqual([...PERCENTILE_FIELDS].sort())
    expect(Object.keys(F.percentiles()).sort()).toEqual([...PERCENTILE_FIELDS].sort())
  })
})

describe('unusualRatio', () => {
  it('scores a move against the name own typical day', () => {
    // GLW-ish: 6% on a name whose typical 10-day move is 6% (≈1.9%/day) ≈ 3.2x.
    expect(unusualRatio(f('GLW', { ret1: 6, typicalMove10: 6 }))!).toBeCloseTo(3.16, 1)
    // A penny name that swings 40% in ten days needs 25% to score the same.
    expect(unusualRatio(f('PENNY', { ret1: 25, typicalMove10: 40 }))!).toBeCloseTo(1.98, 1)
    expect(unusualRatio(f('PENNY', { ret1: 6, typicalMove10: 40 }))!).toBeLessThan(1)
  })
  it('floors the scale so a somnolent name cannot manufacture a shock', () => {
    expect(unusualRatio(f('X', { ret1: 2, typicalMove10: 1 }))).toBe(2)
  })
  it('is sign-blind and null without the inputs', () => {
    expect(unusualRatio(f('X', { ret1: -6, typicalMove10: 6 }))).toBe(unusualRatio(f('X', { ret1: 6, typicalMove10: 6 })))
    expect(unusualRatio(f('X', { ret1: null }))).toBeNull()
    expect(unusualRatio(f('X', { typicalMove10: null }))).toBeNull()
  })
})

describe('applyHygiene', () => {
  const T = F.LAST_T
  const us = F.member({ sym: 'AAA' })
  const lse = F.member({ sym: 'BBB.L', exchange: 'LSE', currency: 'GBp' })
  const never = () => false

  it('passes a healthy US name', () => {
    expect(applyHygiene(us, f('AAA', { lastT: T, close: 100, dollarVol20: 50e6 }), T, never)).toBeNull()
  })
  it('etp is refused before anything is read', () => {
    expect(applyHygiene(us, null, T, () => true)).toBe('etp')
  })
  it('unreadable history is too-short', () => {
    expect(applyHygiene(us, null, T, never)).toBe('too-short')
    expect(applyHygiene(us, f('AAA', { bars: HYGIENE.minBars - 1 }), T, never)).toBe('too-short')
  })
  it('stale bars: more than three sessions behind the market', () => {
    expect(applyHygiene(us, f('AAA', { lastT: T - 3 * 86_400 }), T, never)).toBeNull()
    expect(applyHygiene(us, f('AAA', { lastT: T - 7 * 86_400 }), T, never)).toBe('stale-bars')
    expect(sessionsBetween(T - 7 * 86_400, T)).toBe(5)
  })
  it('price floor is $2 in the US and 50p on the LSE', () => {
    expect(applyHygiene(us, f('AAA', { lastT: T, close: 1.9 }), T, never)).toBe('price-floor')
    expect(applyHygiene(us, f('AAA', { lastT: T, close: 2 }), T, never)).toBeNull()
    expect(applyHygiene(lse, f('BBB.L', { lastT: T, close: 49, dollarVol20: 1e9 }), T, never)).toBe('price-floor')
    expect(applyHygiene(lse, f('BBB.L', { lastT: T, close: 50, dollarVol20: 1e9 }), T, never)).toBeNull()
  })

  // CPG.L, IHG.L, BCG.L, PEY.L and four more of the committed seed are LSE
  // LISTINGS THAT QUOTE IN DOLLARS OR EUROS. Keyed on the venue, their $25 price
  // met a 50p floor and their $200M tape was divided by 100 — every one of them
  // left the scan as an illiquid penny stock.
  describe('the pence rules follow the CURRENCY, not the venue', () => {
    const usdOnLse = F.member({ sym: 'CPG.L', exchange: 'LSE', currency: 'USD' })
    const penceOnLse = F.member({ sym: 'VOD.L', exchange: 'LSE', currency: 'GBp' })
    const unknownOnLse = F.member({ sym: 'XXX.L', exchange: 'LSE', currency: null })

    it('a dollar-quoted LSE line faces the $2 floor and keeps its whole dollar volume', () => {
      expect(quotesInPence(usdOnLse)).toBe(false)
      expect(scaleDollarVol(usdOnLse, 20e6)).toBe(20e6)
      // $25.60, $20M a day: a real FTSE 100 name, and it passes.
      expect(applyHygiene(usdOnLse, f('CPG.L', { lastT: T, close: 25.6, dollarVol20: 20e6 }), T, never)).toBeNull()
    })

    it('…while a pence line still faces 50p and the /100 divide', () => {
      expect(quotesInPence(penceOnLse)).toBe(true)
      expect(scaleDollarVol(penceOnLse, 199e6)).toBe(1.99e6)
      expect(applyHygiene(penceOnLse, f('VOD.L', { lastT: T, close: 49, dollarVol20: 1e9 }), T, never)).toBe('price-floor')
      expect(applyHygiene(penceOnLse, f('VOD.L', { lastT: T, close: 200, dollarVol20: 199e6 }), T, never)).toBe('liquidity-floor')
    })

    it('unknown currency falls back to the venue — right nine times in ten, and all we know', () => {
      expect(quotesInPence(unknownOnLse)).toBe(true)
      expect(applyHygiene(unknownOnLse, f('XXX.L', { lastT: T, close: 49, dollarVol20: 1e9 }), T, never)).toBe('price-floor')
    })
  })
  it('liquidity floor: $5M US, and LSE pence are divided by 100 into pounds', () => {
    expect(applyHygiene(us, f('AAA', { lastT: T, close: 100, dollarVol20: 4.9e6 }), T, never)).toBe('liquidity-floor')
    expect(applyHygiene(us, f('AAA', { lastT: T, close: 100, dollarVol20: 5e6 }), T, never)).toBeNull()
    // 199,000,000 pence×shares = £1.99M — under the floor. Without the divide it
    // would read as £199M and every 40p shell would clear it.
    expect(applyHygiene(lse, f('BBB.L', { lastT: T, close: 200, dollarVol20: 199e6 }), T, never)).toBe('liquidity-floor')
    expect(applyHygiene(lse, f('BBB.L', { lastT: T, close: 200, dollarVol20: 200e6 }), T, never)).toBeNull()
  })
  it('unknown liquidity is not a pass', () => {
    expect(applyHygiene(us, f('AAA', { lastT: T, close: 100, dollarVol20: null }), T, never)).toBe('liquidity-floor')
  })
})

// --- selection -------------------------------------------------------------

const hit = (lens: LensId, score: number): LensHit => ({ lens, score, reason: `${lens} at ${score}`, side: 'long' })

function bench(n: number, opts: { lens?: LensId; sector?: string | null } = {}) {
  const lens = opts.lens ?? 'climax'
  const hits = new Map<string, LensHit[]>()
  const members = new Map<string, UniverseMember>()
  const features = new Map<string, Features>()
  for (let i = 0; i < n; i++) {
    const sym = `S${String(i).padStart(2, '0')}`
    hits.set(sym, [hit(lens, 0.9 - i * 0.01)])
    members.set(sym, F.member({ sym, sector: opts.sector === undefined ? null : opts.sector }))
    features.set(sym, f(sym))
  }
  return { hits, members, features }
}

describe('selectCandidates', () => {
  it('keeps only the lens top-N and reports the rest as cut', () => {
    const { hits, members, features } = bench(15)
    const { candidates, cut } = selectCandidates(hits, members, features, new Map())
    expect(candidates).toHaveLength(LENS_TOP_N.climax)
    expect(candidates[0].sym).toBe('S00')
    expect(cut.size).toBe(15 - LENS_TOP_N.climax)
    expect(cut.has('S14')).toBe(true)
  })
  it('caps one sector at 30% of a lens picks; unknown sector never blocks', () => {
    const one = bench(15, { sector: 'Technology' })
    expect(selectCandidates(one.hits, one.members, one.features, new Map()).candidates).toHaveLength(3) // floor(10 × 0.3)
    const open = bench(15)
    expect(selectCandidates(open.hits, open.members, open.features, new Map()).candidates).toHaveLength(LENS_TOP_N.climax)
  })
  it('a lens cut never blocks a different lens', () => {
    const { hits, members, features } = bench(15, { sector: 'Technology' })
    for (const [sym, list] of hits) list.push(hit('breakout', 0.5 - Number(sym.slice(1)) * 0.01))
    const { candidates } = selectCandidates(hits, members, features, new Map())
    // breakout's own cap is floor(20 × 0.3) = 6, so six names survive on that lens alone
    expect(candidates.length).toBeGreaterThan(3)
  })
  it('keeps at most two readings per name, and the third does not reject it', () => {
    const hits = new Map<string, LensHit[]>([['ONE', [hit('unusual', 0.4), hit('breakout', 0.9), hit('climax', 0.7)]]])
    const members = new Map([['ONE', F.member({ sym: 'ONE' })]])
    const features = new Map([['ONE', f('ONE')]])
    const { candidates, cut } = selectCandidates(hits, members, features, new Map())
    expect(candidates[0].lenses.map(l => l.lens)).toEqual(['breakout', 'climax'])
    expect(cut.get('ONE')!.map(l => l.lens)).toEqual(['unusual'])
  })
  it('two independent nominators bump a name past an equal-scoring rival', () => {
    const hits = new Map<string, LensHit[]>([['AAA', [hit('breakout', 0.6)]], ['ZZZ', [hit('breakout', 0.6)]]])
    const members = new Map([['AAA', F.member({ sym: 'AAA' })], ['ZZZ', F.member({ sym: 'ZZZ' })]])
    const features = new Map([['AAA', f('AAA')], ['ZZZ', f('ZZZ')]])
    const noms = new Map([['ZZZ', ['nom:social', 'nom:news']]])
    const { candidates } = selectCandidates(hits, members, features, noms)
    expect(candidates.map(c => c.sym)).toEqual(['ZZZ', 'AAA'])
    expect(candidates[0].priority).toBe(priorityFor(0.6, 2))
    expect(candidates[0].nominators).toEqual(['nom:social', 'nom:news'])
  })
  it('the nominator bump saturates at two', () => {
    expect(priorityFor(0.6, 2)).toBe(priorityFor(0.6, 5))
    expect(priorityFor(0.6, 1)).toBeLessThan(priorityFor(0.6, 2))
    expect(priorityFor(0.6, 0)).toBe(0.42)
  })
  it('is deterministic: shuffling every input map changes nothing', () => {
    const { hits, members, features } = bench(20, { sector: 'Health' })
    const noms = new Map([['S03', ['nom:social']], ['S07', ['nom:news', 'nom:social']]])
    const first = selectCandidates(hits, members, features, noms)
    const shuffle = <V>(m: Map<string, V>) => new Map([...m].reverse())
    const second = selectCandidates(shuffle(hits), shuffle(members), shuffle(features), shuffle(noms))
    expect(JSON.stringify(second.candidates)).toBe(JSON.stringify(first.candidates))
    expect([...second.cut.keys()].sort()).toEqual([...first.cut.keys()].sort())
  })
  it('ties break on symbol, never on insertion order', () => {
    const syms = ['MMM', 'AAA', 'ZZZ']
    const hits = new Map(syms.map(s => [s, [hit('breakout', 0.5)]]))
    const members = new Map(syms.map(s => [s, F.member({ sym: s })]))
    const features = new Map(syms.map(s => [s, f(s)]))
    expect(selectCandidates(hits, members, features, new Map()).candidates.map(c => c.sym)).toEqual(['AAA', 'MMM', 'ZZZ'])
  })
})
