import { describe, expect, it } from 'vitest'
import { externalHrefFrom, installExternalLinkOpener, isDesktopShellLocation } from './platform'

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

// EXTERNAL LINKS IN THE SHELL (owner 2026-08-17: "none is clickable"). Tauri
// denies new-window requests by default, so every `target="_blank"` news link
// in the Mac app silently did nothing. The shell now intercepts clicks on
// external http(s) anchors and hands them to the OS browser via the opener
// plugin; same-origin navigation and non-http schemes stay untouched.
describe('externalHrefFrom', () => {
  const ORIGIN = 'tauri://localhost'
  const anchor = (href: string) => {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    document.body.appendChild(a)
    return a
  }

  it('returns the href for an external https link — even from a nested child', () => {
    const a = anchor('https://www.ft.com/markets/story')
    const span = document.createElement('span')
    a.appendChild(span)
    expect(externalHrefFrom(span, ORIGIN)).toBe('https://www.ft.com/markets/story')
  })

  it('ignores in-app navigation and non-http schemes', () => {
    expect(externalHrefFrom(anchor('tauri://localhost/app/stocks'), ORIGIN)).toBeNull()
    expect(externalHrefFrom(anchor('/app/stocks'), ORIGIN)).toBeNull()
    expect(externalHrefFrom(anchor('mailto:x@y.z'), ORIGIN)).toBeNull()
    expect(externalHrefFrom(anchor('#news'), ORIGIN)).toBeNull()
    expect(externalHrefFrom(document.createElement('div'), ORIGIN)).toBeNull()
  })
})

describe('installExternalLinkOpener', () => {
  it('opens an external link through the injected opener and cancels the default', () => {
    const opened: string[] = []
    const dispose = installExternalLinkOpener(url => opened.push(url), true)
    const a = document.createElement('a')
    a.setAttribute('href', 'https://www.bloomberg.com/x')
    a.setAttribute('target', '_blank')
    document.body.appendChild(a)
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(opened).toEqual(['https://www.bloomberg.com/x'])
    expect(ev.defaultPrevented).toBe(true)
    dispose()
  })

  it('outside the shell it installs nothing', () => {
    const opened: string[] = []
    const dispose = installExternalLinkOpener(url => opened.push(url), false)
    const a = document.createElement('a')
    a.setAttribute('href', 'https://www.bloomberg.com/y')
    document.body.appendChild(a)
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(opened).toEqual([])
    dispose()
  })
})
