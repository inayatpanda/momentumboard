import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { ensureD1Schema, type D1Database } from './d1Store'
import { blobAppStore } from './store'
import { appStore, configureStoreFromEnv, currentAppStore, currentCacheStore, currentD1, findD1Binding, looksLikeD1, storeBackend, useBlobStore, useD1Store, D1_BINDING_NAMES } from './storeProvider'
import { clearRuntimeEnv, installRuntimeEnv } from './runtimeEnv'
import { getCached, setCached } from './cache'
import { authenticate, generateLicenceKey } from './auth'

async function freshD1(): Promise<D1Database & { close(): void }> {
  const db = openSqliteD1(':memory:')
  await ensureD1Schema(db)
  return db
}

beforeEach(() => {
  clearRuntimeEnv()
  useBlobStore()
  delete process.env.STORE_BACKEND
})
afterEach(() => {
  clearRuntimeEnv()
  useBlobStore()
  delete process.env.STORE_BACKEND
})

describe('backend selection', () => {
  it('defaults to Blobs — the Netlify path, unchanged', () => {
    expect(storeBackend()).toBe('blobs')
    expect(currentAppStore()).toBe(blobAppStore)
    expect(currentCacheStore()).toBeNull()
    expect(currentD1()).toBeNull()
  })

  it('stays on Blobs when the host hands over no binding', () => {
    expect(configureStoreFromEnv({ APP_TOKEN: 'x', URL: 'https://x.test' })).toBe('blobs')
    expect(configureStoreFromEnv(null)).toBe('blobs')
    expect(configureStoreFromEnv(undefined)).toBe('blobs')
  })

  it('switches to D1 the moment a binding appears, under either accepted name', async () => {
    for (const name of D1_BINDING_NAMES) {
      useBlobStore()
      const db = await freshD1()
      expect(configureStoreFromEnv({ [name]: db })).toBe('d1')
      expect(storeBackend()).toBe('d1')
      expect(currentD1()).toBe(db)
      expect(currentCacheStore()).not.toBeNull()
      db.close()
    }
  })

  it('prefers the explicit binding name over the generic one', async () => {
    const explicit = await freshD1()
    const generic = await freshD1()
    configureStoreFromEnv({ DB: generic, STREETSIGNAL_DB: explicit })
    expect(currentD1()).toBe(explicit)
    explicit.close()
    generic.close()
  })

  it('is idempotent: re-installing the same binding does not rebuild the store', async () => {
    const db = await freshD1()
    configureStoreFromEnv({ STREETSIGNAL_DB: db })
    const first = currentAppStore()
    configureStoreFromEnv({ STREETSIGNAL_DB: db })
    expect(currentAppStore()).toBe(first)
    db.close()
  })

  // A deployment that MEANT to use D1 and quietly fell back to Blobs would
  // write the day's ledger into the wrong store and nobody would find out
  // until the numbers stopped matching.
  it('THROWS when STORE_BACKEND=d1 but no binding was handed over', () => {
    expect(() => configureStoreFromEnv({ STORE_BACKEND: 'd1' })).toThrow(/no D1 binding/)
  })

  it('honours STORE_BACKEND=blobs even with a binding present — the M3 A/B switch', async () => {
    const db = await freshD1()
    expect(configureStoreFromEnv({ STORE_BACKEND: 'blobs', STREETSIGNAL_DB: db })).toBe('blobs')
    expect(currentAppStore()).toBe(blobAppStore)
    db.close()
  })

  it('reads STORE_BACKEND from an already-installed runtime bag too', async () => {
    installRuntimeEnv({ STORE_BACKEND: 'blobs' })
    const db = await freshD1()
    expect(configureStoreFromEnv({ STREETSIGNAL_DB: db })).toBe('blobs')
    db.close()
    delete process.env.STORE_BACKEND // installRuntimeEnv mirrors it
  })

  it('will not mistake a plain object for a database', () => {
    expect(looksLikeD1(null)).toBe(false)
    expect(looksLikeD1({})).toBe(false)
    expect(looksLikeD1('STREETSIGNAL_DB')).toBe(false)
    expect(looksLikeD1({ prepare: 'not a function' })).toBe(false)
    expect(looksLikeD1({ prepare: () => undefined })).toBe(true)
    expect(findD1Binding({ SOMETHING_ELSE: { prepare: () => undefined } })).toBeNull()
  })
})

