/**
 * Build `shared/engine/discovery/universe.seed.json` — the static universe the
 * discovery engine screens over: liquid, Yahoo-resolvable equities across US
 * large/mid/small caps and UK large/mid caps.
 *
 *   npx vite-node scripts/build-universe-seed.ts
 *   npx vite-node scripts/build-universe-seed.ts --limit 50   (smoke run)
 *   npx vite-node scripts/build-universe-seed.ts --no-validate
 *
 * DESIGN
 * - Every source is FAIL-SOFT. A 404, a timeout, or a page that has quietly
 *   dropped its constituents table is reported in the summary and skipped; the
 *   run still writes a seed from whatever came back. It refuses to write in
 *   exactly two cases, both of which mean the run measured the network rather
 *   than the universe: no source returned anything at all, or Yahoo left more
 *   than 2% of symbols unanswered (SOFT_FAILURE_CEILING). A gutted seed
 *   committed silently is the real failure mode here.
 * - Parsing is DOM-free (see ../shared/engine/discovery/universeSeedBuild.ts):
 *   no new dependency for one JSON file.
 * - Output is DETERMINISTIC: rows sorted by symbol, index tags in a fixed
 *   order, one row per line so a regeneration diffs as a handful of lines.
 *
 * NASDAQ-100: the Wikipedia article is the documented source and is tried
 * first, but as of 2026-09 the article no longer carries a components table
 * (the section was removed upstream). When the table is missing the script
 * falls back to Nasdaq's own public list endpoint and SAYS SO in the summary,
 * rather than silently shipping a seed with no `ndx` tags.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accumulate, extractTables, normaliseSymbol, parseCsv, pickConstituentTable, sortRows,
  INDEX_EXCHANGE, SYMBOL_RE,
  type IndexTag, type RawConstituent, type UniverseSeedRow,
} from '../shared/engine/discovery/universeSeedBuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../shared/engine/discovery/universe.seed.json')

/**
 * Plain `Mozilla/5.0`, and it has to stay plain.
 *
 * MEASURED 2026-09-22: a full Chrome UA string
 * ("Mozilla/5.0 (Macintosh; …) Chrome/124.0 Safari/537.36") makes Yahoo's chart
 * endpoint answer `429 Too Many Requests` to a burst of 8 concurrent requests
 * from the first one onward, while the same burst with `Mozilla/5.0` returns
 * 200 for all of them — the first pass of this script lost all 1,867 symbols to
 * it. Wikipedia and raw.githubusercontent.com are happy with the short string
 * too, so one UA serves every source.
 */
const UA = 'Mozilla/5.0'

const args = process.argv.slice(2)
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 ? Number(args[i + 1]) : 0
})()
const VALIDATE = !args.includes('--no-validate')

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface FetchResult { ok: boolean; status: number; body: string; error?: string }

/**
 * Shared throttle gate. A 429 is a statement about the CALLER, not about the
 * one URL that happened to receive it, so backing off inside a single worker
 * while seven others keep hammering just keeps the limiter angry. Every worker
 * waits behind this timestamp instead.
 */
let cooldownUntil = 0

async function waitForGate(): Promise<void> {
  for (;;) {
    const left = cooldownUntil - Date.now()
    if (left <= 0) return
    await sleep(Math.min(left, 2_000))
  }
}

function openCooldown(ms: number): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms)
}

/** GET with a browser UA, a timeout, and an all-workers backoff on 429/5xx.
 * Never throws — the caller decides what a failed source means. */
async function get(url: string, attempts = 3, timeoutMs = 30_000): Promise<FetchResult> {
  let last: FetchResult = { ok: false, status: 0, body: '', error: 'not attempted' }
  for (let a = 0; a < attempts; a++) {
    await waitForGate()
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 429 || res.status >= 500) {
        last = { ok: false, status: res.status, body: '', error: `HTTP ${res.status}` }
        const retryAfter = Number(res.headers.get('retry-after'))
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : Math.min(1_000 * 2 ** a, 30_000)
        openCooldown(backoff)
        continue
      }
      const body = await res.text()
      return { ok: res.ok, status: res.status, body, error: res.ok ? undefined : `HTTP ${res.status}` }
    } catch (e) {
      last = { ok: false, status: 0, body: '', error: e instanceof Error ? e.message : String(e) }
      await sleep(Math.min(500 * 2 ** a, 8_000))
    }
  }
  return last
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface SourceReport {
  index: IndexTag
  url: string
  status: 'ok' | 'skipped'
  httpStatus: number
  /** Rows parsed off the page (before cross-source merge and Yahoo validation). */
  rows: number
  note?: string
}

