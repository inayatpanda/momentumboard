// Bounded, free historical research. No API keys, LLM calls or paid data.
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
    if (cached.sym === sym && cached.fetchedAt <= now && now - cached.fetchedAt < 7 * 86400 && cached.candles.length > 2400 && cached.adjustment.length === cached.candles.length) tape = cached
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
const digest = createHash('sha256').update(JSON.stringify(tapes.map(t => ({ sym: t.sym, candles: t.candles, adjustment: t.adjustment })))).digest('hex')
const study = buildHistoricalStudy(tapes.slice(1), tapes[0], now, digest, console.log)
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
