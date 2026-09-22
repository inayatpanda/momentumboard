import { describe, expect, it } from 'vitest'
import {
  EARNINGS_CALENDAR_KEY,
  PRUNE_CALENDAR_DAYS,
  SNAPSHOT_DAYS,
  earningsCalendarRows,
  fetchNasdaqEarnings,
  mergeEarningsRow,
  normaliseSymbol,
  parseMoney,
  parseNum,
  pruneEarningsRows,
  snapshotEarningsCalendar,
  upcomingEarnings,
  type EarningsCalendarBlob,
  type NasdaqEarningsRow,
} from './nasdaqEarnings'
import { memoryStore } from './store'

// The REAL field names, copied from live probes of
// api.nasdaq.com/api/calendar/earnings on 2026-09-22. The two bodies are the two
// different answers one endpoint gives, and the difference is the entire reason
// the snapshot exists:
//
//   FUTURE date → `time` is populated, `eps`/`surprise` are absent, and the rows
//                 instead carry lastYearRptDt / lastYearEPS.
//   PAST date   → `eps`/`surprise` are there and `time` reads time-not-supplied
//                 on every single row.
const futureBody = {
  data: {
    asOf: 'Thu, Sep 24, 2026',
    headers: { time: 'Time', symbol: 'Symbol', name: 'Company Name' },
    rows: [
      {
        lastYearRptDt: '9/25/2025',
        lastYearEPS: '$5.87',
        time: 'time-after-hours',
        symbol: 'COST',
        name: 'Costco Wholesale Corporation',
        marketCap: '$398,456,848,000',
        fiscalQuarterEnding: 'Aug/2026',
        epsForecast: '$6.48',
        noOfEsts: '11',
      },
      {
        lastYearRptDt: '9/18/2025',
        lastYearEPS: '$1.97',
        time: 'time-pre-market',
        symbol: 'DRI',
        name: 'Darden Restaurants, Inc.',
        marketCap: '$24,105,816,100',
        fiscalQuarterEnding: 'Aug/2026',
        epsForecast: '$2.06',
        noOfEsts: '11',
      },
      {
        lastYearRptDt: '9/04/2025',
        lastYearEPS: '($0.35)',
        time: 'time-not-supplied',
        symbol: 'BRK.B',
        name: 'Berkshire Hathaway Inc.',
        marketCap: '$1,000,000,000,000',
        fiscalQuarterEnding: 'Jun/2026',
        epsForecast: 'N/A',
        noOfEsts: 'N/A',
      },
      // no symbol at all — nothing to trade, nothing to date
      { time: 'time-pre-market', symbol: '', name: 'Nameless Co', marketCap: '$1,000', epsForecast: '$0.10', noOfEsts: '1' },
    ],
  },
}

const pastBody = {
  data: {
    asOf: 'Tue, Sep 15, 2026',
    headers: { eps: 'EPS', surprise: '% Surprise' },
    rows: [
      { eps: '$0.92', surprise: '9.52', time: 'time-not-supplied', symbol: 'TCOM', name: 'Trip.com', marketCap: '$25,597,517,800', epsForecast: '$0.84', noOfEsts: '2' },
      { eps: '($0.02)', surprise: '-300', time: 'time-not-supplied', symbol: 'EPM', name: 'Evolution Petroleum', marketCap: '$143,013,120', epsForecast: '$0.01', noOfEsts: '3' },
      { eps: '($0.24)', surprise: 'N/A', time: 'time-not-supplied', symbol: 'ISPR', name: 'Ispire Technology', marketCap: '$72,193,088', epsForecast: '($0.20)', noOfEsts: '1' },
    ],
  },
}

const okFetch = (body: unknown): typeof fetch => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