const WIKI = {
  ndx: 'https://en.wikipedia.org/wiki/Nasdaq-100',
  sp400: 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies',
  sp600: 'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies',
  ftse100: 'https://en.wikipedia.org/wiki/FTSE_100_Index',
  ftse250: 'https://en.wikipedia.org/wiki/FTSE_250_Index',
} as const

const SP500_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'
const NDX_FALLBACK = 'https://api.nasdaq.com/api/quote/list-type/nasdaq100'

function toRaw(index: IndexTag, sym: string, name: string, sector: string): RawConstituent | null {
  const norm = normaliseSymbol(sym, INDEX_EXCHANGE[index])
  if (!norm || !SYMBOL_RE.test(norm)) return null
  return { sym: norm, name: name || norm, sector: sector || null, index }
}

/** S&P 500 from the `datasets/` CSV mirror (Symbol, Security, GICS Sector…). */
async function fetchSp500(): Promise<{ report: SourceReport; raws: RawConstituent[] }> {
  const res = await get(SP500_CSV)
  const base: SourceReport = { index: 'sp500', url: SP500_CSV, status: 'skipped', httpStatus: res.status, rows: 0 }
  if (!res.ok) return { report: { ...base, note: res.error ?? 'fetch failed' }, raws: [] }
  const table = parseCsv(res.body)
  if (table.length < 2) return { report: { ...base, note: 'empty CSV' }, raws: [] }
  const header = table[0].map(h => h.trim().toLowerCase())
  const symIdx = header.findIndex(h => h.includes('symbol') || h.includes('ticker'))
  const nameIdx = header.findIndex(h => h.includes('security') || h.includes('name'))
  const sectorIdx = header.findIndex(h => h.includes('sector'))
  if (symIdx < 0) return { report: { ...base, note: `no symbol column in [${header.join(', ')}]` }, raws: [] }
  const raws: RawConstituent[] = []
  for (const row of table.slice(1)) {
    const r = toRaw('sp500', row[symIdx] ?? '', nameIdx >= 0 ? (row[nameIdx] ?? '') : '', sectorIdx >= 0 ? (row[sectorIdx] ?? '') : '')
    if (r) raws.push(r)
  }
  return { report: { ...base, status: raws.length > 0 ? 'ok' : 'skipped', rows: raws.length }, raws }
}

/** Any Wikipedia constituents page, found by header shape rather than by id. */
async function fetchWikiIndex(index: IndexTag, url: string, minRows: number): Promise<{ report: SourceReport; raws: RawConstituent[] }> {
  const res = await get(url)
  const base: SourceReport = { index, url, status: 'skipped', httpStatus: res.status, rows: 0 }
  if (!res.ok) return { report: { ...base, note: res.error ?? 'fetch failed' }, raws: [] }
  const picked = pickConstituentTable(extractTables(res.body), minRows)
  if (!picked) return { report: { ...base, note: `no constituents wikitable (>=${minRows} rows) on the page` }, raws: [] }
  const raws: RawConstituent[] = []
  for (const row of picked.rows) {
    const r = toRaw(index, row[picked.symbolIdx] ?? '', row[picked.nameIdx] ?? '', picked.sectorIdx >= 0 ? (row[picked.sectorIdx] ?? '') : '')
    if (r) raws.push(r)
  }
  return { report: { ...base, status: raws.length > 0 ? 'ok' : 'skipped', rows: raws.length }, raws }
}

/** Nasdaq-100 fallback: Nasdaq's public list endpoint. Only reached when the
 * Wikipedia table is gone; the summary records which one was used. */
