// Task 12 (CX-6/7/8, DS-6/13): the SW contract + the offline/update surfaces.
// The sw.ts assertions are file-level on purpose — importing a service worker
// into jsdom is theatre; what matters is what the file DOES and DOESN'T do.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    reportSliceHealth('board', { offline: true, fetchedAt: noon.getTime() })
    await waitFor(() => expect(screen.getByText(/offline — showing 12:30 data/i)).toBeInTheDocument())
    reportSliceHealth('board', { offline: false, fetchedAt: Date.now() })
    await waitFor(() => expect(screen.queryByText(/offline/i)).not.toBeInTheDocument())
  })
})