describe('the money/number parsers', () => {
  it('reads Nasdaq money, including the accountancy minus and the N/A sentinel', () => {
    expect(parseMoney('$24.89')).toBe(24.89)
    expect(parseMoney('($8.75)')).toBe(-8.75) // parentheses ARE the minus sign
    expect(parseMoney('$398,456,848,000')).toBe(398_456_848_000)
    expect(parseMoney('N/A')).toBeNull()
    expect(parseMoney('')).toBeNull()
    expect(parseMoney(undefined)).toBeNull()
  })

  it('reads the plain numerics and refuses the sentinel there too', () => {
    expect(parseNum('9.52')).toBe(9.52)
    expect(parseNum('-57.58')).toBe(-57.58)
    expect(parseNum('237.5')).toBe(237.5)
    expect(parseNum('N/A')).toBeNull()
    // 0 is a READING, not an absence — a surprise of exactly zero is a real fact
    expect(parseNum('0')).toBe(0)
  })
})

describe('symbol normalisation', () => {
  it('maps a share class to Yahoo form — the shape every candle fetch here uses', () => {
    expect(normaliseSymbol('BRK.B')).toBe('BRK-B')
    expect(normaliseSymbol(' cost ')).toBe('COST')
    expect(normaliseSymbol('')).toBeNull()
    expect(normaliseSymbol(undefined)).toBeNull()
    expect(normaliseSymbol('not a ticker')).toBeNull()
  })
})

describe('fetchNasdaqEarnings', () => {
  it('normalises a FUTURE date: time survives, eps/surprise are honestly null', async () => {
    const rows = await fetchNasdaqEarnings('2026-09-24', okFetch(futureBody))
    expect(rows.map(r => r.sym)).toEqual(['COST', 'DRI', 'BRK-B']) // the symbol-less row is dropped
    expect(rows[0]).toEqual<NasdaqEarningsRow>({
      sym: 'COST',
      date: '2026-09-24',
      time: 'post',
      epsActual: null,
      epsForecast: 6.48,
      surprisePct: null,
      noOfEsts: 11,
      marketCapUsdM: 398_457,
    })
    expect(rows[1].time).toBe('pre')
    // time-not-supplied is 'unknown' and NEVER guessed into pre/post — the guess
    // would move the reaction bar by a whole session.
    expect(rows[2].time).toBe('unknown')
    expect(rows[2].epsForecast).toBeNull()
    expect(rows[2].noOfEsts).toBeNull()
  })

  it('normalises a PAST date: eps/surprise arrive, every time reads unknown', async () => {
    const rows = await fetchNasdaqEarnings('2026-09-15', okFetch(pastBody))
    expect(rows.every(r => r.time === 'unknown')).toBe(true)
    expect(rows[0]).toMatchObject({ sym: 'TCOM', epsActual: 0.92, epsForecast: 0.84, surprisePct: 9.52 })
    expect(rows[1]).toMatchObject({ sym: 'EPM', epsActual: -0.02, surprisePct: -300 })
    expect(rows[2].surprisePct).toBeNull() // 'N/A' is an unknown, never a zero
  })

  it('fails soft on a non-200, on bad JSON, on a thrown fetch and on a shape that moved', async () => {
    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await fetchNasdaqEarnings('2026-01-01', notOk)).toEqual([])
    const badJson = (async () => ({
      ok: true,
      json: async () => {
        throw new Error('unexpected token')
      },
    })) as unknown as typeof fetch
    expect(await fetchNasdaqEarnings('2026-01-02', badJson)).toEqual([])
    const throws = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await fetchNasdaqEarnings('2026-01-03', throws)).toEqual([])
    expect(await fetchNasdaqEarnings('2026-01-04', okFetch({ data: { rows: null } }))).toEqual([])
    expect(await fetchNasdaqEarnings('2026-01-05', okFetch({}))).toEqual([])
  })
})

const row = (over: Partial<NasdaqEarningsRow>): NasdaqEarningsRow => ({
  sym: 'ABC',
  date: '2026-09-20',
  time: 'unknown',
  epsActual: null,
  epsForecast: null,
  surprisePct: null,
  noOfEsts: null,
  marketCapUsdM: null,
  ...over,
})

