import { describe, expect, it } from 'vitest'
import { routeT212 } from '../t212.mts'
import type { AppStore } from './store'
import type { T212Position } from './t212lib'

const POS: T212Position[] = [{ symbol: 'AAPL', rawTicker: 'AAPL_US_EQ', quantity: 1, averagePrice: 100, currentPrice: 110, pplPct: 10 }]
const ENV = { APP_TOKEN: 'admin-secret', T212_API_KEY: 'env-key', T212_SECRET_KEY: 'env-sec' }

function harness() {
  const blobs = new Map<string, unknown>([
    ['licences', [{ key: 'lic-a', label: 'A', createdAt: 1 }, { key: 'lic-b', label: 'B', createdAt: 1 }]],
  ])
  const store = {
    read: async <T>(k: string) => (blobs.get(k) as T) ?? null,
    write: async (k: string, v: unknown) => void blobs.set(k, v),
  } as unknown as AppStore
  const cache = new Map<string, unknown>()
  const fetchedWith: string[] = []
  const deps = {
    // accepts only the keys 'good-key' and 'env-key' — everything else is "rejected by T212"
    fetchPositions: async (env: { T212_API_KEY?: string }) => {
      fetchedWith.push(env.T212_API_KEY ?? '')
      return env.T212_API_KEY === 'good-key' || env.T212_API_KEY === 'env-key' ? POS : null
    },
    cacheGet: async <T>(k: string) => (cache.get(k) as T) ?? null,
    cacheSet: async (k: string, v: unknown) => void cache.set(k, v),
  }
  const call = (token: string, method = 'GET', path = '/api/t212', body?: unknown) =>
    routeT212(
      new Request(`https://x.test${path}`, {
        method,
        headers: { 'x-app-token': token },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      ENV,
      store,
      deps,
    )
  return { blobs, cache, fetchedWith, call }
}

describe('routeT212 — BYO keys with namespace isolation', () => {
  it('rejects unauthenticated callers', async () => {
    const { call } = harness()
    expect((await call('nope')).status).toBe(401)
  })

  it('admin uses the env pair and the legacy unprefixed cache key', async () => {
    const { call, cache, fetchedWith } = harness()
    const res = await call('admin-secret')
    const body = (await res.json()) as { data: { positions: unknown[] } }
    expect(body.data.positions).toHaveLength(1)
    expect(fetchedWith).toEqual(['env-key'])
    expect(cache.has('t212-portfolio')).toBe(true)
    expect((await call('admin-secret', 'PUT', '/api/t212', { apiKey: 'good-key' })).status).toBe(400) // env-configured
  })

  it('a licensee starts unconfigured and can NOT see the owner portfolio', async () => {
    const { call, fetchedWith } = harness()
    const body = (await (await call('lic-a')).json()) as { data: { unconfigured?: boolean } }
    expect(body.data.unconfigured).toBe(true)
    expect(fetchedWith).toHaveLength(0) // the env key was never used for a licensee
  })

  it('PUT validates against T212 before storing; a rejected key stores nothing', async () => {
    const { call, blobs } = harness()
    expect((await call('lic-a', 'PUT', '/api/t212', { apiKey: 'bad-key' })).status).toBe(400)
    expect([...blobs.keys()].some(k => k.includes('t212'))).toBe(false)
    expect((await call('lic-a', 'PUT', '/api/t212', { apiKey: 'good-key', secret: 's' })).status).toBe(200)
    const stored = [...blobs.entries()].find(([k]) => k.startsWith('u:') && k.endsWith('t212'))
    expect(stored?.[1]).toMatchObject({ apiKey: 'good-key', secret: 's' })
  })

  it('after connecting, the licensee reads THEIR portfolio via THEIR key, ns-cached — and another licensee sees nothing', async () => {
    const { call, cache, fetchedWith } = harness()
    await call('lic-a', 'PUT', '/api/t212', { apiKey: 'good-key' })
    const a = (await (await call('lic-a')).json()) as { data: { positions?: unknown[] } }
    expect(a.data.positions).toHaveLength(1)
    expect(fetchedWith).not.toContain('env-key')
    const nsKeys = [...cache.keys()].filter(k => k.includes('t212-portfolio'))
    expect(nsKeys.every(k => k.startsWith('u:'))).toBe(true) // never the shared/global cache slot
    const b = (await (await call('lic-b')).json()) as { data: { unconfigured?: boolean } }
    expect(b.data.unconfigured).toBe(true) // no bleed between namespaces
  })

  it('view=key reports status without echoing keys; DELETE disconnects', async () => {
    const { call } = harness()
    await call('lic-a', 'PUT', '/api/t212', { apiKey: 'good-key' })
    const s1 = (await (await call('lic-a', 'GET', '/api/t212?view=key')).json()) as { data: { connected: boolean; source: string } }
    expect(s1.data).toEqual({ connected: true, source: 'own' })
    expect(JSON.stringify(s1)).not.toContain('good-key')
    await call('lic-a', 'DELETE')
    const s2 = (await (await call('lic-a', 'GET', '/api/t212?view=key')).json()) as { data: { connected: boolean } }
    expect(s2.data.connected).toBe(false)
  })
})
