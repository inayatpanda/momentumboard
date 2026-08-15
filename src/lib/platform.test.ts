import { describe, expect, it } from 'vitest'
import { isDesktopShellLocation } from './platform'

// The two Tauri v2 webview origins, split into the parts `location` exposes.
// They are the SAME two the server's CORS allow-list names — if these ever
// disagree with functions/_middleware.ts, the desktop app either shows the
// marketing site on every launch or gets a CORS wall, and neither failure
// points at the other file.
describe('isDesktopShellLocation', () => {
  it('recognises the macOS shell — tauri://localhost', () => {
    expect(isDesktopShellLocation('tauri:', 'localhost')).toBe(true)
  })

  it('recognises the Windows/Linux shell — http://tauri.localhost', () => {
    expect(isDesktopShellLocation('http:', 'tauri.localhost')).toBe(true)
  })

  it('says no to the website, on either scheme', () => {
    expect(isDesktopShellLocation('https:', 'thestreetsignal.rqai.co.uk')).toBe(false)
    expect(isDesktopShellLocation('http:', 'thestreetsignal.rqai.co.uk')).toBe(false)
  })

  it('says no to local development — the dev server is the web build', () => {
    expect(isDesktopShellLocation('http:', 'localhost')).toBe(false)
    expect(isDesktopShellLocation('http:', '127.0.0.1')).toBe(false)
  })

  // A page cannot be trusted to be the shell just because it says "tauri"
  // somewhere: a hostname is attacker-chosen. Only the exact forms count.
  it('says no to a hostname that merely contains the marker', () => {
    expect(isDesktopShellLocation('https:', 'tauri.localhost.evil.test')).toBe(false)
    expect(isDesktopShellLocation('https:', 'nottauri.localhost')).toBe(false)
    expect(isDesktopShellLocation('https:', 'tauri.localhost')).toBe(false)
  })
})

// The blank-pane regression (first free-tier DMG launch): the shell loads at
// tauri://localhost/ while the router mounts at /app — nothing matched, the
// catch-all spun, the pane rendered nothing. The boot rewrite is the fix.
describe('normaliseDesktopPath', () => {
  const setLocation = (protocol: string, hostname: string, pathname: string) => {
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, protocol, hostname, pathname },
    })
    return () => Object.defineProperty(window, 'location', { configurable: true, value: original })
  }

  it('rewrites the desktop shell’s root path into the router’s /app base', async () => {
    const restore = setLocation('tauri:', 'localhost', '/')
    try {
      const { normaliseDesktopPath } = await import('./platform')
      expect(normaliseDesktopPath()).toBe(true)
    } finally {
      restore()
    }
  })

  it('leaves the web alone, and a desktop path already inside /app alone', async () => {
    const { normaliseDesktopPath } = await import('./platform')
    const restoreWeb = setLocation('https:', 'thestreetsignal.rqai.co.uk', '/')
    try {
      expect(normaliseDesktopPath()).toBe(false)
    } finally {
      restoreWeb()
    }
    const restoreApp = setLocation('tauri:', 'localhost', '/app/stocks')
    try {
      expect(normaliseDesktopPath()).toBe(false)
    } finally {
      restoreApp()
    }
  })
})
