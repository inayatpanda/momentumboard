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
    expect((await routeBackup('PUT', auth, 'null', env, memoryStore())).status).toBe(400)
  })
  it('never stores credentials or unknown settings from older clients', async () => {
    const store = memoryStore()
    const settings = [{ key: 'groqApiKey', value: 'test-secret' }, { key: 'futureApiKey', value: 'future-secret' }, { key: 'capital', value: '5000', extra: 'secret' }]
    await routeBackup('PUT', auth, JSON.stringify({ trades: [], settings, token: 'also-secret' }), env, store)
    const saved = await store.read<any>('journal-backup')
    expect(saved.settings).toEqual([{ key: 'capital', value: '5000' }])
    expect(JSON.stringify(saved)).not.toContain('secret')
  })
  it('scrubs previously stored credentials before returning or restoring a backup', async () => {
    const store = memoryStore()
    await store.write('journal-backup', { trades: [], settings: [{ key: 'groqApiKey', value: 'old-secret' }, { key: 'capital', value: '7000' }], at: 123 })
    const got = await (await routeBackup('GET', auth, null, env, store)).json()
    expect(got.data.settings).toEqual([{ key: 'capital', value: '7000' }])
    expect(got.data.at).toBe(123)
    expect(JSON.stringify(await store.read('journal-backup'))).not.toContain('old-secret')
  })
})
