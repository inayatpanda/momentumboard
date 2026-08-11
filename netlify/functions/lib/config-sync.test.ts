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

  // The phone's config mirror builds its payload from the local watchlist/rules/
  // notes ONLY — it never carries the engine-only fields. Without a server-side
  // merge, every routine phone sync would wipe the seeded levMap, the risk pin
  // and the favourite channels. These prove the preservation.
  it('phone-style PUT without levMap/override/favourites preserves the stored values', async () => {
    const store = memoryStore()
    await store.write('config', {
      ...goodConfig,
      levMap: { TSLA: { short3x: '3STS.L', long3x: '3LTS.L' } },
      riskRungOverride: 2,
      favouriteChannels: ['Stocks with Josh'],
    })
    // exactly what mirrorConfig() sends: no levMap, no riskRungOverride, no favouriteChannels
    const put = await routeConfig(new URL('http://x/api/config'), 'PUT', headers, JSON.stringify(goodConfig), env, store)
    expect(put.status).toBe(200)
    const body = await (await routeConfig(new URL('http://x/api/config'), 'GET', headers, null, env, store)).json()
    expect(body.data.levMap).toEqual({ TSLA: { short3x: '3STS.L', long3x: '3LTS.L' } })
    expect(body.data.riskRungOverride).toBe(2)
    expect(body.data.favouriteChannels).toEqual(['Stocks with Josh'])
    // the phone's real fields still land
    expect(body.data.watchlist[0].symbol).toBe('AAPL')
  })

  it('explicit levMap in a PUT replaces the stored one', async () => {
    const store = memoryStore()
    await store.write('config', { ...goodConfig, levMap: { TSLA: { short3x: '3STS.L' } } })
    const put = await routeConfig(
      new URL('http://x/api/config'),
      'PUT',
      headers,
      JSON.stringify({ ...goodConfig, levMap: { NVDA: { long3x: '3LNV.L' } } }),
      env,
      store,
    )
    expect(put.status).toBe(200)
    const body = await (await routeConfig(new URL('http://x/api/config'), 'GET', headers, null, env, store)).json()
    expect(body.data.levMap).toEqual({ NVDA: { long3x: '3LNV.L' } })
  })

  it('an explicit riskRungOverride of null clears the stored pin (absent would have preserved)', async () => {
    const store = memoryStore()
    await store.write('config', { ...goodConfig, riskRungOverride: 3 })
    const put = await routeConfig(new URL('http://x/api/config'), 'PUT', headers, JSON.stringify({ ...goodConfig, riskRungOverride: null }), env, store)
    expect(put.status).toBe(200)
    const body = await (await routeConfig(new URL('http://x/api/config'), 'GET', headers, null, env, store)).json()
    expect(body.data.riskRungOverride).toBeNull()
  })

  it('a phone payload without coreSleeve does not wipe the stored coreSleeve', async () => {
    const store = memoryStore()
    await store.write('config', { ...goodConfig, coreSleeve: ['ZZZZ'] })
    // exactly what mirrorConfig() sends: no coreSleeve
    const put = await routeConfig(new URL('http://x/api/config'), 'PUT', headers, JSON.stringify(goodConfig), env, store)
    expect(put.status).toBe(200)
    const body = await (await routeConfig(new URL('http://x/api/config'), 'GET', headers, null, env, store)).json()
    expect(body.data.coreSleeve).toEqual(['ZZZZ'])
  })
})
