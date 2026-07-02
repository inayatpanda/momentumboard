import { describe, it, expect } from 'vitest'
import { routePush } from '../push.mts'
import { memoryStore } from './store'

const env = { APP_TOKEN: 'app', VAPID_PUBLIC_KEY: 'PUBKEY' }
const auth = new Headers({ 'x-app-token': 'app' })
const sub = (endpoint: string) => JSON.stringify({ endpoint, keys: { p256dh: 'p', auth: 'a' } })

describe('push registry', () => {
  it('GET serves the public key without auth', async () => {
    const res = await routePush('GET', new Headers(), null, env, memoryStore())
    expect((await res.json()).data.publicKey).toBe('PUBKEY')
  })
  it('POST requires the app token, dedupes by endpoint, caps devices', async () => {
    const store = memoryStore()
    expect((await routePush('POST', new Headers(), sub('e1'), env, store)).status).toBe(401)
    await routePush('POST', auth, sub('e1'), env, store)
    await routePush('POST', auth, sub('e1'), env, store) // same device again
    const res = await routePush('POST', auth, sub('e2'), env, store)
    expect((await res.json()).data.devices).toBe(2)
    expect((await routePush('POST', auth, '{"nope":1}', env, store)).status).toBe(400)
  })
  it('DELETE removes a device', async () => {
    const store = memoryStore()
    await routePush('POST', auth, sub('e1'), env, store)
    const res = await routePush('DELETE', auth, JSON.stringify({ endpoint: 'e1' }), env, store)
    expect((await res.json()).data.devices).toBe(0)
  })
})
