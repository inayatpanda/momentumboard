import { describe, expect, it } from 'vitest'
import { buildUniverse, exchangeForNomination, sessionsSince, type UniverseNomination, type UniverseSeedRow } from './universe'
import { DYNAMIC_UNIVERSE_MAX, type DynamicUniverseState } from './types'

// In-memory rows only: the real seed is 1,800 names and a moving target, and a
// universe test that depends on index membership fails the day S&P rebalances.
const seedRow = (sym: string, over: Partial<UniverseSeedRow> = {}): UniverseSeedRow => ({
  sym,
  name: `${sym} Inc`,
  exchange: 'US',
  index: ['sp500'],
  sector: 'Technology',
  capBand: 'large',
  ...over,
})

const dyn = (members: DynamicUniverseState['members']): DynamicUniverseState => ({ version: 1, members })
const entry = (over: Partial<DynamicUniverseState['members'][string]> = {}) => ({
  origins: ['nom:social'],
  joined: '2026-06-01',
  lastSeen: '2026-09-19',
  capBand: null,
  sector: null,
  exchange: 'US' as const,
  ...over,
})

const TODAY = '2026-09-22'

describe('buildUniverse', () => {
  it('seeds from index membership, one origin per index', () => {
    const { members, nextDynamic } = buildUniverse([seedRow('AAPL', { index: ['sp500', 'ndx'] })], null, [], TODAY)
    expect(members.get('AAPL')!.origins).toEqual(['seed:sp500', 'seed:ndx'])
    expect(members.get('AAPL')!.capBand).toBe('large')
    expect(nextDynamic.members).toEqual({}) // seed names are never stored
  })

  it('carries dynamic members that are still inside the TTL', () => {
    const { members } = buildUniverse([], dyn({ FRESH: entry({ lastSeen: '2026-09-19' }) }), [], TODAY)
    expect(members.has('FRESH')).toBe(true)
    expect(members.get('FRESH')!.lastSeen).toBe('2026-09-19')
  })

  it('drops dynamic members past the 60-session TTL', () => {
    // 60 sessions ≈ 84 calendar days; 2026-05-01 is 144 days back.
    const { members, nextDynamic } = buildUniverse([], dyn({ OLD: entry({ lastSeen: '2026-05-01' }) }), [], TODAY)
    expect(members.has('OLD')).toBe(false)
    expect(nextDynamic.members.OLD).toBeUndefined()
    expect(sessionsSince('2026-05-01', TODAY)).toBeGreaterThan(60)
    expect(sessionsSince('2026-07-01', TODAY)).toBeLessThan(60)
  })

  it('a nomination inserts a new dynamic member stamped today', () => {
    const noms: UniverseNomination[] = [{ sym: 'NEW', origin: 'screener:gainers', sector: 'Energy', capBand: 'mid' }]
    const { members, nextDynamic, nominators } = buildUniverse([], null, noms, TODAY)
    expect(members.get('NEW')!.origins).toEqual(['nom:screener:gainers'])
    expect(members.get('NEW')!.sector).toBe('Energy')
    expect(nextDynamic.members.NEW).toEqual({ origins: ['nom:screener:gainers'], joined: TODAY, lastSeen: TODAY, capBand: 'mid', sector: 'Energy', exchange: 'US' })
    expect(nominators.get('NEW')).toEqual(['nom:screener:gainers'])
  })

  it('a nomination refreshes an existing dynamic member without re-joining it', () => {
    const state = dyn({ OLDIE: entry({ lastSeen: '2026-08-01', joined: '2026-03-02' }) })
    const { members, nextDynamic } = buildUniverse([], state, [{ sym: 'OLDIE', origin: 'nom:news' }], TODAY)
    expect(nextDynamic.members.OLDIE.joined).toBe('2026-03-02')
    expect(nextDynamic.members.OLDIE.lastSeen).toBe(TODAY)
    expect(nextDynamic.members.OLDIE.origins).toEqual(['nom:social', 'nom:news'])
    expect(members.get('OLDIE')!.lastSeen).toBe(TODAY)
  })

  it('nominating a seed name adds the origin but stores nothing', () => {
    const { members, nextDynamic, nominators } = buildUniverse([seedRow('AAPL')], null, [{ sym: 'AAPL', origin: 'watchlist' }], TODAY)
    expect(members.get('AAPL')!.origins).toEqual(['seed:sp500', 'nom:watchlist'])
    expect(nextDynamic.members.AAPL).toBeUndefined()
    expect(nominators.get('AAPL')).toEqual(['nom:watchlist'])
  })

  it('lists every nominator that named a symbol today, deduped', () => {
    const noms: UniverseNomination[] = [
      { sym: 'HOT', origin: 'social' },
      { sym: 'HOT', origin: 'news' },
      { sym: 'HOT', origin: 'social' },
    ]
    expect(buildUniverse([], null, noms, TODAY).nominators.get('HOT')).toEqual(['nom:social', 'nom:news'])
  })

  it('evicts the oldest lastSeen first when the dynamic cap is hit', () => {
    const members: DynamicUniverseState['members'] = {}
    for (let i = 0; i < DYNAMIC_UNIVERSE_MAX; i++) {
      members[`D${String(i).padStart(4, '0')}`] = entry({ lastSeen: i === 0 ? '2026-07-02' : '2026-09-19' })
    }
    const { nextDynamic } = buildUniverse([], dyn(members), [{ sym: 'NEW', origin: 'social' }], TODAY)
    expect(Object.keys(nextDynamic.members)).toHaveLength(DYNAMIC_UNIVERSE_MAX)
    expect(nextDynamic.members.D0000).toBeUndefined() // the stalest went
    expect(nextDynamic.members.NEW).toBeDefined() // today's nomination never does
  })

  it('drops crypto everywhere, silently — the crypto lane owns it', () => {
    const { members, nextDynamic, nominators } = buildUniverse(
      [seedRow('AAPL')],
      dyn({ 'ETH-USD': entry() }),
      [{ sym: 'BTC-USD', origin: 'social' }, { sym: 'MSFT', origin: 'social' }],
      TODAY,
    )
    expect([...members.keys()].sort()).toEqual(['AAPL', 'MSFT'])
    expect(nextDynamic.members['BTC-USD']).toBeUndefined()
    expect(nextDynamic.members['ETH-USD']).toBeUndefined()
    expect(nominators.has('BTC-USD')).toBe(false)
  })

  it('infers the venue from the suffix, and an explicit exchange wins', () => {
    expect(exchangeForNomination('BARC.L')).toBe('LSE')
    expect(exchangeForNomination('BRK-B')).toBe('US')
    expect(exchangeForNomination('WEIRD', 'LSE')).toBe('LSE')
    const { members } = buildUniverse([], null, [{ sym: 'RIO.L', origin: 'social' }], TODAY)
    expect(members.get('RIO.L')!.exchange).toBe('LSE')
  })

  it('a dynamic row that has since joined an index merges into the seed member', () => {
    const { members, nextDynamic } = buildUniverse([seedRow('AAPL')], dyn({ AAPL: entry({ origins: ['nom:watchlist'] }) }), [], TODAY)
    expect(members.get('AAPL')!.origins).toEqual(['seed:sp500', 'nom:watchlist'])
    expect(nextDynamic.members.AAPL).toBeUndefined()
  })

  it('is deterministic: same inputs, same order, same stored state', () => {
    const seed = [seedRow('MSFT'), seedRow('AAPL')]
    const state = dyn({ ZZZ: entry(), AAA: entry() })
    const noms: UniverseNomination[] = [{ sym: 'NEW', origin: 'social' }]
    const a = buildUniverse(seed, state, noms, TODAY)
    const b = buildUniverse(seed, state, noms, TODAY)
    expect([...a.members.keys()]).toEqual(['MSFT', 'AAPL', 'AAA', 'ZZZ', 'NEW'])
    expect([...b.members.keys()]).toEqual([...a.members.keys()])
    expect(JSON.stringify(b.nextDynamic)).toBe(JSON.stringify(a.nextDynamic))
  })
})
