import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MOVERS_DEPTH, partitionMovers, routeRequest } from '../market-data.mts'
import type { ScreenRow } from './screener'

// THE REAL PAYLOAD, captured live on 2026-08-17 (`/api/market?type=movers`).
// Yahoo's predefined screeners return NOISY MEMBERSHIP: the `day_losers` list
// led with MAAS +5.6% and LB +4.5%, and `day_gainers` carried QNT −7.2%. The
// board served those lists raw, so the Losers rail's top row was a name that
// had gone UP. Every number below is from that capture.
const LIVE_GAINERS: ScreenRow[] = [
  ['NBIS', 8.9], ['QNT', -7.2], ['EROC', 6.8], ['SHAZ', 6.2], ['CRWV', -1], ['SMCI', 1.7],
  ['MRX', -1.8], ['ATRO', 0.9], ['HRB', 1.1], ['CAVA', 3.1], ['LITE', 5.2], ['BE', -2.7],
].map(([sym, changePct]) => ({ sym: sym as string, price: 10, capUsdM: 1000, changePct: changePct as number, name: `${sym} Inc` }))

const LIVE_LOSERS: ScreenRow[] = [
  ['MAAS', 5.6], ['FRVO', -2.8], ['LQDA', 3.2], ['ALMR', 0.7], ['LB', 4.5], ['ACM', -0.8],
  ['GRAL', -0.5], ['BSP', -3.9], ['CENX', 0.7], ['ACHR', -5], ['DJT', -0.4], ['LIME', -6.9],
].map(([sym, changePct]) => ({ sym: sym as string, price: 10, capUsdM: 1000, changePct: changePct as number, name: `${sym} Inc` }))

const LIVE_ACTIVES: ScreenRow[] = [
  ['SMCI', 1.7], ['SPCX', -0.9], ['INTC', -2], ['NOK', 1.9], ['NVDA', -0.1], ['PLUG', 0.9],
  ['ONDS', 3.7], ['CRWV', -1], ['PATH', -4], ['NBIS', 8.9], ['ACHR', -5], ['IREN', -1.6],
].map(([sym, changePct]) => ({ sym: sym as string, price: 10, capUsdM: 1000, changePct: changePct as number, name: `${sym} Inc` }))

describe('partitionMovers — the sign of the move decides the rail, not the screener', () => {
  it('re-partitions the LIVE mixed payload: every gainer is up, every loser is down', () => {
    const { gainers, losers } = partitionMovers([...LIVE_GAINERS, ...LIVE_LOSERS])
    expect(gainers.length).toBeGreaterThan(0)
    expect(losers.length).toBeGreaterThan(0)
    for (const r of gainers) expect(r.changePct!).toBeGreaterThan(0)
    for (const r of losers) expect(r.changePct!).toBeLessThan(0)
    // the two rows the live board actually led with
    expect(losers.map(r => r.sym)).not.toContain('MAAS')
    expect(losers.map(r => r.sym)).not.toContain('LB')
    expect(gainers.map(r => r.sym)).not.toContain('QNT')
    // …and they are not lost, they are on the side their own number puts them
    expect(gainers.map(r => r.sym)).toContain('MAAS')
    expect(losers.map(r => r.sym)).toContain('QNT')
  })

  it('sorts gainers biggest-up first and losers biggest-down first', () => {
    const { gainers, losers } = partitionMovers([...LIVE_GAINERS, ...LIVE_LOSERS])
    expect(gainers[0].sym).toBe('NBIS') // +8.9
    expect(gainers.map(r => r.changePct)).toEqual([...gainers.map(r => r.changePct)].sort((a, b) => b! - a!))
    expect(losers[0].sym).toBe('QNT') // −7.2
    expect(losers.map(r => r.changePct)).toEqual([...losers.map(r => r.changePct)].sort((a, b) => a! - b!))
  })

  it('dedupes by symbol, keeping the record with the larger move', () => {
    const rows: ScreenRow[] = [
      { sym: 'DUP', price: 10, capUsdM: 1, changePct: 2.1, name: 'Dup' },
      { sym: 'DUP', price: 11, capUsdM: 1, changePct: 4.4, name: 'Dup later' },
      { sym: 'FLIP', price: 10, capUsdM: 1, changePct: 1.2, name: 'Flip' },
      { sym: 'FLIP', price: 9, capUsdM: 1, changePct: -6.5, name: 'Flip stale' },
    ]
    const { gainers, losers } = partitionMovers(rows)
    expect(gainers.filter(r => r.sym === 'DUP')).toHaveLength(1)
    expect(gainers.find(r => r.sym === 'DUP')!.price).toBe(11)
    // a symbol whose two records disagree on SIGN lands on the side of the
    // bigger move, once — never once on each rail
    expect(gainers.map(r => r.sym)).not.toContain('FLIP')
    expect(losers.filter(r => r.sym === 'FLIP')).toHaveLength(1)
  })

  it('drops a row with no move to speak of — null or flat is on neither side', () => {
    const rows: ScreenRow[] = [
      { sym: 'NOPCT', price: 10, capUsdM: 1, changePct: null, name: null },
      { sym: 'FLAT', price: 10, capUsdM: 1, changePct: 0, name: null },
      { sym: 'UP', price: 10, capUsdM: 1, changePct: 1, name: null },
    ]
    const { gainers, losers } = partitionMovers(rows)
    expect(gainers.map(r => r.sym)).toEqual(['UP'])
    expect(losers).toEqual([])
  })

  it('serves each side up to MOVERS_DEPTH rows, and MOVERS_DEPTH is 25', () => {
    expect(MOVERS_DEPTH).toBe(25)
    const many: ScreenRow[] = Array.from({ length: 60 }, (_, i) => ({ sym: `G${i}`, price: 10, capUsdM: 1, changePct: 60 - i, name: null }))
    const down: ScreenRow[] = Array.from({ length: 60 }, (_, i) => ({ sym: `L${i}`, price: 10, capUsdM: 1, changePct: -(60 - i), name: null }))
    const { gainers, losers } = partitionMovers([...many, ...down])
    expect(gainers).toHaveLength(25)
    expect(losers).toHaveLength(25)
    expect(gainers[0].sym).toBe('G0') // +60, the biggest
  })
})

