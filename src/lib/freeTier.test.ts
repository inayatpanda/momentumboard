// The DMG free tier (owner decision, 2026-08-15): the desktop build bakes a
// SHARED licence token so the app opens with no gate. Two consequences the
// tests pin: the token seeds only when the device has none (an explicit
// personal unlock always wins), and free-tier devices are sync-ISOLATED —
// every free DMG shares one server namespace, so config push/pull would
// cross-pollinate watchlists between friends.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSharedFreeToken, seedFreeTierToken } from './api'

beforeEach(() => {
  localStorage.clear()
  vi.stubEnv('VITE_FREE_TOKEN', 'mb_freefreefreefreefreefreefreefreefre')
})
afterEach(() => vi.unstubAllEnvs())

describe('the DMG free tier', () => {
  it('seeds the shared token on a tokenless device, with a claimed-at stamp', () => {
    seedFreeTierToken()
    expect(localStorage.getItem('mb-token')).toBe('mb_freefreefreefreefreefreefreefreefre')
    expect(Number(localStorage.getItem('mb-token-at'))).toBeGreaterThan(0)
  })

  it('never overwrites a personal licence', () => {
    localStorage.setItem('mb-token', 'mb_personal')
    seedFreeTierToken()
    expect(localStorage.getItem('mb-token')).toBe('mb_personal')
  })

  it('does nothing in web builds (no VITE_FREE_TOKEN)', () => {
    vi.stubEnv('VITE_FREE_TOKEN', '')
    seedFreeTierToken()
    expect(localStorage.getItem('mb-token')).toBeNull()
  })

  it('isSharedFreeToken tells the shared token from a personal one', () => {
    seedFreeTierToken()
    expect(isSharedFreeToken()).toBe(true)
    localStorage.setItem('mb-token', 'mb_personal')
    expect(isSharedFreeToken()).toBe(false)
    vi.stubEnv('VITE_FREE_TOKEN', '')
    expect(isSharedFreeToken()).toBe(false) // web build: nothing is "the free token"
  })
})

describe('free-tier sync isolation', () => {
  it('syncFromServer is a no-op on the shared token — no fetch, no invalidation', async () => {
    seedFreeTierToken()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { syncFromServer } = await import('./sync')
    const changed = await syncFromServer()
    expect(changed).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('mirrorConfig is a no-op on the shared token', async () => {
    seedFreeTierToken()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { mirrorConfig } = await import('./configMirror')
    mirrorConfig(0)
    await new Promise(r => setTimeout(r, 50))
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
