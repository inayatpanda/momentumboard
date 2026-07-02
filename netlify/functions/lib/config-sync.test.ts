import { describe, it, expect } from 'vitest'
import { routeConfig } from '../config-sync.mts'
import { memoryStore } from './store'

const env = { APP_TOKEN: 'secret' }
const headers = new Headers({ 'x-app-token': 'secret' })
const goodConfig = {
  watchlist: [{ symbol: 'AAPL', riskClass: 'normal' }],
  rules: [{ id: 'r1', symbol: 'AAPL', kind: 'priceAbove', level: 300 }],
  ytChannels: [{ id: 'UC1', name: 'Josh' }],
  capital: 5000,
}

describe('config-sync', () => {
  it('rejects without token', async () => {
    const res = await routeConfig(new URL('http://x/api/config'), 'GET', new Headers(), null, env, memoryStore())
    expect(res.status).toBe(401)
  })
  it('PUT validates and GET returns what was stored', async () => {
    const store = memoryStore()
    const put = await routeConfig(new URL('http://x/api/config'), 'PUT', headers, JSON.stringify(goodConfig), env, store)
    expect(put.status).toBe(200)
    const get = await routeConfig(new URL('http://x/api/config'), 'GET', headers, null, env, store)
    const body = await get.json()
    expect(body.data.watchlist[0].symbol).toBe('AAPL')
    expect(body.data.rules).toHaveLength(1)
  })
  it('rejects malformed config', async () => {
    const res = await routeConfig(new URL('http://x/api/config'), 'PUT', headers, JSON.stringify({ watchlist: 'nope' }), env, memoryStore())
    expect(res.status).toBe(400)
  })
  it('serves the runlog view', async () => {
    const store = memoryStore()
    await store.write('runlog', [{ at: 1, events: 2 }])
    const res = await routeConfig(new URL('http://x/api/config?view=runlog'), 'GET', headers, null, env, store)
    expect((await res.json()).data).toEqual([{ at: 1, events: 2 }])
  })
})