async function fetchNdxFallback(): Promise<{ report: SourceReport; raws: RawConstituent[] }> {
  const res = await get(NDX_FALLBACK)
  const base: SourceReport = { index: 'ndx', url: NDX_FALLBACK, status: 'skipped', httpStatus: res.status, rows: 0 }
  if (!res.ok) return { report: { ...base, note: res.error ?? 'fetch failed' }, raws: [] }
  let rows: Array<{ symbol?: string; companyName?: string; sector?: string }> = []
  try {
    const json = JSON.parse(res.body) as { data?: { data?: { rows?: unknown } } }
    const maybe = json.data?.data?.rows
    if (Array.isArray(maybe)) rows = maybe as typeof rows
  } catch (e) {
    return { report: { ...base, note: `unparseable JSON: ${e instanceof Error ? e.message : String(e)}` }, raws: [] }
  }
  const raws: RawConstituent[] = []
  for (const row of rows) {
    // Nasdaq appends the security type to the name ("Apple Inc. Common Stock").
    const name = (row.companyName ?? '').replace(/\s+(Common Stock|Class [A-Z]|Ordinary Shares?)\b.*$/i, '').trim()
    const r = toRaw('ndx', row.symbol ?? '', name, row.sector ?? '')
    if (r) raws.push(r)
  }
  return { report: { ...base, status: raws.length > 0 ? 'ok' : 'skipped', rows: raws.length, note: 'Wikipedia fallback' }, raws }
}

// ---------------------------------------------------------------------------
// Yahoo validation
// ---------------------------------------------------------------------------

interface Verdict {
  sym: string
  keep: boolean
  /** true  = Yahoo answered and the symbol genuinely fails the bar (404, thin).
   *  false = we never got an answer (throttled, timed out). A soft failure is
   *  NOT evidence about the symbol, so it must not quietly shrink the seed —
   *  see the SOFT_FAILURE_CEILING guard in main(). */
  hard: boolean
  reason?: string
  currency?: string
  exchangeName?: string
}

const MIN_BARS = 10

/** Above this share of soft failures the run is not measuring the universe, it
 * is measuring the rate limiter — so it refuses to overwrite the seed. */
const SOFT_FAILURE_CEILING = 0.02

async function verify(sym: string): Promise<Verdict> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`
  const res = await get(url, 6, 20_000)
  if (res.status === 404) return { sym, keep: false, hard: true, reason: '404' }
  if (!res.ok) return { sym, keep: false, hard: false, reason: res.error ?? `HTTP ${res.status}` }
  try {
    const json = JSON.parse(res.body) as {
      chart?: { result?: Array<{ timestamp?: number[]; meta?: { currency?: string; exchangeName?: string } }> | null }
    }
    const result = json.chart?.result?.[0]
    if (!result) return { sym, keep: false, hard: true, reason: 'no result' }
    const bars = result.timestamp?.length ?? 0
    if (bars < MIN_BARS) return { sym, keep: false, hard: true, reason: `${bars} bars` }
    return { sym, keep: true, hard: false, currency: result.meta?.currency, exchangeName: result.meta?.exchangeName }
  } catch (e) {
    return { sym, keep: false, hard: false, reason: `unparseable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Fixed-size worker pool — 8 in flight, which Yahoo tolerates without 429s. */
