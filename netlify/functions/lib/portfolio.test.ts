import { describe, it, expect } from 'vitest'
import { routePortfolio } from '../portfolio.mts'
import { memoryStore } from './store'

const env = { APP_TOKEN: 'app', REPORT_TOKEN: 'rep' }
const snapshot = JSON.stringify({ capital: 5000, openPositions: [{ symbol: 'AAPL' }], stats: {} })

describe('portfolio endpoint', () => {
  it('PUT requires the app token; report token is read-only', async () => {
    const store = memoryStore()
    expect((await routePortfolio('PUT', new Headers({ 'x-report-token': 'rep' }), snapshot, env, store)).status).toBe(401)
    expect((await routePortfolio('PUT', new Headers({ 'x-app-token': 'app' }), snapshot, env, store)).status).toBe(200)
  })
  it('GET works with either token and returns the snapshot with a timestamp', async () => {
    const store = memoryStore()
    await routePortfolio('PUT', new Headers({ 'x-app-token': 'app' }), snapshot, env, store)
    const res = await routePortfolio('GET', new Headers({ 'x-report-token': 'rep' }), null, env, store)
    const body = await res.json()
    expect(body.data.openPositions[0].symbol).toBe('AAPL')
    expect(body.data.at).toBeGreaterThan(0)
    expect((await routePortfolio('GET', new Headers(), null, env, store)).status).toBe(401)
  })
  it('rejects malformed snapshots', async () => {
    expect((await routePortfolio('PUT', new Headers({ 'x-app-token': 'app' }), '{"nope":1}', env, memoryStore())).status).toBe(400)
  })
})
