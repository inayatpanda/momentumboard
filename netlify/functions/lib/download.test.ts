import { describe, expect, it } from 'vitest'
import { routeDownload, type DownloadStats } from '../download.mts'
import { memoryStore } from './store'

const h = (ip = '1.2.3.4') => new Headers({ 'x-nf-client-connection-ip': ip })
const NOW = Date.parse('2026-07-11T12:00:00Z') / 1000

describe('routeDownload', () => {
  it('mac → 302 to the stable dmg asset; win → the exe', async () => {
    const store = memoryStore()
    const mac = await routeDownload('mac', h(), store, NOW)
    expect(mac.status).toBe(302)
    expect(mac.headers.get('location')).toContain('/releases/latest/download/StreetSignal.dmg')
    const win = await routeDownload('win', h(), store, NOW)
    expect(win.headers.get('location')).toContain('StreetSignal-Setup.exe')
  })

  it('unknown platform → 404, nothing counted', async () => {
    const store = memoryStore()
    expect((await routeDownload('linux', h(), store, NOW)).status).toBe(404)
    expect(await store.read('download-stats')).toBeNull()
  })

  it('counts totals, per-day, and rough uniques by ip hash', async () => {
    const store = memoryStore()
    await routeDownload('mac', h('1.1.1.1'), store, NOW)
    await routeDownload('mac', h('1.1.1.1'), store, NOW) // same device again
    await routeDownload('mac', h('2.2.2.2'), store, NOW)
    await routeDownload('win', h('2.2.2.2'), store, NOW)
    const s = (await store.read<DownloadStats>('download-stats'))!
    expect(s.totals).toEqual({ mac: 3, win: 1 })
    expect(s.byDay['2026-07-11']).toEqual({ mac: 3, win: 1 })
    expect(s.uniques['2026-07-11']).toHaveLength(2) // two distinct ip hashes
  })

  it('a broken store never blocks the download', async () => {
    const broken = { read: async () => { throw new Error('blobs down') }, write: async () => { throw new Error('blobs down') } }
    const res = await routeDownload('mac', h(), broken, NOW)
    expect(res.status).toBe(302)
  })
})
