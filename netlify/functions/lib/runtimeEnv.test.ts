import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FUNCTION_ENV_VARS, clearRuntimeEnv, installRuntimeEnv, readEnv, runtimeBinding, runtimeEnvBag, runtimeHost } from './runtimeEnv'

const TOUCHED = ['M2_ONLY_IN_BAG', 'M2_ALREADY_SET', 'M2_BLANK_HERE', 'M2_MIRRORED']

beforeEach(() => {
  clearRuntimeEnv()
  for (const k of TOUCHED) delete process.env[k]
})
afterEach(() => {
  clearRuntimeEnv()
  for (const k of TOUCHED) delete process.env[k]
})

describe('reading the environment', () => {
  it('falls straight through to process.env when nothing is installed — the Netlify path', () => {
    process.env.M2_ALREADY_SET = 'from-netlify'
    expect(runtimeEnvBag()).toBeNull()
    expect(readEnv('M2_ALREADY_SET')).toBe('from-netlify')
    expect(readEnv('M2_ONLY_IN_BAG')).toBeUndefined()
  })

  it('finds a Worker var that process.env has never heard of', () => {
    installRuntimeEnv({ M2_ONLY_IN_BAG: 'from-worker' })
    expect(readEnv('M2_ONLY_IN_BAG')).toBe('from-worker')
  })

  // The whole reason 23 handler files kept their `process.env.X` reads.
  it('mirrors the Worker bag onto process.env so unchanged handler code works', () => {
    installRuntimeEnv({ M2_MIRRORED: 'mirrored-value' })
    expect(process.env.M2_MIRRORED).toBe('mirrored-value')
  })

  it('never clobbers a value the platform already set', () => {
    process.env.M2_ALREADY_SET = 'platform-wins'
    installRuntimeEnv({ M2_ALREADY_SET: 'bag-loses' })
    expect(process.env.M2_ALREADY_SET).toBe('platform-wins')
  })

  // GitHub materialises an unset secret as '', which 401'd every morning paper
  // from 2026-07-24 (auth.ts:24-33). A blank must not shadow a real value.
  it('treats a blank as unset, on both sides', () => {
    process.env.M2_BLANK_HERE = ''
    installRuntimeEnv({ M2_BLANK_HERE: 'real-value' })
    expect(process.env.M2_BLANK_HERE).toBe('real-value')
    expect(readEnv('M2_BLANK_HERE')).toBe('real-value')

    clearRuntimeEnv()
    process.env.M2_BLANK_HERE = ''
    expect(readEnv('M2_BLANK_HERE')).toBeUndefined()
  })

  it('keeps non-string bindings out of process.env and reachable by name', () => {
    const db = { prepare: () => undefined }
    installRuntimeEnv({ STREETSIGNAL_DB: db, APP_TOKEN: 'tok' })
    expect(runtimeBinding('STREETSIGNAL_DB')).toBe(db)
    expect(process.env.STREETSIGNAL_DB).toBeUndefined()
    expect(runtimeBinding('APP_TOKEN')).toBeNull() // a string is a var, not a binding
  })

  it('clears cleanly', () => {
    installRuntimeEnv({ M2_ONLY_IN_BAG: 'x' })
    clearRuntimeEnv()
    expect(runtimeEnvBag()).toBeNull()
    expect(runtimeBinding('M2_ONLY_IN_BAG')).toBeNull()
  })

  it('reports the host, and calls an installed bag Workers', () => {
    expect(runtimeHost()).toBe('node')
    installRuntimeEnv({ APP_TOKEN: 'x' })
    expect(runtimeHost()).toBe('workers')
  })
})

// THE M3 CUTOVER CHECKLIST, kept honest. A key added to a handler and forgotten
// here is a key nobody sets on Cloudflare, and the failure lands at 05:20 on a
// weekday morning.
describe('FUNCTION_ENV_VARS covers what the functions actually read', () => {
  const ROOTS = [join(__dirname, '..'), join(__dirname, '..', '..', '..', 'shared')]

  function* sources(dir: string): Generator<string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === '__fixtures__') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) yield* sources(p)
      else if (/\.(ts|mts)$/.test(e.name) && !e.name.includes('.test.')) yield p
    }
  }

  /** Comment lines are stripped: this very repo's migration notes mention
   * `process.env.X` in prose, and a doc example is not a dependency. */
  const code = (file: string) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

  it('names every literal process.env read in netlify/functions and shared', () => {
    const found = new Set<string>()
    for (const root of ROOTS) for (const f of sources(root)) for (const m of code(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1])
    expect([...found].sort().filter(n => !(FUNCTION_ENV_VARS as readonly string[]).includes(n))).toEqual([])
    expect(found.size).toBeGreaterThan(20)
  })

  // llm.ts spreads the WHOLE of process.env into its LlmEnv, so every field of
  // that interface is a live environment variable that no `process.env.X` grep
  // would ever surface. This is how GROQ_MODEL got onto the checklist.
  it('names every LlmEnv field, because callLlm spreads process.env into it', () => {
    const llm = readFileSync(join(__dirname, 'llm.ts'), 'utf8')
    expect(llm).toMatch(/\{ \.\.\.\(process\.env as LlmEnv\), \.\.\.env \}/)
    const iface = /export interface LlmEnv \{([\s\S]*?)\n\}/.exec(llm)![1]
    const fields = [...iface.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\??:/gm)].map(m => m[1])
    expect(fields.length).toBeGreaterThan(8)
    expect(fields.filter(n => !(FUNCTION_ENV_VARS as readonly string[]).includes(n))).toEqual([])
  })

  it('has no duplicates', () => {
    expect(new Set(FUNCTION_ENV_VARS).size).toBe(FUNCTION_ENV_VARS.length)
  })
})
