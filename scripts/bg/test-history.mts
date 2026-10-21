// Bounded, free historical research. No API keys, LLM calls or paid data.
import { buildFinancialPanel, FINANCIAL_HISTORY_VERSION } from '../lib/historicalFundamentals'
import { resolveSecCompany } from '../../netlify/functions/lib/secFilings'
import type { CompanyFacts } from '../../netlify/functions/lib/businessHealth'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { buildHistoricalStudy, HISTORY_START, HISTORY_SYMBOLS, parseHistoryTape, type HistoryTape } from '../lib/longHistory'
import { configureStoreForScript } from '../lib/configureStore'
import { appStore, acquireLease, releaseLease } from '../../netlify/functions/lib/storeProvider'
import type { EngineLabSnapshot } from '../../shared/engine/strategyLab'

const now = Math.floor(Date.now() / 1000), dir = '.history-cache'
const publish = process.argv.includes('--publish')
await mkdir(dir, { recursive: true })
const tapes: HistoryTape[] = []
for (const sym of ['SPY', ...HISTORY_SYMBOLS]) {
  const path = `${dir}/${sym}.json`
  let tape: HistoryTape | null = null
  try {
    const cached = JSON.parse(await readFile(path, 'utf8')) as HistoryTape
    if (cached.sym === sym && cached.fetchedAt <= now && now - cached.fetchedAt < 7 * 86400 && cached.candles.length > 2400 && cached.adjustment.length === cached.candles.length && Array.isArray(cached.splits)) tape = cached
  } catch { /* fetch a fresh public tape */ }
  if (!tape) {
    for (let attempt = 0; attempt < 3 && !tape; attempt++) {
      try {
        const host = attempt === 1 ? 'query2' : 'query1'
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?period1=${HISTORY_START}&period2=${now}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (StreetSignal research)' }, signal: AbortSignal.timeout(25000) })
        if (!response.ok) throw new Error(`public-feed-http-${response.status}`)
        tape = parseHistoryTape(await response.json(), sym, now)
        if (tape.candles.length < 2400 || now - tape.candles.at(-1)!.t > 7 * 86400) throw new Error('Insufficient or stale long history')
        await writeFile(path, JSON.stringify(tape))
      } catch (error) { tape = null; console.warn(`${sym}: ${String(error)}`); if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1))) }
    }
  }
  if (!tape) throw new Error(`${sym}: full predeclared panel unavailable; preserving the previous study`)
  tapes.push(tape)
}
const financialPanels = [], financialHashes: string[] = []
const userAgent = process.env.SEC_USER_AGENT || 'StreetSignal research https://thestreetsignal.rqai.co.uk'
for (const sym of HISTORY_SYMBOLS) {
  const path = `${dir}/sec-${sym}.json`
  let body: CompanyFacts | null = null
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'))
    if (cached.sym === sym && cached.fetchedAt <= now && now - cached.fetchedAt < 7 * 86400 && cached.body?.facts) body = cached.body
  } catch { /* fetch public SEC data */ }
  if (!body) {
    for (let attempt = 0; attempt < 3 && !body; attempt++) {
      try {
        const bounded: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(25000) })
        const company = await resolveSecCompany(sym, bounded, userAgent)
        if (!company) throw new Error('No SEC issuer identity')
        const response = await bounded(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(company.cik_str).padStart(10, '0')}.json`, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } })
        if (!response.ok) throw new Error(`SEC HTTP ${response.status}`)
        const candidate = await response.json() as CompanyFacts
        if (Number(candidate.cik) !== company.cik_str || !candidate.facts) throw new Error('SEC identity/financial facts mismatch')
        body = { ...candidate, cik: company.cik_str }
        await writeFile(path, JSON.stringify({ sym, fetchedAt: now, body }))
      } catch (e) { console.warn(`${sym} financials: ${String(e)}`); await new Promise(r => setTimeout(r, 2000 * (attempt + 1))) }
    }
  }
  // Preserve the predeclared universe: a failed download is an operational
  // failure, not permission to publish a smaller, better-looking panel.
  if (!body) throw new Error(`${sym}: SEC download unavailable; preserving the previous study`)
  financialHashes.push(createHash('sha256').update(JSON.stringify(body)).digest('hex'))
  const panel = buildFinancialPanel(body, sym, now)
  financialPanels.push(panel)
  console.log(`${sym}: ${panel.points.length} dated financial snapshots prepared`)
  await new Promise(r => setTimeout(r, 250))
}
const digest = createHash('sha256').update(JSON.stringify(tapes.map(t => ({ sym: t.sym, candles: t.candles, adjustment: t.adjustment, splits: t.splits })))).update(FINANCIAL_HISTORY_VERSION).update(JSON.stringify(financialHashes)).digest('hex')
const study = buildHistoricalStudy(tapes.slice(1), tapes[0], now, digest, console.log, financialPanels)
await writeFile(`${dir}/result.json`, JSON.stringify(study, null, 2))
console.log(JSON.stringify({ dataThrough: study.dataThrough, digest, strategies: study.strategies.map(s => ({ label: s.label, status: s.status, stats: s.stats })), gates: study.gates }))
if (publish) {
  await configureStoreForScript()
  const key = 'lease:predict-background', lease = await acquireLease(appStore, key, Math.floor(Date.now() / 1000), 120)
  if (!lease) throw new Error('Engine is writing; finished study retained locally. Retry publication later.')
  try {
    await appStore.write('engine-historical-study', study)
    const lab = await appStore.read<EngineLabSnapshot>('engine-lab')
    if (lab?.learning) {
      lab.learning.historicalStudy = study
      await appStore.write('engine-research-learning', lab.learning)
      await appStore.write('engine-lab', lab)
    }
    console.log('Historical study published to the app. Live forecast outcomes remain separate.')
  } finally { await releaseLease(appStore, key, lease) }
}
