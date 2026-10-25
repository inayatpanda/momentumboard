import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { mirrorPortfolio, restoreBackup } from './portfolioMirror'

const shared = vi.hoisted(() => ({ free: false }))
vi.mock('./api', () => ({ apiUrl: (s: string) => s, getToken: () => 'test-device', isSharedFreeToken: () => shared.free }))
beforeEach(async () => {
  shared.free = false
  await Promise.all([db.trades.clear(), db.rules.clear(), db.watchlist.clear(), db.settings.clear()])
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('private journal backups', () => {
  it('excludes the device AI key from outbound backups', async () => {
    await db.settings.bulkPut([{ key: 'groqApiKey', value: 'device-secret' }, { key: 'capital', value: '5000' }])
    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetcher)
    mirrorPortfolio(0)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/backup', expect.any(Object)))
    const body = JSON.parse(fetcher.mock.calls.find(call => call[0] === '/api/backup')![1].body)
    expect(body.settings).toEqual([{ key: 'capital', value: '5000' }])
    expect(JSON.stringify(body)).not.toContain('device-secret')
  })
  it('cannot overwrite a device key from a legacy backup', async () => {
    await db.settings.put({ key: 'groqApiKey', value: 'local-secret' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ ok: true, data: { at: 123, settings: [{ key: 'groqApiKey', value: 'old-server-secret' }, { key: 'capital', value: '6000' }] } }) }))
    await restoreBackup()
    expect((await db.settings.get('groqApiKey'))?.value).toBe('local-secret')
    expect((await db.settings.get('capital'))?.value).toBe('6000')
  })
  it('does not share private backups through the old desktop shared identity', async () => {
    shared.free = true
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    mirrorPortfolio(0)
    expect(await restoreBackup()).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