async function verifyAll(syms: readonly string[], concurrency = 8): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>()
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= syms.length) return
      const v = await verify(syms[i])
      out.set(v.sym, v)
      done += 1
      if (done % 100 === 0 || done === syms.length) {
        process.stdout.write(`  validated ${done}/${syms.length}\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, syms.length) }, worker))
  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Fetching constituent lists…')
  const results = await Promise.all([
    fetchSp500(),
    fetchWikiIndex('ndx', WIKI.ndx, 40),
    fetchWikiIndex('sp400', WIKI.sp400, 200),
    fetchWikiIndex('sp600', WIKI.sp600, 300),
    fetchWikiIndex('ftse100', WIKI.ftse100, 60),
    fetchWikiIndex('ftse250', WIKI.ftse250, 150),
  ])

  const reports: SourceReport[] = results.map(r => r.report)
  const raws: RawConstituent[] = results.flatMap(r => r.raws)

  // Nasdaq-100 fallback (see header note).
  const ndxReport = reports.find(r => r.index === 'ndx')!
  if (ndxReport.status === 'skipped') {
    console.log(`  ndx: ${ndxReport.note} — trying the Nasdaq list endpoint instead`)
    const fb = await fetchNdxFallback()
    if (fb.report.status === 'ok') {
      reports[reports.indexOf(ndxReport)] = { ...fb.report, note: `${ndxReport.note}; used ${NDX_FALLBACK}` }
      raws.push(...fb.raws)
    } else {
      ndxReport.note = `${ndxReport.note}; fallback also failed (${fb.report.note})`
    }
  }

  console.log('\nSource summary')
  for (const r of reports) {
    console.log(`  ${r.index.padEnd(8)} ${String(r.status).padEnd(8)} http=${String(r.httpStatus).padEnd(4)} rows=${String(r.rows).padStart(4)}${r.note ? `  — ${r.note}` : ''}`)
  }

  if (raws.length === 0) {
    console.error('\nEVERY source failed — refusing to write an empty seed.')
    process.exitCode = 1
    return
  }

  const merged = accumulate(raws)
  let rows = sortRows([...merged.values()])
  if (LIMIT > 0) rows = rows.slice(0, LIMIT)
  console.log(`\nMerged ${raws.length} constituents into ${rows.length} unique symbols.`)

  const dropped: Array<{ sym: string; reason: string }> = []
  const unresolved: Array<{ sym: string; reason: string }> = []
  if (VALIDATE) {
    console.log(`Validating against Yahoo (concurrency 8, drop <${MIN_BARS} bars or 404)…`)
    const verdicts = await verifyAll(rows.map(r => r.sym))
    const kept: UniverseSeedRow[] = []
    for (const row of rows) {
      const v = verdicts.get(row.sym)
      if (!v || !v.keep) {
        const entry = { sym: row.sym, reason: v?.reason ?? 'no verdict' }
        if (v?.hard) dropped.push(entry)
        else unresolved.push(entry)
        continue
      }
      if (v.currency) row.currency = v.currency
      if (v.exchangeName) row.exchangeName = v.exchangeName
      kept.push(row)
    }

    // A throttled run must not be allowed to overwrite a good seed with a
    // gutted one: an unanswered request says nothing about the symbol.
    const softRate = unresolved.length / Math.max(1, rows.length)
    if (softRate > SOFT_FAILURE_CEILING) {
      console.error(
        `\n${unresolved.length}/${rows.length} symbols never got an answer from Yahoo ` +
        `(${(softRate * 100).toFixed(1)}% > ${(SOFT_FAILURE_CEILING * 100).toFixed(0)}% ceiling) — ` +
        `that is a throttle, not a universe. Refusing to write ${OUT}.`,
      )
      for (const u of unresolved.slice(0, 10)) console.error(`  - ${u.sym} (${u.reason})`)
      process.exitCode = 1
      return
    }

    rows = kept
    console.log(`\nDropped ${dropped.length + unresolved.length} symbol(s) — ${dropped.length} rejected by Yahoo, ${unresolved.length} unanswered.`)
    for (const d of [...dropped, ...unresolved]) console.log(`  - ${d.sym} (${d.reason})`)
  } else {
    console.log('Skipping Yahoo validation (--no-validate).')
  }

  const sources: Record<string, { status: string; rows: number; url: string; note?: string }> = {}
  for (const r of reports) {
    sources[r.index] = { status: r.status, rows: r.rows, url: r.url, ...(r.note ? { note: r.note } : {}) }
  }

  const header = {
    generatedAt: new Date().toISOString(),
    sources,
    droppedByYahoo: dropped.length + unresolved.length,
    count: rows.length,
  }
  // One row per line: a regeneration diffs as the lines that actually moved.
  const body = [
    `{`,
    `  "generatedAt": ${JSON.stringify(header.generatedAt)},`,
    `  "sources": ${JSON.stringify(header.sources, null, 2).split('\n').join('\n  ')},`,
    `  "droppedByYahoo": ${header.droppedByYahoo},`,
    `  "count": ${header.count},`,
    `  "rows": [`,
    rows.map(r => `    ${JSON.stringify(r)}`).join(',\n'),
    `  ]`,
    `}`,
    ``,
  ].join('\n')

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, body, 'utf8')

  const byExchange = new Map<string, number>()
  const byBand = new Map<string, number>()
  for (const r of rows) {
    byExchange.set(r.exchange, (byExchange.get(r.exchange) ?? 0) + 1)
    byBand.set(r.capBand, (byBand.get(r.capBand) ?? 0) + 1)
  }
  console.log(`\nWrote ${OUT}`)
  console.log(`  count     ${rows.length}`)
  console.log(`  exchange  ${[...byExchange].sort().map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`  capBand   ${[...byBand].sort().map(([k, v]) => `${k}=${v}`).join(' ')}`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
