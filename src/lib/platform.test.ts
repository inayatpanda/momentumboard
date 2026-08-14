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
