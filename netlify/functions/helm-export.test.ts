import { describe, it, expect } from 'vitest'
import { routeExport } from './helm-export.mts'
import { memoryStore } from './lib/store'

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
  return store
}

describe('routeExport', () => {
  it('rejects without a valid token', async () => {
    const store = await seed()
    const res = await routeExport(new URL('http://x/api/export'), new Headers({ 'x-report-token': 'nope' }), env, store)
    expect(res.status).toBe(401)
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
})
