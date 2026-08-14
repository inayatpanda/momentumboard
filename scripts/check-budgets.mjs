#!/usr/bin/env node
// Bundle budget gate (plan Task 11 + CX-10). Measures the INITIAL STATIC
// CLOSURE — index.html + every script it loads or modulepreloads + CSS — in
// gzip bytes, against the cutover budget. Warn-only by default; --enforce
// exits 1 (the cutover flip, Task 24, runs it enforced).
//
//   node scripts/check-budgets.mjs [--enforce]
//
// Budgets (amended CX-10): initial JS+CSS ≤ 120 KB gzip HARD, 100 KB target.
// (The old shell ships 170.2 KB gzip initial — recon §2.0.)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const DIST = new URL('../dist', import.meta.url).pathname
const HARD = 120 * 1024
const TARGET = 100 * 1024
const enforce = process.argv.includes('--enforce')

const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const initialRefs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(m => m[1])
const modulepreloads = [...html.matchAll(/rel="modulepreload"[^>]*href="([^"]+)"/g)].map(m => m[1])

const gz = p => gzipSync(readFileSync(p)).length
const kb = n => (n / 1024).toFixed(1).padStart(7)

let rows = []
for (const f of readdirSync(join(DIST, 'assets'))) {
  const p = join(DIST, 'assets', f)
  if (!statSync(p).isFile()) continue
  const ref = `/assets/${f}`
  rows.push({ f, raw: statSync(p).size, gz: gz(p), initial: initialRefs.includes(ref) || modulepreloads.includes(ref) })
}
rows.sort((a, b) => b.gz - a.gz)

console.log('\n  chunk                                        raw KB   gz KB  initial')
for (const r of rows) console.log(`  ${r.f.padEnd(42)} ${kb(r.raw)} ${kb(r.gz)}  ${r.initial ? '● ' : ''}`)

const initial = rows.filter(r => r.initial)
const total = initial.reduce((s, r) => s + r.gz, 0)
console.log(`\n  INITIAL CLOSURE (html-referenced + modulepreload): ${(total / 1024).toFixed(1)} KB gzip`)
console.log(`  budget: target ${TARGET / 1024} KB · hard ${HARD / 1024} KB ${enforce ? '(ENFORCED)' : '(warn-only until cutover)'}`)

// Vendor chunks must be reachable at boot: either script-src or modulepreload.
const missingPreload = rows.filter(r => /^(react|data)-.*\.js$/.test(r.f) && !r.initial)
if (missingPreload.length) {
  console.error(`  ✗ vendor chunks missing from the initial graph (no modulepreload): ${missingPreload.map(r => r.f).join(', ')}`)
  if (enforce) process.exit(1)
}

if (total > HARD) {
  console.error(`  ✗ initial closure ${(total / 1024).toFixed(1)} KB exceeds the ${HARD / 1024} KB hard budget`)
  if (enforce) process.exit(1)
} else if (total > TARGET) {
  console.warn(`  ⚠ over the ${TARGET / 1024} KB target (within hard budget)`)
} else {
  console.log('  ✓ within target')
}
