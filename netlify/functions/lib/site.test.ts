// I-3: a function calling another function has to spell the path per host.
//
// predict-background kicks the composer over HTTP. `/.netlify/functions/<name>`
// is native on Netlify and does not exist on Pages (Pages will not serve a
// dot-segment directory); `/api/fn/<name>` is lib/router.ts's by-name door and
// has no netlify.toml redirect, so it 404s on Netlify. Either hardcode is
// broken on exactly one host — inside a `.catch()`, which is how it stays
// broken. One seam decides, and this pins both sides of it.

import { describe, expect, it, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANONICAL_SITE, internalFunctionPath, internalFunctionUrl } from './site'
import { clearRuntimeEnv, installRuntimeEnv } from './runtimeEnv'

afterEach(() => clearRuntimeEnv())

describe('internalFunctionPath', () => {
  // The default is today's behaviour, and it is the default for a reason: only
  // an explicitly installed Worker env bag flips it, and only the Cloudflare
  // entry points install one. Netlify, the GitHub Actions runners and vitest
  // all land here.
  it('is the Netlify spelling when nobody has handed us a Worker env', () => {
    expect(internalFunctionPath('report-compose-background')).toBe('/.netlify/functions/report-compose-background')
    expect(internalFunctionUrl(CANONICAL_SITE, 'report-compose-background')).toBe('https://thestreetsignal.rqai.co.uk/.netlify/functions/report-compose-background')
  })

  it('is the /api/fn/ door once a Worker env bag is installed', () => {
    installRuntimeEnv({})
    expect(internalFunctionPath('report-compose-background')).toBe('/api/fn/report-compose-background')
    expect(internalFunctionUrl('https://preview.pages.dev', 'report-compose-background')).toBe('https://preview.pages.dev/api/fn/report-compose-background')
  })

  it('does not double the slash when the base carries one', () => {
    expect(internalFunctionUrl('https://x.test/', 'watchdog')).toBe('https://x.test/.netlify/functions/watchdog')
  })

  // Every name it can be asked for is a real, routable handler.
  it('addresses a path the router can actually resolve', async () => {
    const { resolveRoute } = await import('./router')
    installRuntimeEnv({})
    const url = new URL(internalFunctionUrl('https://x.test', 'report-compose-background'))
    expect(resolveRoute(url)?.name).toBe('report-compose-background')
  })
})

// The drift guard. The whole point is that there is ONE place that knows.
describe('nothing else hardcodes a host-specific function path', () => {
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('leaves /.netlify/functions/ to lib/site.ts alone', () => {
    const roots = [join(__dirname, '..'), __dirname]
    const offenders: string[] = []
    for (const dir of roots) {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile() || !/\.(mts|ts)$/.test(f.name) || f.name === 'site.ts' || f.name.endsWith('.test.ts')) continue
        if (stripComments(readFileSync(join(dir, f.name), 'utf8')).includes('/.netlify/functions/')) offenders.push(f.name)
      }
    }
    expect(offenders, 'use internalFunctionUrl() from lib/site.ts instead').toEqual([])
  })

  // …and the failure is logged. A silent `.catch(() => {})` on the compose kick
  // means a morning with no paper and no reason recorded anywhere.
  it('logs the compose kick before swallowing it', () => {
    const src = readFileSync(join(__dirname, '..', 'predict-background.mts'), 'utf8')
    expect(src).toContain('internalFunctionUrl(SITE')
    // The fetch(...) that kicks the composer, from `const composeUrl` to the
    // end of its catch. It must not be the bare `.catch(() => {})` it was.
    const kick = /const composeUrl = internalFunctionUrl[\s\S]*?\n\s*\}\)\.catch\((.*)\n/.exec(src)
    expect(kick, 'the compose kick moved — re-point this guard').not.toBeNull()
    expect(kick![1]).not.toMatch(/\(\)\s*=>\s*\{\s*\}/)
    expect(kick![1]).toContain("console.error('PREDICT: compose kick failed")
  })
})
