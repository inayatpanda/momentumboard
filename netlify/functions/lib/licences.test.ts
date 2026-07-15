import { describe, it, expect } from 'vitest'
import { routeLicences } from '../licences.mts'
import { authenticate } from './auth'
import { routeConfig } from '../config-sync.mts'
import { memoryStore } from './store'

const env = { APP_TOKEN: 'admin-key', URL: 'https://x' }
const admin = new Headers({ 'x-app-token': 'admin-key' })

describe('licence lifecycle', () => {
  it('admin generates, licensee authenticates with own namespace, revocation locks out', async () => {
    const store = memoryStore()
    // non-admin cannot manage licences
    expect((await routeLicences('POST', new Headers({ 'x-app-token': 'nope' }), '{}', env, store)).status).toBe(401)
    // generate
    const created = await (await routeLicences('POST', admin, JSON.stringify({ label: 'Dad' }), env, store)).json()
    const key = created.data.key as string
    expect(key.startsWith('mb_')).toBe(true)
    expect(created.data.unlockLink).toContain(`?key=${key}`)
    // licensee authenticates at user level with a namespace
    const auth = await authenticate(new Headers({ 'x-app-token': key }), env, store)
    expect(auth?.level).toBe('user')
    expect(auth?.ns).toMatch(/^u:[0-9a-f]{8}:$/)
    // admin auth has no namespace
    expect((await authenticate(admin, env, store))?.ns).toBe('')
    // revoke → locked out
    await routeLicences('DELETE', admin, JSON.stringify({ key }), env, store)
    expect(await authenticate(new Headers({ 'x-app-token': key }), env, store)).toBeNull()
  })

  it('a house licence carries the flag through authenticate; plain ones do not', async () => {
    const store = memoryStore()
    const created = await (await routeLicences('POST', admin, JSON.stringify({ label: 'mac' }), env, store)).json()
    const key = created.data.key as string
    expect((await authenticate(new Headers({ 'x-app-token': key }), env, store))?.house).toBeUndefined()
    // flip the flag the way the Helm /house command does
    const lics = (await store.read<{ key: string; house?: boolean }[]>('licences'))!
    lics.find(l => l.key === key)!.house = true
    await store.write('licences', lics)
    expect((await authenticate(new Headers({ 'x-app-token': key }), env, store))?.house).toBe(true)
  })

  it('licensee config is isolated from admin config', async () => {
    const store = memoryStore()
    const created = await (await routeLicences('POST', admin, JSON.stringify({ label: 'U1' }), env, store)).json()
    const userHeaders = new Headers({ 'x-app-token': created.data.key })
    const cfg = (watch: string) => JSON.stringify({ watchlist: [{ symbol: watch, riskClass: 'normal' }], rules: [], ytChannels: [], capital: 5000 })
    await routeConfig(new URL('http://x/api/config'), 'PUT', admin, cfg('AAPL'), env, store)
    await routeConfig(new URL('http://x/api/config'), 'PUT', userHeaders, cfg('TSLA'), env, store)
    const adminGet = await (await routeConfig(new URL('http://x/api/config'), 'GET', admin, null, env, store)).json()
    const userGet = await (await routeConfig(new URL('http://x/api/config'), 'GET', userHeaders, null, env, store)).json()
    expect(adminGet.data.watchlist[0].symbol).toBe('AAPL')
    expect(userGet.data.watchlist[0].symbol).toBe('TSLA')
  })
})

describe('self-served trial', () => {
  const ipHeaders = (ip: string) => new Headers({ 'x-nf-client-connection-ip': ip })

  it('mints a 7-day trial with NO auth; the key authenticates at user level', async () => {
    const store = memoryStore()
    const res = await routeLicences('POST', ipHeaders('1.2.3.4'), JSON.stringify({ trial: true }), env, store)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.key.startsWith('mb_')).toBe(true)
    expect(body.data.expiresAt).toBeGreaterThan(Date.now() / 1000 + 6 * 86_400)
    const auth = await authenticate(new Headers({ 'x-app-token': body.data.key }), env, store)
    expect(auth?.level).toBe('user')
  })

  it('expiry locks out server-side: an expired trial no longer authenticates and check=1 says 401', async () => {
    const store = memoryStore()
    const body = await (await routeLicences('POST', ipHeaders('1.2.3.4'), JSON.stringify({ trial: true }), env, store)).json()
    // force-expire it in the blob, like a week passing
    const lics = (await store.read('licences')) as { key: string; expiresAt?: number }[]
    lics.find(l => l.key === body.data.key)!.expiresAt = Math.floor(Date.now() / 1000) - 60
    await store.write('licences', lics)
    expect(await authenticate(new Headers({ 'x-app-token': body.data.key }), env, store)).toBeNull()
    const check = await routeLicences('GET', new Headers({ 'x-app-token': body.data.key }), null, env, store, true)
    expect(check.status).toBe(401)
  })

  it('per-IP cap: a third trial from the same IP inside a week is refused', async () => {
    const store = memoryStore()
    for (let i = 0; i < 2; i++) {
      expect((await routeLicences('POST', ipHeaders('9.9.9.9'), JSON.stringify({ trial: true }), env, store)).status).toBe(200)
    }
    expect((await routeLicences('POST', ipHeaders('9.9.9.9'), JSON.stringify({ trial: true }), env, store)).status).toBe(429)
    // a different IP is unaffected
    expect((await routeLicences('POST', ipHeaders('8.8.8.8'), JSON.stringify({ trial: true }), env, store)).status).toBe(200)
  })

  it('trials do not consume the Helm licence cap; check=1 confirms a valid admin token', async () => {
    const store = memoryStore()
    await routeLicences('POST', ipHeaders('1.1.1.1'), JSON.stringify({ trial: true }), env, store)
    // admin can still mint a real licence (cap counts non-trial only)
    const real = await (await routeLicences('POST', admin, JSON.stringify({ label: 'Dad' }), env, store)).json()
    expect(real.ok).toBe(true)
    const check = await routeLicences('GET', admin, null, env, store, true)
    expect(check.status).toBe(200)
    expect((await check.json()).data.level).toBe('admin')
  })
})
