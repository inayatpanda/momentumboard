import { describe, it, expect } from 'vitest'
import { routeExport } from '../helm-export.mts'
import { memoryStore } from './store'

const env = { APP_TOKEN: 'app', REPORT_TOKEN: 'rep' }

async function seed() {
  const store = memoryStore()
  await store.write('composed-history', [
    { date: '2026-07-01', headline: 'Old', standfirst: 's', regime: 'amber', ideas: [] },
    { date: '2026-07-02', headline: 'Latest', standfirst: 'today', regime: 'green', ideas: [{ ticker: 'MS', side: 'long' }] },
  ])
  await store.write('pick-stats', { scores: [{ bucket: 'ALL', n: 3 }], reports: 3 })
  await store.write('report-index', ['2026-07-01', '2026-07-02'])
  await store.write('report:2026-07-01', { html: '<p>old</p>', at: 1_000 })
  await store.write('report:2026-07-02', { html: '<p>new</p>', at: 5_000 })
  await store.write('report-picks', [
    { date: '2026-07-01', at: 1_000, picks: [{ ticker: 'X', side: 'long' }] },
    { date: '2026-07-02', at: 5_000, picks: [{ ticker: 'MS', side: 'long', priceAtPick: 110 }] },
  ])
  await store.write('event-dossiers', [{ kind: 'shock', name: 'Oil', assessment: 'up', at: 5_000 }])
  await store.write('journal-backup', {
    trades: [{ id: 't1', symbol: 'MS', side: 'long' }],
    rules: [],
    watchlist: [],
    settings: {},
    at: 5_000,
  })
  await store.write('config', {
    watchlist: [{ symbol: 'MS' }],
    capital: 5000,
    notes: [{ id: 'n1', kind: 'observation', text: 'buy the dip not the chase' }],
  })
  return store
}

describe('routeExport', () => {
  it('rejects without a valid token', async () => {
    const store = await seed()
    const res = await routeExport(new URL('http://x/api/export'), new Headers({ 'x-report-token': 'nope' }), env, store)
    expect(res.status).toBe(401)
  })

  // a blank HELM_EXPORT_TOKEN means "not cut over yet", not "no auth"
  it('still accepts REPORT_TOKEN when the scoped token is present but blank', async () => {
    const store = await seed()
    const blank = { ...env, HELM_EXPORT_TOKEN: '' }
    const res = await routeExport(new URL('http://x/api/export?summary=1'), new Headers({ 'x-report-token': 'rep' }), blank, store)
    expect(res.status).toBe(200)
  })

  it('summary mode returns the dashboard card without heavy html', async () => {
    const store = await seed()
    const res = await routeExport(new URL('http://x/api/export?summary=1'), new Headers({ 'x-report-token': 'rep' }), env, store)
    const body = await res.json()
    expect(body.data.summary.latestEdition.headline).toBe('Latest')
    expect(body.data.summary.latestEdition.regime).toBe('green')
    expect(body.data.summary.scorecard.reports).toBe(3)
    expect(body.data.editions).toBeUndefined() // summary omits editions
  })

  it('since watermark returns only newer editions/picks/events', async () => {
    const store = await seed()
    const res = await routeExport(new URL('http://x/api/export?since=2000'), new Headers({ 'x-app-token': 'app' }), env, store)
    const body = await res.json()
    expect(body.data.editions.map((e: { date: string }) => e.date)).toEqual(['2026-07-02'])
    expect(body.data.picks.map((p: { date: string }) => p.date)).toEqual(['2026-07-02'])
    expect(body.data.events).toHaveLength(1)
    expect(typeof body.data.now).toBe('number')
  })

  it('full snapshot (no since) returns all editions', async () => {
    const store = await seed()
    const res = await routeExport(new URL('http://x/api/export'), new Headers({ 'x-report-token': 'rep' }), env, store)
    const body = await res.json()
    expect(body.data.editions).toHaveLength(2)
  })

  it('includes trades (when the journal changed), notes, and a notes-stripped config doc', async () => {
    const store = await seed()
    const res = await routeExport(new URL('http://x/api/export?since=2000'), new Headers({ 'x-app-token': 'app' }), env, store)
    const body = await res.json()
    expect(body.data.trades.map((t: { id: string }) => t.id)).toEqual(['t1']) // backup.at 5000 > 2000
    expect(body.data.notes.map((n: { id: string }) => n.id)).toEqual(['n1'])
    expect(body.data.config.capital).toBe(5000)
    expect(body.data.config.notes).toBeUndefined() // notes split into their own collection
  })

  it('omits trades when the journal has not changed since the watermark; notes/config still ride along', async () => {
    const store = await seed()
    const res = await routeExport(new URL('http://x/api/export?since=9000'), new Headers({ 'x-app-token': 'app' }), env, store)
    const body = await res.json()
    expect(body.data.trades).toEqual([]) // backup.at 5000 <= 9000
    expect(body.data.notes).toHaveLength(1)
    expect(body.data.config.capital).toBe(5000)
  })
})
