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
