import { describe, expect, it } from 'vitest'
import {
  EARNINGS_CALENDAR_KEY,
  PRUNE_CALENDAR_DAYS,
  REREAD_DAYS,
  REREAD_TTL_SEC,
  SNAPSHOT_CONCURRENCY,
  SNAPSHOT_DAYS,
  SNAPSHOT_TTL_SEC,
  earningsCalendarRows,
  fetchNasdaqEarnings,
  mergeEarningsRow,
  normaliseSymbol,
  parseMoney,
  parseNum,
  pruneEarningsRows,
  snapshotDates,
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

  it('reads the accountancy minus in a PLAIN numeric too — the same formatter writes both', () => {
    // `% Surprise` comes back parenthesised on some rows and signed on others.
    // Read the first as positive and a miss is published to the reader as a beat.
    expect(parseNum('(300)')).toBe(-300)
    expect(parseNum('(57.58)')).toBe(-57.58)
    expect(parseNum('(1,250)')).toBe(-1250)
    expect(parseNum('(12.5%)')).toBe(-12.5)
    expect(parseNum('(0)')).toBe(-0)
    // …and an unmatched bracket is not a number at all, never a silent 0
    expect(parseNum('(oops)')).toBeNull()
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

describe('the snapshot window', () => {
  it('reaches BACK as well as forward — an outcome only exists on a past date', () => {
    const w = snapshotDates('2030-03-01')
    expect(w.map(d => d.iso)).toEqual([
      '2030-02-26', '2030-02-27', '2030-02-28', '2030-03-01', // today−3 … today: the re-read
      '2030-03-02', '2030-03-03', '2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08',
      '2030-03-09', '2030-03-10', '2030-03-11', '2030-03-12', '2030-03-13', '2030-03-14', '2030-03-15',
    ])
    expect(w.length).toBe(SNAPSHOT_DAYS + REREAD_DAYS + 1)
    expect(w.filter(d => d.forward).length).toBe(SNAPSHOT_DAYS)
  })

  it('caches the two readings of one date under DIFFERENT keys and different TTLs', () => {
    // The masking mechanism, pinned: a date is fetched forward (6h) days before
    // it is re-read as history, so a shared key would serve the re-read the
    // stale pre-print body and the surprise could never land.
    const w = snapshotDates('2030-03-01')
    const past = w.find(d => d.iso === '2030-03-01')!
    const fwd = w.find(d => d.iso === '2030-03-05')!
    expect(past).toMatchObject({ forward: false, cacheKey: 'nasdaq-earnings:past:2030-03-01', ttlSec: REREAD_TTL_SEC })
    expect(fwd).toMatchObject({ forward: true, cacheKey: 'nasdaq-earnings:2030-03-05', ttlSec: SNAPSHOT_TTL_SEC })
    expect(new Set(w.map(d => d.cacheKey)).size).toBe(w.length)
    expect(REREAD_TTL_SEC).toBeLessThanOrEqual(3_600) // short enough that the re-read reaches Nasdaq
  })

  it('reaches exactly as far forward as the engine slices — 14 days, the horizon it logs', () => {
    // upcomingEarnings' default IS the engine's earnings-risk window; a snapshot
    // that stopped at 10 made every print in days 11–14 read as "no print known".
    expect(SNAPSHOT_DAYS).toBe(14)
    const w = snapshotDates('2030-03-01')
    const edge = row({ sym: 'EDGE', date: '2030-03-15' }) // today+14
    expect(upcomingEarnings([edge], '2030-03-01').map(r => r.sym)).toEqual(['EDGE'])
    expect(w.map(d => d.iso)).toContain(edge.date)
  })
})

describe('snapshotEarningsCalendar', () => {
  // Distinct base dates per test: lib/cache.ts falls back to a module-level Map
  // under vitest, and it is shared across the file.
  it('fetches the whole window once per date, four at a time, and re-uses the per-date cache', async () => {
    const store = memoryStore()
    const asked: string[] = []
    let inFlight = 0
    let peak = 0
    const fetchFn = (async (url: string) => {
      asked.push(new URL(url).searchParams.get('date')!)
      inFlight++
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight--
      return {
        ok: true,
        json: async () => ({
          data: { rows: [{ symbol: 'ZZA', time: 'time-pre-market', epsForecast: '$1.00', noOfEsts: '4', marketCap: '$2,000,000,000' }] },
        }),
      }
    }) as unknown as typeof fetch

    const first = await snapshotEarningsCalendar(store, '2030-03-01', fetchFn)
    const window = SNAPSHOT_DAYS + REREAD_DAYS + 1
    expect(asked.length).toBe(window)
    expect(asked[0]).toBe('2030-02-26') // today−3: the re-read window leads
    expect(asked[asked.length - 1]).toBe('2030-03-15') // today+14
    // BOUNDED FAN-OUT, not Promise.all over the whole window: one anonymous
    // key-less endpoint, eighteen dates.
    expect(peak).toBeLessThanOrEqual(SNAPSHOT_CONCURRENCY)
    expect(first.length).toBe(window)
    expect(first.every(r => r.time === 'pre')).toBe(true)
    expect(first.every(r => r.marketCapUsdM === 2_000)).toBe(true)

    // A second run the same morning costs NOTHING: every date is inside its own
    // cache window, which is what keeps a per-run fan-out from becoming a
    // per-invocation one.
    asked.length = 0
    await snapshotEarningsCalendar(store, '2030-03-01', fetchFn)
    expect(asked).toEqual([])

    const blob = await store.read<EarningsCalendarBlob>(EARNINGS_CALENDAR_KEY)
    expect(blob?.v).toBe(1)
    expect(Object.keys(blob!.rows).length).toBe(window)
  })

  it('LEARNS THE SURPRISE: seen forward with a time, re-read as history with the print', async () => {
    // The whole reason this module exists, end to end and through the cache —
    // and the thing the forward-only window could never do, which is why the
    // earnings-fade lane had never fired.
    const store = memoryStore()
    const printDate = '2031-05-06'
    const bodyFor = (rows: unknown[]) => ({ ok: true, json: async () => ({ data: { rows } }) })

    // RUN ONE, three days early. The date is in the FUTURE: Nasdaq gives the
    // session timing and no numbers — and the row is cached under the forward
    // key for six hours.
    const forward = (async (url: string) => {
      const date = new URL(url).searchParams.get('date')!
      return bodyFor(date === printDate ? [{ symbol: 'ZZD', time: 'time-pre-market', epsForecast: '$1.00', noOfEsts: '4' }] : [])
    }) as unknown as typeof fetch
    const first = await snapshotEarningsCalendar(store, '2031-05-03', forward)
    expect(first.find(r => r.date === printDate)).toMatchObject({ sym: 'ZZD', time: 'pre', epsActual: null, surprisePct: null })

    // RUN TWO, two days later. The same date is now PAST, so it falls in the
    // re-read window — under its own cache key, so the six-hour forward entry
    // written above cannot serve it.
    const asked: string[] = []
    const history = (async (url: string) => {
      const date = new URL(url).searchParams.get('date')!
      asked.push(date)
      return bodyFor(
        date === printDate
          ? [{ symbol: 'ZZD', time: 'time-not-supplied', eps: '$1.20', surprise: '(20)', epsForecast: '$1.00', noOfEsts: '4' }]
          : [],
      )
    }) as unknown as typeof fetch
    const second = await snapshotEarningsCalendar(store, '2031-05-08', history)
    expect(asked).toContain(printDate) // the re-read actually reached Nasdaq

    const merged = second.find(r => r.date === printDate)!
    expect(merged.time).toBe('pre') // FIRST SEEN WINS — the field only a forward read carries
    expect(merged.epsActual).toBe(1.2) // …and the numbers fill in
    expect(merged.surprisePct).toBe(-20) // …parenthesised minus and all: a MISS, not a beat
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
