// Task 12 (CX-6/7/8, DS-6/13): the SW contract + the offline/update surfaces.
// The sw.ts assertions are file-level on purpose — importing a service worker
// into jsdom is theatre; what matters is what the file DOES and DOESN'T do.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

describe('service worker contract', () => {
  it('never claims or skips on its own, never caches /api, keeps the /app navigation route + push handlers', () => {
    const sw = read('src/sw.ts')
    expect(sw).not.toMatch(/^\s*self\.skipWaiting\(\)/m) // only inside the message handler
    expect(sw).not.toContain('clientsClaim()')
    expect(sw).toContain("type === 'SKIP_WAITING'")
    expect(sw).not.toContain('/api') // Dexie owns API data — CX-6
    expect(sw).toContain('NavigationRoute')
    expect(sw).toContain("addEventListener('push'")
    expect(sw).toContain('CacheFirst') // hashed lazy chunks
  })

  it('vite precaches only the entry closure and prompts for updates', () => {
    const cfg = read('vite.config.ts')
    expect(cfg).toContain("registerType: 'prompt'")
    expect(cfg).toContain('assets/index-*.js')
    expect(cfg).toContain('assets/react-*.js')
    expect(cfg).toContain('fonts/*.woff2')
    expect(cfg).not.toContain("globPatterns: ['**/*")
  })
})

describe('UpdateBanner', () => {
  it('renders on needRefresh and reloads through updateServiceWorker', async () => {
    const update = vi.fn()
    vi.doMock('virtual:pwa-register/react', () => ({
      useRegisterSW: () => ({ needRefresh: [true, vi.fn()], offlineReady: [false, vi.fn()], updateServiceWorker: update }),
    }))
    const { UpdateBanner } = await import('./UpdateBanner')
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: /reload/i }))
    expect(update).toHaveBeenCalledWith(true)
    vi.doUnmock('virtual:pwa-register/react')
  })
})

describe('OfflinePill', () => {
  it('shows the oldest offline slice age and keeps quiet when everything is fresh', async () => {
    const { reportSliceHealth, OfflinePill } = await import('./OfflinePill')
    render(<OfflinePill />)
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument()
    const noon = new Date()
    noon.setHours(12, 30, 0, 0)
    act(() => reportSliceHealth('inst-1', { key: 'board', offline: true, fetchedAt: noon.getTime() }))
    await waitFor(() => expect(screen.getByText(/offline — showing 12:30 data/i)).toBeInTheDocument())
    act(() => reportSliceHealth('inst-1', { key: 'board', offline: false, fetchedAt: Date.now() }))
    await waitFor(() => expect(screen.queryByText(/offline/i)).not.toBeInTheDocument())
    act(() => reportSliceHealth('inst-1', null))
  })

  // D1: the desk mounts Today and the BoardColumn together and both read
  // 'board'. Keyed by slice key they shared ONE registry row, and either
  // unmount deleted it — the survivor's offline state vanished with it.
  it('two readers of one slice key are two rows: one unmounting leaves the other’s offline state standing', async () => {
    const { reportSliceHealth, OfflinePill } = await import('./OfflinePill')
    render(<OfflinePill />)
    const noon = new Date()
    noon.setHours(9, 15, 0, 0)
    act(() => reportSliceHealth('today', { key: 'board', offline: true, fetchedAt: noon.getTime() }))
    act(() => reportSliceHealth('column', { key: 'board', offline: false, fetchedAt: Date.now() }))
    await waitFor(() => expect(screen.getByText(/offline — showing 09:15 data/i)).toBeInTheDocument())

    act(() => reportSliceHealth('column', null)) // the column unmounts…
    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByText(/offline — showing 09:15 data/i)).toBeInTheDocument() // …Today still says it

    act(() => reportSliceHealth('today', null))
    await waitFor(() => expect(screen.queryByText(/offline/i)).not.toBeInTheDocument())
  })

  // …and the whole point of the pill: it reports through a live hook, so a
  // second mounted useSlice on the same key cannot silence the first.
  it('a second mounted useSlice on the same key does not clear the first one’s report on unmount', async () => {
    const { OfflinePill } = await import('./OfflinePill')
    const { renderHook } = await import('@testing-library/react')
    const { useSlice } = await import('../lib/useSlice')
    const { db } = await import('../lib/db')
    await db.slices.clear()
    await db.slices.put({ key: 'board:d1', data: { v: 1 }, fetchedAt: Date.now() - 10 * 60_000 })

    render(<OfflinePill />)
    const a = renderHook(() => useSlice('board:d1', async () => Promise.reject(new Error('net down'))))
    await waitFor(() => expect(a.result.current.offline).toBe(true))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/offline/i))

    const b = renderHook(() => useSlice('board:d1', async () => Promise.reject(new Error('net down'))))
    await waitFor(() => expect(b.result.current.offline).toBe(true))
    b.unmount()

    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i) // A is still mounted and still offline
    a.unmount()
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })
})