describe('the merge rule', () => {
  it('KEEPS the first known time — the post-print re-read must not erase it', () => {
    const forward = row({ time: 'pre', epsForecast: 2.06 })
    const afterwards = row({ time: 'unknown', epsActual: 2.2, surprisePct: 6.8 })
    const merged = mergeEarningsRow(forward, afterwards)
    expect(merged.time).toBe('pre') // the ONE field only a forward read carries
    expect(merged.epsActual).toBe(2.2) // …and the numbers fill in
    expect(merged.surprisePct).toBe(6.8)
    expect(merged.epsForecast).toBe(2.06) // a null incoming never clears what is known
  })

  it('replaces an unknown time once a real one arrives', () => {
    expect(mergeEarningsRow(row({ time: 'unknown' }), row({ time: 'post' })).time).toBe('post')
  })

  it('a first sighting is kept whole', () => {
    const first = row({ time: 'post', surprisePct: 1 })
    expect(mergeEarningsRow(undefined, first)).toEqual(first)
  })
})

describe('pruning', () => {
  it('drops prints older than the retention window and keeps everything inside it', () => {
    const today = '2026-09-22'
    const old = new Date(Date.parse(`${today}T00:00:00Z`) - (PRUNE_CALENDAR_DAYS + 5) * 86_400_000).toISOString().slice(0, 10)
    const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10)
    const kept = pruneEarningsRows(
      {
        [`${old}:OLD`]: row({ sym: 'OLD', date: old }),
        [`${recent}:NEW`]: row({ sym: 'NEW', date: recent }),
        '2026-10-01:FWD': row({ sym: 'FWD', date: '2026-10-01' }),
      },
      today,
    )
    expect(Object.values(kept).map(r => r.sym).sort()).toEqual(['FWD', 'NEW'])
  })
})

