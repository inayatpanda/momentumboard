// Task 7 (PWA rebuild): the token system + self-hosted fonts. File-level
// assertions on purpose — the render-blocking third-party font origin
// (recon §2.6 row 0a) and the two-theme token contract are build facts, and a
// jsdom render can't see either.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

describe('token system + fonts', () => {
  it('index.html carries no third-party font origin and preloads the self-hosted face', () => {
    const html = read('index.html')
    expect(html).not.toContain('fonts.googleapis.com')
    expect(html).not.toContain('fonts.gstatic.com')
    expect(html).toContain('rel="preload"')
    expect(html).toContain('/fonts/inter')
  })

  it('tokens.css defines the indigo accent and surfaces for BOTH themes, and no cream anywhere', () => {
    const css = read('src/styles/tokens.css')
    expect(css).toContain(":root[data-theme='dark']")
    expect(css).toContain(":root[data-theme='light']")
    // one definition per theme block
    expect(css.match(/--accent:/g)?.length).toBe(2)
    expect(css).toContain('#5b6cf5') // dark accent (ratified v2 mockup B)
    expect(css).toContain('#4a5ae8') // light accent
    expect(css.toLowerCase()).not.toContain('#f6f4ef') // the old cream is gone
    for (const token of ['--bg', '--surface-1', '--surface-2', '--border', '--text', '--text-dim', '--long', '--short', '--warn', '--radius-card']) {
      expect(css.match(new RegExp(`${token}:`, 'g'))?.length, token).toBeGreaterThanOrEqual(2)
    }
  })

  it('self-hosted font files exist and @font-face points at them', () => {
    const css = read('src/styles/tokens.css')
    expect(css).toContain('@font-face')
    expect(css).toContain("url('/fonts/")
    expect(() => read('public/fonts/inter-var.woff2')).not.toThrow()
    expect(() => read('public/fonts/fraunces-var.woff2')).not.toThrow()
  })
})
