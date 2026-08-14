// THE VIEW SLICES (PWA rebuild, plan Task 1+): /api/engine?view=… serves narrow
// projections beside the legacy aggregate. Driven against a REAL sqlite-backed
// D1 and the REAL authenticate() — admin is the APP_TOKEN master, the user is a
// seeded licence — because the auth split (holdingsReads stays admin/house-only)
// is exactly the thing a mocked auth would fake-pass.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqliteD1 } from '../../scripts/lib/sqliteD1'
import { ensureD1Schema } from './lib/d1Store'
import { useBlobStore, useD1Store } from './lib/storeProvider'
import handler from './engine.mts'

const todayLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())

describe('engine ?view= slices', () => {
  let sqlite: ReturnType<typeof openSqliteD1>

  const seed = (key: string, value: unknown) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO blobs (store, key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind('app', key, JSON.stringify(value), Date.now(), null)
      .run()

  const req = (qs = '', token = 'admin-master') =>
    new Request(`https://x/api/engine${qs}`, { headers: { 'x-app-token': token } })

  const body = async (res: Response) => (await res.json()) as { ok: boolean; data: Record<string, unknown> }

  beforeEach(async () => {
    sqlite = openSqliteD1(':memory:')
    await ensureD1Schema(sqlite)
    useD1Store(sqlite)
    process.env.APP_TOKEN = 'admin-master'
    await seed('licences', [{ key: 'user-key-1', label: 'reader', createdAt: 1 }])
  })

  afterEach(() => {
    useBlobStore()
    delete process.env.APP_TOKEN
    sqlite.close()
  })

  it('401s without a token, on views too', async () => {
    const res = await handler(new Request('https://x/api/engine?view=board'))
    expect(res.status).toBe(401)
  })

  it('rejects unknown views with 400', async () => {
    const res = await handler(req('?view=nope'))
    expect(res.status).toBe(400)
  })

  it('?view=board serves only the board slice — no ledger, no predictions', async () => {
    await seed('engine-board', { date: '2026-08-14', regime: 'risk-on', board: [{ sym: 'NVDA', side: 'long' }] })
    await seed('engine-calibration', { buckets: {}, brier: [], referenceBase: 0.41 })
    await seed('risk-state', { rung: 2 })
    await seed('engine-run-status', { phase: 'done', startedAt: 1, updatedAt: 2 })
    await seed('predictions-index', ['2026-08-14'])
    await seed('predictions:2026-08-14', [{ sym: 'SHOULD-NOT-APPEAR' }])

    const r = await body(await handler(req('?view=board')))
    expect(r.ok).toBe(true)
    const data = r.data as { board: { board: { sym: string }[] }; referenceBase: number; riskState: unknown; runStatus: unknown }
    expect(data.board.board[0].sym).toBe('NVDA')
    expect(data.referenceBase).toBe(0.41)
    expect(data.riskState).toEqual({ rung: 2 })
    expect(data.runStatus).toMatchObject({ phase: 'done' })
    const raw = JSON.stringify(r.data)
    expect(raw).not.toContain('SHOULD-NOT-APPEAR')
    expect(r.data).not.toHaveProperty('ledger')
    expect(r.data).not.toHaveProperty('holdingsReads')
  })

  it('?view=board carries the yesterday strip: wins/losses + the day’s top regret (CX-18)', async () => {
    await seed('engine-board', { date: '2026-08-14', board: [] })
    await seed('predictions-index', ['2026-08-12', '2026-08-13'])
    await seed('predictions:2026-08-13', [
      { id: 'w', sym: 'NVDA', side: 'long', outcome10: { excessPct: 4.2, rawPct: 5, spyPct: 0.8, stopped: false, hit: true } },
      { id: 'l', sym: 'COIN', side: 'short', outcome10: { excessPct: -2.0, rawPct: -1, spyPct: 1, stopped: true, hit: false } },
      { id: 'u', sym: 'AMD', side: 'long' }, // ungraded — counts nowhere
    ])
    await seed('miss-ledger', {
      gates: {
        'dead-zone-core': {
          cost: 2,
          costExcessSum: 16,
          examples: [
            { date: '2026-08-13', sym: 'PLTR', side: 'long', excessPct: 6.1, gate: 'dead-zone-core' },
            { date: '2026-08-10', sym: 'STALE', side: 'long', excessPct: 9.9, gate: 'dead-zone-core' }, // not yesterday
          ],
        },
      },
      days: { '2026-08-13': { checked: 3, unchecked: 1, misses: 1 } },
    })
    const r = await body(await handler(req('?view=board')))
    expect(r.data.yesterday).toEqual({
      date: '2026-08-13',
      wins: 1,
      losses: 1,
      // the whole-day census stays for one release; the SPLIT is what the strip reads
      equity: { wins: 1, losses: 1 },
      crypto: null, // no cohort row graded that day — the strip stays single-voiced
      topRegret: { sym: 'PLTR', excessPct: 6.1, gate: 'dead-zone-core' },
    })
  })

  // THE PARTITION, IN THE STRIP (crypto-v2 wave, finding 5). An equity verdict is
  // "beat SPY by ≥1pp over ten sessions"; a cohort verdict is "moved ≥1pp on its
  // own, over fourteen crypto bars". Summed into one "3 wins · 1 loss" they read
  // as one measurement, and a weekend date on which only the coins graded reads
  // as a generic engine result over a market that was shut.
  it('?view=board partitions yesterday’s verdicts by cohort', async () => {
    await seed('engine-board', { date: '2026-08-18', board: [] })
    await seed('predictions-index', ['2026-08-17'])
    await seed('predictions:2026-08-17', [
      { id: 'e1', sym: 'NVDA', side: 'long', outcome10: { excessPct: 4.2, rawPct: 5, spyPct: 0.8, stopped: false, hit: true } },
      { id: 'e2', sym: 'AMD', side: 'long', outcome10: { excessPct: -1.1, rawPct: 0, spyPct: 1.1, stopped: false, hit: false } },
      { id: 'c1', sym: 'BTC-USD', cohort: 'crypto', side: 'long', outcome10: { excessPct: 6.4, rawPct: 6.4, spyPct: 0, stopped: false, hit: true } },
      { id: 'c2', sym: 'ETH-USD', cohort: 'crypto', side: 'short', outcome10: { excessPct: -3.2, rawPct: -3.2, spyPct: 0, stopped: true, hit: false } },
    ])
    const r = await body(await handler(req('?view=board')))
    expect(r.data.yesterday).toMatchObject({
      date: '2026-08-17',
      equity: { wins: 1, losses: 1 },
      crypto: { wins: 1, losses: 1 },
      wins: 2, // the flat census still counts the whole day
      losses: 2,
    })
  })

  it('?view=board reports a crypto-only weekend as crypto, not as a generic result', async () => {
    await seed('engine-board', { date: '2026-08-18', board: [] })
    await seed('predictions-index', ['2026-08-16'])
    await seed('predictions:2026-08-16', [
      { id: 'c1', sym: 'BTC-USD', cohort: 'crypto', side: 'long', outcome10: { excessPct: 2.4, rawPct: 2.4, spyPct: 0, stopped: false, hit: true } },
    ])
    const r = await body(await handler(req('?view=board')))
    expect(r.data.yesterday).toMatchObject({ equity: { wins: 0, losses: 0 }, crypto: { wins: 1, losses: 0 } })
  })

  it('?view=board yesterday is null with no graded history', async () => {
    await seed('engine-board', { date: '2026-08-14', board: [] })
    const r = await body(await handler(req('?view=board')))
    expect(r.data.yesterday).toBeNull()
  })

  it('?view=board keeps the intraday-flags today-only guard', async () => {
    await seed('engine-board', { date: todayLondon(), board: [] })
    await seed('intraday-flags', { date: '2020-01-01', flags: [{ sym: 'OLD' }] })
    const stale = await body(await handler(req('?view=board')))
    expect(stale.data.intradayFlags).toBeNull()

    await seed('intraday-flags', { date: todayLondon(), flags: [{ sym: 'NVDA' }] })
    const fresh = await body(await handler(req('?view=board')))
    expect(fresh.data.intradayFlags).toMatchObject({ date: todayLondon() })
  })

  it('board slice is identical for user-level and admin — nothing privileged rides it', async () => {
    await seed('engine-board', { date: '2026-08-14', board: [{ sym: 'NVDA' }] })
    await seed('holdings-reads', [{ sym: 'SECRET-HOLDING', quantity: 1 }])
    const admin = await body(await handler(req('?view=board')))
    const user = await body(await handler(req('?view=board', 'user-key-1')))
    expect(JSON.stringify(admin.data)).not.toContain('SECRET-HOLDING')
    expect(JSON.stringify(user.data)).not.toContain('SECRET-HOLDING')
    expect(user.data).toEqual(admin.data)
  })

  describe('?view=journey&sym=', () => {
    it('400s on a missing or malformed sym', async () => {
      expect((await handler(req('?view=journey'))).status).toBe(400)
      expect((await handler(req('?view=journey&sym=BAD%20SYM!'))).status).toBe(400)
    })

    it('merges funnel path, past calls, board row and open trace for one name', async () => {
      await seed('funnel-trace-index', ['2026-08-12', '2026-08-13'])
      await seed('funnel-trace:2026-08-13', {
        date: '2026-08-13',
        gates: { deadZone: 0.3 },
        rows: {
          'NVDA:long': { gate: 'entry-chase', side: 'long', core: 0.61, detail: 'ran +3.8% already' },
          'TSLA:short': { gate: 'dead-zone-core', side: 'short', core: 0.2 },
        },
        counts: { notCandidate: 90 },
        nearMisses: [{ sym: 'NVDA', core: 0.61, capUsdM: 3100, lastClose: 128, atrNow: 4, capacityPct: 1, stage: 'S2', factors: { momentum: { score: 1, weight: 2, detail: 'FACTOR-PROSE' } } }],
        emptySides: {},
      })
      await seed('predictions-index', ['2026-08-11'])
      await seed('predictions:2026-08-11', [
        { id: 'p1', date: '2026-08-11', sym: 'NVDA', side: 'long', grade: 'A', composite: 1.4, postMortem: { cls: 'won', detail: 'ran to target', at: 1 }, outcome21: 9.2 },
        { id: 'p2', date: '2026-08-11', sym: 'AMD', side: 'long', grade: 'B', composite: 1.1 },
      ])
      await seed('engine-board', { date: todayLondon(), board: [{ sym: 'NVDA', side: 'long', grade: 'A' }] })
      await seed('open-trace', { date: todayLondon(), generatedAt: 1, entries: [{ sym: 'NVDA', verdict: 'weakening', progressPct: 40 }] })

      const r = await body(await handler(req('?view=journey&sym=NVDA')))
      const d = r.data as {
        sym: string
        boardRow: { sym: string } | null
        openTrace: { verdict: string } | null
        funnel: { date: string; rows: { key: string; gate: string; detail?: string }[]; nearMiss: { factors: Record<string, { score: number }> } | null }[]
        calls: { sym: string; postMortem: { cls: string } | null; outcome21: number | null }[]
      }
      expect(d.sym).toBe('NVDA')
      expect(d.boardRow?.sym).toBe('NVDA')
      expect(d.openTrace?.verdict).toBe('weakening')
      expect(d.funnel).toHaveLength(1) // 2026-08-12 has no trace blob → omitted
      expect(d.funnel[0].date).toBe('2026-08-13')
      expect(d.funnel[0].rows).toHaveLength(1)
      expect(d.funnel[0].rows[0].gate).toBe('entry-chase')
      expect(d.funnel[0].rows[0].detail).toBe('ran +3.8% already') // row detail KEPT
      expect(d.funnel[0].nearMiss?.factors.momentum.score).toBe(1)
      expect(JSON.stringify(d)).not.toContain('FACTOR-PROSE') // near-miss factor prose DROPPED
      expect(JSON.stringify(d)).not.toContain('TSLA')
      expect(d.calls).toHaveLength(1)
      expect(d.calls[0].postMortem?.cls).toBe('won')
      expect(d.calls[0].outcome21).toBe(9.2)
    })

    // D6: every value in these projections comes out of a stored blob, and a
    // blob is not a type. A truncated write or an older schema puts a null
    // where a factor should be, and `f.score` on it threw — surfacing as a 500
    // on the whole page, for one bad field.
    it('survives a corrupt trace: a null factor, a null near miss and a non-array nearMisses', async () => {
      await seed('funnel-trace-index', ['2026-08-12', '2026-08-13'])
      await seed('funnel-trace:2026-08-13', {
        date: '2026-08-13',
        rows: { 'NVDA:long': { gate: 'entry-chase', side: 'long', core: 0.61 } },
        nearMisses: [null, { sym: 'NVDA', core: 0.61, factors: { momentum: null, technical: { score: 2, detail: 'x' } } }],
      })
      await seed('funnel-trace:2026-08-12', { date: '2026-08-12', rows: {}, nearMisses: 'not-an-array' })

      const journey = await handler(req('?view=journey&sym=NVDA'))
      expect(journey.status).toBe(200)
      const d = (await body(journey)).data as { funnel: { nearMiss: { factors: Record<string, { score: number | null }> } | null }[] }
      expect(d.funnel[0].nearMiss?.factors.momentum.score).toBeNull() // the field is lost, the page is not
      expect(d.funnel[0].nearMiss?.factors.technical.score).toBe(2)

      const funnel = await handler(req('?view=funnel&date=2026-08-12'))
      expect(funnel.status).toBe(200)
      expect(((await body(funnel)).data as { nearMisses: unknown[] }).nearMisses).toEqual([])
    })

    it('uppercases the sym and answers an unseen name with an empty journey', async () => {
      const r = await body(await handler(req('?view=journey&sym=zzq')))
      expect(r.ok).toBe(true)
      expect(r.data).toMatchObject({ sym: 'ZZQ', boardRow: null, openTrace: null, funnel: [], calls: [] })
    })

    it('widens the calls window on ?days= — the full retained index is reachable (CX-16)', async () => {
      const dates = Array.from({ length: 40 }, (_, i) => `2026-06-${String((i % 30) + 1).padStart(2, '0')}x${i}`.slice(0, 10)).map((_, i) => {
        const d = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000)
        return d.toISOString().slice(0, 10)
      })
      await seed('predictions-index', dates)
      await seed(`predictions:${dates[2]}`, [{ id: 'old', date: dates[2], sym: 'NVDA', side: 'long' }])
      const dflt = await body(await handler(req('?view=journey&sym=NVDA')))
      expect((dflt.data as { calls: unknown[] }).calls).toHaveLength(0) // outside the default 30
      const wide = await body(await handler(req('?view=journey&sym=NVDA&days=250')))
      expect((wide.data as { calls: { id: string }[] }).calls.map(c => c.id)).toEqual(['old'])
    })

    it('reads only the last 10 trace days', async () => {
      const dates = Array.from({ length: 12 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`)
      await seed('funnel-trace-index', dates)
      await seed('funnel-trace:2026-07-01', { date: '2026-07-01', gates: {}, rows: { NVDA: { gate: 'no-candles' } }, counts: { notCandidate: 0 }, nearMisses: [], emptySides: {} })
      await seed('funnel-trace:2026-07-12', { date: '2026-07-12', gates: {}, rows: { NVDA: { gate: 'trimmed' } }, counts: { notCandidate: 0 }, nearMisses: [], emptySides: {} })
      const r = await body(await handler(req('?view=journey&sym=NVDA')))
      const d = r.data as { funnel: { date: string }[] }
      expect(d.funnel.map(f => f.date)).toEqual(['2026-07-12']) // -01 fell outside the 10-day window
    })
  })

  describe('?view=ledger', () => {
    const seedDays = async () => {
      await seed('predictions-index', ['2026-08-11', '2026-08-12', '2026-08-13'])
      await seed('predictions:2026-08-11', [{ id: 'p11', date: '2026-08-11', sym: 'OLD', side: 'long' }])
      await seed('predictions:2026-08-12', [{ id: 'p12', date: '2026-08-12', sym: 'AMD', side: 'long' }])
      await seed('predictions:2026-08-13', [
        { id: 'p13', date: '2026-08-13', sym: 'NVDA', side: 'long', postMortem: { cls: 'market-drag', detail: 'tape rolled over', at: 1 }, outcome21: -3.1 },
      ])
    }

    it('serves the last N days newest-first, rows carrying postMortem + outcome21', async () => {
      await seedDays()
      const r = await body(await handler(req('?view=ledger&days=2')))
      const d = r.data as { days: { date: string; predictions: { sym: string; postMortem: { cls: string } | null; outcome21: number | null }[] }[] }
      expect(d.days.map(x => x.date)).toEqual(['2026-08-13', '2026-08-12'])
      expect(JSON.stringify(d)).not.toContain('OLD')
      expect(d.days[0].predictions[0].postMortem?.cls).toBe('market-drag')
      expect(d.days[0].predictions[0].outcome21).toBe(-3.1)
    })

    it('clamps days to at least 1 and defaults to 7', async () => {
      await seedDays()
      const zero = await body(await handler(req('?view=ledger&days=0')))
      expect((zero.data as { days: unknown[] }).days).toHaveLength(1)
      const dflt = await body(await handler(req('?view=ledger')))
      expect((dflt.data as { days: unknown[] }).days).toHaveLength(3) // only 3 seeded, default window is 7
    })

    // THE GRADE LAW OUTLIVES THE BOARD (Task 17 review, I4). A watch-only row
    // and a below-base row were never sized, so they never earned a letter —
    // and the projection dropped both flags, which meant a reader's history
    // showed them with a grade pill the day after they aged off the board.
    it('carries watchOnly and belowBase, so a never-sized row stays never-sized in history', async () => {
      await seed('predictions-index', ['2026-08-13'])
      await seed('predictions:2026-08-13', [
        { id: 'w', date: '2026-08-13', sym: 'WATCH', side: 'long', grade: 'B', watchOnly: true },
        { id: 'b', date: '2026-08-13', sym: 'UNDER', side: 'long', grade: 'C', belowBase: true },
        { id: 's', date: '2026-08-13', sym: 'SIZED', side: 'long', grade: 'A' },
      ])
      const r = await body(await handler(req('?view=ledger&days=1')))
      const rows = (r.data as { days: { predictions: { sym: string; watchOnly: boolean; belowBase: boolean }[] }[] }).days[0].predictions
      const bySym = Object.fromEntries(rows.map(p => [p.sym, p]))
      expect(bySym.WATCH).toMatchObject({ watchOnly: true, belowBase: false })
      expect(bySym.UNDER).toMatchObject({ watchOnly: false, belowBase: true })
      // …and a row with neither flag says so explicitly, rather than going absent
      expect(bySym.SIZED).toMatchObject({ watchOnly: false, belowBase: false })
    })

    it('the legacy aggregate ledger rows now carry postMortem too (same projection)', async () => {
      await seedDays()
      const r = await body(await handler(req()))
      const ledger = r.data.ledger as { date: string; predictions: { postMortem?: { cls: string } | null }[] }[]
      const day13 = ledger.find(x => x.date === '2026-08-13')
      expect(day13?.predictions[0].postMortem?.cls).toBe('market-drag')
    })
  })

  describe('?view=funnel', () => {
    it('splits refusals from published rows; refusals rank by |core| desc, nulls last; near-miss prose stripped', async () => {
      await seed('funnel-trace-index', ['2026-08-12', '2026-08-13'])
      await seed('funnel-trace:2026-08-13', {
        date: '2026-08-13',
        gates: { deadZone: 0.3 },
        rows: {
          'AAA:long': { gate: 'diversity', side: 'long', core: 22 },
          BBB: { gate: 'no-candles' },
          // a strong SHORT refusal: signed core NEGATIVE, conviction highest (CX-2)
          'CCC:short': { gate: 'slot-cut', side: 'short', core: -31 },
          // a PUBLISHED row must never appear among the refusals (CX-1)
          'EEE:long': { gate: 'called-full', side: 'long', core: 40 },
        },
        counts: { notCandidate: 42 },
        nearMisses: [{ sym: 'DDD', core: 0.5, capUsdM: null, lastClose: 10, atrNow: 1, capacityPct: null, stage: null, factors: { momentum: { score: 2, detail: 'NM-PROSE' } } }],
        emptySides: { short: 'no-candidates' },
      })
      const r = await body(await handler(req('?view=funnel')))
      const d = r.data as { date: string; refusals: { key: string }[]; published: { key: string; gate: string }[]; nearMisses: unknown[]; counts: { notCandidate: number }; gates: { deadZone: number }; emptySides: { short: string } }
      expect(d.date).toBe('2026-08-13')
      expect(d.refusals.map(x => x.key)).toEqual(['CCC:short', 'AAA:long', 'BBB'])
      expect(d.published).toEqual([{ key: 'EEE:long', gate: 'called-full', side: 'long', core: 40 }])
      expect(d.counts.notCandidate).toBe(42)
      expect(d.gates.deadZone).toBe(0.3)
      expect(d.emptySides.short).toBe('no-candidates')
      expect(d.nearMisses).toHaveLength(1)
      expect(JSON.stringify(d)).not.toContain('NM-PROSE')
    })

    it('honours ?date=, 400s a malformed one, and flags a day with no trace', async () => {
      await seed('funnel-trace-index', ['2026-08-12', '2026-08-13'])
      expect((await handler(req('?view=funnel&date=13-08-2026'))).status).toBe(400)
      const r = await body(await handler(req('?view=funnel&date=2026-08-12')))
      expect(r.ok).toBe(true)
      expect(r.data).toMatchObject({ date: '2026-08-12', missing: true, refusals: [], published: [], nearMisses: [] })
    })
  })

  describe('?view=learning', () => {
    it('serves structured gates, regret examples, and the aggregate’s own projections of weights/scorecard/roster', async () => {
      await seed('gate-state', { gates: { deadZone: { delta: -2.5, history: [{ date: '2026-08-01', from: 25, to: 22.5, why: 'earned' }] } } })
      await seed('miss-ledger', {
        gates: { 'dead-zone-core': { cost: 2, costExcessSum: 15.3, saved: 1, unchecked: 3, examples: [{ date: '2026-08-04', sym: 'PLTR', side: 'long', excessPct: 6.1, gate: 'dead-zone-core' }] } },
        days: { '2026-08-10': { checked: 5, unchecked: 3, misses: 2 } },
      })
      await seed('engine-weights', { base: { momentum: 2 }, current: { momentum: 2.2 }, history: Array.from({ length: 15 }, (_, i) => ({ at: i })) })
      await seed('engine-scorecard', { byGrade: { A: { n: 3 }, wildcard: { n: 1 } } })
      await seed('engine-roster', [{ sym: 'NVDA' }])
      await seed('engine-roster-log', [{ date: '2026-08-13', joined: ['NVDA'], dropped: [] }])
      await seed('channel-credibility', { yt1: { graded: 4, hits: 2, sumExcess: 8 } })
      await seed('engine-calibration', { buckets: { 'long:risk-on:high': { n: 5 } }, brier: [0.2], referenceBase: 0.41 })

      const r = await body(await handler(req('?view=learning')))
      const d = r.data as {
        gateState: { gates: { gate: string; current: number; history: unknown[] }[] }
        gateLines: { moves: string[] } | null
        regrets: { topGates: { gate: string; examples: { sym: string }[] }[]; note: string } | null
        weights: { history: unknown[] }
        scorecard: { byGrade: Record<string, unknown> }
        roster: { entries: unknown[]; changes: unknown[] }
        channelCred: Record<string, { graded: number; avgExcess: number | null }>
        calibration: { referenceBase: number | null }
      }
      expect(d.gateState.gates).toHaveLength(3)
      expect(d.gateState.gates.find(g => g.gate === 'deadZone')?.history).toHaveLength(1)
      expect(d.gateLines?.moves.length).toBeGreaterThan(0)
      expect(d.regrets?.topGates[0].examples[0].sym).toBe('PLTR')
      expect(d.regrets?.note).toContain('unpriced')
      expect(d.weights.history).toHaveLength(10) // same slice(-10) the aggregate applies
      expect(d.scorecard.byGrade).toHaveProperty('wildcard')
      expect(d.roster.entries).toHaveLength(1)
      expect(d.channelCred.yt1.avgExcess).toBe(2)
      expect(d.calibration.referenceBase).toBe(0.41)
      expect(r.data).not.toHaveProperty('holdingsReads')
      expect(r.data).not.toHaveProperty('ledger')
    })

    // THE COHORT'S OWN PANE (crypto-v2 wave, finding 4). `engine-scorecard` and
    // `engine-calibration` are the EQUITY partition's — the grading pass keeps
    // every crypto row out of both, on purpose — so a learning slice that serves
    // only those two hands the app a record with a cohort silently missing from
    // it. The partition's own two blobs travel beside them, never inside them.
    it('serves the crypto partition’s own calibration and rung, beside the equity ones', async () => {
      await seed('engine-calibration', { buckets: { 'long:risk-on:high': { n: 5, hits: 3 } }, brier: [0.2], referenceBase: 0.41, defVersion: 3 })
      await seed('crypto-calibration', {
        basis: 'absolute',
        defVersion: 3,
        buckets: { 'long:green:55-70': { n: 12, hits: 7 } },
        brier: [0.24],
        seeded: false,
        seedGeneration: 0,
        evidence: { seed: { n: 0, hits: 0 }, live: { n: 12, hits: 7 }, shadow: { n: 0, hits: 0 } },
      })
      await seed('crypto-risk', { rung: 1, sinceDate: '2026-08-01', gradedAtRung: 12, history: [] })

      const r = await body(await handler(req('?view=learning')))
      const d = r.data as {
        calibration: { referenceBase: number | null }
        crypto: { gradedN: number; coldStartN: number; rung: number | null; gradedAtRung: number | null; calibration: { basis: string; buckets: Record<string, unknown>; referenceBase: number | null } | null } | null
      }
      // the equity blob is untouched by the new field
      expect(d.calibration.referenceBase).toBe(0.41)
      expect(d.crypto).not.toBeNull()
      expect(d.crypto!.gradedN).toBe(12) // the same count the row's own voice quotes
      expect(d.crypto!.coldStartN).toBe(50)
      expect(d.crypto!.rung).toBe(1)
      expect(d.crypto!.gradedAtRung).toBe(12)
      expect(d.crypto!.calibration!.basis).toBe('absolute')
      expect(d.crypto!.calibration!.buckets).toHaveProperty('long:green:55-70')
      // there is no crypto reference sweep, and the equity 0.4158 may never leak in
      expect(d.crypto!.calibration!.referenceBase).toBeNull()
    })

    it('serves crypto: null when the partition has never moved', async () => {
      await seed('engine-calibration', { buckets: {}, brier: [], defVersion: 3 })
      const r = await body(await handler(req('?view=learning')))
      expect((r.data as { crypto: unknown }).crypto).toBeNull()
    })

    it('reads a mis-keyed equity blob under the crypto key as COLD, never as the cohort’s record', async () => {
      // no `basis` brand → loadCryptoCalibration goes cold (cryptoCalibration.ts)
      await seed('crypto-calibration', { defVersion: 3, buckets: { 'long:risk-on:high': { n: 8500, hits: 3500 } }, brier: [] })
      const r = await body(await handler(req('?view=learning')))
      const c = (r.data as { crypto: { gradedN: number; calibration: { buckets: Record<string, unknown> } | null } | null }).crypto
      expect(c!.gradedN).toBe(0)
      expect(c!.calibration!.buckets).toEqual({})
    })
  })

  describe('?view=verdict&sym=', () => {
    const candleFix = (n = 60, gain = 0.6) =>
      Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000 + i * 86_400, o: 100 + i * gain - 0.3, h: 100 + i * gain + 0.8, l: 100 + i * gain - 0.9, c: 100 + i * gain, v: 1_000_000 }))

    it('answers from cached candles, never mints a grade, and caches the verdict for 15 min', async () => {
      const { setCached } = await import('./lib/cache')
      await setCached('candles:ZAP:1y', { candles: candleFix(60, 0.6) }, 900)
      await setCached('candles:SPY:1y', { candles: candleFix(60, 0) }, 900)
      // Momentum-only weights: a monotonic synthetic rise legitimately reads
      // 'exhausted' to technicalStage, so the technical factor would argue
      // short — the fixture only controls relative strength, so only RS votes.
      await seed('engine-weights', { base: { momentum: 2 }, current: { momentum: 2 }, history: [] })
      await seed('engine-board', { date: '2026-08-14', regime: 'green', board: [] })

      const first = await body(await handler(req('?view=verdict&sym=zap')))
      const v = first.data as { sym: string; onDemand: boolean; lean: string; nulls: string[]; note: string }
      expect(v.sym).toBe('ZAP')
      expect(v.onDemand).toBe(true)
      expect(v.lean).toBe('long')
      expect(v.nulls).toContain('news')
      expect(v.note).toContain('not one of today’s calls')
      expect(first.data).not.toHaveProperty('grade')
      expect(first.data).not.toHaveProperty('probability')

      // Mutate the tape: a cached verdict must NOT recompute inside its TTL.
      await setCached('candles:ZAP:1y', { candles: candleFix(60, -0.6) }, 900)
      const second = await body(await handler(req('?view=verdict&sym=ZAP')))
      expect(second.data).toEqual(first.data)

      // …and nothing was ever written into the predictions record.
      const rows = sqlite.prepare("SELECT key FROM blobs WHERE store='app' AND key LIKE 'predictions:%'").all<{ key: string }>()
      expect((await rows).results ?? []).toHaveLength(0)

      // B4: the verdict cache belongs to the CACHE store, where rows carry a TTL
      // and the sweep can collect them — never the durable app store, which
      // would keep a permanent row per symbol any reader ever asked about.
      const cached = await sqlite.prepare("SELECT key, expires_at FROM blobs WHERE store='cache' AND key LIKE 'verdict-cache:%'").all<{ key: string; expires_at: number | null }>()
      expect((cached.results ?? []).map(r => r.key)).toEqual(['verdict-cache:ZAP'])
      expect(cached.results![0].expires_at).toBeGreaterThan(Date.now())
      const durable = await sqlite.prepare("SELECT key FROM blobs WHERE store='app' AND key LIKE 'verdict-cache:%'").all<{ key: string }>()
      expect(durable.results ?? []).toHaveLength(0)
    })

    // FINDING 1: this view's arithmetic is the equity engine's — equity windows,
    // momentum vs SPY, equity weights, the board's equity regime. Over a coin it
    // would publish a lean in VerdictHero that no partition ever measured.
    it('contains a crypto pair instead of publishing an equity lean on it', async () => {
      await seed('engine-weights', { base: { momentum: 2 }, current: { momentum: 2 }, history: [] })
      await seed('engine-board', { date: '2026-08-14', regime: 'green', board: [] })
      const r = await body(await handler(req('?view=verdict&sym=btc-usd')))
      const v = r.data as { sym: string; contained?: true; unavailable?: true; lean: string; core: number | null; note: string }
      expect(v.sym).toBe('BTC-USD')
      expect(v.contained).toBe(true)
      expect(v.unavailable).toBeUndefined()
      expect(v.lean).toBe('none')
      expect(v.core).toBeNull()
      expect(v.note).toMatch(/crypto lane/i)
      // contained BEFORE any work: no verdict cache entry (B4 moved it to the
      // cache store — check there, and in the durable one for good measure), no
      // candle fetch
      const rows = await sqlite.prepare("SELECT key FROM blobs WHERE key LIKE 'verdict-cache:%'").all<{ key: string }>()
      expect(rows.results ?? []).toHaveLength(0)
    })

    it('400s a malformed sym and reports unavailable when no tape can be fetched', async () => {
      expect((await handler(req('?view=verdict&sym='))).status).toBe(400)
      const realFetch = globalThis.fetch
      globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
      try {
        const r = await body(await handler(req('?view=verdict&sym=NOPE')))
        expect(r.ok).toBe(true)
        expect(r.data).toMatchObject({ sym: 'NOPE', unavailable: true })
      } finally {
        globalThis.fetch = realFetch
      }
    })
  })

  it('legacy aggregate still serves without ?view — and keeps its admin gate', async () => {
    await seed('engine-board', { date: '2026-08-14', board: [] })
    await seed('holdings-reads', [{ sym: 'SECRET-HOLDING', quantity: 1 }])
    const admin = await body(await handler(req()))
    expect(admin.data).toHaveProperty('ledger')
    expect(admin.data).toHaveProperty('missLedger')
    expect(JSON.stringify(admin.data.holdingsReads)).toContain('SECRET-HOLDING')

    const user = await body(await handler(req('', 'user-key-1')))
    expect(user.data.holdingsReads).toBeNull()
  })
})
