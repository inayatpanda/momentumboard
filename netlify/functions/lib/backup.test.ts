import { describe, it, expect } from 'vitest'
import { routeBackup } from '../backup.mts'
import { memoryStore } from './store'

const env = { APP_TOKEN: 'app' }
const auth = new Headers({ 'x-app-token': 'app' })

describe('journal backup', () => {
  it('requires the app token (report token is NOT enough — personal data)', async () => {
    const res = await routeBackup('GET', new Headers({ 'x-report-token': 'rep' }), null, env, memoryStore())
    expect(res.status).toBe(401)
  })
  it('stores and returns the full backup with a timestamp', async () => {
    const store = memoryStore()
    const body = JSON.stringify({ trades: [{ id: 't1', symbol: 'AAPL' }], rules: [], watchlist: [], settings: [] })
    expect((await routeBackup('PUT', auth, body, env, store)).status).toBe(200)
    const got = await (await routeBackup('GET', auth, null, env, store)).json()
    expect(got.data.trades[0].symbol).toBe('AAPL')
    expect(got.data.at).toBeGreaterThan(0)
  })
  it('rejects garbage', async () => {
    expect((await routeBackup('PUT', auth, '{"nope":1}', env, memoryStore())).status).toBe(400)
    expect((await routeBackup('PUT', auth, 'not json', env, memoryStore())).status).toBe(400)
  })
})
