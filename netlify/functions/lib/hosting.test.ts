// THE TWO THINGS netlify.toml CARRIES THAT ARE NOT ROUTES.
//
// M2 shipped the route table and stopped there. netlify.toml also declares the
// SPA fallback (its last two `[[redirects]]`) and three `[[headers]]` blocks,
// and neither was ported. This file pins both ports so they cannot rot, in the
// same spirit as router.test.ts re-parsing netlify.toml's redirect list.
//
// ── C-1, the SPA fallback: no file, by design ─────────────────────────────
// Cloudflare Pages needs no `_redirects` rule for this. Its documented default
// (developers.cloudflare.com/pages/configuration/serving-pages/, "Single-page
// application (SPA) rendering") is:
//
//   "If your project does not include a top-level `404.html` file, Pages
//    assumes that you are deploying a single-page application. [...] Pages'
//    default single-page application behavior matches all incoming paths to the
//    root (`/`), allowing you to capture URLs like `/about` or `/help` and
//    respond to them from within your SPA."
//
// So the port of netlify.toml:38-41 (`/app/*`) and :106-109 (`/*`) is a
// PRECONDITION, not a rule: as long as dist/ has no top-level 404.html, every
// unmatched path serves the SPA. This test is that precondition, written down.
//
// The `_redirects` alternative was examined and rejected on the docs, twice over:
//   Cloudflare: "Redirects are always followed, regardless of whether or not an
//     asset matches the incoming request." A `/* /index.html 200` would
//     therefore shadow /assets/*.js — Netlify's not-found-only semantics do NOT
//     carry over.
//   Netlify: "Rules in the `_redirects` file are always processed first,
//     followed by rules in the Netlify configuration file." The same file would
//     be read on Netlify during the parallel run and would out-rank every
//     `/api/* -> /.netlify/functions/*` rule in netlify.toml — i.e. the whole
//     API would answer with index.html.
// Hence the catch-all guard below.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const PUBLIC_DIR = join(REPO_ROOT, 'public')
const DIST_DIR = join(REPO_ROOT, 'dist')

const read = (p: string) => readFileSync(p, 'utf8')

/* ───────────────────────────── C-1 ───────────────────────────── */

describe("the SPA fallback — Cloudflare's default, kept reachable", () => {
  // The single precondition. A top-level 404.html anywhere that reaches dist/
  // silently turns /engine, /paper, /ledger and /faq — and /app/, the PWA's
  // start_url and scope (vite.config.ts:17-18) — into 404s on Pages.
  it('ships no top-level 404.html, on any path into dist/', () => {
    expect(existsSync(join(PUBLIC_DIR, '404.html')), 'public/404.html').toBe(false)
    expect(existsSync(join(REPO_ROOT, '404.html')), '404.html at the repo root').toBe(false)
    if (existsSync(DIST_DIR)) expect(existsSync(join(DIST_DIR, '404.html')), 'dist/404.html').toBe(false)
  })

  // Belt and braces on the mechanism actually chosen: nobody may "helpfully"
  // add the catch-all rule, on either host. See the header for both quotes.
  it('declares no /* catch-all redirect in a _redirects file', () => {
    for (const dir of [PUBLIC_DIR, DIST_DIR]) {
      const f = join(dir, '_redirects')
      if (!existsSync(f)) continue
      const sources = read(f)
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split(/\s+/)[0])
      for (const s of sources) expect(s, `${f}: a catch-all here shadows static assets AND netlify.toml`).not.toMatch(/^\/(\*|app\/\*)$/)
    }
  })

  // The reliance has to be legible where a deployer looks, not only here.
  it('says so out loud in wrangler.toml', () => {
    expect(read(join(REPO_ROOT, 'wrangler.toml'))).toContain('404.html')
  })

  // The Netlify side of the same behaviour, unchanged and still last. Netlify
  // reads its redirects top-down, so a rule added below the catch-all is dead.
  it("leaves netlify.toml's own SPA rules in place, with /* still last", () => {
    const toml = read(join(REPO_ROOT, 'netlify.toml'))
    const froms = [...toml.matchAll(/\[\[redirects\]\]\s*\n\s*from\s*=\s*"([^"]+)"/g)].map(m => m[1])
    expect(froms).toContain('/app/*')
    expect(froms[froms.length - 1]).toBe('/*')
  })
})

