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