describe('snapshotEarningsCalendar', () => {
  // Distinct base dates per test: lib/cache.ts falls back to a module-level Map
  // under vitest, and it is shared across the file.
  it('fetches today+1 … today+10, once per date, and re-uses the per-date cache within the TTL', async () => {
    const store = memoryStore()
    const asked: string[] = []
    const fetchFn = (async (url: string) => {
      asked.push(new URL(url).searchParams.get('date')!)
      return {
        ok: true,
        json: async () => ({
          data: { rows: [{ symbol: 'ZZA', time: 'time-pre-market', epsForecast: '$1.00', noOfEsts: '4', marketCap: '$2,000,000,000' }] },
        }),
      }
    }) as unknown as typeof fetch

    const first = await snapshotEarningsCalendar(store, '2030-03-01', fetchFn)
    expect(asked.length).toBe(SNAPSHOT_DAYS)
    expect(asked[0]).toBe('2030-03-02') // starts at today+1: today's rows already read as history
    expect(asked[SNAPSHOT_DAYS - 1]).toBe('2030-03-11')
    expect(first.length).toBe(SNAPSHOT_DAYS)
    expect(first.every(r => r.time === 'pre')).toBe(true)
    expect(first.every(r => r.marketCapUsdM === 2_000)).toBe(true)

    // A second run the same morning costs NOTHING: every date is inside the ~6h
    // cache window, which is what keeps ten calls a run from becoming ten calls a
    // scheduled job.
    asked.length = 0
    await snapshotEarningsCalendar(store, '2030-03-01', fetchFn)
    expect(asked).toEqual([])

    const blob = await store.read<EarningsCalendarBlob>(EARNINGS_CALENDAR_KEY)
    expect(blob?.v).toBe(1)
    expect(Object.keys(blob!.rows).length).toBe(SNAPSHOT_DAYS)
  })

  it('the post-print re-read fills in eps/surprise and CANNOT erase the session timing', async () => {
    // The blob already holds what a forward read learned: this name reports
    // pre-market. The snapshot now re-reads the same date as history — where
    // Nasdaq answers `time-not-supplied` on every row — and the merge has to keep
    // the timing while taking the numbers.
    const store = memoryStore()
    await store.write(EARNINGS_CALENDAR_KEY, {
      v: 1,
      updatedAt: 'x',
      rows: { '2031-05-04:ZZC': row({ sym: 'ZZC', date: '2031-05-04', time: 'pre', epsForecast: 1 }) },
    } satisfies EarningsCalendarBlob)
    const history = okFetch({
      data: { rows: [{ symbol: 'ZZC', time: 'time-not-supplied', eps: '$1.20', surprise: '20', epsForecast: '$1.00', noOfEsts: '4' }] },
    })
    const rows = await snapshotEarningsCalendar(store, '2031-05-03', history)
    const reread = rows.find(r => r.date === '2031-05-04')!
    expect(reread.time).toBe('pre') // FIRST SEEN WINS — the one field only a forward read carries
    expect(reread.surprisePct).toBe(20)
    expect(reread.epsActual).toBe(1.2)
  })

  it('prunes on write, so the blob cannot grow without bound', async () => {
    const store = memoryStore()
    const stale = '2029-01-01'
    await store.write(EARNINGS_CALENDAR_KEY, {
      v: 1,
      updatedAt: 'x',
      rows: { [`${stale}:OLD`]: row({ sym: 'OLD', date: stale }) },
    } satisfies EarningsCalendarBlob)
    const rows = await snapshotEarningsCalendar(store, '2030-06-01', okFetch({ data: { rows: [{ symbol: 'ZZB', time: 'time-after-hours' }] } }))
    expect(rows.some(r => r.sym === 'OLD')).toBe(false)
    expect(rows.every(r => r.sym === 'ZZB')).toBe(true)
  })

  it('a dead endpoint costs the calendar nothing it already knew', async () => {
    const store = memoryStore()
    await store.write(EARNINGS_CALENDAR_KEY, {
      v: 1,
      updatedAt: 'x',
      rows: { '2030-09-05:KEEP': row({ sym: 'KEEP', date: '2030-09-05', time: 'post', surprisePct: 4 }) },
    } satisfies EarningsCalendarBlob)
    const dead = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    const rows = await snapshotEarningsCalendar(store, '2030-09-01', dead)
    expect(rows.map(r => r.sym)).toEqual(['KEEP'])
  })
})

describe('the readers', () => {
  it('earningsCalendarRows is fail-soft and newest-print-first', async () => {
    const store = memoryStore()
    expect(await earningsCalendarRows(store)).toEqual([]) // nothing written yet
    await store.write(EARNINGS_CALENDAR_KEY, { v: 1, updatedAt: 'x', rows: 'not an object' })
    expect(await earningsCalendarRows(store)).toEqual([])
    await store.write(EARNINGS_CALENDAR_KEY, {
      v: 1,
      updatedAt: 'x',
      rows: {
        'a:A': row({ sym: 'A', date: '2026-09-01' }),
        'b:B': row({ sym: 'B', date: '2026-09-20' }),
      },
    } satisfies EarningsCalendarBlob)
    expect((await earningsCalendarRows(store)).map(r => r.sym)).toEqual(['B', 'A'])
  })

  it('upcomingEarnings takes the forward fortnight only, soonest first', () => {
    const rows = [
      row({ sym: 'PAST', date: '2026-09-01' }),
      row({ sym: 'SOON', date: '2026-09-23' }),
      row({ sym: 'LATER', date: '2026-10-02' }),
      row({ sym: 'BEYOND', date: '2026-11-01' }),
      row({ sym: 'TODAY', date: '2026-09-22' }),
    ]
    expect(upcomingEarnings(rows, '2026-09-22', 14).map(r => r.sym)).toEqual(['TODAY', 'SOON', 'LATER'])
  })
})