// The route level: the same live payload through `type=movers`, with the
// screener and the candle cache both mocked so nothing leaves the process.
const screenerMock = vi.hoisted(() => ({ fetchScreen: vi.fn() }))
vi.mock('./screener', () => screenerMock)
const marketCacheMock = vi.hoisted(() => ({ cachedCandles: vi.fn(async () => null) }))
vi.mock('./marketCache', () => marketCacheMock)

const env = { APP_TOKEN: 'secret', FINNHUB_API_KEY: 'fk' }
const deps = { yahoo: vi.fn(), finnhub: vi.fn() }
const movers = () => routeRequest(new URL('http://x/api/market?type=movers'), new Headers({ 'x-app-token': 'secret' }), env, deps as never)

describe('market-data movers — what the rails are actually served', () => {
  beforeEach(async () => {
    const { setCached } = await import('./cache')
    await setCached('movers', null, -10) // expire the payload cache between tests
    screenerMock.fetchScreen.mockReset()
    screenerMock.fetchScreen.mockImplementation(async (kind: string) =>
      kind === 'day_gainers' ? LIVE_GAINERS : kind === 'day_losers' ? LIVE_LOSERS : LIVE_ACTIVES,
    )
  })

  it('never serves a row on the wrong rail, whichever screener it arrived in', async () => {
    const body = await (await movers()).json()
    expect(body.ok).toBe(true)
    const { gainers, losers } = body.data as { gainers: { sym: string; changePct: number }[]; losers: { sym: string; changePct: number }[] }
    for (const r of gainers) expect(r.changePct).toBeGreaterThan(0)
    for (const r of losers) expect(r.changePct).toBeLessThan(0)
    expect(losers[0].sym).toBe('QNT')
    expect(gainers[0].sym).toBe('NBIS')
    // a symbol appears at most once per rail
    expect(new Set(gainers.map(r => r.sym)).size).toBe(gainers.length)
    expect(new Set(losers.map(r => r.sym)).size).toBe(losers.length)
  })

  it('asks the screeners for the full depth and carries the `at` stamp through', async () => {
    const before = Math.floor(Date.now() / 1000)
    const body = await (await movers()).json()
    expect(body.data.at).toBeGreaterThanOrEqual(before)
    expect(typeof body.data.at).toBe('number')
    expect(body.data.actives.length).toBeGreaterThan(0)
    // every served row still carries the shape the client renders
    expect(body.data.gainers[0]).toHaveProperty('price')
    expect(body.data.gainers[0]).toHaveProperty('name')
    expect(body.data.gainers[0]).toHaveProperty('stage')
  })

  it('serves the cached payload verbatim on the next call — `at` unchanged', async () => {
    const first = await (await movers()).json()
    screenerMock.fetchScreen.mockClear()
    const second = await (await movers()).json()
    expect(second.data.at).toBe(first.data.at)
    expect(screenerMock.fetchScreen).not.toHaveBeenCalled()
  })
})