/* ───────────────────────────── I-1 ───────────────────────────── */

type HeaderBlock = { path: string; values: [string, string][] }

/** netlify.toml's `[[headers]]` blocks, in file order. */
function netlifyHeaderBlocks(): HeaderBlock[] {
  const out: HeaderBlock[] = []
  let cur: HeaderBlock | null = null
  let inValues = false
  for (const raw of read(join(REPO_ROOT, 'netlify.toml')).split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#') || line === '') continue
    if (line === '[[headers]]') {
      cur = { path: '', values: [] }
      inValues = false
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('[[') || (line.startsWith('[') && line !== '[headers.values]')) {
      cur = null
      continue
    }
    if (line === '[headers.values]') {
      inValues = true
      continue
    }
    const m = /^([A-Za-z0-9_-]+)\s*=\s*"(.*)"$/.exec(line)
    if (!m) continue
    if (!inValues && m[1] === 'for') cur.path = m[2]
    else if (inValues) cur.values.push([m[1], m[2]])
  }
  return out
}

/** public/_headers, in file order. Cloudflare's format: an unindented path,
 * then indented `Name: value` lines. */
function cloudflareHeaderBlocks(): HeaderBlock[] {
  const out: HeaderBlock[] = []
  let cur: HeaderBlock | null = null
  for (const raw of read(join(PUBLIC_DIR, '_headers')).split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      cur = { path: raw.trim(), values: [] }
      out.push(cur)
      continue
    }
    const m = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw)
    if (m && cur) cur.values.push([m[1], m[2]])
  }
  return out
}

describe('public/_headers is netlify.toml [[headers]], transcribed', () => {
  const netlify = netlifyHeaderBlocks()
  const cloudflare = cloudflareHeaderBlocks()

  // If the parser ever stops seeing the blocks, everything below passes
  // vacuously. Pin the count and the audit fixes by name.
  it('finds all three blocks on both sides', () => {
    expect(netlify.map(b => b.path)).toEqual(['/*', '/assets/*', '/manifest.webmanifest'])
    expect(cloudflare.map(b => b.path)).toEqual(['/*', '/assets/*', '/manifest.webmanifest'])
  })

  it('carries the same header names and the same values, path for path', () => {
    expect(cloudflare).toEqual(netlify)
  })

  // The three reasons these blocks exist, spelled out so a future edit that
  // guts one of them fails here and not in production six weeks later.
  it('keeps the audit M-4 security set intact', () => {
    const v = Object.fromEntries(cloudflare[0].values)
    expect(v['X-Frame-Options']).toBe('DENY')
    expect(v['X-Content-Type-Options']).toBe('nosniff')
    expect(v['Referrer-Policy']).toBe('no-referrer')
    expect(v['Content-Security-Policy']).toContain("frame-ancestors 'none'")
    expect(v['Permissions-Policy']).toContain('camera=()')
  })

  it('keeps L-1 immutable asset caching and the L-2 manifest content-type', () => {
    expect(Object.fromEntries(cloudflare[1].values)['Cache-Control']).toBe('public, max-age=31536000, immutable')
    expect(Object.fromEntries(cloudflare[2].values)['Content-Type']).toBe('application/manifest+json; charset=utf-8')
  })

  // Cloudflare joins repeated names with a comma; a stray duplicate here would
  // emit `Content-Type: a, a` and re-break exactly what L-2 fixed.
  it('names each header once per block', () => {
    for (const b of cloudflare) {
      const names = b.values.map(([n]) => n.toLowerCase())
      expect(new Set(names).size, b.path).toBe(names.length)
    }
  })
})
