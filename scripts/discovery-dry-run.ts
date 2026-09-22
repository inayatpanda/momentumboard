// Run the real discovery scan against LIVE market data and print what it saw.
//
//   npx tsx scripts/discovery-dry-run.ts [--limit N] [--budget-ms N] [--no-cache] [--store=live]
//
// Defaults are deliberately harmless: an IN-MEMORY store, so the dynamic
// universe and the discovery trace are written to nothing and production blobs
// are never touched (`--store=live` opts in). The bars cache is the real
// lib/cache.ts, which under a bare Node process with no Netlify credentials is
// itself an in-process Map — so a first run is cold, and a second run in the
// same process is warm. `--no-cache` forces cold.
//
// Ship gate (design §5): a clean run under 3 minutes with ≥ 90% bars coverage.
// This script exits 1 below 80%, which is the "something is actually broken"
// line rather than the target.
import { readFileSync } from 'node:fs'
import { memoryStore, type AppStore } from '../netlify/functions/lib/store'
import { fetchUniverseBars, type BarsCache } from '../netlify/functions/lib/discoveryBars'
import { runDiscovery } from '../netlify/functions/lib/discovery'
import { isRouteEtp } from '../shared/engine/riskLadder'
import type { UniverseSeedRow } from '../shared/engine/discovery/universeSeedBuild'
import { LENS_IDS, type LensId } from '../shared/engine/discovery/types'

// minimal .env loader — the script runs outside Netlify's env injection
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* no .env — fine, nothing here needs a key */
}

const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const eq = argv.find(a => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const has = (name: string) => argv.includes(`--${name}`)

const limit = Number(flag('limit')) || 0
const budgetMs = Number(flag('budget-ms')) || 180_000
const coldCache = has('no-cache')
const liveStore = flag('store') === 'live'

async function loadSeed(): Promise<UniverseSeedRow[]> {
  try {
    const mod = await import('../shared/engine/discovery/universeSeed')
    return mod.loadUniverseSeed()
  } catch (e) {
    // The loader imports the JSON; if the seed has not been generated yet the
    // import itself fails. Read the file directly so the shape of the failure
    // is "no seed file" rather than "module missing".
    try {
      const raw = JSON.parse(readFileSync(new URL('../shared/engine/discovery/universe.seed.json', import.meta.url), 'utf8')) as { rows?: UniverseSeedRow[] }
      return raw.rows ?? []
    } catch {
      throw new Error(`no universe seed available (${String((e as Error)?.message ?? e).slice(0, 120)}) — run scripts/build-universe-seed.ts first`)
    }
  }
}

const store: AppStore = liveStore ? (await import('../netlify/functions/lib/storeProvider')).appStore : memoryStore()
// `false` is the bars layer's own opt-out: no shard read, no shard write, every
// name cold. Nothing is stubbed, so the incremental planner still runs — it just
// never finds anything.
const cache: BarsCache | false | undefined = coldCache ? false : undefined

const seedAll = await loadSeed()
const seed = limit > 0 ? seedAll.slice(0, limit) : seedAll
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

console.log(`discovery dry run · ${date} · seed ${seed.length}/${seedAll.length} names · budget ${(budgetMs / 1000).toFixed(0)}s · store ${liveStore ? 'LIVE' : 'memory'} · cache ${coldCache ? 'cold' : 'shared'}`)

// SPY first and on its own: every relative-strength feature in the scan is
// measured against it, so a scan that starts without it is a scan with no RS.
const spyRes = await fetchUniverseBars(['SPY'], { cache, log: () => {} })
const spy = spyRes.tapes.get('SPY') ?? null
console.log(`SPY: ${spy ? `${spy.length} bars, last close ${spy[spy.length - 1].c}` : 'UNAVAILABLE — relative strength will be null'}`)

const t0 = Date.now()
const res = await runDiscovery({
  date,
  store,
  seed,
  nominations: [],
  spy,
  isEtp: (sym: string) => isRouteEtp(sym, {}),
  budgetMs,
  log: line => console.log(`  ${line}`),
  cache,
})
const elapsed = Date.now() - t0

const s = res.stats
const read = s.barsFetched + s.barsFromCache
const coverage = s.universeSize ? read / s.universeSize : 0
// The bars columns partition the universe (fetched + cached + failed + unread),
// so coverage is the two that produced a tape and nothing has to be subtracted
// back out. `stats.rejects` — counted over the WHOLE universe, not off the
// 400-row trace — is what says why each of the others fell out.
const unread = s.barsUnread
console.log(
  `\nuniverse ${s.universeSize} (seed ${s.seedSize} + dynamic ${s.dynamicSize}) · bars ${s.barsFetched} fetched / ${s.barsFromCache} cached / ${s.barsFailed} failed / ${unread} unread · ` +
    `partial bars dropped ${s.partialDropped} · coverage ${(coverage * 100).toFixed(1)}% · scanned ${s.scanned} · selected ${s.selected} · ${(elapsed / 1000).toFixed(1)}s · budgetHit ${s.budgetHit}`,
)

const rejects = Object.entries(s.rejects).sort((a, b) => b[1] - a[1])
if (rejects.length) console.log(`rejects (whole universe): ${rejects.map(([k, v]) => `${k} ${v}`).join(' · ')}`)

console.log('\nper lens:')
for (const lens of LENS_IDS) console.log(`  ${lens.padEnd(10)} ${String(s.perLens[lens as LensId] ?? 0).padStart(4)}`)

const num = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits))
console.log(`\ntop ${Math.min(40, res.candidates.length)} candidates:`)
console.log(`${'sym'.padEnd(9)} ${'lenses'.padEnd(34)} ${'ret1'.padStart(7)} ${'rvol'.padStart(6)} ${'rsSpy20'.padStart(8)}  reason`)
for (const c of res.candidates.slice(0, 40)) {
  const lenses = c.lenses.map(l => `${l.lens}:${l.score.toFixed(2)}`).join(' ')
  console.log(
    `${c.sym.padEnd(9)} ${lenses.padEnd(34)} ${num(c.features.ret1).padStart(7)} ${num(c.features.rvol, 2).padStart(6)} ${num(c.features.rsSpy20).padStart(8)}  ${c.lenses[0]?.reason ?? ''}`,
  )
}

if (coverage < 0.8) {
  console.error(`\nFAIL: bars coverage ${(coverage * 100).toFixed(1)}% is below the 80% floor`)
  process.exit(1)
}
