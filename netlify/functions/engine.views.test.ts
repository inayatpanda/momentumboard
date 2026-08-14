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

    it('uppercases the sym and answers an unseen name with an empty journey', async () => {
      const r = await body(await handler(req('?view=journey&sym=zzq')))
      expect(r.ok).toBe(true)
      expect(r.data).toMatchObject({ sym: 'ZZQ', boardRow: null, openTrace: null, funnel: [], calls: [] })
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

    it('the legacy aggregate ledger rows now carry postMortem too (same projection)', async () => {
      await seedDays()
      const r = await body(await handler(req()))
      const ledger = r.data.ledger as { date: string; predictions: { postMortem?: { cls: string } | null }[] }[]
      const day13 = ledger.find(x => x.date === '2026-08-13')
      expect(day13?.predictions[0].postMortem?.cls).toBe('market-drag')
    })
  })

  describe('?view=funnel', () => {
    it('defaults to the newest trace day; rows ranked by core desc, nulls last; near-miss prose stripped', async () => {
      await seed('funnel-trace-index', ['2026-08-12', '2026-08-13'])
      await seed('funnel-trace:2026-08-13', {
        date: '2026-08-13',
        gates: { deadZone: 0.3 },
        rows: {
          'AAA:long': { gate: 'diversity', side: 'long', core: 0.3 },
          BBB: { gate: 'no-candles' },
          'CCC:short': { gate: 'slot-cut', side: 'short', core: 0.9 },
        },
        counts: { notCandidate: 42 },
        nearMisses: [{ sym: 'DDD', core: 0.5, capUsdM: null, lastClose: 10, atrNow: 1, capacityPct: null, stage: null, factors: { momentum: { score: 2, detail: 'NM-PROSE' } } }],
        emptySides: { short: 'no-candidates' },
      })
      const r = await body(await handler(req('?view=funnel')))
      const d = r.data as { date: string; rows: { key: string; core?: number }[]; nearMisses: unknown[]; counts: { notCandidate: number }; gates: { deadZone: number }; emptySides: { short: string } }
      expect(d.date).toBe('2026-08-13')
      expect(d.rows.map(x => x.key)).toEqual(['CCC:short', 'AAA:long', 'BBB'])
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
      expect(r.data).toMatchObject({ date: '2026-08-12', missing: true, rows: [], nearMisses: [] })
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
