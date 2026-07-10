import { describe, expect, it } from 'vitest'
import { fetchIpoCalendar, upcomingListings, recentListings, type IpoRow } from './ipoCalendar'

// a Finnhub-shaped response; `price` is a string (point or range), status is one
// of expected|priced|filed|withdrawn. One row has no symbol → must be dropped.
const sampleBody = {
  ipoCalendar: [
    { date: '2026-07-10', exchange: 'NASDAQ Global Select', name: 'SK hynix Inc.', numberOfShares: 177900000, price: '158.14', status: 'expected', symbol: 'skhy', totalSharesValue: 1 },
    { date: '2026-07-16', exchange: 'NYSE', name: 'Standard Nuclear, Inc.', numberOfShares: 18250000, price: '18.00-21.00', status: 'expected', symbol: 'STDN', totalSharesValue: 2 },
    { date: '2026-06-20', exchange: 'NASDAQ', name: 'Freshly Listed Co', numberOfShares: 1000000, price: '12.00', status: 'priced', symbol: 'FRSH', totalSharesValue: 3 },
    { date: '2026-05-01', exchange: 'NYSE', name: 'Old News Corp', numberOfShares: 1000000, price: '9.00', status: 'priced', symbol: 'OLDN', totalSharesValue: 4 },
    { date: '2026-07-14', exchange: 'NYSE', name: 'No Ticker Yet', numberOfShares: 1, price: '', status: 'filed', symbol: '', totalSharesValue: 0 },
  ],
}

const okFetch = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

describe('fetchIpoCalendar', () => {
  it('normalizes rows, uppercases the symbol, keeps the price string, drops symbol-less rows', async () => {
    const rows = await fetchIpoCalendar('KEY', '2026-06-01', '2026-07-31', okFetch(sampleBody))
    expect(rows.map(r => r.sym)).toEqual(['SKHY', 'STDN', 'FRSH', 'OLDN']) // symbol-less filed row dropped
    const sk = rows.find(r => r.sym === 'SKHY')!
    expect(sk).toEqual<IpoRow>({ sym: 'SKHY', name: 'SK hynix Inc.', date: '2026-07-10', exchange: 'NASDAQ Global Select', priceRange: '158.14', status: 'expected' })
    expect(rows.find(r => r.sym === 'STDN')!.priceRange).toBe('18.00-21.00') // ranges preserved verbatim
  })

  it('fail-soft on non-ok response and on bad JSON', async () => {
    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await fetchIpoCalendar('KEY', '2020-01-01', '2020-01-02', notOk)).toEqual([])
    const badJson = (async () => ({ ok: true, json: async () => { throw new Error('unexpected token') } })) as unknown as typeof fetch
    expect(await fetchIpoCalendar('KEY', '2020-02-01', '2020-02-02', badJson)).toEqual([])
  })

  it('coerces an unknown status to expected', async () => {
    const rows = await fetchIpoCalendar('KEY', '2019-01-01', '2019-01-02', okFetch({ ipoCalendar: [{ symbol: 'WAT', name: 'What', date: '2026-07-10', exchange: 'NYSE', price: '5', status: 'rumoured' }] }))
    expect(rows[0].status).toBe('expected')
  })
})

// window helpers operate on already-normalized rows — no fetch involved
const rows: IpoRow[] = [
  { sym: 'SKHY', name: 'SK hynix', date: '2026-07-16', exchange: 'NASDAQ', priceRange: '158.14', status: 'expected' },
  { sym: 'PRC', name: 'Priced Soon', date: '2026-07-12', exchange: 'NYSE', priceRange: '10', status: 'priced' },
  { sym: 'PAST', name: 'Expected But Past', date: '2026-07-01', exchange: 'NYSE', priceRange: '10', status: 'expected' },
  { sym: 'FRSH', name: 'Fresh Listing', date: '2026-06-20', exchange: 'NASDAQ', priceRange: '12', status: 'priced' }, // ~20d ago
  { sym: 'YDAY', name: 'Listed Yesterday', date: '2026-07-09', exchange: 'NYSE', priceRange: '8', status: 'priced' }, // 1d ago — too young
  { sym: 'OLDN', name: 'Old News', date: '2026-01-01', exchange: 'NYSE', priceRange: '9', status: 'priced' }, // >90d ago — too old
  { sym: 'WD', name: 'Withdrawn', date: '2026-07-15', exchange: 'NYSE', priceRange: '9', status: 'withdrawn' },
]
const TODAY = '2026-07-10'

describe('upcomingListings', () => {
  it('keeps expected|priced dated today or later, soonest first; drops past + withdrawn', () => {
    expect(upcomingListings(rows, TODAY).map(r => r.sym)).toEqual(['PRC', 'SKHY'])
  })
})

describe('recentListings', () => {
  it('keeps priced names between minDays and maxDays ago, newest first', () => {
    expect(recentListings(rows, TODAY).map(r => r.sym)).toEqual(['FRSH']) // YDAY too young, OLDN too old, PRC not yet listed
  })
  it('honours custom windows', () => {
    expect(recentListings(rows, TODAY, 0, 90).map(r => r.sym)).toEqual(['YDAY', 'FRSH']) // relaxing minDays admits YDAY
  })
})
