// Dry-run the full daily engine against LIVE market data with an in-memory
// store — no Netlify, no Telegram, no paper, nothing published. Shows exactly
// what the 05:20 run would produce this morning.
// Run: npm run engine-dry-run
import { readFileSync } from 'node:fs'
import { memoryStore } from '../netlify/functions/lib/store'
import { buildBoard, defaultDeps, gradeOutstanding } from '../netlify/functions/lib/engine'

// minimal .env loader — the script runs outside Netlify's env injection
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* no .env — Finnhub-dependent factors will just return null */
}

const store = memoryStore()
await store.write('config', {
  watchlist: [
    { symbol: 'NVDA', riskClass: 'normal' },
    { symbol: 'TSLA', riskClass: 'normal' },
    { symbol: 'PLTR', riskClass: 'speculative' },
  ],
  rules: [],
  ytChannels: [],
})

const nowSec = Math.floor(Date.now() / 1000)
const deps = defaultDeps({ FINNHUB_API_KEY: process.env.FINNHUB_API_KEY })

console.log('— grading pass (empty ledger → no-op) —')
console.log(await gradeOutstanding(store, deps, nowSec, null))

console.log('— building board from live data —')
const t0 = Date.now()
const { board, rosterSize, regime } = await buildBoard(store, deps, nowSec)
console.log(`regime ${regime} · roster ${rosterSize} · board ${board.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)

for (const p of board) {
  console.log(
    `\n${p.grade}${p.provisional ? '·prov' : ''} ${p.sym} ${p.side.toUpperCase()} | p=${p.probability} | composite ${p.composite} | in ${p.entry} stop ${p.stop} tgt ${p.target} | ~${p.expectedMovePct}% | cap ${p.capacityPct}%${p.smallCap ? ' | SMALL CAP' : ''}${p.earningsRisk ? ' | EARNINGS' : ''}${p.paperOnly ? ' | paper-only' : ''}${p.instrument ? ` | ${p.instrument.ticker} ${p.instrument.leverage}x` : ''}`,
  )
  console.log(`   ${p.note}`)
  for (const [name, f] of Object.entries(p.factors)) {
    if (f.score != null) console.log(`   ${name.padEnd(11)} ${String(f.score).padStart(6)} · ${f.detail}`)
  }
}

const blob = (await store.read<{ worldTape?: { tone: string; votes: { on: number; off: number }; detail: string }; newsTone?: { score: number; label: string; hits: number } }>('engine-board')) ?? {}
console.log(`\nworld tape: ${blob.worldTape?.detail ?? 'n/a'}`)
console.log(`news tone: ${blob.newsTone ? `${blob.newsTone.label} (score ${blob.newsTone.score}, ${blob.newsTone.hits} polarity hits)` : 'n/a'} — display/log only, not a factor`)

const today = new Date(nowSec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const ledger = (await store.read<{ sym: string; side: string; composite: number; probability: number; shadow?: boolean }[]>(`predictions:${today}`)) ?? []
const shadows = ledger.filter(p => p.shadow)
console.log(`\nledger today: ${ledger.length} (${shadows.length} shadow — graded for learning, never published)`)
for (const s of shadows) console.log(`   shadow ${s.sym} ${s.side} composite ${s.composite} p=${s.probability}`)

const roster = (await store.read<{ sym: string; capUsdM: number | null; source: string }[]>('engine-roster')) ?? []
const smalls = roster.filter(r => r.capUsdM != null && r.capUsdM < 2000).length
console.log(`\nroster: ${roster.length} names, ${smalls} small caps`)
console.log(roster.map(r => r.sym).join(' '))

// Fix A/B observability: insider coverage this run + 13F smart-money firings.
const rosterSyms = roster.map(r => r.sym)
const watchSyms = ['NVDA', 'TSLA', 'PLTR']
const cov = await deps.insiderCoverage(rosterSyms, watchSyms, today) // cached from the build — no fresh burst
const withBuys = [...cov.entries()].filter(([, v]) => v && v.buyers.length)
console.log(`\ninsider coverage: ${cov.size}/${rosterSyms.length} roster names checked (${withBuys.length} with open-market buys)`)
for (const [sym, v] of withBuys) console.log(`   ${sym}: ${v!.buyers.length} buyer(s)${v!.isCluster ? ' — CLUSTER' : ''}`)

const moves = await deps.smartMoney()
console.log(`\n13F funds parsed: ${moves.length} (${moves.map(m => `${m.fund}@${m.filedAt}`).join(', ') || 'none'})`)
if (moves.length) {
  const { matchSmartMoney } = await import('../netlify/functions/lib/edgar')
  let matchable = 0
  const firings: string[] = []
  for (const sym of rosterSyms) {
    const m = matchSmartMoney(sym, await deps.companyName(sym), moves)
    if (m) {
      matchable++
      firings.push(`${sym}: ${[...(m.bought.length ? [`+${m.bought.join('/')}`] : []), ...(m.exited.length ? [`-${m.exited.join('/')}`] : [])].join(' ')}`)
    }
  }
  console.log(`smartMoney matchable roster names: ${matchable}/${rosterSyms.length}`)
  for (const f of firings) console.log(`   ${f}`)
}