describe('the appStore façade', () => {
  it('follows the installed backend rather than freezing at import time', async () => {
    await appStore.write('config', { watchlist: ['on-blobs'] })
    expect(await appStore.read('config')).toEqual({ watchlist: ['on-blobs'] })

    const db = await freshD1()
    useD1Store(db)
    expect(await appStore.read('config')).toBeNull() // a different store entirely
    await appStore.write('config', { watchlist: ['on-d1'] })
    expect(await appStore.read('config')).toEqual({ watchlist: ['on-d1'] })

    useBlobStore()
    expect(await appStore.read('config')).toEqual({ watchlist: ['on-blobs'] })
    db.close()
  })

  // auth.ts and readLicencesFresh both branch on `store.readStrong` existing.
  // The façade always has it, so both hosts take the same path — the Blobs
  // strong read on Netlify, a plain (already strongly consistent) read on D1.
  it('always offers readStrong, so the licence path does not fork by host', async () => {
    expect(typeof appStore.readStrong).toBe('function')
    const db = await freshD1()
    useD1Store(db)
    const key = generateLicenceKey()
    await appStore.write('licences', [{ key, label: 'reader', createdAt: 1 }])
    expect(await appStore.readStrong('licences')).toEqual([{ key, label: 'reader', createdAt: 1 }])

    const headers = new Headers({ 'x-app-token': key })
    const auth = await authenticate(headers, { APP_TOKEN: 'admin-token' }, appStore)
    expect(auth).toMatchObject({ level: 'user' })
    expect(await authenticate(new Headers({ 'x-app-token': 'admin-token' }), { APP_TOKEN: 'admin-token' }, appStore)).toEqual({ level: 'admin', ns: '' })
    expect(await authenticate(new Headers({ 'x-app-token': 'nope' }), { APP_TOKEN: 'admin-token' }, appStore)).toBeNull()
    db.close()
  })
})

// lib/cache.ts is the ONLY place in the codebase that reaches for the cache
// store (M1's H2 audit), so it is the only place that needed the seam.
describe('the cache seam', () => {
  it('routes getCached/setCached to D1 and honours the envelope TTL', async () => {
    const db = await freshD1()
    useD1Store(db)
    await setCached('quote:AAPL', { price: 231.4 }, 60)
    expect(await getCached('quote:AAPL')).toEqual({ price: 231.4 })

    // the envelope and the column agree — the sweeper depends on that
    const row = await db.prepare(`SELECT value, expires_at FROM blobs WHERE store = 'cache' AND key = 'quote:AAPL'`).first<{ value: string; expires_at: number }>()
    expect(JSON.parse(row!.value)).toEqual({ value: { price: 231.4 }, expires: row!.expires_at })
    expect(row!.expires_at).toBeGreaterThan(Date.now())
    db.close()
  })

  it('serves a stale entry as a miss, and the app store never sees the cache rows', async () => {
    const db = await freshD1()
    useD1Store(db)
    await db.prepare(`INSERT INTO blobs (store, key, value, updated_at, expires_at) VALUES ('cache', 'econ-calendar', ?1, 1, 1)`).bind(JSON.stringify({ value: [{ e: 'CPI' }], expires: 1 })).run()
    expect(await getCached('econ-calendar')).toBeNull()
    expect(await appStore.read('econ-calendar')).toBeNull()
    db.close()
  })

  it('leaves the Netlify path alone: no binding, no D1', async () => {
    useBlobStore()
    await setCached('mkt-trending', [{ sym: 'NVDA' }], 600)
    expect(await getCached('mkt-trending')).toEqual([{ sym: 'NVDA' }])
    expect(currentCacheStore()).toBeNull()
  })
})
